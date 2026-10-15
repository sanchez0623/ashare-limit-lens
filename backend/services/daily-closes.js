// 每日收盘数据服务：直接读取 quan_quant 维护的 parquet 数据集
// （daily.parquet + adj_factor.parquet），为买点分类器提供 MA5。
//
// 设计（与使用者确认过的方案一致）：
// - 纯 Node 直读，不落库不拷贝：盘后 review / 回测重构各消费一次；
//   hyparquet（纯 JS parquet 解析）+ hyparquet-compressors（zstd），
//   无原生依赖、无 Python。
// - 不使用 hyparquet 的 asyncBufferFromFile（仅其 Node 入口提供，服务端
//   构建产物按 platform:browser 打包时选中浏览器入口，该助手不存在）。
//   这里自实现 AsyncBuffer，浏览器/Node 两种入口形态下行为一致。
// - 进程内按"规范化路径+mtime+size"缓存解析结果：同进程多次调用零成本，
//   quan_quant 更新 parquet 后自动失效重读，永远没有陈旧副本；
//   不同数据目录不会互相串缓存。
// - 优雅降级：QUAN_DATA_DIR 未配置、依赖缺失或文件读取失败时返回空 Map
//   （带 reason），MA5 未知 → 首阴买点不触发（宁缺毋滥），不影响其他链路。
// - MA5 口径（严格性约定）：
//   1. 数据必须覆盖快照日：数据截止日落后于快照日时返回空（带 reason），
//      不把旧 MA5 当作当日均线使用；
//   2. 窗口 5 根的复权因子齐全 → 前复权到快照日（close × f_i / f_asOf）；
//      整股完全无因子（数据源未覆盖）→ 未复权口径（一致基准）；
//      因子部分缺失 → 口径不明确，该股不产出 MA5，不静默混用两种口径；
//   3. 停牌股（快照日无收盘）与不足 5 根 K 线的新股不产出 MA5。

import fs from "node:fs";
import path from "node:path";
import { safeError } from "../http.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dailyDataDir(env) {
  return env?.QUAN_DATA_DIR || process.env.QUAN_DATA_DIR || null;
}

// ---------- AsyncBuffer：基于 node:fs 的字节区间读取 ----------
// hyparquet 约定：{ byteLength, slice(start, end?) => ArrayBuffer | Promise }

async function openAsyncBuffer(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  const size = (await handle.stat()).size;
  return {
    byteLength: size,
    async slice(start, end = size) {
      const length = end - start;
      if (length <= 0) return new ArrayBuffer(0);
      if (start < 0 || end > size)
        throw new Error(`文件读取越界：${filePath} [${start}, ${end})`);
      const view = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(
          view,
          read,
          length - read,
          start + read,
        );
        if (bytesRead <= 0)
          throw new Error(`文件读取不足：${filePath} @${start + read}`);
        read += bytesRead;
      }
      return view.buffer;
    },
    close: () => handle.close(),
  };
}

// ---------- parquet 列读取：流式按行组归并，避免全量行对象落内存 ----------

async function readColumns(filePath, columns) {
  const { parquetMetadataAsync, parquetRead } = await import("hyparquet");
  const { compressors } = await import("hyparquet-compressors");
  const file = await openAsyncBuffer(filePath);
  try {
    const meta = await parquetMetadataAsync(file);
    const rgRows = meta.row_groups.map((rg) => Number(rg.num_rows));
    const rgStarts = [];
    for (let acc = 0, i = 0; i < rgRows.length; i++) {
      rgStarts.push(acc);
      acc += rgRows[i];
    }
    const pending = new Map(); // rgIndex -> Map(column -> [{ start, data }])
    const merged = new Map(columns.map((c) => [c, []]));

    await parquetRead({
      file,
      compressors,
      columns,
      onChunk({ columnName, columnData, rowStart }) {
        let rg = rgStarts.length - 1;
        while (rg > 0 && rowStart < rgStarts[rg]) rg--;
        let bucket = pending.get(rg);
        if (!bucket) {
          bucket = new Map();
          pending.set(rg, bucket);
        }
        let parts = bucket.get(columnName);
        if (!parts) {
          parts = [];
          bucket.set(columnName, parts);
        }
        parts.push({ start: rowStart, data: columnData });
        const expected = rgRows[rg];
        const filled = (ps) => ps.reduce((s, p) => s + p.data.length, 0);
        // 所有请求列都凑齐本行组后才归并（chunk 到达顺序是乱序的，
        // 单列先到齐不代表行组可合并）
        const ready = columns.every((col) => {
          const ps = bucket.get(col);
          return ps !== undefined && filled(ps) >= expected;
        });
        if (!ready) return;
        for (const col of columns) {
          const out = merged.get(col);
          for (const part of bucket
            .get(col)
            .slice()
            .sort((a, b) => a.start - b.start))
            for (let i = 0; i < part.data.length; i++) out.push(part.data[i]);
        }
        pending.delete(rg);
      },
    });
    if (pending.size)
      throw new Error(
        `parquet 列数据不完整：${filePath} 有 ${pending.size} 个行组未凑齐`,
      );
    return merged;
  } finally {
    await file.close();
  }
}

// ---------- 数据集解析与缓存 ----------

async function parseDataset(dailyPath, adjPath) {
  const daily = await readColumns(dailyPath, ["code", "date", "close"]);
  const dCode = daily.get("code"),
    dDate = daily.get("date"),
    dClose = daily.get("close");
  const datesSet = new Set();
  const builders = new Map(); // code -> { d: string[], c: number[] }
  for (let i = 0; i < dCode.length; i++) {
    const code = dCode[i],
      date = dDate[i],
      close = Number(dClose[i]);
    if (typeof code !== "string" || !code) continue;
    if (typeof date !== "string" || !DATE_RE.test(date)) continue;
    if (!Number.isFinite(close) || close <= 0) continue;
    datesSet.add(date);
    let rec = builders.get(code);
    if (!rec) {
      rec = { d: [], c: [] };
      builders.set(code, rec);
    }
    rec.d.push(date);
    rec.c.push(close);
  }

  // 复权因子按 code+date 建索引；缺失的因子在 per-code 数组里以 NaN 表示
  const adj = await readColumns(adjPath, ["code", "date", "adj_factor"]);
  const aCode = adj.get("code"),
    aDate = adj.get("date"),
    aFactor = adj.get("adj_factor");
  const adjByCode = new Map();
  for (let i = 0; i < aCode.length; i++) {
    const code = aCode[i],
      date = aDate[i],
      f = Number(aFactor[i]);
    if (typeof code !== "string" || typeof date !== "string") continue;
    if (!Number.isFinite(f) || f <= 0) continue;
    let m = adjByCode.get(code);
    if (!m) {
      m = new Map();
      adjByCode.set(code, m);
    }
    m.set(date, f);
  }

  const dates = [...datesSet].sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const codes = new Map();
  for (const [code, rec] of builders) {
    // 数据源不保证按日升序，统一排序后压缩为类型数组
    const order = rec.d
      .map((d, i) => [dateIdx.get(d), i])
      .sort((x, y) => x[0] - y[0]);
    const n = order.length;
    const ds = new Uint32Array(n);
    const cs = new Float64Array(n);
    const as = new Float64Array(n).fill(Number.NaN);
    const fm = adjByCode.get(code) ?? null;
    for (let k = 0; k < n; k++) {
      const i = order[k][1];
      ds[k] = order[k][0];
      cs[k] = rec.c[i];
      const f = fm?.get(rec.d[i]);
      if (f !== undefined) as[k] = f;
    }
    codes.set(code, {
      dates: ds,
      closes: cs,
      adjs: as,
      // 该股在因子文件中是否有任何覆盖：完全没有 → 才允许未复权口径
      hasFactor: (fm?.size ?? 0) > 0,
    });
  }
  return { dates, dateIdx, codes };
}

let cache = null; // { key, dataset }

// 缓存键必须包含规范化路径：仅 mtime+size 无法区分"两个目录里属性相同的文件"
async function fileKey(resolvedPath) {
  const s = await fs.promises.stat(resolvedPath);
  return `${resolvedPath}@${Math.round(s.mtimeMs)}-${s.size}`;
}

export async function loadDailyDataset(dataDir) {
  const dir = path.resolve(dataDir);
  const dailyPath = path.join(dir, "daily.parquet");
  const adjPath = path.join(dir, "adj_factor.parquet");
  const key = `${await fileKey(dailyPath)}|${await fileKey(adjPath)}`;
  if (cache?.key === key) return cache.dataset;
  const dataset = await parseDataset(dailyPath, adjPath);
  cache = { key, dataset };
  return dataset;
}

// ---------- MA5 计算 ----------

function lowerBound(arr, target) {
  let lo = 0,
    hi = arr.length - 1,
    found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return found;
}

export function computeMa5ByCode(dataset, snapshotDate) {
  const { dates, dateIdx, codes } = dataset;
  if (!dates.length) return { ma5ByCode: new Map(), asOf: null };
  // 严格日期一致：数据必须覆盖快照日。数据滞后（快照日晚于数据截止）时
  // 返回空并说明原因，绝不把旧 MA5 当作当日均线——首阴判断对当日口径敏感。
  if (snapshotDate && DATE_RE.test(snapshotDate) && !dateIdx.has(snapshotDate))
    return {
      ma5ByCode: new Map(),
      asOf: dates[dates.length - 1] ?? null,
      reason: `日线数据未覆盖快照日 ${snapshotDate}（数据截止 ${
        dates[dates.length - 1] ?? "空"
      }），MA5 不可用`,
    };
  const end = snapshotDate && dateIdx.has(snapshotDate)
    ? dateIdx.get(snapshotDate)
    : dates.length - 1;
  if (end < 4) return { ma5ByCode: new Map(), asOf: dates[end] ?? null };
  const asOf = dates[end];
  const ma5ByCode = new Map();
  for (const [code, s] of codes) {
    // 快照日必须有收盘（停牌 / 退市股不产出 MA5）
    const p = lowerBound(s.dates, end);
    if (p < 0 || p < 4) continue;
    // 复权口径判定（严格，不静默混用）：
    //   - 窗口 5 根因子齐全 → 前复权到 asOf；
    //   - 整股在因子文件中完全无覆盖（hasFactor=false）→ 未复权口径
    //     （一致基准：该股所有日期都无因子，不存在跨除权混算）；
    //   - 该股有因子但窗口内任一根缺失（典型：因子更新滞后于日线，
    //     恰逢除权窗口）→ 口径不明确，不产出 MA5。
    let missing = 0;
    for (let k = p - 4; k <= p; k++) {
      const f = s.adjs[k];
      if (!Number.isFinite(f) || f <= 0) missing++;
    }
    if (s.hasFactor && missing > 0) continue; // 口径不明确，标记不可用
    let sum = 0;
    if (s.hasFactor) {
      const fEnd = s.adjs[p];
      for (let k = p - 4; k <= p; k++)
        sum += (s.closes[k] * s.adjs[k]) / fEnd;
    } else {
      for (let k = p - 4; k <= p; k++) sum += s.closes[k];
    }
    ma5ByCode.set(code, Math.round((sum / 5) * 1000) / 1000);
  }
  return { ma5ByCode, asOf };
}

// ---------- 对外 API ----------

// 返回 { ma5ByCode: Map<code, number>, asOf: string|null, reason?: string }。
// 任何失败都降级为空 Map，不抛错——调用方无需 try/catch。
export async function getMa5ByCode(env, snapshotDate) {
  const dataDir = dailyDataDir(env);
  if (!dataDir)
    return {
      ma5ByCode: new Map(),
      asOf: null,
      reason: "未配置 QUAN_DATA_DIR，MA5 不可用（首阴买点将不触发）",
    };
  try {
    const dataset = await loadDailyDataset(dataDir);
    return computeMa5ByCode(dataset, snapshotDate);
  } catch (error) {
    return {
      ma5ByCode: new Map(),
      asOf: null,
      reason: `日线数据读取失败：${safeError(error)}`,
    };
  }
}
