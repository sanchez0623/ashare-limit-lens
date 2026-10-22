import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  computeMa5ByCode,
  computeStockFeaturesByCode,
  computeExitEodRowsByCode,
  getMa5ByCode,
} from "../backend/services/daily-closes.js";
import { analyze, normalize } from "../shared/scoring.js";

// 合成数据集：dates 全局交易日，perCode 为 [date, close, adj?, high?, low?, volume?] 序列。
// volume 缺省 NaN（夹具不带 volume 列时）；显式传入 null/undefined 表示"空成交量"
// （复现 Parquet 缺失值），显式传数字则按未复权量写入。
function makeDataset(dates, perCode) {
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const codes = new Map();
  for (const [code, series] of perCode) {
    const n = series.length;
    const ds = new Uint32Array(n);
    const cs = new Float64Array(n);
    const hs = new Float64Array(n).fill(Number.NaN);
    const ls = new Float64Array(n).fill(Number.NaN);
    const vs = new Float64Array(n).fill(Number.NaN);
    const os = new Float64Array(n).fill(Number.NaN);
    const as = new Float64Array(n).fill(Number.NaN);
    let hasFactor = false;
    series.forEach(([d, c, a, h, l, v], k) => {
      ds[k] = dateIdx.get(d);
      cs[k] = c;
      if (a !== undefined) {
        as[k] = a;
        hasFactor = true;
      }
      if (h !== undefined) hs[k] = h;
      if (l !== undefined) ls[k] = l;
      if (v === null || v === undefined) vs[k] = Number.NaN;
      else if (Number.isFinite(v)) vs[k] = v;
    });
    codes.set(code, {
      dates: ds,
      closes: cs,
      opens: os,
      highs: hs,
      lows: ls,
      volumes: vs,
      adjs: as,
      hasFactor,
    });
  }
  return { dates, dateIdx, codes };
}

const DATES = [
  "2026-10-08",
  "2026-10-09",
  "2026-10-10",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
];

test("MA5：最近 5 个交易日（含 asOf）的收盘均值", () => {
  const dataset = makeDataset(DATES, [
    ["600001", DATES.map((d) => [d, 10, 1])],
  ]);
  const { ma5ByCode, asOf } = computeMa5ByCode(dataset, "2026-10-14");
  assert.equal(asOf, "2026-10-14");
  assert.equal(ma5ByCode.get("600001"), 10);
});

test("MA5：快照日早于数据末日时取 ≤ 快照日的窗口", () => {
  const dataset = makeDataset(DATES, [
    ["600001", DATES.map((d, i) => [d, 10 + i, 1])],
  ]);
  const { ma5ByCode, asOf } = computeMa5ByCode(dataset, "2026-10-10");
  assert.equal(asOf, "2026-10-10");
  // 窗口 D1..D3 只有 3 根 → 不足 5 根，不产出
  assert.equal(ma5ByCode.size, 0);
});

test("MA5：前复权——窗口内除权，因子对齐到 asOf", () => {
  // D4 除权：价格 10 → 5，因子 1 → 2。前复权到 D6 后全窗都是 5。
  const series = DATES.map((d, i) => [d, i < 3 ? 10 : 5, i < 3 ? 1 : 2]);
  const dataset = makeDataset(DATES, [["600001", series]]);
  const { ma5ByCode } = computeMa5ByCode(dataset, "2026-10-14");
  assert.equal(ma5ByCode.get("600001"), 5);
});

test("MA5：整股完全无因子（数据源未覆盖）时退回未复权口径", () => {
  // 同上价格路径但整股无因子：未复权 MA5 = (10+10+5+5+5)/5 = 7（一致基准）
  const series = DATES.map((d, i) => [d, i < 3 ? 10 : 5]);
  const dataset = makeDataset(DATES, [["600001", series]]);
  const { ma5ByCode } = computeMa5ByCode(dataset, "2026-10-14");
  assert.equal(ma5ByCode.get("600001"), 7);
});

test("MA5：窗口内复权因子部分缺失时不产出（口径不明确，不静默混用）", () => {
  // D4 除权（价格 10→5），但因子文件只覆盖 D6 一天：前 4 根因子缺失。
  // 若静默混用会得到 (10+10+10+5+5)/5 = 8 的无意义混合口径，直接排除。
  const series = DATES.map((d, i) => [
    d,
    i < 3 ? 10 : 5,
    i === 5 ? 2 : undefined,
  ]);
  const dataset = makeDataset(DATES, [["600001", series]]);
  const { ma5ByCode } = computeMa5ByCode(dataset, "2026-10-14");
  assert.equal(ma5ByCode.size, 0);
});

test("MA5：整股有因子但窗口内全部缺失（因子滞后于日线）时不产出", () => {
  // 复现：D1 有因子、窗口 D2–D6 全缺。若回退未复权，跨除权窗口会得到
  // (10+10+5+5+5)/5 = 7（应答 10），口径不明 → 排除。
  const series = DATES.map((d, i) => [
    d,
    i < 3 ? 10 : 5,
    i === 0 ? 1 : undefined,
  ]);
  const dataset = makeDataset(DATES, [["600001", series]]);
  const { ma5ByCode } = computeMa5ByCode(dataset, "2026-10-14");
  assert.equal(ma5ByCode.size, 0);
});

test("MA5：快照日无收盘（停牌）与不足 5 根 K 线的股票不产出", () => {
  const dataset = makeDataset(DATES, [
    ["600001", DATES.slice(0, 5).map((d) => [d, 10, 1])], // D6 停牌
    ["600002", DATES.slice(3).map((d) => [d, 10, 1])], // 仅 3 根
  ]);
  const { ma5ByCode } = computeMa5ByCode(dataset, "2026-10-14");
  assert.equal(ma5ByCode.size, 0);
});

test("MA5：快照日晚于数据截止（数据滞后）时返回空并说明原因，不拿旧 MA5 当当日", () => {
  const dataset = makeDataset(DATES, [
    ["600001", DATES.map((d) => [d, 10, 1])],
  ]);
  const { ma5ByCode, asOf, reason } = computeMa5ByCode(dataset, "2026-10-15");
  assert.equal(ma5ByCode.size, 0);
  assert.equal(asOf, "2026-10-14"); // 数据实际截止日，供诊断
  assert.match(reason, /未覆盖快照日 2026-10-15/);
});

test("MA5：快照日早于数据起点时返回空（数据未覆盖快照日）", () => {
  const dataset = makeDataset(DATES, [
    ["600001", DATES.map((d) => [d, 10, 1])],
  ]);
  const { ma5ByCode, asOf, reason } = computeMa5ByCode(dataset, "2026-01-01");
  assert.equal(ma5ByCode.size, 0);
  assert.equal(asOf, "2026-10-14"); // 数据截止日，供诊断
  assert.match(reason, /未覆盖快照日 2026-01-01/);
});

// ---------- analyze() ma5 注入 ----------

const RAW = {
  c: "600001",
  n: "测试股",
  hybk: "测试板块",
  p: 9500,
  o: 10000,
  h: 10000,
  zdp: -3,
  amount: 1e8,
  ltsz: 1e9,
  fund: null,
  hs: 3,
  fbt: null,
  lbt: null,
  zbc: 0,
  lbc: 0,
  zttj: { days: 3, ct: 2 },
};
const PREV = {
  ...RAW,
  p: 9900,
  o: 9000,
  zdp: 9.9,
  lbc: 3, // 昨日 3 连板（首阴门槛与 skill 对齐：>=3）
};

test("analyze 注入 ma5ByCode（普通对象与 Map 皆可）", () => {
  const rows = [normalize(RAW)];
  const previous = [normalize(PREV)];
  const withObject = analyze(rows, null, previous, undefined, {
    ma5ByCode: { 600001: 9 },
  });
  assert.equal(withObject.stocks[0].ma5, 9);
  const withMap = analyze(rows, null, previous, undefined, {
    ma5ByCode: new Map([["600001", 9]]),
  });
  assert.equal(withMap.stocks[0].ma5, 9);
  const without = analyze(rows, null, previous);
  assert.equal(without.stocks[0].ma5, undefined);
});

test("MA5 注入后首阴买点在真实 analyze 链路激活（3 连板后首阴、未破 5 日线）", () => {
  const rows = [normalize(RAW)];
  const previous = [normalize(PREV)];
  const result = analyze(rows, null, previous, undefined, {
    ma5ByCode: { 600001: 9 },
  });
  assert.equal(result.stocks[0].buyPoint.primary?.type, "first-neg-dip");
  // MA5 未知 → 首阴拒绝（宁缺毋滥）
  const noMa5 = analyze(rows, null, previous);
  assert.notEqual(noMa5.stocks[0].buyPoint.primary?.type, "first-neg-dip");
});

// ---------- 股票分类历史特征 ----------

const F25 = Array.from(
  { length: 25 },
  (_, i) => `2026-09-${String(1 + i).padStart(2, "0")}`,
);

test("特征：近10日涨停基因（收盘比口径，boardLimit 感知）", () => {
  // 主板：D15 从 10 → 11（+10%），快照 D20 时落在近 10 日内
  const series = F25.map((d, i) => [d, i === 14 ? 11 : 10, 1, 11, 9.8]);
  const dataset = makeDataset(F25, [["600001", series]]);
  const inWindow = computeStockFeaturesByCode(dataset, F25[19]);
  assert.equal(inWindow.featuresByCode.get("600001").limitUp10d, true);
  // 快照 D25：D15 已在 10 日窗口外（D16–D25）→ 无涨停基因
  const outWindow = computeStockFeaturesByCode(dataset, F25[24]);
  assert.equal(outWindow.featuresByCode.get("600001").limitUp10d, false);
});

test("特征：20% 板（300 开头）按 19.7% 阈值识别涨停", () => {
  const series = F25.map((d, i) => [d, i === 20 ? 12 : 10, 1, 12, 9.8]);
  const dataset = makeDataset(F25, [["300001", series]]);
  const { featuresByCode } = computeStockFeaturesByCode(dataset, F25[24]);
  // +20% 对 20% 板算涨停；若误用 10% 板口径则 +20% 也算，无法区分——
  // 反向验证：主板 600001 同样 +20% 涨幅在 10% 板口径下仍算涨停，
  // 而 +15%（主板不算、20% 板也不算涨停）不触发。
  assert.equal(featuresByCode.get("300001").limitUp10d, true);
  const main = F25.map((d, i) => [d, i === 20 ? 11.5 : 10, 1, 11.5, 9.8]);
  const mainData = makeDataset(F25, [["600001", main]]);
  // +15% 对主板涨停（>=9.7）成立——构造 +9% 的不触发样本更有意义
  const flat = F25.map((d, i) => [d, i === 20 ? 10.9 : 10, 1, 10.9, 9.8]);
  const flatData = makeDataset(F25, [["300001", flat]]);
  // 300xxx +9%：20% 板阈值 19.7 → 不算涨停
  assert.equal(
    computeStockFeaturesByCode(flatData, F25[24]).featuresByCode.get("300001")
      .limitUp10d,
    false,
  );
  void mainData;
});

test("特征：MA20 与 20 日区间振幅，不足 20 根为 null", () => {
  const series = F25.map((d, i) => [d, 10, 1, i === 24 ? 12 : 11, 10]);
  const dataset = makeDataset(F25, [["600001", series]]);
  const full = computeStockFeaturesByCode(dataset, F25[24]);
  const f = full.featuresByCode.get("600001");
  assert.equal(f.ma20, 10);
  // maxHigh = 12（末日），minLow = 10 → 振幅 20%
  assert.equal(f.amplitude20, 20);
  const short = computeStockFeaturesByCode(dataset, F25[14]); // 仅 15 根
  assert.equal(short.featuresByCode.get("600001").ma20, null);
  assert.equal(short.featuresByCode.get("600001").amplitude20, null);
});

test("特征：窗口内 high/low 缺失（NaN）时振幅未知", () => {
  const series = F25.map((d, i) => [d, 10, 1, i === 10 ? Number.NaN : 11, 10]);
  const dataset = makeDataset(F25, [["600001", series]]);
  const { featuresByCode } = computeStockFeaturesByCode(dataset, F25[24]);
  assert.equal(featuresByCode.get("600001").amplitude20, null);
  assert.equal(featuresByCode.get("600001").ma20, 10);
});

test("特征：跨除权窗口按快照日前复权，MA20/振幅不受除权跳空失真", () => {
  // D15 除权：价格 10 → 5（腰斩），因子 1 → 2。前复权到快照日（f=2）后
  // 全窗价格连续为 5：未复权 MA20 = (10×15+5×5)/20 = 8.75（失真），
  // 复权 MA20 = 5；未复权振幅 (11-4.5)/4.5 ≈ 144%，复权 (5.5-4.5)/4.5 ≈ 22%。
  const series = F25.map((d, i) =>
    i < 15 ? [d, 10, 1, 11, 9] : [d, 5, 2, 5.5, 4.5],
  );
  const dataset = makeDataset(F25, [["600001", series]]);
  const { featuresByCode } = computeStockFeaturesByCode(dataset, F25[24]);
  const f = featuresByCode.get("600001");
  assert.equal(f.ma20, 5);
  assert.equal(f.amplitude20, 22.22);
});

test("特征：有因子覆盖但 MA20 窗口内因子缺失 → 特征 null（口径不明确）", () => {
  // 同上跨除权构造，但除权日（D15）因子缺失：MA20/振幅口径不明确 → null；
  // 涨停基因窗口（D16–D25）因子齐全 → 不受影响。
  const series = F25.map((d, i) =>
    i < 15 ? [d, 10, 1, 11, 9] : [d, 5, i === 15 ? undefined : 2, 5.5, 4.5],
  );
  const dataset = makeDataset(F25, [["600001", series]]);
  const { featuresByCode } = computeStockFeaturesByCode(dataset, F25[24]);
  const f = featuresByCode.get("600001");
  assert.equal(f.ma20, null);
  assert.equal(f.amplitude20, null);
});

test("特征：数据未覆盖快照日 → 空 Map + reason", () => {
  const series = F25.map((d) => [d, 10, 1, 11, 10]);
  const dataset = makeDataset(F25, [["600001", series]]);
  const { featuresByCode, asOf, reason } = computeStockFeaturesByCode(
    dataset,
    "2026-10-15",
  );
  assert.equal(featuresByCode.size, 0);
  assert.equal(asOf, F25[24]);
  assert.match(reason, /未覆盖快照日 2026-10-15/);
});

test("特征：停牌股（快照日无收盘）不产出特征", () => {
  const dataset = makeDataset(F25, [
    ["600001", F25.slice(0, 20).map((d) => [d, 10, 1, 11, 10])],
  ]);
  const { featuresByCode } = computeStockFeaturesByCode(dataset, F25[24]);
  assert.equal(featuresByCode.has("600001"), false);
});

// ---------- 优雅降级 ----------

test("未配置 QUAN_DATA_DIR 时返回空 Map 并说明原因", async () => {
  const saved = process.env.QUAN_DATA_DIR;
  delete process.env.QUAN_DATA_DIR;
  try {
    const result = await getMa5ByCode({}, "2026-10-14");
    assert.equal(result.ma5ByCode.size, 0);
    assert.equal(result.asOf, null);
    assert.match(result.reason, /QUAN_DATA_DIR/);
  } finally {
    if (saved !== undefined) process.env.QUAN_DATA_DIR = saved;
  }
});

// ---------- 成交量缺失值保护（P2-4） ----------

test("特征：历史均量窗口内任一空 volume → vol20Avg 未知，当日量保持独立", () => {
  // 复现 Parquet 实测：前 19 根中任一缺失被当成 0，均量被压低（94.74），
  // 当日量 145 被误判为放量滞涨。修复后：缺值则 vol20Avg=null，不参与均值。
  const series = F25.map((d, i) => {
    // D5..D23（p=24 的前 19 根：k=5..23）全部 100；D10 故意空（null）
    const v = i === 10 ? null : 100;
    return [d, 10, 1, 11, 9, v];
  });
  // 当日 D25 量 145（无空值）
  series[24] = [F25[24], 10, 1, 11, 9, 145];
  const dataset = makeDataset(F25, [["600001", series]]);
  const { featuresByCode } = computeStockFeaturesByCode(dataset, F25[24]);
  const f = featuresByCode.get("600001");
  assert.equal(f.vol20Avg, null, "窗口内任一 volume 空 → 均量未知");
  assert.equal(f.todayVolume, 145, "当日 volume 独立读取，不被窗口污染");
});

test("特征：前 19 根 volume 全部有效 → vol20Avg 为窗口均值，当日量如实返回", () => {
  const series = F25.map((d) => [d, 10, 1, 11, 9, 100]);
  series[24] = [F25[24], 10, 1, 11, 9, 145];
  const dataset = makeDataset(F25, [["600001", series]]);
  const { featuresByCode } = computeStockFeaturesByCode(dataset, F25[24]);
  const f = featuresByCode.get("600001");
  // 前 19 根（D5..D23）均为 100
  assert.equal(f.vol20Avg, 100);
  assert.equal(f.todayVolume, 145);
});

// ---------- EOD 行涨幅口径（P2：无因子股票 change 恒 null） ----------

test("EOD 行：无因子覆盖的股票按未复权价计算涨幅（修复 change 恒 null）", () => {
  // 复现 Parquet 实测：价格 9.9 → 10、量 100 → 200。修复前
  // hasFactor=false 仍要求昨日因子有效 → change 恒 null → 放量滞涨
  // 漏检，仍做正向 T。修复后无因子分支按一致未复权口径计算。
  const series = F25.map((d, i) => [
    d,
    i === 24 ? 10 : 9.9, // 昨收 9.9，今收 10
    undefined, // 整股无因子覆盖
    10.2,
    9.8,
    i === 24 ? 200 : 100,
  ]);
  const dataset = makeDataset(F25, [["600001", series]]);
  const { rowsByCode } = computeExitEodRowsByCode(dataset, F25[24]);
  const row = rowsByCode.get("600001");
  assert.ok(row, "应产出 EOD 行");
  assert.equal(row.close, 10);
  assert.ok(
    Math.abs(row.change - 1.01) < 1e-9,
    `涨幅应按未复权价计算为 1.01%，实际 ${row.change}`,
  );
  assert.equal(row.volume, 200);
  assert.equal(row.limitUpPct, 10);
});

test("EOD 行：有因子但昨日因子缺失 → change 保持未知（口径不明确不猜）", () => {
  const series = F25.map((d, i) => [
    d,
    10,
    i === 24 ? 1 : undefined, // 仅快照日有因子，昨日缺失
    10.2,
    9.8,
    100,
  ]);
  const dataset = makeDataset(F25, [["600001", series]]);
  const { rowsByCode } = computeExitEodRowsByCode(dataset, F25[24]);
  const row = rowsByCode.get("600001");
  assert.ok(row);
  assert.equal(row.change, null, "因子口径不明确时涨幅保持未知");
});

test("数据目录存在时烟雾测试（读取真实 parquet）", async (t) => {
  let dir = process.env.QUAN_DATA_DIR;
  if (!dir) {
    try {
      const config = parseEnv(
        await readFile(new URL("../.env", import.meta.url), "utf8"),
      );
      dir = config.QUAN_DATA_DIR;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!dir)
    return t.skip(
      "进程环境和 .env 均未配置 QUAN_DATA_DIR，跳过真实数据烟雾测试",
    );
  // 将本地配置仅传给真实数据检查，避免其他合成数据用例读取本机行情。
  const result = await getMa5ByCode({ QUAN_DATA_DIR: dir }, "2026-10-13");
  assert.ok(result.ma5ByCode.size > 0, `应产出 MA5：${result.reason ?? ""}`);
  assert.ok(result.asOf, "应解析出 asOf 交易日");
  // 抽查任一产出代码的 MA5 为有限正值。
  const [code, ma5] = [...result.ma5ByCode.entries()][0];
  assert.ok(
    Number.isFinite(ma5) && ma5 > 0,
    `${code} 应有有限 MA5，实际 ${ma5}`,
  );
});
