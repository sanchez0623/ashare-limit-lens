// 执行成本内核（docs/design/opening-execution-cost.md §4）：
// 纯函数成本估计、价格取整、累计冲击函数与数量求解。
// 不读数据库、不请求行情或 AI；不修改传入对象，只返回候选状态。
// 试算和 CAS 失败都不消耗真实容量——容量推进只发生在调用方确认成交后。

import {
  EXECUTION_COST_MODEL,
  executionPeriod,
  isOpeningPeriod,
  HARD_PARTICIPATION_CAP,
} from "../../shared/execution-cost.js";

const roundLot = (quantity) => Math.floor(Math.max(0, quantity) / 100) * 100;
const bps = (ratio) => ratio * 10000;

function canonicalIntervalState(state) {
  if (!state || typeof state !== "object") return null;
  return {
    intervalKey:
      typeof state.intervalKey === "string" ? state.intervalKey : null,
    referencePriceCents: Number(state.referencePriceCents) || 0,
    marketVolumeShares: Number(state.marketVolumeShares) || 0,
    consumedShares: Number(state.consumedShares) || 0,
    cumulativeImpactCents: Number(state.cumulativeImpactCents) || 0,
  };
}

// buildExecutionContext：plan 提供事前标志/政策，observation 仅提供当前可用输入。
// 不得从全日 dataset 隐式读取尚未发生的 high/low/volume。
export function buildExecutionContext({
  plan,
  code,
  event,
  quote,
  intervalState,
}) {
  const price = Number(event?.priceCents);
  if (!(price > 0))
    return { supported: false, rejectionReason: "缺少有效观测价格" };
  const state = canonicalIntervalState(intervalState);
  const intervalKey = String(event.intervalKey ?? event.time ?? "");
  const period = executionPeriod(event.time);
  // 日线假设开盘没有可用区间量：只能作为观察模型，不产生可信成交（§4.4）。
  if (event.volumeShares == null)
    return {
      supported: false,
      rejectionReason: "DAILY_OBSERVATION_ONLY",
      detail: "日线假设开盘不产生可信成交，仅保留观察",
    };
  const continued =
    state && state.intervalKey === intervalKey && state.marketVolumeShares > 0;
  // 同股区间状态：新区间以当前观测价冻结锚点；V 只来自真实量差或已完成分钟。
  const referencePriceCents = continued ? state.referencePriceCents : price;
  const marketVolumeShares = continued
    ? state.marketVolumeShares
    : Number(event.volumeShares);
  if (!Number.isFinite(marketVolumeShares))
    return {
      supported: false,
      rejectionReason: "DAILY_OBSERVATION_ONLY",
      detail: "日线假设开盘不产生可信成交，仅保留观察",
    };
  if (marketVolumeShares <= 0)
    return {
      supported: false,
      rejectionReason: "NO_INTERVAL_VOLUME",
      detail: "首帧、零量或缺口区间不新增可成交容量",
    };
  const previousLimitUpCodes = plan?.previousLimitUpCodes;
  const previousLimitUp =
    plan?.previousLimitUpKnown !== false &&
    Array.isArray(previousLimitUpCodes) &&
    previousLimitUpCodes.includes(code);
  // 盘口必须同代码、同日、时间可比、价格为正且非倒挂（§4.1）。
  const bid1 = Number(quote?.bid1Cents),
    ask1 = Number(quote?.ask1Cents);
  const bookUsable =
    Number.isFinite(bid1) &&
    bid1 > 0 &&
    Number.isFinite(ask1) &&
    ask1 > 0 &&
    bid1 <= ask1 &&
    quote?.orderBookQuality !== "INVERTED" &&
    quote?.orderBookQuality !== "MISSING";
  return {
    supported: true,
    intervalKey,
    referencePriceCents,
    marketVolumeShares,
    consumedShares: continued ? state.consumedShares : 0,
    cumulativeImpactCents: continued ? state.cumulativeImpactCents : 0,
    period: period ?? "regular",
    previousLimitUp,
    quality: event.quality ?? "unknown",
    orderBook: bookUsable
      ? { source: "BOOK", bid1Cents: bid1, ask1Cents: ask1 }
      : { source: "FALLBACK", bid1Cents: null, ask1Cents: null },
    orderBookQuality: bookUsable
      ? "OK"
      : (quote?.orderBookQuality ?? "MISSING"),
  };
}

// 累计冲击代理 F(Q) = P0 × Q × κ_eff × (p(Q)/p_ref)^γ / 10000（单位：分）。
// κ_eff 已含数据质量倍数与压力倍数（§4.1：倍数作用于残余项，冲击项是残余项
// 的组成部分）；同一区间内 κ_eff 不变，保证拆单一致的累计成本差（§4.2）。
export function cumulativeImpactCents(
  referencePriceCents,
  marketVolumeShares,
  consumedShares,
  impactBpsEffective,
  referenceParticipation,
  impactExponent,
) {
  if (consumedShares <= 0 || marketVolumeShares <= 0) return 0;
  const participation = consumedShares / marketVolumeShares;
  const relative = participation / referenceParticipation;
  return (
    (referencePriceCents *
      consumedShares *
      impactBpsEffective *
      Math.pow(relative, impactExponent)) /
    10000
  );
}

// estimateExecutionCost：返回 { supported, referencePriceCents, fillPriceCents,
// costBreakdown, nextIntervalState, rejectionReason }（§5.3 契约）。
export function estimateExecutionCost({
  policy,
  context,
  side,
  quantity,
  stressMultiplier,
}) {
  // 情景倍数：显式参数优先，否则使用政策冻结的执行情景值（常规为 1）。
  const stress =
    stressMultiplier ?? policy.payload.executionStressMultiplier ?? 1;
  if (!context?.supported)
    return {
      supported: false,
      rejectionReason: context?.rejectionReason ?? "执行上下文不可用",
    };
  if (!Number.isInteger(quantity) || quantity <= 0)
    return { supported: false, rejectionReason: "数量必须为正整数" };
  if (side !== "BUY" && side !== "SELL")
    return { supported: false, rejectionReason: "方向无效" };
  const p0 = context.referencePriceCents;
  const payload = policy.payload;
  const periodBps =
    payload.periodBaseBps[context.period] ?? payload.periodBaseBps.regular;
  const limitUpBps = context.previousLimitUp
    ? payload.previousLimitUpPremiumBps
    : 0;
  const fallbackSpread = context.orderBook.source === "FALLBACK";
  const floorBps = fallbackSpread ? payload.unknownSpreadFloorBps : 0;
  const qualityMultiplier =
    context.quality === "minute" ? payload.minuteQualityMultiplier : 1;
  // 倍数同时作用于残余项与数量冲击项（冲击项属于残余项，§4.1）。
  const impactBpsEffective =
    payload.impactBpsAtReferenceParticipation * qualityMultiplier * stress;
  const residualBps =
    (periodBps + limitUpBps + floorBps) * qualityMultiplier * stress;
  // 对手盘可用时锚定不利价差；已用对手盘后不再加同一份价差，避免双计。
  const anchorCents =
    side === "BUY"
      ? fallbackSpread
        ? p0
        : Math.max(p0, context.orderBook.ask1Cents)
      : fallbackSpread
        ? p0
        : Math.min(p0, context.orderBook.bid1Cents);
  const spreadBps = fallbackSpread ? 0 : bps(Math.abs(anchorCents - p0) / p0);
  const spreadCostCents = Math.abs(anchorCents - p0) * quantity;
  const residualCostCents = (p0 * quantity * residualBps) / 10000;
  const impactBeforeCents = Math.round(
    cumulativeImpactCents(
      p0,
      context.marketVolumeShares,
      context.consumedShares,
      impactBpsEffective,
      payload.referenceParticipation,
      payload.impactExponent,
    ),
  );
  const impactAfterCents = Math.round(
    cumulativeImpactCents(
      p0,
      context.marketVolumeShares,
      context.consumedShares + quantity,
      impactBpsEffective,
      payload.referenceParticipation,
      payload.impactExponent,
    ),
  );
  const impactCostCents = impactAfterCents - impactBeforeCents;
  const unroundedCostCents =
    spreadCostCents + residualCostCents + impactCostCents;
  const unroundedBps = bps(unroundedCostCents / (p0 * quantity));
  if (unroundedBps > payload.maximumSupportedCostBps)
    return {
      supported: false,
      rejectionReason: "EXECUTION_COST_OUT_OF_DOMAIN",
      detail: `模型成本 ${unroundedBps.toFixed(1)}bps 超过适用域 ${payload.maximumSupportedCostBps}bps；缩量或拒绝，不截成更便宜的成交`,
      costBreakdown: { totalBps: Number(unroundedBps.toFixed(2)) },
    };
  // 买入向上、卖出向下按价格单位取整（§3.1/§4.3）。
  const sideSign = side === "BUY" ? 1 : -1;
  const unroundedFillPrice = p0 + (sideSign * unroundedCostCents) / quantity;
  const fillPriceCents =
    side === "BUY"
      ? Math.ceil(unroundedFillPrice)
      : Math.floor(unroundedFillPrice);
  const impliedCostCents = sideSign * (fillPriceCents - p0) * quantity;
  return {
    supported: true,
    referencePriceCents: p0,
    anchorCents,
    fillPriceCents,
    unroundedFillPriceCents: unroundedFillPrice,
    costBreakdown: {
      modelVersion: EXECUTION_COST_MODEL,
      policyDigest: policy.payloadDigest,
      scenario: stress,
      intervalKey: context.intervalKey,
      period: context.period,
      previousLimitUp: context.previousLimitUp,
      quality: context.quality,
      orderBookSource: context.orderBook.source,
      orderBookQuality: context.orderBookQuality,
      spreadSource: fallbackSpread ? "FALLBACK_FLOOR" : "BOOK",
      spreadBps: Number(spreadBps.toFixed(2)),
      residualBps: Number(residualBps.toFixed(2)),
      periodBps,
      limitUpBps,
      floorBps,
      qualityMultiplier,
      stressMultiplier,
      impactBps: Number(bps(impactCostCents / (p0 * quantity)).toFixed(2)),
      participation: Number(
        (
          (context.consumedShares + quantity) /
          context.marketVolumeShares
        ).toFixed(8),
      ),
      marketVolumeShares: context.marketVolumeShares,
      consumedBeforeShares: context.consumedShares,
      spreadCostCents,
      residualCostCents: Number(residualCostCents.toFixed(2)),
      impactCostCents,
      impliedCostCents,
      roundingCostCents: impliedCostCents - unroundedCostCents,
      totalBps: Number(bps(impliedCostCents / (p0 * quantity)).toFixed(2)),
      unroundedTotalBps: Number(unroundedBps.toFixed(2)),
    },
    nextIntervalState: {
      intervalKey: context.intervalKey,
      referencePriceCents: p0,
      marketVolumeShares: context.marketVolumeShares,
      consumedShares: context.consumedShares + quantity,
      cumulativeImpactCents: impactAfterCents,
    },
  };
}

// solveFillQuantity：返回 { quantity, executionCost, nextIntervalState }，不修改传入账本。
// 数量与冲击相互影响，使用对数复杂度的单调搜索找到可成交数量（§4.3）。
export function solveFillQuantity({
  policy,
  context,
  side,
  desiredQuantity,
  stressMultiplier,
  limits = {},
  estimateFees,
}) {
  const stress =
    stressMultiplier ?? policy.payload.executionStressMultiplier ?? 1;
  if (!context?.supported)
    return {
      quantity: 0,
      reason: context?.rejectionReason ?? "执行上下文不可用",
    };
  const remainingShared = Math.max(
    0,
    roundLot(context.marketVolumeShares * HARD_PARTICIPATION_CAP) -
      context.consumedShares,
  );
  // 09:30–09:35 的软容量上限与硬上限取较小值（§3.1/§4.3）；
  // 买入按 100 股向下取整，卖出按股。
  const remainingOpeningRaw = isOpeningPeriod(context.period)
    ? Math.max(
        0,
        Math.round(
          context.marketVolumeShares * policy.payload.openingParticipationCap,
        ) - context.consumedShares,
      )
    : Infinity;
  // 买入上限必须整手：共享容量扣除奇数股卖出后的余额也要向下取整，
  // 否则“先卖 1 股后买 999 股”会突破整手约束（§4.3）。
  let upper =
    side === "BUY"
      ? roundLot(
          Math.min(
            desiredQuantity,
            remainingShared,
            remainingOpeningRaw,
            limits.capCents != null
              ? Math.max(0, limits.capCents) / context.referencePriceCents
              : Infinity,
          ),
        )
      : Math.min(
          desiredQuantity,
          Math.floor(remainingShared),
          Math.floor(remainingOpeningRaw),
          limits.availableQuantity ?? Infinity,
        );
  const violates = (quantity) => {
    const estimate = estimateExecutionCost({
      policy,
      context,
      side,
      quantity,
      stressMultiplier: stress,
    });
    if (!estimate.supported)
      return {
        violated: true,
        reason: estimate.rejectionReason,
        detail: estimate.detail,
      };
    if (side === "BUY") {
      if (
        limits.maxPriceCents &&
        estimate.fillPriceCents > limits.maxPriceCents
      )
        return { violated: true, reason: "含成本价格超过事前买入上限" };
      if (limits.limitUpCents && estimate.fillPriceCents >= limits.limitUpCents)
        return { violated: true, reason: "含成本价格触及涨停保守边界" };
      if (limits.capCents != null) {
        const fees = estimateFees
          ? estimateFees(quantity * estimate.fillPriceCents, side)
          : 0;
        if (quantity * estimate.fillPriceCents + fees > limits.capCents)
          return { violated: true, reason: "现金、仓位或流动性约束不足" };
      }
    } else if (
      limits.limitDownCents &&
      estimate.fillPriceCents <= limits.limitDownCents
    )
      return { violated: true, reason: "含成本价格触及跌停保守边界" };
    return { violated: false, estimate };
  };
  if (upper <= 0 || (side === "BUY" && upper < 100))
    return {
      quantity: 0,
      reason:
        side === "SELL"
          ? "没有 T+1 可卖底仓或流动性不足"
          : "现金、仓位、流动性或成本约束不足一手",
    };
  const probe = violates(upper);
  if (!probe.violated)
    return {
      quantity: upper,
      executionCost: probe.estimate,
      nextIntervalState: probe.estimate.nextIntervalState,
    };
  // 单调搜索：成本随数量非降，可行域是一段前缀；随手数对数收缩。
  let low = 0,
    high = upper,
    best = null,
    lastReason = probe.reason,
    lastDetail = probe.detail;
  while (low < high) {
    const mid =
      side === "BUY"
        ? Math.max(low, Math.floor((low + high) / 2 / 100) * 100)
        : Math.floor((low + high) / 2);
    if (mid === low) break;
    const check = violates(mid);
    if (check.violated) {
      high = mid;
      lastReason = check.reason;
      lastDetail = check.detail;
    } else {
      low = mid;
      best = check.estimate;
    }
  }
  if (best)
    return {
      quantity: low,
      executionCost: best,
      nextIntervalState: best.nextIntervalState,
    };
  return {
    quantity: 0,
    reason: lastReason,
    detail: lastDetail,
  };
}
