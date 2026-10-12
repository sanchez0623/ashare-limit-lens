import { digestOf } from "./research-lineage.js";

// 共用配对统计（§5.3）：所有成员与两个共同对照使用同一按日期重采样的索引，
// 保留它们之间的相关性；固定种子的循环区块 bootstrap，区块长度 5 日。
// 统计检验计算配对每日对数收益差的单侧下界，不把 T 的两腿当作独立市场日样本。

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedToUint32(hex) {
  const value = BigInt(`0x${hex.slice(0, 8)}`);
  return Number(value & 0xffffffffn) >>> 0;
}

// 生成共享重采样索引矩阵：同一 cohort 内所有成员与两个对照复用。
export async function resampleIndexMatrix({
  dates,
  blockLength,
  resamples,
  seedInput,
}) {
  if (!Array.isArray(dates) || dates.length < 2)
    throw new Error("统计重采样要求至少两个共同市场日");
  if (!Number.isInteger(blockLength) || blockLength < 1)
    throw new Error("统计区块长度无效");
  if (!Number.isInteger(resamples) || resamples < 1)
    throw new Error("统计重采样次数无效");
  const digest = await digestOf(seedInput);
  const random = mulberry32(seedToUint32(digest));
  const n = dates.length;
  const blocksPerResample = Math.ceil(n / blockLength);
  const matrix = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    const indices = new Array(n);
    let cursor = 0;
    for (let b = 0; b < blocksPerResample && cursor < n; b++) {
      const start = Math.floor(random() * n);
      for (let j = 0; j < blockLength && cursor < n; j++) {
        indices[cursor++] = (start + j) % n;
      }
    }
    matrix[r] = indices;
  }
  return { matrix, digest, days: n };
}

// 配对每日对数收益差的单侧下界检验：候选持续优于对照时下界 > 0。
export function pairedLowerBoundTest({
  memberReturns,
  comparisonReturns,
  matrix,
  alphaPerComparison,
}) {
  if (!Array.isArray(memberReturns) || !Array.isArray(comparisonReturns))
    throw new Error("统计检验输入不完整");
  if (memberReturns.length !== comparisonReturns.length)
    throw new Error("候选与对照的每日收益未按共同市场日对齐");
  const n = memberReturns.length;
  if (n < 2)
    return { passed: false, reason: "共同市场日不足，证据不足", pValue: null };
  const diffs = memberReturns.map((value, index) => {
    const member = Math.log(1 + value);
    const comparison = Math.log(1 + comparisonReturns[index]);
    if (!Number.isFinite(member) || !Number.isFinite(comparison))
      throw new Error("每日收益出现非有限值，无法进行统计检验");
    return member - comparison;
  });
  const means = matrix.matrix.map((indices) => {
    let sum = 0;
    for (const index of indices) sum += diffs[index];
    return sum / indices.length;
  });
  means.sort((a, b) => a - b);
  const boundIndex = Math.min(
    means.length - 1,
    Math.max(0, Math.floor(alphaPerComparison * means.length)),
  );
  const lowerBound = means[boundIndex];
  const observed = diffs.reduce((a, b) => a + b, 0) / n;
  return {
    passed: lowerBound > 0,
    lowerBound,
    observedMean: observed,
    alphaPerComparison,
    days: n,
    reason:
      lowerBound > 0
        ? "配对对数收益差的单侧下界大于零"
        : "配对对数收益差的单侧下界不大于零，统计证据不足",
  };
}

// 按账户每日权益序列计算每日简单收益；首日相对期初权益。
export function dailyReturns({ initialEquityCents, equities, dates }) {
  const byDate = new Map(
    equities.map((row) => [row.tradeDate ?? row.trade_date, row.equityCents]),
  );
  return dates.map((date, index) => {
    const equity = byDate.get(date);
    if (equity === undefined)
      throw new Error(`缺少 ${date} 的账户净值，统计输入不完整`);
    const previous =
      index === 0 ? initialEquityCents : byDate.get(dates[index - 1]);
    if (!previous || previous <= 0)
      throw new Error("期初或前一日权益无效，无法计算每日收益");
    return equity / previous - 1;
  });
}

// ---------- 证据诊断扩展（docs/design/statistical-evidence.md §6） ----------
// 诊断方法版本与既有正式方法（pairedLowerBoundTest）严格区分；
// 复用同一 PRNG 与区块基础设施，不另建 bootstrap 模块。

export const DIAGNOSTIC_METHOD_VERSION = "DIAGNOSTIC_BASIC_BLOCK_V1";

// 随机种子由 namespace/purpose/asOf/orderedWindowDates/inputDigest/
// policyDigest/methodVersion 的规范化摘要生成（§6.1）；禁止重跑直到显著。
export async function evidenceSeed({
  namespace,
  purpose,
  asOf,
  orderedWindowDates,
  inputDigest,
  policyDigest,
  methodVersion = DIAGNOSTIC_METHOD_VERSION,
}) {
  return digestOf({
    namespace,
    purpose,
    asOf,
    orderedWindowDates,
    inputDigest,
    policyDigest,
    methodVersion,
  });
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position),
    upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

// buildEvidenceWindow：固定日历与缺口（§5.1）。缺失日期留在窗口里，
// 不向窗口外寻找补位日期；缺口将序列分成连续片段。
// dailyMetrics: Map(date → { ic, excessDecimal, ... } | null)。
export function buildEvidenceWindow({
  expectedDates,
  dailyMetrics,
  horizon,
  contextDigest,
}) {
  if (!Array.isArray(expectedDates) || !expectedDates.length)
    throw new Error("证据窗口需要预冻结的交易日日历");
  if (!(Number.isInteger(horizon) && horizon > 0))
    throw new Error("证据窗口长度无效");
  if (expectedDates.length !== horizon)
    throw new Error("冻结日历长度必须等于窗口长度，不得补长或截短");
  const orderedDates = [...expectedDates].sort();
  const validDates = orderedDates.filter((date) => dailyMetrics.get(date));
  const missingDates = orderedDates.filter((date) => !dailyMetrics.get(date));
  // 缺口把有效日期分成连续片段：片段内的日期在原日历上相邻。
  const segments = [];
  let current = [];
  for (const date of orderedDates) {
    if (dailyMetrics.get(date)) {
      current.push(date);
    } else if (current.length) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  return {
    expectedDates: orderedDates,
    validDates,
    missingDates,
    segments,
    contextDigest: contextDigest ?? null,
    coverage: orderedDates.length ? validDates.length / orderedDates.length : 0,
  };
}

// 片段内循环区块索引矩阵（§5.1）：每个连续片段独立循环区块重采样，
// 保留片段原长度，再按原天数对齐合并；区块从不跨越缺口拼接。
// 任一片段短于区块长度时不输出索引（调用方返回 INCOMPLETE_DATA）。
export async function resampleSegmentIndexMatrix({
  segmentLengths,
  blockLength,
  resamples,
  seedInput,
}) {
  if (
    !Array.isArray(segmentLengths) ||
    !segmentLengths.length ||
    segmentLengths.some((length) => !Number.isInteger(length) || length < 1)
  )
    throw new Error("统计片段长度无效");
  if (!Number.isInteger(blockLength) || blockLength < 1)
    throw new Error("统计区块长度无效");
  if (!Number.isInteger(resamples) || resamples < 1)
    throw new Error("统计重采样次数无效");
  const shortest = Math.min(...segmentLengths);
  if (shortest < blockLength)
    return {
      matrix: null,
      reason: "INCOMPLETE_DATA",
      shortest,
      days: segmentLengths.reduce((a, b) => a + b, 0),
    };
  const digest = await digestOf(seedInput);
  const random = mulberry32(seedToUint32(digest));
  const total = segmentLengths.reduce((a, b) => a + b, 0);
  // 每个片段的起始偏移，用于把片段内局部索引映射回全局日期位置。
  const offsets = [];
  let running = 0;
  for (const length of segmentLengths) {
    offsets.push(running);
    running += length;
  }
  const matrix = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    const indices = new Array(total);
    segmentLengths.forEach((length, segment) => {
      const offset = offsets[segment];
      const blocksPerSegment = Math.ceil(length / blockLength);
      let cursor = 0;
      for (let b = 0; b < blocksPerSegment && cursor < length; b++) {
        const start = Math.floor(random() * length);
        for (let j = 0; j < blockLength && cursor < length; j++) {
          indices[offset + cursor++] = offset + ((start + j) % length);
        }
      }
    });
    matrix[r] = indices;
  }
  return { matrix, digest, days: total };
}

const resampleMeans = (values, matrix) =>
  matrix.map((indices) => {
    let sum = 0;
    for (const index of indices) sum += values[index];
    return sum / indices.length;
  });

// bootstrapMeanEvidence（§6.2/§6.3）：basic bootstrap 双侧区间与居中零假设
// p 值。x0_t = x_t − θ̂（H0: μ=0），以同一合法区块机制得到 θ0*；
// p = (1 + count(|θ0*| ≥ |θ̂|)) / (B + 1)，方向不允许见到负均值后翻转。
export function bootstrapMeanEvidence({
  values,
  indexMatrix,
  confidenceLevel = 0.95,
  nullMean = 0,
  side = "TWO_SIDED",
  minValidDays = 2,
}) {
  if (
    !Array.isArray(values) ||
    values.length < 2 ||
    values.some((value) => !Number.isFinite(value))
  )
    return {
      status: "DEGENERATE",
      estimate: null,
      ci: null,
      pRaw: null,
      standardError: null,
      reasons: ["输入序列缺失或包含非有限值"],
    };
  if (!Array.isArray(indexMatrix) || !indexMatrix.length)
    return {
      status: "DEGENERATE",
      estimate: null,
      ci: null,
      pRaw: null,
      standardError: null,
      reasons: ["重采样索引矩阵缺失"],
    };
  if (values.length < minValidDays)
    return {
      status: "INSUFFICIENT_SAMPLE",
      estimate: values.reduce((a, b) => a + b, 0) / values.length,
      ci: null,
      pRaw: null,
      standardError: null,
      reasons: [`有效天数 ${values.length} 少于最低要求 ${minValidDays}`],
    };
  const n = values.length;
  if (
    indexMatrix.some(
      (indices) => !Array.isArray(indices) || indices.length !== n,
    )
  )
    throw new Error("重采样索引与序列长度不一致");
  const estimate = values.reduce((a, b) => a + b, 0) / n;
  const variance =
    values.reduce((sum, value) => sum + (value - estimate) ** 2, 0) / n;
  // 全部取值相同（含浮点估计残差）视作零方差：不输出区间或 p 值。
  const allIdentical = values.every((value) => value === values[0]);
  if (variance <= 0 || allIdentical)
    return {
      status: "DEGENERATE",
      estimate,
      ci: null,
      pRaw: null,
      standardError: 0,
      reasons: ["序列方差为零，无法给出区间或 p 值"],
    };
  // 居中零假设序列 x0_t = x_t − θ̂ + nullMean；同一索引矩阵重采样。
  const centered = values.map((value) => value - estimate + nullMean);
  const thetaStar = resampleMeans(values, indexMatrix);
  const thetaNull = resampleMeans(centered, indexMatrix);
  const errors = thetaStar.map((mean) => mean - estimate).sort((a, b) => a - b);
  const lowerQuantile = quantile(errors, (1 - confidenceLevel) / 2);
  const upperQuantile = quantile(errors, (1 + confidenceLevel) / 2);
  const ci = {
    level: confidenceLevel,
    lower: estimate - upperQuantile,
    upper: estimate - lowerQuantile,
    scope: "POINTWISE",
  };
  const shift = estimate - nullMean;
  const absShift = Math.abs(shift);
  const exceed = thetaNull.filter(
    (mean) => Math.abs(mean - nullMean) >= absShift,
  ).length;
  let pRaw;
  if (side === "POSITIVE")
    pRaw =
      (1 + thetaNull.filter((mean) => mean - nullMean >= shift).length) /
      (thetaNull.length + 1);
  else if (side === "NEGATIVE")
    pRaw =
      (1 + thetaNull.filter((mean) => mean - nullMean <= shift).length) /
      (thetaNull.length + 1);
  else pRaw = (1 + exceed) / (thetaNull.length + 1);
  const meanStar = thetaStar.reduce((a, b) => a + b, 0) / thetaStar.length;
  const standardError = Math.sqrt(
    thetaStar.reduce((sum, mean) => sum + (mean - meanStar) ** 2, 0) /
      thetaStar.length,
  );
  // 退化重采样：块内全部取到同一取值（无变异）。比例过高不给区间。
  const degenerate = indexMatrix.filter((indices) => {
    let min = Infinity,
      max = -Infinity;
    for (const index of indices) {
      if (values[index] < min) min = values[index];
      if (values[index] > max) max = values[index];
    }
    return min === max;
  }).length;
  return {
    status: "READY",
    estimate,
    ci,
    pRaw,
    standardError,
    resamples: thetaStar.length,
    degenerateResampleRatio: degenerate / indexMatrix.length,
    validDays: n,
  };
}

// adjustEvidenceFamily（§6.4）：当日族 Holm 校正。保留全部预登记假设与
// 原族大小；不可估计的检验在内部排序按 p=1 占名额，外部仍返回 null。
export function adjustEvidenceFamily({
  declaredHypotheses,
  results,
  method = "HOLM",
}) {
  if (method !== "HOLM") throw new Error("未知多重检验方法");
  const familySize = declaredHypotheses.length;
  if (!familySize) throw new Error("检验族为空");
  const byKey = new Map(results.map((row) => [row.key, row]));
  const entries = declaredHypotheses.map((key) => {
    const row = byKey.get(key);
    const estimable = !!row && Number.isFinite(row.pRaw);
    return {
      key,
      estimable,
      // 不可估计在内部排序中占名额（p=1），外部仍返回 null 与原因。
      sortP: estimable ? row.pRaw : 1,
      raw: estimable ? row.pRaw : null,
      reason: estimable ? null : (row?.reason ?? "检验不可估计"),
    };
  });
  const ordered = [...entries]
    .sort((a, b) => a.sortP - b.sortP)
    .map((entry, index) => ({ ...entry, rank: index }));
  let runningMax = 0;
  const adjusted = new Map();
  for (const entry of ordered) {
    const value = Math.min(1, (familySize - entry.rank) * entry.sortP);
    runningMax = Math.max(runningMax, value);
    adjusted.set(entry.key, runningMax);
  }
  return {
    method: "HOLM",
    familySize,
    hypotheses: entries.map((entry) => ({
      key: entry.key,
      estimable: entry.estimable,
      pRaw: entry.raw,
      pAdjustedWithinFamily: entry.estimable ? adjusted.get(entry.key) : null,
      reason: entry.reason,
    })),
  };
}
