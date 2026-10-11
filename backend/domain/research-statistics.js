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
