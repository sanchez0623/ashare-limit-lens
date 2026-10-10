import { digestOf } from "./research-lineage.js";

export const PROVENANCE_ORIGINS = {
  HISTORICAL_RECONSTRUCTED: "历史重构（供应商档案）",
  LIVE_ARCHIVED: "实时采集归档",
  UNKNOWN: "来源未知",
};
export const POINT_IN_TIME_CONFIDENCE = {
  ARCHIVED: "归档原始记录",
  SOURCE_REPORTED: "供应商报告",
  INFERRED: "推导估算",
  UNKNOWN: "未知",
};
export const EXECUTION_MODELS = {
  SIX_FACTOR_V1: "六因子完整评分（历史重构）",
  DAILY_OBSERVATION_V1: "日线观察研究（无封板特征）",
};
export const HISTORY_STAGES = {
  PLANNED: "已登记",
  PROBING: "能力探测中",
  DOWNLOADING: "下载中",
  NORMALIZING: "规范化中",
  SCORING: "评分中",
  READY: "数据集就绪",
  PARTIAL: "部分就绪（存在缺失）",
  BLOCKED: "能力不足被阻塞",
  FAILED: "失败",
};
const REQUIRED_LIMIT_FIELDS = [
  "code",
  "name",
  "sector",
  "price",
  "amount",
  "seal",
  "turnover",
  "first",
  "last",
  "breaks",
  "height",
];
export function assessFieldCoverage(
  rows,
  requiredFields = REQUIRED_LIMIT_FIELDS,
) {
  if (!rows.length)
    return { covered: 0, missing: requiredFields, ratio: 0, complete: false };
  const missing = new Map(requiredFields.map((field) => [field, 0]));
  for (const row of rows)
    for (const field of requiredFields)
      if (row[field] === null || row[field] === undefined)
        missing.set(field, missing.get(field) + 1);
  const covered = requiredFields.length * rows.length;
  const holes = [...missing.values()].reduce((a, b) => a + b, 0);
  return {
    covered: covered - holes,
    missing: [...missing.entries()]
      .filter(([, count]) => count > 0)
      .map(([field, count]) => `${field}(${count})`),
    ratio: Math.round(((covered - holes) / covered) * 100),
    complete: holes === 0,
  };
}
export function classifyExecutionModel(coverageRatio, hasLimitFeatures) {
  if (hasLimitFeatures && coverageRatio >= 80) return "SIX_FACTOR_V1";
  return "DAILY_OBSERVATION_V1";
}
function finiteOrThrow(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new Error(`历史输入字段 ${field} 不是有限数值`);
  return number;
}
export function normalizeLimitFeatureRow(
  raw,
  { origin = "HISTORICAL_RECONSTRUCTED", provider = "unknown", fetchedAt } = {},
) {
  if (!raw || typeof raw !== "object") throw new Error("历史涨停特征行无效");
  const code = String(raw.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error("历史涨停特征缺少合法证券代码");
  const breaks =
    raw.breaks === null || raw.breaks === undefined
      ? null
      : finiteOrThrow(raw.breaks, "breaks");
  if (breaks !== null && breaks < 0)
    throw new Error("炸板次数不能为负数（缺失请记为 null，而非 0）");
  const row = {
    code,
    name: String(raw.name ?? "").trim() || null,
    sector: String(raw.sector ?? "").trim() || "未分类",
    price:
      raw.price === null || raw.price === undefined
        ? null
        : finiteOrThrow(raw.price, "price"),
    change:
      raw.change === null || raw.change === undefined
        ? null
        : finiteOrThrow(raw.change, "change"),
    amount:
      raw.amount === null || raw.amount === undefined
        ? null
        : finiteOrThrow(raw.amount, "amount"),
    floatCap:
      raw.floatCap === null || raw.floatCap === undefined
        ? null
        : finiteOrThrow(raw.floatCap, "floatCap"),
    seal:
      raw.seal === null || raw.seal === undefined
        ? null
        : finiteOrThrow(raw.seal, "seal"),
    turnover:
      raw.turnover === null || raw.turnover === undefined
        ? null
        : finiteOrThrow(raw.turnover, "turnover"),
    first:
      raw.first === null || raw.first === undefined
        ? null
        : finiteOrThrow(raw.first, "first"),
    last:
      raw.last === null || raw.last === undefined
        ? null
        : finiteOrThrow(raw.last, "last"),
    breaks,
    height:
      raw.height === null || raw.height === undefined
        ? null
        : finiteOrThrow(raw.height, "height"),
  };
  if (row.price !== null && row.price <= 0)
    throw new Error("历史价格必须为正数");
  const coverage = assessFieldCoverage([row]);
  return {
    row,
    provenance: {
      origin,
      provider,
      providerSchemaVersion: raw.providerSchemaVersion ?? "unknown",
      taxonomyId: raw.taxonomyId ?? null,
      tradeDate: raw.tradeDate ?? null,
      fetchedAt: fetchedAt ?? null,
      effectiveAt: raw.effectiveAt ?? raw.tradeDate ?? null,
      availabilityEstimatedAt: raw.availabilityEstimatedAt ?? null,
      pointInTimeConfidence: raw.pointInTimeConfidence ?? "SOURCE_REPORTED",
      fieldCoverage: coverage,
      note: "缺失字段保持 null，不填 0 或均值凑覆盖",
    },
  };
}
export function normalizeDailyBarRow(raw) {
  if (!raw || typeof raw !== "object") throw new Error("历史日线行无效");
  const code = String(raw.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error("历史日线缺少合法证券代码");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.tradeDate ?? "")))
    throw new Error("历史日线缺少合法交易日期");
  const toCentsFromYuan = (value, field) => {
    if (value === null || value === undefined) return null;
    const cents = Math.round(Number(value) * 100);
    if (!Number.isFinite(cents) || cents <= 0)
      throw new Error(`历史日线字段 ${field} 必须为正数（单位：元）`);
    return cents;
  };
  const row = {
    code,
    tradeDate: String(raw.tradeDate),
    openCents: toCentsFromYuan(raw.openYuan, "openYuan"),
    closeCents: toCentsFromYuan(raw.closeYuan, "closeYuan"),
    highCents: toCentsFromYuan(raw.highYuan, "highYuan"),
    lowCents: toCentsFromYuan(raw.lowYuan, "lowYuan"),
    volumeShares:
      raw.volumeShares === null || raw.volumeShares === undefined
        ? null
        : Math.round(finiteOrThrow(raw.volumeShares, "volumeShares")),
  };
  if (
    row.highCents !== null &&
    row.lowCents !== null &&
    row.highCents < row.lowCents
  )
    throw new Error("历史日线最高价低于最低价");
  return row;
}
export async function buildSampleProvenance({
  origin = "HISTORICAL_RECONSTRUCTED",
  provider,
  providerSchemaVersion = "unknown",
  taxonomyId = null,
  tradeDate,
  fetchedAt,
  pointInTimeConfidence = "SOURCE_REPORTED",
  fieldCoverage,
  rawPayload,
  normalizedPayload,
}) {
  return {
    origin,
    provider,
    providerSchemaVersion,
    taxonomyId,
    tradeDate,
    fetchedAt,
    effectiveAt: tradeDate,
    availabilityEstimatedAt: null,
    pointInTimeConfidence,
    fieldCoverage,
    rawDigest: await digestOf(rawPayload),
    normalizedDigest: await digestOf(normalizedPayload),
  };
}
export function sanitizeMinuteSeries(rows, date) {
  const inSession = [];
  const anomalies = [];
  let previousTime = null;
  for (const row of rows ?? []) {
    const time = String(row?.time ?? "");
    const price = Number(row?.priceCents);
    const volume = Number(row?.volumeShares);
    if (!/^\d{2}:\d{2}$/.test(time)) {
      anomalies.push({ time, reason: "时间格式无效" });
      continue;
    }
    if (time < "09:30" || time > "15:00") {
      anomalies.push({ time, reason: "时段外记录（竞价或盘后）" });
      continue;
    }
    if (time > "11:30" && time < "13:00") {
      anomalies.push({ time, reason: "午休时段记录" });
      continue;
    }
    if (!(price > 0)) {
      anomalies.push({ time, reason: "价格非正数" });
      continue;
    }
    if (previousTime !== null && time <= previousTime) {
      anomalies.push({ time, reason: "时间倒序或重复" });
      continue;
    }
    if (!(volume >= 0) || !Number.isFinite(volume)) {
      anomalies.push({ time, reason: "成交量无效" });
      continue;
    }
    inSession.push({ ...row, time, date });
    previousTime = time;
  }
  return { inSession, anomalies };
}
export function mergeSegmentedDates(segments, { start, end }) {
  const dates = new Set();
  const issues = [];
  for (const segment of segments) {
    for (const date of segment.dates ?? []) {
      if (date < start || date > end) {
        issues.push(`分段 ${segment.requestRange} 返回范围外日期 ${date}`);
        continue;
      }
      dates.add(date);
    }
  }
  const ordered = [...dates].sort();
  return { dates: ordered, issues };
}
