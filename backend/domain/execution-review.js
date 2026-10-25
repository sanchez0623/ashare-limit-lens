import { EXECUTION_REVIEW_KIND } from "../../shared/review.js";
import { digestOf } from "./research-lineage.js";

const integer = (value) => Number.isSafeInteger(value);
const positive = (value) => integer(value) && value > 0;
const nonnegative = (value) => integer(value) && value >= 0;
const sum = (rows, key) =>
  rows.every((row) => integer(row[key]))
    ? rows.reduce((total, row) => total + row[key], 0)
    : null;
const unique = (values) => [...new Set(values.filter(Boolean))];
const buyPointOf = (fill) =>
  fill.buyPoint ??
  fill.entryEvidence?.buyPoint ??
  fill.entryEvidence?.type ??
  null;
const quantity = (position) =>
  (position?.lots ?? []).reduce((total, lot) => total + lot.quantity, 0);
const basis = (position) =>
  (position?.lots ?? []).reduce((total, lot) => total + lot.costCents, 0);

function finalQuote(quote, date) {
  const stamp = Date.parse(quote?.timestamp);
  if (!Number.isFinite(stamp)) return false;
  const clock = new Date(stamp + 8 * 3600000).toISOString();
  return (
    quote.date === date &&
    clock.slice(0, 10) === date &&
    clock.slice(11, 19) >= "15:00:00" &&
    positive(quote.closeCents) &&
    quote.closingSource !== "FRAME_LAST_OBSERVED"
  );
}

function validFill(fill, date, signalDate) {
  return (
    fill.date === date &&
    fill.signalDate === signalDate &&
    ["BUY", "SELL"].includes(fill.side) &&
    positive(fill.quantity) &&
    positive(fill.priceCents) &&
    fill.notionalCents === fill.quantity * fill.priceCents &&
    nonnegative(fill.feeCents) &&
    fill.cashDeltaCents ===
      (fill.side === "BUY" ? -fill.notionalCents : fill.notionalCents) -
        fill.feeCents &&
    nonnegative(fill.basisCents) &&
    fill.realizedPnlCents ===
      (fill.side === "SELL" ? fill.cashDeltaCents - fill.basisCents : 0)
  );
}

function tradeSide(fills, side) {
  const matching = fills.filter((fill) => fill.side === side);
  const count = sum(matching, "quantity");
  const notionalCents = sum(matching, "notionalCents");
  return {
    quantity: count,
    notionalCents,
    averagePriceCents:
      count > 0 && notionalCents !== null ? notionalCents / count : null,
  };
}

function summarize(rows) {
  return {
    stockCount: rows.length,
    fillCount: rows.reduce((total, row) => total + row.fillCount, 0),
    validCount: rows.filter((row) => row.available).length,
    dailyPnlCents: sum(rows, "dailyPnlCents"),
    realizedPnlCents: sum(rows, "realizedPnlCents"),
    unrealizedPnlCents: sum(rows, "unrealizedPnlCents"),
    feeCents: sum(rows, "feeCents"),
    buyNotionalCents: sum(
      rows.map((row) => row.buy),
      "notionalCents",
    ),
    sellNotionalCents: sum(
      rows.map((row) => row.sell),
      "notionalCents",
    ),
  };
}

// 只投影权威成交及收盘归档；不重放执行器，不借用当前配置或未来行情。
export async function buildExecutionReview({
  date,
  session,
  fills,
  dataset,
  equity,
  createdAt = new Date().toISOString(),
}) {
  const plan = session?.plan;
  if (
    session?.status !== "CLOSED" ||
    session.date !== date ||
    dataset?.date !== date ||
    equity?.date !== date ||
    !plan?.signalDate ||
    plan.signalDate >= date ||
    dataset.previousTradingDate !== plan.signalDate ||
    session.initialBook?.lastDate !== plan.signalDate
  )
    throw new Error("缺少相邻交易日的冻结计划或已完成收盘结算，暂不生成反馈。");

  const ordered = [...fills].sort(
    (a, b) =>
      a.sequence - b.sequence || String(a.id).localeCompare(String(b.id)),
  );
  const sourceReasons = [];
  if (
    !nonnegative(session.fillCount) ||
    session.fillCount !== fills.length ||
    new Set(fills.map((fill) => fill.id)).size !== fills.length ||
    ordered.some((fill, index) => !fill.id || fill.sequence !== index)
  )
    sourceReasons.push("会话成交笔数与归档流水不一致");
  if (
    [
      ["cashCents", "cashDeltaCents"],
      ["realizedPnlCents", "realizedPnlCents"],
      ["feesCents", "feeCents"],
    ].some(([bookKey, fillKey]) => {
      const delta = sum(fills, fillKey);
      return (
        delta === null ||
        !integer(session.initialBook[bookKey]) ||
        session.initialBook[bookKey] + delta !== equity[bookKey]
      );
    })
  )
    sourceReasons.push("成交现金流、已实现盈亏或费用与收盘结算不一致");

  const byCode = new Map();
  for (const fill of ordered) {
    if (!byCode.has(fill.code)) byCode.set(fill.code, []);
    byCode.get(fill.code).push(fill);
  }
  const rows = [...byCode].map(([code, trades]) => {
    const original = session.initialBook.positions?.find(
      (p) => p.code === code,
    );
    const history = plan.entryExecutionPolicy?.history?.[code];
    const planned = plan.orders?.find((order) => order.code === code);
    const quote = dataset.quotes?.[code];
    const reasons = [...sourceReasons];
    const financeReasons = [...sourceReasons];
    const openingQuantity = quantity(original);
    const openingBasisCents = basis(original);
    const openingMarketValueCents = openingQuantity
      ? openingQuantity * original.markCents
      : 0;
    const buy = tradeSide(trades, "BUY");
    const sell = tradeSide(trades, "SELL");
    const endingQuantity = openingQuantity + buy.quantity - sell.quantity;
    if (
      !trades.every((fill) => validFill(fill, date, plan.signalDate)) ||
      !nonnegative(openingQuantity) ||
      !nonnegative(openingBasisCents) ||
      !nonnegative(openingMarketValueCents) ||
      !nonnegative(endingQuantity)
    )
      financeReasons.push("成交现金流、数量或日初持仓资料不能核对");
    const hasClose = finalQuote(quote, date);
    if (!hasClose) {
      reasons.push("缺少当日最终收盘行情");
      if (endingQuantity > 0) financeReasons.push("剩余持仓缺少最终收盘价");
    }
    if (hasClose && !positive(quote.previousCloseCents))
      reasons.push("缺少可比的昨收价");
    if (hasClose && !positive(quote.openCents)) reasons.push("缺少当日开盘价");
    if (hasClose && !positive(quote.lowCents)) reasons.push("缺少当日最低价");
    const closingBasisCents =
      openingBasisCents +
      trades
        .filter((fill) => fill.side === "BUY")
        .reduce((n, fill) => n + fill.notionalCents + fill.feeCents, 0) -
      trades
        .filter((fill) => fill.side === "SELL")
        .reduce((n, fill) => n + fill.basisCents, 0);
    if (
      !nonnegative(closingBasisCents) ||
      (endingQuantity === 0 && closingBasisCents !== 0)
    )
      financeReasons.push("剩余持仓成本不能核对");
    if (
      original &&
      hasClose &&
      (!positive(quote.previousCloseCents) ||
        Math.abs(quote.previousCloseCents - original.markCents) >
          Math.max(1, original.markCents * 0.001))
    )
      financeReasons.push("昨收与日初账面价格不一致，需核对除权或交易日");

    const linkedOrders = (session.orders ?? []).filter(
      (order) =>
        order.code === code && trades.some((fill) => fill.orderId === order.id),
    );
    const buyPoints = unique(trades.map(buyPointOf));
    if (
      trades.some(
        (fill) =>
          fill.action === "OPEN" &&
          (!buyPointOf(fill) || !fill.entryEvidence?.quoteTimestamp),
      )
    )
      reasons.push("部分建仓成交缺少原始买点或触发凭证");
    if (
      trades.some(
        (fill) =>
          fill.entryEvidence?.configId &&
          fill.entryEvidence.configId !== plan.dragonPolicy?.configId,
      )
    )
      reasons.push("成交凭证配置与冻结计划不一致");
    if (
      trades.some(
        (fill) => !linkedOrders.some((order) => order.id === fill.orderId),
      )
    )
      reasons.push("部分成交缺少关联的执行单凭证");
    if (!history?.sector && !original?.sector && !planned?.sector)
      reasons.push("缺少冻结行业归属");
    const knownCash = sum(trades, "cashDeltaCents");
    const closingMarketValueCents =
      endingQuantity === 0
        ? 0
        : hasClose
          ? endingQuantity * quote.closeCents
          : null;
    const financialAvailable = financeReasons.length === 0;
    const allReasons = unique([...financeReasons, ...reasons]);
    const previousClose =
      hasClose && positive(quote.previousCloseCents)
        ? quote.previousCloseCents
        : null;
    const change = (price) =>
      previousClose && positive(price)
        ? (price / previousClose - 1) * 100
        : null;
    const pendingT = linkedOrders.some(
      (order) =>
        order.status === "INCOMPLETE_T" ||
        ((order.recovery || order.intent === "T_RECOVERY") &&
          order.filledQuantity < order.quantity) ||
        (["T_FORWARD", "T_REVERSE"].includes(order.action) &&
          order.firstFilled > order.secondFilled),
    );
    const tRecovery = trades.some(
      (fill) =>
        fill.intent === "T_RECOVERY" || /:recovery$/.test(fill.orderId ?? ""),
    );
    return {
      code,
      name: original?.name ?? history?.name ?? planned?.name ?? trades[0].name,
      sector:
        history?.sector ?? original?.sector ?? planned?.sector ?? "未知行业",
      fillCount: trades.length,
      actions: unique(trades.map((fill) => fill.intent ?? fill.action)),
      buyPoints,
      buy,
      sell,
      openingQuantity,
      endingQuantity,
      actualCloseCents: hasClose ? quote.closeCents : null,
      openReturn: change(quote?.openCents),
      closeReturn: change(quote?.closeCents),
      lowReturn: change(quote?.lowCents),
      dailyPnlCents: financialAvailable
        ? knownCash + closingMarketValueCents - openingMarketValueCents
        : null,
      realizedPnlCents:
        !sourceReasons.length &&
        trades.every((fill) => validFill(fill, date, plan.signalDate))
          ? sum(trades, "realizedPnlCents")
          : null,
      unrealizedPnlCents: financialAvailable
        ? closingMarketValueCents - closingBasisCents
        : null,
      feeCents:
        !sourceReasons.length &&
        trades.every((fill) => nonnegative(fill.feeCents))
          ? sum(trades, "feeCents")
          : null,
      financialAvailable,
      available: allReasons.length === 0,
      reasons: allReasons,
      execution: linkedOrders.map((order) => ({
        id: order.id,
        action: order.intent ?? order.action,
        status: order.status,
        reason: order.reason ?? null,
        filledQuantity: order.filledQuantity ?? null,
        quantity: order.quantity ?? null,
        stopCents: order.stopCents ?? null,
        triggerPriceCents: order.triggerPriceCents ?? null,
        recovery: !!order.recovery,
      })),
      tStatus: pendingT ? "INCOMPLETE" : tRecovery ? "RECOVERY" : null,
      fills: structuredClone(trades),
    };
  });

  const sectors = unique(rows.map((row) => row.sector)).map((name) => ({
    name,
    ...summarize(rows.filter((row) => row.sector === name)),
  }));
  const summary = summarize(rows);
  if (sourceReasons.length) {
    for (const key of [
      "dailyPnlCents",
      "realizedPnlCents",
      "unrealizedPnlCents",
      "feeCents",
      "buyNotionalCents",
      "sellNotionalCents",
    ])
      summary[key] = null;
  }
  const sources = {
    planDigest: await digestOf(plan),
    sessionDigest: await digestOf(session),
    ledgerDigest: await digestOf(ordered),
    marketDigest: await digestOf(dataset),
    equityDigest: await digestOf(equity),
  };
  return {
    reviewKind: EXECUTION_REVIEW_KIND,
    schemaVersion: 2,
    modelVersion: "execution-feedback-v1",
    date,
    snapshotDate: plan.signalDate,
    createdAt,
    status: sourceReasons.length
      ? "PARTIAL"
      : !rows.length
        ? "NO_TRADES"
        : rows.every((row) => row.available)
          ? "COMPLETE"
          : "PARTIAL",
    systemScore: null,
    total: rows.length,
    validCount: summary.validCount,
    coverage: rows.length ? summary.validCount / rows.length : null,
    summary,
    rows,
    sectors,
    policy: {
      tradingPolicyVersion:
        plan.dragonPolicy?.version ?? session.tradingPolicyVersion ?? "legacy",
      selectionPolicyVersion:
        plan.selectionPolicyVersion ?? plan.selectionPolicy?.version ?? null,
      strategyVersion: plan.strategyVersion ?? null,
      configId: plan.dragonPolicy?.configId ?? null,
      configDigest: plan.dragonPolicy?.configDigest ?? null,
      config: structuredClone(plan.dragonPolicy?.config ?? null),
      riskLimits: structuredClone(plan.riskLimits ?? null),
      provenance: structuredClone(plan.dragonPolicy?.provenance ?? null),
      engineBuild: plan.engineBuild ?? null,
      transitionState: session.initialBook.dragonTransition?.state ?? null,
      feeModel: plan.feeModel ?? null,
      feeConfigVersion: plan.feeConfigVersion ?? null,
      feeConfig: structuredClone(plan.feeConfig ?? null),
      executionCostModel: plan.executionCostModel ?? null,
      executionCostPolicyDigest:
        plan.executionCostPolicy?.payloadDigest ?? null,
    },
    sources,
    sourceDigest: await digestOf(sources),
    sourceReasons,
    conclusion: sourceReasons.length
      ? sourceReasons.join("；")
      : !rows.length
        ? "当日无成交，不评价买点或策略优劣。"
        : `仅反馈主账户实际成交的 ${rows.length} 只股票、${fills.length} 笔成交；可核验 ${summary.validCount} 只。`,
    caveat:
      "今日开盘、收盘与最低涨跌幅均以昨收为基准，是全天市场表现；不是买入后的收益或最大回撤。当日损益含实际费用及成交价格中的执行成本，仅合计当日成交标的；已实现盈亏按账本成本，收盘浮盈亏未扣假设卖出费用。单日反馈不证明策略有效，不改变配置验证或晋级状态。",
  };
}
