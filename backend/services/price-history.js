import { getPricesHistorical } from "./fuyao.js";
import {
  dailyDataDir,
  loadDailyDataset,
  computeMa5ByCode,
  computeStockFeaturesByCode,
  computeEodRowsWithPrev,
} from "./daily-closes.js";
import { digestOf } from "../domain/research-lineage.js";
import { OBSERVATION_SCHEDULE } from "../../shared/observation-schedule.js";

export const PRICE_HISTORY_VERSION = "fuyao-daily-v1";
// Historical research reuses validation without the live acquisition clock or cache writes.
export {
  cleanBars as cleanPriceHistoryBars,
  validateRecord as validatePriceHistoryRecord,
};
const positive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
const dayOf = (n) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(n));
const failures = new Map();
const inFlight = new WeakMap();

function cleanBars(items, date) {
  if (!Array.isArray(items)) throw new Error("历史日线格式无效");
  const seen = new Set();
  return items
    .map((r) => {
      if (!Number.isFinite(r.date_ms) || r.date_ms <= 0)
        throw new Error("日线日期无效");
      const day = dayOf(r.date_ms);
      if (
        day > date ||
        seen.has(day) ||
        ![r.open_price, r.high_price, r.low_price, r.close_price].every(
          positive,
        ) ||
        r.high_price < Math.max(r.open_price, r.close_price) ||
        r.low_price > Math.min(r.open_price, r.close_price) ||
        !Number.isFinite(r.volume) ||
        r.volume < 0 ||
        !Number.isFinite(r.turnover) ||
        r.turnover < 0
      )
        throw new Error("日线日期、价格或量额无效");
      seen.add(day);
      return {
        date: day,
        open: r.open_price,
        high: r.high_price,
        low: r.low_price,
        close: r.close_price,
        volume: r.volume,
        amount: r.turnover,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function validateRecord(record, date, code) {
  if (
    record.version !== PRICE_HISTORY_VERSION ||
    record.asOf !== date ||
    record.code !== code ||
    record.raw?.length < 5 ||
    record.raw?.length !== record.adjusted?.length ||
    record.raw.at(-1)?.date !== date ||
    !Number.isFinite(Date.parse(record.observedAt))
  )
    throw new Error("历史输入缺少信号日或复权配对");
  record.raw.forEach((r, i) => {
    const a = record.adjusted[i];
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
      r.date > date ||
      r.date !== a.date ||
      (i && r.date <= record.raw[i - 1].date) ||
      ![r.open, r.high, r.low, r.close, a.open, a.high, a.low, a.close].every(
        positive,
      ) ||
      r.high < Math.max(r.open, r.close) ||
      r.low > Math.min(r.open, r.close) ||
      !Number.isFinite(r.volume) ||
      r.volume < 0 ||
      !Number.isFinite(r.amount) ||
      r.amount < 0
    )
      throw new Error("冻结日线输入无效");
    const ratio = a.close / r.close;
    if (
      ["open", "high", "low"].some(
        (k) => Math.abs(a[k] - r[k] * ratio) > Math.max(0.011, a[k] * 0.002),
      )
    )
      throw new Error("复权序列口径不一致");
  });
  return record;
}

export function datasetFromPriceRecords(records, date, calendarDates = []) {
  const dates = [
    ...new Set([
      ...calendarDates.filter((d) => d <= date),
      ...records.flatMap((r) => r.raw.map((b) => b.date)),
    ]),
  ].sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const codes = new Map();
  for (const record of records) {
    validateRecord(record, date, record.code);
    const raw = record.raw;
    codes.set(record.code, {
      dates: new Uint32Array(raw.map((b) => dateIdx.get(b.date))),
      opens: new Float64Array(raw.map((b) => b.open)),
      highs: new Float64Array(raw.map((b) => b.high)),
      lows: new Float64Array(raw.map((b) => b.low)),
      closes: new Float64Array(raw.map((b) => b.close)),
      volumes: new Float64Array(raw.map((b) => b.volume)),
      amounts: new Float64Array(raw.map((b) => b.amount)),
      adjs: new Float64Array(
        raw.map((b, i) => record.adjusted[i].close / b.close),
      ),
      hasFactor: true,
    });
  }
  return { dates, dateIdx, codes };
}

async function cachedRecord(env, date, code) {
  if (!env.DB) return null;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?")
    .bind(`${PRICE_HISTORY_VERSION}:${date}:${code}`)
    .first();
  if (!row) return null;
  const { record, digest } = JSON.parse(row.value);
  if ((await digestOf(record)) !== digest)
    throw new Error("历史缓存摘要不一致");
  return validateRecord(record, date, code);
}

async function acquireRecord(env, date, code, history, now, timeoutMs) {
  const existing = await cachedRecord(env, date, code);
  if (existing) return existing;
  const end = Date.parse(`${date}T23:59:59+08:00`);
  const start = Date.parse(`${date}T00:00:00+08:00`) - 75 * 86400000;
  const thscode = `${code}.${code.startsWith("6") ? "SH" : "SZ"}`;
  const responses = [];
  for (const adjust of ["none", "forward"]) {
    const result = await history(thscode, {
      start,
      end,
      adjust,
      timeoutMs,
      retries: 0,
    });
    if (
      result.unavailable ||
      (result.thscode && result.thscode !== thscode) ||
      (result.interval && result.interval !== "1d") ||
      (result.adjust && result.adjust !== adjust)
    )
      throw new Error("历史接口返回标的或周期不一致");
    responses.push({
      timestamp: result.timestamp,
      bars: cleanBars(result.item, date),
    });
  }
  const record = validateRecord(
    {
      version: PRICE_HISTORY_VERSION,
      source: "fuyao-prices-historical",
      code,
      asOf: date,
      observedAt: new Date().toISOString(),
      adjustment: "paired-none-forward-rebased-to-signal-day",
      upstreamReadyAt: responses.map((r) => r.timestamp ?? null),
      raw: responses[0].bars,
      adjusted: responses[1].bars,
    },
    date,
    code,
  );
  if (env.DB) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)",
    )
      .bind(
        `${PRICE_HISTORY_VERSION}:${date}:${code}`,
        JSON.stringify({ record, digest: await digestOf(record) }),
      )
      .run();
    return cachedRecord(env, date, code);
  }
  return record;
}

// 本地数据优先。远端仅用于当前盘后或下次开盘前的冻结准备，不在历史重放时追取。
export async function resolveDailyPriceInputs(
  env,
  date,
  {
    rows = [],
    codes = [],
    frozenInputs = null,
    history = getPricesHistorical,
    now = new Date(),
    localDataset,
    maxCodes = Number.POSITIVE_INFINITY,
    deadlineMs = 45000,
    allowRemote = true,
  } = {},
) {
  const scope = env.DB ?? env;
  const key = `${date}:${allowRemote}:${maxCodes}:${[...new Set([...codes, ...rows.map((r) => r.code ?? r.c)])].sort().join(",")}`;
  if (!frozenInputs && history === getPricesHistorical) {
    let pending = inFlight.get(scope);
    if (!pending) inFlight.set(scope, (pending = new Map()));
    if (pending.has(key)) return pending.get(key);
    const work = resolveInputs(env, date, {
      rows,
      codes,
      history,
      now,
      localDataset,
      maxCodes,
      deadlineMs,
      allowRemote,
    });
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  }
  return resolveInputs(env, date, {
    rows,
    codes,
    history,
    now,
    localDataset,
    maxCodes,
    deadlineMs,
    frozenInputs,
    allowRemote,
  });
}

async function resolveInputs(env, date, options) {
  const { rows, codes, history, now, maxCodes, deadlineMs, frozenInputs } =
    options;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("历史信号日无效");
  let local = options.localDataset;
  if (local === undefined) {
    try {
      local = dailyDataDir(env)
        ? await loadDailyDataset(dailyDataDir(env))
        : null;
    } catch {
      local = null;
    }
  }
  const datasets = local ? [local] : [];
  const ma5ByCode = local ? computeMa5ByCode(local, date).ma5ByCode : new Map();
  const featuresByCode = local
    ? computeStockFeaturesByCode(local, date).featuresByCode
    : new Map();
  const eodRows = local
    ? computeEodRowsWithPrev(local, date).rowsByCode
    : new Map();
  // 正确保留池内代码、前日强势股和持仓；远端回补不枚举全市场。
  const requestedAll = [
    ...new Set([...codes, ...rows.map((r) => r.code ?? r.c)]),
  ]
    .filter((c) => /^(00|30|60)\d{4}$/.test(c))
    .filter(
      (c) =>
        !ma5ByCode.has(c) ||
        !eodRows.has(c) ||
        featuresByCode.get(c)?.ma20 == null,
    );
  // This is a per-request work budget, not a universe limit. Read every cached
  // record first so later attempts advance past a completed batch.
  const requested = requestedAll.sort();
  const records = [],
    errors = new Set();
  let rateLimited = false;
  const clockTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const today = dayOf(now.getTime());
  const canFetch =
    (date === today && clockTime >= "15:05") ||
    (date < today &&
      clockTime < OBSERVATION_SCHEDULE.preparationEnd.slice(0, 5) &&
      now.getTime() - Date.parse(`${date}T00:00:00+08:00`) < 15 * 86400000);
  if (frozenInputs) {
    if (
      frozenInputs.version !== PRICE_HISTORY_VERSION ||
      frozenInputs.asOf !== date
    )
      throw new Error("冻结历史日期或版本不一致");
    for (const r of frozenInputs.records ?? []) {
      if ((await digestOf(r.record)) !== r.digest)
        throw new Error("冻结历史摘要不一致");
      records.push(validateRecord(r.record, date, r.record.code));
    }
  } else if (
    options.allowRemote &&
    canFetch &&
    (history !== getPricesHistorical || process.env.FU_YAO_API_KEY)
  ) {
    const uncached = [];
    for (const code of requested) {
      try {
        const cached = await cachedRecord(env, date, code);
        if (cached) records.push(cached);
        else uncached.push(code);
      } catch {
        errors.add(code);
      }
    }
    const started = Date.now();
    let cursor = 0,
      attempted = 0;
    const worker = async () => {
      while (cursor < uncached.length && !rateLimited) {
        if (Date.now() - started >= deadlineMs || attempted >= maxCodes) return;
        const code = uncached[cursor++];
        const failKey = `${date}:${code}`;
        if (
          history === getPricesHistorical &&
          Date.now() - (failures.get(failKey) ?? 0) < 60000
        ) {
          errors.add(code);
          continue;
        }
        attempted++;
        try {
          const record = await acquireRecord(
            env,
            date,
            code,
            history,
            now,
            Math.max(100, Math.min(4000, deadlineMs - (Date.now() - started))),
          );
          records.push(record);
        } catch (error) {
          if (history === getPricesHistorical)
            failures.set(failKey, Date.now());
          errors.add(code);
          if (/限流|429/.test(error.message)) rateLimited = true;
        }
      }
    };
    await Promise.all([worker(), worker()]);
  } else {
    // 盘中只读已经冻结的原始历史，不获取可能尚未收盘的当日日线。
    for (const code of requested) {
      try {
        const cached = await cachedRecord(env, date, code);
        if (cached) records.push(cached);
      } catch {
        errors.add(code);
      }
    }
  }
  if (records.length) {
    records.sort((a, b) => a.code.localeCompare(b.code));
    const dataset = datasetFromPriceRecords(records, date, local?.dates ?? []);
    datasets.push(dataset);
    for (const [k, v] of computeMa5ByCode(dataset, date).ma5ByCode)
      ma5ByCode.set(k, v);
    for (const [k, v] of computeStockFeaturesByCode(dataset, date)
      .featuresByCode)
      featuresByCode.set(k, v);
    for (const [k, v] of computeEodRowsWithPrev(dataset, date).rowsByCode)
      eodRows.set(k, v);
  }
  const evidence = {
    version: PRICE_HISTORY_VERSION,
    asOf: date,
    records: await Promise.all(
      records.map(async (record) => ({
        record,
        digest: await digestOf(record),
      })),
    ),
  };
  const captured = new Set(records.map((record) => record.code));
  const pendingCodes = requested.filter(
    (code) => !captured.has(code) && !errors.has(code),
  );
  return {
    datasets,
    ma5ByCode,
    featuresByCode,
    eodRows,
    evidence,
    status: {
      source: records.length ? "local-with-fuyao-fallback" : "local",
      requested: requestedAll.length,
      supplemented: records.length,
      failedCodes: [...errors].sort(),
      pendingCodes,
      limited: rateLimited || pendingCodes.length > 0,
      complete: pendingCodes.length === 0 && errors.size === 0,
      localAsOf: local?.dates.at(-1) ?? null,
    },
  };
}

// 昨日池只提供昨日成员/连板信息；其中的现价、涨幅和开盘价不充当昨日 K 线。
export function verifiedPreviousRows(previous, eodRows) {
  return (previous ?? []).map((row) => {
    const eod = eodRows.get(row.code);
    return {
      ...row,
      price: eod?.prevClose ?? null,
      close: eod?.prevClose ?? null,
      open: eod?.prevOpen ?? null,
      high: eod?.prevHigh ?? null,
      change: eod?.prevChange ?? null,
      breaks: eod?.prevBreaks ?? null,
    };
  });
}
