// 评分日指标（docs/design/statistical-evidence.md §3.1/§6.1）：
// 冻结样本与 Top 分组下的单日 IC 与观察超额。纯函数：无数据库/网络依赖；
// 收益内核统一小数（0.003 = 0.3 个百分点 = 30bps），单位转换只在 DTO/显示边界。
import { digestOf } from "./research-lineage.js";
import { MIN_SECTOR_COUNT } from "./evidence-policy.js";

// 并列分数取平均秩（与既有 correlation 口径一致）；常数序列返回 null。
export function averageRanks(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const ranks = Array(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i + 1;
    while (j < order.length && order[j].value === order[i].value) j++;
    const average = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) ranks[order[k].index] = average;
    i = j;
  }
  return ranks;
}

export function spearman(xs, ys) {
  if (
    !Array.isArray(xs) ||
    !Array.isArray(ys) ||
    xs.length < 2 ||
    xs.length !== ys.length
  )
    return null;
  const rx = averageRanks(xs),
    ry = averageRanks(ys);
  if (!rx || !ry) return null;
  const mx = rx.reduce((s, v) => s + v, 0) / rx.length,
    my = ry.reduce((s, v) => s + v, 0) / ry.length;
  let numerator = 0,
    dx = 0,
    dy = 0;
  rx.forEach((v, i) => {
    numerator += (v - mx) * (ry[i] - my);
    dx += (v - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  });
  return dx && dy ? numerator / Math.sqrt(dx * dy) : null;
}

// 评分上下文摘要（§5.2）：仅 modelVersion 不足以区分不同权重。
// 变更导致新证据 epoch；跨 epoch 的持续系统诊断另行标记 MIXED_CONTEXT。
export function reviewContextDigest(frozenSnapshot) {
  return digestOf({
    scoring: "rules-v1-frozen-pool",
    modelVersion: frozenSnapshot?.modelVersion ?? null,
    weights: frozenSnapshot?.weights ?? null,
    poolDefinition: "EASTMONEY_ZT_POOL_FROZEN",
    topDefinition: "FROZEN_ORDER_TOP_20PCT",
    sectorRule: "FROZEN_PRIMARY_SECTOR",
    returnMeasure: "PREVIOUS_CLOSE_TO_CLOSE_DECIMAL",
  });
}

// computeDailyReviewMetrics：每个结果日使用上一交易日已经冻结的样本、
// 评分和前 20% 组成员（§3.1）。Top 从原冻结排序确定，不根据今日收益重新
// 挑选，不把失踪高分股用其他股票补齐。
// verifiedOutcomes: [{ code, returnDecimal, available, reason? }]，
// returnDecimal 为昨收至今日收盘的观察收益小数，缺失/无效为 null。
export async function computeDailyReviewMetrics({
  frozenSnapshot,
  verifiedOutcomes,
  policy,
}) {
  if (!frozenSnapshot || !Array.isArray(frozenSnapshot.stocks))
    throw new Error("缺少冻结评分快照");
  if (!Array.isArray(verifiedOutcomes)) throw new Error("缺少已核验结果");
  const outcomesByCode = new Map(
    verifiedOutcomes.map((row) => [row.code, row]),
  );
  const exclusionReasons = {};
  const valid = [];
  for (const stock of frozenSnapshot.stocks) {
    const outcome = outcomesByCode.get(stock.code);
    if (!outcome || !outcome.available) {
      exclusionReasons[stock.code] =
        outcome?.reason ?? "缺少当日已核验行情结果";
      continue;
    }
    const value = outcome.returnDecimal;
    if (!Number.isFinite(value) || value <= -1) {
      exclusionReasons[stock.code] =
        outcome.reason ?? "观察收益非有限或低于 -100%";
      continue;
    }
    valid.push({
      code: stock.code,
      score: stock.score,
      returnDecimal: value,
      sector: stock.sector,
    });
  }
  const expectedStocks = frozenSnapshot.stocks.length;
  const stockCoverage = expectedStocks ? valid.length / expectedStocks : 0;
  // Top 组成员来自冻结排序：快照股票序列的固定前 20%。
  const topSize = Math.max(1, Math.ceil(expectedStocks * 0.2));
  const topCodes = new Set(
    frozenSnapshot.stocks.slice(0, topSize).map((stock) => stock.code),
  );
  const top = valid.filter((stock) => topCodes.has(stock.code));
  const mean = (list) =>
    list.length
      ? list.reduce((sum, row) => sum + row.returnDecimal, 0) / list.length
      : null;
  const allMean = mean(valid);
  const topMean = mean(top);
  const ic = spearman(
    valid.map((row) => row.score),
    valid.map((row) => row.returnDecimal),
  );
  const excess =
    topMean === null || allMean === null ? null : topMean - allMean;
  const reasons = [];
  if (valid.length < policy.minValidStocks)
    reasons.push(
      `有效股票 ${valid.length} 少于最低要求 ${policy.minValidStocks}`,
    );
  if (top.length < policy.minTopStocks)
    reasons.push(
      `有效前组股票 ${top.length} 少于最低要求 ${policy.minTopStocks}`,
    );
  if (stockCoverage < policy.minStockCoverage)
    reasons.push(
      `股票覆盖 ${stockCoverage.toFixed(3)} 低于最低要求 ${policy.minStockCoverage}`,
    );
  if (ic === null) reasons.push("评分或收益序列退化，无法计算秩相关");
  // 板块聚合（§3.2 批次 C）：用事前冻结的板块归属与板块评分，计算板块
  // 评分与板块平均观察收益的每日秩相关，并给出逐板块观察超额。
  // 多概念归属使用冻结主板块（stock.sector），一只股票不会被重复计为
  // 多个独立样本；板块数不足时返回 null 与原因，不虚构秩相关。
  const sectorScores = new Map(
    (Array.isArray(frozenSnapshot.sectors) ? frozenSnapshot.sectors : []).map(
      (sector) => [sector.name, sector.score],
    ),
  );
  const bySector = new Map();
  for (const stock of valid) {
    if (!stock.sector || !sectorScores.has(stock.sector)) continue;
    if (!bySector.has(stock.sector)) bySector.set(stock.sector, []);
    bySector.get(stock.sector).push(stock);
  }
  const sectors = [...bySector.entries()]
    .map(([name, members]) => ({
      name,
      score: sectorScores.get(name),
      meanReturnDecimal: mean(members),
      excessDecimal: allMean === null ? null : mean(members) - allMean,
      validStocks: members.length,
    }))
    .filter(
      (sector) =>
        Number.isFinite(sector.score) &&
        Number.isFinite(sector.meanReturnDecimal),
    );
  const sectorIc =
    sectors.length >= MIN_SECTOR_COUNT
      ? spearman(
          sectors.map((sector) => sector.score),
          sectors.map((sector) => sector.meanReturnDecimal),
        )
      : null;
  // 板块不足不拖垮主指标的单日质量：IC/超额质量门与板块聚合门分开，
  // sectorIc 为 null 时报告端按"板块序列不可估计"如实降级（§3.2）。
  const status = reasons.length ? "INSUFFICIENT_SAMPLE" : "READY";
  return {
    date: frozenSnapshot.resultDate,
    snapshotDate: frozenSnapshot.date,
    contextDigest: await reviewContextDigest(frozenSnapshot),
    values: {
      ic,
      excessDecimal: excess,
      allMeanDecimal: allMean,
      topMeanDecimal: topMean,
      sectorReturnIc: sectorIc,
    },
    quality: {
      expectedStocks,
      validStocks: valid.length,
      topStocks: top.length,
      topSize,
      stockCoverage,
      sectorCount: sectors.length,
    },
    status,
    sectors,
    exclusionReasons,
    reasons,
  };
}
