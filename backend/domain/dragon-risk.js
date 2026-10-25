// Independent policy. Only the observed buy-point predicates, fees and cost solver
// are shared with the legacy engine; no legacy strategy/risk defaults are read.
import {
  DRAGON_POLICY_VERSION as VERSION,
  DRAGON_TEMPLATE_VERSION,
  DRAGON_REGIMES,
  DRAGON_HOLD_DAYS,
  normalizeDragonConfig,
  dragonPreview,
} from "../../shared/dragon-risk-config.js";
import {
  INTRADAY_ENTRY_RULES,
  INTRADAY_ENTRY_VERSION,
  eligible,
  typesAt,
  updateEntryPath,
} from "./intraday-entry.js";
import {
  selectionPolicy,
  selectionPolicyFields,
  SELECTION_VERSION_V5,
  SELECTION_VERSION_DRAGON,
} from "./signal-selection.js";
import { canonicalJson } from "./research-lineage.js";
import { buildExecutionContext, solveFillQuantity } from "./execution-cost.js";
import { EXECUTION_COST_MODEL } from "../../shared/execution-cost.js";
import {
  transactionFees,
  availableQuantity,
  totalQuantity,
  costBasis,
  roundLot,
} from "./trading.js";
import { feesForBook } from "../../shared/fees.js";
import { planFreezeDeadline } from "../../shared/observation-schedule.js";

export const DRAGON_RULES = Object.freeze({
  version: DRAGON_TEMPLATE_VERSION,
  sectorMinimum: 55,
  firstNegMinPrevHeight: 3,
  maxChase: 0.03,
  profitAddAt: 0.5,
  profitAddBefore: 1,
  profitAddFraction: 0.5,
  lossAddFrom: -0.75,
  lossAddTo: -0.5,
  lossAddFraction: 0.25,
  addRiskFraction: 0.5,
  tEntryDeviation: 0.02,
  tLossLimit: 2,
  tCooldownDays: 3,
  profitMilestones: [1, 2],
  profitFractions: [0.3, 0.3],
  trailingR: 1,
  holdDays: DRAGON_HOLD_DAYS,
});
export const isDragon = (value) => value?.tradingPolicyVersion === VERSION;
const clone = (value) => structuredClone(value);
const qOf = (book, code) => book.positions.find((p) => p.code === code);
const qty = (p) => (p ? totalQuantity(p) : 0);
const clock = (stamp) =>
  new Date(Date.parse(stamp) + 8 * 3600000).toISOString().slice(11, 19);
const fresh = (stamp, now, age) =>
  Number.isFinite(Date.parse(stamp)) &&
  now >= Date.parse(stamp) &&
  now - Date.parse(stamp) <= age;
const terminal = new Set(["FILLED", "CANCELLED", "EXPIRED", "EXPIRED_PARTIAL"]);
function mark(book) {
  book.positions = book.positions.filter((p) => qty(p) > 0);
  book.equityCents =
    book.cashCents +
    book.positions.reduce((n, p) => n + qty(p) * p.markCents, 0);
  book.peakEquityCents = Math.max(book.peakEquityCents, book.equityCents);
  if (book.dragonRiskPeakCents != null)
    book.dragonRiskPeakCents = Math.max(
      book.dragonRiskPeakCents,
      book.equityCents,
    );
}
export function assertDragonPlan(plan, book = null) {
  if (!isDragon(plan))
    throw new Error("新政策计划缺少 dragon-risk-v1 标记，禁止回退旧规则");
  const policy = plan.dragonPolicy;
  const expectedSelection = selectionPolicyFields(
    selectionPolicy(SELECTION_VERSION_DRAGON),
  );
  if (
    canonicalJson(plan.selectionPolicy) !==
      canonicalJson(expectedSelection.selectionPolicy) ||
    plan.selectionPolicyDigest !== expectedSelection.selectionPolicyDigest
  )
    throw new Error("新政策排序声明不一致，不能继承旧评分排序");
  if (
    !policy ||
    policy.version !== VERSION ||
    policy.templateVersion !== DRAGON_TEMPLATE_VERSION ||
    canonicalJson(policy.rules) !== canonicalJson(DRAGON_RULES) ||
    canonicalJson(plan.entryExecutionPolicy?.rules) !==
      canonicalJson(INTRADAY_ENTRY_RULES)
  )
    throw new Error("新政策规则或模板与冻结版本不一致");
  normalizeDragonConfig(policy.config);
  if (
    !policy.configId ||
    !policy.configDigest ||
    !plan.executionCostPolicy?.payloadDigest ||
    !plan.engineBuild
  )
    throw new Error("新政策缺少配置版本、成本政策或执行指纹");
  if (book?.tradingPolicyVersion && !isDragon(book))
    throw new Error("账户交易政策与计划不一致");
  if (
    plan.strategy ||
    plan.riskLimits ||
    plan.strategyProgram ||
    plan.exposureTiers
  )
    throw new Error("新政策计划不得携带旧策略或风控参数");
  return policy.config;
}
export function createDragonPlan(snapshot, book, createdAt, options = {}) {
  const config = normalizeDragonConfig(book.dragonConfig);
  const context = snapshot.intradayEntryContext;
  if (
    !options.defensive &&
    (context?.asOf !== snapshot.date ||
      context?.version !== INTRADAY_ENTRY_VERSION)
  )
    throw new Error("新政策缺少信号日冻结的买点历史");
  const history = clone(context?.history ?? {});
  const candidates = Object.keys(history)
    .filter((code) => eligible(history[code], null))
    .sort(
      (a, b) =>
        (history[b].amount ?? 0) - (history[a].amount ?? 0) ||
        a.localeCompare(b),
    )
    .slice(0, INTRADAY_ENTRY_RULES.maxPremarketCandidates);
  const allCandidates = [
    ...new Set([...book.positions.map((p) => p.code), ...candidates]),
  ];
  const phase =
    snapshot.cycle?.phase ?? snapshot.marketSummary?.cycle?.phase ?? "unknown";
  const plan = {
    tradingPolicyVersion: VERSION,
    signalDate: snapshot.date,
    createdAt,
    strategyVersion: book.dragonConfigId,
    entryExecutionMode: "intraday-conditional",
    sourceSnapshotMissing: !!options.defensive,
    engineBuild: options.engineBuild ?? book.dragonEngineBuild,
    dragonPolicy: {
      version: VERSION,
      templateVersion: DRAGON_TEMPLATE_VERSION,
      configId: book.dragonConfigId,
      configDigest: book.dragonConfigDigest,
      config,
      ...(book.dragonConfigProvenance
        ? { provenance: clone(book.dragonConfigProvenance) }
        : {}),
      rules: clone(DRAGON_RULES),
    },
    ...selectionPolicyFields(selectionPolicy(SELECTION_VERSION_DRAGON)),
    sourceUniverseVersion: SELECTION_VERSION_V5,
    entryExecutionPolicy: {
      version: INTRADAY_ENTRY_VERSION,
      sourceDate: snapshot.date,
      rules: clone(INTRADAY_ENTRY_RULES),
      history,
      candidates: allCandidates,
      firstNegMinPrevHeight: DRAGON_RULES.firstNegMinPrevHeight,
    },
    feeModel: book.feeModel,
    feeConfig: clone(feesForBook(book)),
    feeConfigVersion: book.feeConfigVersion,
    executionCostModel: EXECUTION_COST_MODEL,
    executionCostPolicy: clone(options.executionCostPolicy),
    previousLimitUpCodes: (snapshot.stocks ?? [])
      .filter((s) => s.height >= 1)
      .map((s) => s.code)
      .sort(),
    previousLimitUpKnown: !options.defensive,
    marketPolicy: dragonPreview(config, phase),
    selectionAudit: {
      signalDate: snapshot.date,
      snapshotDigest: options.snapshotDigest ?? null,
      candidates: candidates.map((code, index) => ({
        code,
        name: history[code].name,
        rank: index + 1,
        amount: history[code].amount,
        status: "WATCHING",
        reason: "等待实际买点与共享风险预算",
      })),
    },
    orders: book.positions.map((p) => ({
      tradingPolicyVersion: VERSION,
      referenceCents: p.markCents,
      takeProfitCents: p.dragon?.p0Cents + p.dragon?.r0Cents,
      id: `${snapshot.date}:${p.code}:HOLD`,
      code: p.code,
      name: p.name,
      action: "HOLD",
      side: "NONE",
      quantity: 0,
      stopCents: p.dragon?.stopCents,
      reason: "由独立风险预算政策管理",
    })),
    constraints:
      "独立配置；按实际观测买点触发；所有买入共享预算；T+1；旧参数不参与。",
  };
  assertDragonPlan(plan, book);
  return plan;
}
export function openDragonSession(book, plan, date) {
  assertDragonPlan(plan, book);
  if (
    !isDragon(book) ||
    book.lastDate !== plan.signalDate ||
    plan.signalDate >= date ||
    !Number.isFinite(Date.parse(plan.createdAt)) ||
    Date.parse(plan.createdAt) >= planFreezeDeadline(plan, date)
  )
    throw new Error("新政策需要执行日前冻结的计划，禁止盘中切换");
  for (const p of book.positions)
    if (!p.dragon) throw new Error("新政策不能接管未结清的旧持仓");
  return {
    tradingPolicyVersion: VERSION,
    date,
    signalDate: plan.signalDate,
    status: "OPEN",
    plan: clone(plan),
    initialBook: clone(book),
    sequence: 0,
    fillCount: 0,
    quotes: {},
    orders: [],
    lastObservedAt: null,
    executionState: {
      policyDigest: plan.executionCostPolicy.payloadDigest,
      byCode: {},
    },
    entryState: {
      admissions: Object.fromEntries(
        plan.entryExecutionPolicy.candidates.map((code) => [code, { code }]),
      ),
      paths: {},
      coverage: { acceptedQuotes: 0 },
    },
    regime: {
      phase: "unknown",
      pending: null,
      confirmations: 0,
      marketStamp: null,
    },
    dailyPaused: false,
    cooldownAtStart: book.dragonCooldownDays ?? 0,
  };
}
function marketState(session, observation) {
  const market = observation.entryInputs?.market,
    now = Date.parse(observation.observedAt);
  const next =
    market?.date === session.date &&
    fresh(market.observedAt, now, INTRADAY_ENTRY_RULES.marketMaxAgeMs) &&
    Object.hasOwn(DRAGON_REGIMES, market.cycle?.phase)
      ? market.cycle.phase
      : "unknown";
  const order = { unknown: -1, freezing: 0, ebbing: 1, climax: 2, rising: 3 };
  const state = session.regime;
  if (next === "unknown" || order[next] <= order[state.phase]) {
    state.phase = next;
    state.pending = null;
    state.confirmations = 0;
  } else if (market.observedAt !== state.marketStamp) {
    state.confirmations = state.pending === next ? state.confirmations + 1 : 1;
    state.pending = next;
    if (state.confirmations >= 2) {
      state.phase = next;
      state.pending = null;
      state.confirmations = 0;
    }
  }
  if (market) state.marketStamp = market.observedAt;
  return DRAGON_REGIMES[state.phase];
}
function reservations(
  book,
  session,
  excludingCode = null,
  excludingOrder = null,
) {
  const result = book.positions
    .filter(
      (p) => p.code !== excludingCode && p.dragon?.t?.direction === "REVERSE",
    )
    .reduce(
      (s, p) => {
        const t = p.dragon.t,
          remaining = t.firstQuantity - t.secondQuantity;
        const cents = remaining * t.reservePriceCents;
        const buyFee = transactionFees(
          cents,
          "BUY",
          session.plan.feeConfig,
          session.plan.feeModel,
        ).total;
        const sellFee = transactionFees(
          cents,
          "SELL",
          session.plan.feeConfig,
          session.plan.feeModel,
        ).total;
        s.cash += cents + buyFee;
        s.exposure += cents;
        s.risk +=
          remaining * Math.max(1, t.reservePriceCents - p.dragon.stopCents) +
          buyFee +
          sellFee;
        if (p.sector) s.sectors[p.sector] = (s.sectors[p.sector] ?? 0) + cents;
        return s;
      },
      { cash: 0, exposure: 0, risk: 0, sectors: {} },
    );
  for (const o of session.orders) {
    if (
      o.id === excludingOrder ||
      terminal.has(o.status) ||
      !["OPEN", "ADD_PROFIT", "ADD_LOSS"].includes(o.intent)
    )
      continue;
    const remaining = Math.max(0, o.quantity - o.filledQuantity),
      cents = remaining * o.maxPriceCents;
    const fee = remaining
      ? transactionFees(
          cents,
          "BUY",
          session.plan.feeConfig,
          session.plan.feeModel,
        ).total +
        transactionFees(
          cents,
          "SELL",
          session.plan.feeConfig,
          session.plan.feeModel,
        ).total
      : 0;
    result.cash += cents + fee;
    result.exposure += cents;
    result.risk += remaining * Math.max(1, o.maxPriceCents - o.stopCents) + fee;
    const sector = session.plan.entryExecutionPolicy.history[o.code]?.sector;
    result.sectors[sector] = (result.sectors[sector] ?? 0) + cents;
  }
  return result;
}
export function dragonBudget(
  book,
  session,
  code,
  priceCents,
  stopCents,
  intent,
  maxQuantity = Infinity,
  excludingOrder = null,
) {
  const config = session.plan.dragonPolicy.config,
    risk = config.risk,
    regime = DRAGON_REGIMES[session.regime.phase];
  if (1 - book.equityCents / session.initialBook.equityCents >= risk.dailyLoss)
    session.dailyPaused = true;
  if (
    1 - book.equityCents / (book.dragonRiskPeakCents ?? book.peakEquityCents) >=
    risk.drawdown
  )
    book.dragonHalted = true;
  const p = qOf(book, code),
    history = session.plan.entryExecutionPolicy.history[code];
  const sector = p?.sector ?? history?.sector;
  const reserve = reservations(
    book,
    session,
    intent === "T_RECOVERY" ? code : null,
    excludingOrder,
  );
  const exposure = book.positions.reduce((s, x) => s + qty(x) * x.markCents, 0);
  const sectorExposure = book.positions
    .filter((x) => x.sector === sector)
    .reduce((s, x) => s + qty(x) * x.markCents, 0);
  const heldRisk = book.positions.reduce(
    (s, x) =>
      s +
      qty(x) *
        Math.max(
          x.dragon?.exit ? x.dragon.r0Cents : 0,
          x.markCents - (x.dragon?.stopCents ?? 0),
          0,
        ) +
      Math.ceil(qty(x) * x.markCents * 0.003),
    0,
  );
  const policy = dragonPreview(config, session.regime.phase).effective;
  const gross =
    intent === "T_RECOVERY" && session.regime.phase === "ebbing"
      ? Math.min(0.2, risk.grossWeight)
      : policy.grossWeight;
  const factor =
    intent === "T_RECOVERY" && session.regime.phase === "ebbing"
      ? 1
      : regime.factor;
  if (
    session.dailyPaused ||
    session.missingHoldingQuotes ||
    book.dragonHalted ||
    !factor ||
    gross == null ||
    session.plan.sourceSnapshotMissing
  )
    return { quantity: 0, reason: "市场、数据或账户暂停新增风险" };
  const pendingCodes = new Set(
    session.orders
      .filter(
        (o) =>
          o.intent === "OPEN" &&
          !terminal.has(o.status) &&
          o.quantity > o.filledQuantity &&
          !qOf(book, o.code),
      )
      .map((o) => o.code),
  );
  if (
    !p &&
    !pendingCodes.has(code) &&
    book.positions.length + pendingCodes.size >= risk.maxPositions
  )
    return { quantity: 0, reason: "持仓及待成交名额已满" };
  const equity = book.equityCents;
  const cap = Math.max(
    0,
    Math.min(
      book.cashCents - reserve.cash,
      equity * gross - exposure - reserve.exposure,
      equity * risk.stockWeight - qty(p) * (p?.markCents ?? 0),
      equity * risk.sectorWeight -
        sectorExposure -
        (reserve.sectors[sector] ?? 0),
    ),
  );
  const perShareRisk =
    Math.max(1, priceCents - stopCents) + Math.ceil(priceCents * 0.003);
  const tradeRisk =
    equity * risk.entryRisk * factor * (intent.startsWith("ADD_") ? 0.5 : 1);
  const remainingRisk = Math.max(
    0,
    equity * risk.portfolioRisk * factor - heldRisk - reserve.risk,
  );
  return {
    quantity: roundLot(
      Math.min(
        maxQuantity,
        cap / (priceCents * 1.003),
        tradeRisk / perShareRisk,
        remainingRisk / perShareRisk,
      ),
    ),
    capCents: Math.floor(cap),
    riskBudgetCents: Math.floor(Math.min(tradeRisk, remainingRisk)),
    stopCents,
    reason:
      cap <= 0 ? "现金、仓位或预留不足" : "计划风险、集中度与共享预算约束",
  };
}
function addOrder(session, code, action, reason, extras = {}) {
  const id = `${session.date}:${code}:${action}`;
  let order = session.orders.find((o) => o.id === id);
  if (!order) {
    const h = session.plan.entryExecutionPolicy.history[code];
    order = {
      id,
      code,
      name: h?.name ?? code,
      action,
      intent: action,
      side: ["EXIT", "REDUCE"].includes(action) ? "SELL" : "BUY",
      quantity: 0,
      filledQuantity: 0,
      firstFilled: 0,
      secondFilled: 0,
      status: "WATCHING",
      reason,
      ...extras,
    };
    session.orders.push(order);
  }
  return order;
}
function recordT(book, position, status, date) {
  const t = position.dragon.t;
  if (!t) return;
  const complete =
    status === "COMPLETED" && t.firstQuantity === t.secondQuantity;
  const record = {
    id: t.id,
    code: position.code,
    direction: t.direction,
    startedDate: t.date,
    completedDate: date,
    status,
    buyQuantity: t.direction === "FORWARD" ? t.firstQuantity : t.secondQuantity,
    sellQuantity:
      t.direction === "FORWARD" ? t.secondQuantity : t.firstQuantity,
    netPnlCents: complete ? t.cashDeltaCents : null,
    netCashCents: t.cashDeltaCents,
  };
  book.dragonTRecords = [...(book.dragonTRecords ?? []), record].slice(-100);
  if (complete) {
    book.dragonTNetPnlCents = (book.dragonTNetPnlCents ?? 0) + t.cashDeltaCents;
    book.dragonTLossStreak =
      t.cashDeltaCents < 0 ? (book.dragonTLossStreak ?? 0) + 1 : 0;
    if (book.dragonTLossStreak >= 2) {
      book.dragonCooldownDays = 3;
      book.dragonCooldownDate = date;
      book.dragonTLossStreak = 0;
    }
  }
  position.dragon.t = null;
}
// The cost solver is shared, while risk caps, intent validation and accounting
// state are policy-local. A failed/partial fill never spends unfilled inventory.
function fill(
  book,
  session,
  item,
  order,
  side,
  desired,
  ledger,
  budget = null,
) {
  const { quote, volume } = item,
    code = quote.code,
    plan = session.plan;
  const p = qOf(book, code);
  if (
    (side === "BUY" && quote.closeCents >= quote.limitUpCents) ||
    (side === "SELL" && quote.closeCents <= quote.limitDownCents)
  ) {
    order.reason = "涨跌停排队不假设成交";
    return null;
  }
  const now = Date.parse(session.lastObservedAt);
  if (
    side === "BUY" &&
    (quote.orderBookQuality !== "OK" ||
      !(quote.ask1Cents > 0) ||
      !(quote.ask1Shares > 0) ||
      !fresh(quote.orderBookTimestamp, now, INTRADAY_ENTRY_RULES.quoteMaxAgeMs))
  ) {
    order.reason = "缺少当帧可验证卖盘";
    return null;
  }
  const fees = (n) =>
    transactionFees(n, side, plan.feeConfig, plan.feeModel).total;
  const event = {
    priceCents: quote.closeCents,
    volumeShares: volume,
    time: clock(session.lastObservedAt),
    intervalKey: quote.timestamp,
    quality: "realtime_poll",
  };
  const context = buildExecutionContext({
    plan,
    code,
    event,
    quote,
    intervalState: session.executionState.byCode[code],
  });
  const available =
    side === "SELL"
      ? availableQuantity(p, session.date)
      : Math.min(desired, quote.ask1Shares);
  const solve = (desiredQuantity) =>
    solveFillQuantity({
      policy: plan.executionCostPolicy,
      context,
      side,
      desiredQuantity,
      limits: {
        maxPriceCents: side === "BUY" ? order.maxPriceCents : null,
        limitUpCents: quote.limitUpCents,
        limitDownCents: quote.limitDownCents,
        capCents:
          side === "BUY"
            ? Math.min(book.cashCents, budget?.capCents ?? 0)
            : null,
        availableQuantity: available,
      },
      estimateFees: (n) => fees(n),
    });
  let solved = solve(Math.min(desired, available));
  while (side === "BUY" && solved.quantity > 0) {
    const n = solved.quantity * solved.executionCost.fillPriceCents;
    const planned =
      solved.quantity *
        Math.max(0, solved.executionCost.fillPriceCents - budget.stopCents) +
      fees(n) +
      transactionFees(n, "SELL", plan.feeConfig, plan.feeModel).total;
    if (planned <= budget.riskBudgetCents) break;
    solved = solve(solved.quantity - 100);
  }
  if (!solved.quantity) {
    order.reason = solved.detail ?? solved.reason;
    order.status = "BLOCKED";
    return null;
  }
  const quantity = solved.quantity,
    price = solved.executionCost.fillPriceCents,
    notional = quantity * price;
  const feeBreakdown = transactionFees(
      notional,
      side,
      plan.feeConfig,
      plan.feeModel,
    ),
    fee = feeBreakdown.total;
  if (order.side === "PAIR") {
    const roundTripFees =
      transactionFees(notional, "BUY", plan.feeConfig, plan.feeModel).total +
      transactionFees(notional, "SELL", plan.feeConfig, plan.feeModel).total;
    const nextCost =
      (notional * (solved.executionCost.costBreakdown.totalBps ?? 0)) / 10000;
    if (
      notional * plan.dragonPolicy.config.advanced.tSpread <=
      roundTripFees + nextCost
    ) {
      order.reason = "实际可成交数量不足以覆盖做 T 双边费用和预计成本";
      order.status = "BLOCKED";
      return null;
    }
  }
  const cashDelta = side === "BUY" ? -notional - fee : notional - fee;
  let position = p,
    basisCents = 0;
  if (side === "BUY") {
    if (!position) {
      const h = plan.entryExecutionPolicy.history[code];
      position = {
        code,
        name: h.name,
        sector: h.sector,
        lots: [],
        heldDays: 0,
        markCents: quote.closeCents,
        markDate: session.date,
      };
      book.positions.push(position);
    }
    position.lots.push({
      acquiredDate: session.date,
      quantity,
      costCents: notional + fee,
      priceCents: price,
      dragonIntent: order.intent,
      cycleId: position.dragon?.id ?? `${session.date}:${code}`,
    });
  } else {
    let left = quantity;
    for (const lot of position.lots) {
      if (lot.acquiredDate >= session.date || !left) continue;
      const used = Math.min(left, lot.quantity),
        basis = Math.round((lot.costCents * used) / lot.quantity);
      lot.quantity -= used;
      lot.costCents -= basis;
      basisCents += basis;
      left -= used;
    }
    position.lots = position.lots.filter((l) => l.quantity > 0);
    book.realizedPnlCents += cashDelta - basisCents;
  }
  book.cashCents += cashDelta;
  book.feesCents += fee;
  session.executionState.byCode[code] = solved.nextIntervalState;
  const row = {
    id: `${session.date}:live:${session.fillCount}`,
    date: session.date,
    signalDate: plan.signalDate,
    sequence: session.fillCount++,
    time: event.time,
    code,
    name: position.name,
    action: order.action,
    intent: order.intent,
    side,
    quantity,
    priceCents: price,
    notionalCents: notional,
    feeCents: fee,
    feeBreakdown,
    feeModel: plan.feeModel,
    feeConfig: plan.feeConfig,
    feeConfigVersion: plan.feeConfigVersion,
    cashDeltaCents: cashDelta,
    basisCents,
    realizedPnlCents: side === "SELL" ? cashDelta - basisCents : 0,
    cashAfterCents: book.cashCents,
    strategyVersion: plan.strategyVersion,
    tradingPolicyVersion: VERSION,
    orderId: order.id,
    buyPoint: order.buyPoint ?? null,
    quoteTimestamp: quote.timestamp,
    observationSequence: session.sequence,
    dataQuality: "realtime_poll",
    source: "持久行情帧",
    sourcePriceCents: quote.closeCents,
    executionCost: solved.executionCost.costBreakdown,
    entryEvidence: {
      intent: order.intent,
      observedAt: session.lastObservedAt,
      quoteTimestamp: quote.timestamp,
      marketTimestamp: session.regime.marketStamp,
      phase: session.regime.phase,
      buyPoint: order.buyPoint ?? null,
      observedPriceCents: quote.closeCents,
      previousCloseCents: quote.previousCloseCents,
      triggerPriceCents: order.triggerPriceCents ?? null,
      stableQuotes: session.entryState.paths[code]?.stableQuotes ?? 0,
      downQuotes: session.entryState.paths[code]?.downQuotes ?? 0,
      stopCents: budget?.stopCents ?? position.dragon?.stopCents ?? null,
      riskBudgetCents: budget?.riskBudgetCents ?? null,
      capCents: budget?.capCents ?? null,
      configId: plan.dragonPolicy.configId,
    },
    cycleId: position.dragon?.id ?? `${session.date}:${code}`,
  };
  ledger.push(row);
  order.filledQuantity += quantity;
  order.status = order.filledQuantity >= order.quantity ? "FILLED" : "PARTIAL";
  order.reason = "按实际观测、共享容量、费用和风险预算成交";
  mark(book);
  return { quantity, price, cashDelta, position, notional, fee };
}
function processProtection(book, session, item, ledger, regime) {
  const p = qOf(book, item.quote.code);
  if (!p?.dragon) return false;
  const c = p.dragon,
    price = p.markCents,
    config = session.plan.dragonPolicy.config;
  c.highCents = Math.max(c.highCents, price);
  let reason = null,
    target = null;
  const gross = book.equityCents
    ? (book.equityCents - book.cashCents) / book.equityCents
    : 0;
  if (
    book.dragonHalted ||
    regime.phase === "freezing" ||
    c.exit ||
    price <= c.stopCents ||
    p.heldDays >= c.holdDays
  ) {
    c.exit = true;
    target = 0;
    reason = "熔断、保护位或持有期限要求退出";
  } else if (
    regime.target != null &&
    gross > Math.min(regime.target, config.risk.grossWeight)
  ) {
    target = roundLot(
      (qty(p) * Math.min(regime.target, config.risk.grossWeight)) / gross,
    );
    reason = "市场退潮压缩敞口";
  } else {
    let stage = c.stage;
    if (price >= c.p0Cents + c.r0Cents) stage = Math.max(stage, 1);
    if (price >= c.p0Cents + 2 * c.r0Cents) stage = 2;
    const newStage = stage > c.stage;
    if (newStage) {
      c.baseQuantity ??= c.strategicQuantity;
      c.stage = stage;
      c.targetQuantity = Math.max(
        0,
        c.baseQuantity - roundLot(c.baseQuantity * 0.3) * stage,
      );
      c.stopCents = Math.max(
        c.stopCents,
        Math.ceil(c.strategicCostCents / c.strategicQuantity),
      );
    }
    if (c.stage) c.stopCents = Math.max(c.stopCents, c.highCents - c.r0Cents);
    if (price <= c.stopCents) {
      c.exit = true;
      target = 0;
      reason = "跟踪保护退出";
    } else if (
      c.targetQuantity != null &&
      qty(p) >
        c.targetQuantity +
          (!newStage && c.t?.direction === "FORWARD"
            ? c.t.firstQuantity - c.t.secondQuantity
            : 0)
    ) {
      target = c.targetQuantity;
      reason = "按累计盈利档位减仓";
    }
  }
  if (target == null) return false;
  if (c.t) recordT(book, p, "ABORTED_BY_RISK", session.date);
  c.targetQuantity = Math.min(c.targetQuantity ?? Infinity, target);
  for (const o of session.orders.filter(
    (o) => o.code === p.code && o.side === "BUY" && !terminal.has(o.status),
  ))
    o.status = "CANCELLED";
  const desired = Math.max(0, qty(p) - c.targetQuantity),
    action = target === 0 ? "EXIT" : "REDUCE";
  if (desired > 0) {
    const order = addOrder(session, p.code, action, reason);
    order.quantity = order.filledQuantity + desired;
    fill(book, session, item, order, "SELL", desired, ledger);
  }
  return true;
}
function processT(book, session, item, ledger, regime, recoveringOnly = false) {
  const p = qOf(book, item.quote.code);
  if (!p?.dragon || p.dragon.exit) return;
  const c = p.dragon,
    conf = session.plan.dragonPolicy.config,
    time = clock(session.lastObservedAt),
    price = item.quote.closeCents;
  let t = c.t;
  if (
    !t &&
    !recoveringOnly &&
    regime.t &&
    !session.dailyPaused &&
    !book.dragonHalted &&
    !(book.dragonCooldownDays > 0) &&
    c.dayAction !== session.date &&
    c.startDate < session.date &&
    time >= "09:35:00" &&
    time < "14:45:00"
  ) {
    const path = session.entryState.paths[p.code],
      reference = item.quote.previousCloseCents;
    const direction =
      conf.operations.tForward &&
      price <= reference * 0.98 &&
      path?.stableQuotes >= 1
        ? "FORWARD"
        : conf.operations.tReverse &&
            price >= reference * 1.02 &&
            (path?.downQuotes ?? 0) >= 1
          ? "REVERSE"
          : null;
    const quantity = roundLot(
      availableQuantity(p, session.date) * conf.advanced.tFraction,
    );
    if (!direction || quantity < 100) return;
    const expected = quantity * price * conf.advanced.tSpread;
    if (
      expected <=
      transactionFees(
        quantity * price,
        "BUY",
        session.plan.feeConfig,
        session.plan.feeModel,
      ).total +
        transactionFees(
          quantity * price,
          "SELL",
          session.plan.feeConfig,
          session.plan.feeModel,
        ).total +
        quantity * price * 0.006
    )
      return;
    let budget;
    if (direction === "REVERSE") {
      const reduced = clone(book),
        simulated = qOf(reduced, p.code);
      let remaining = quantity;
      for (const l of simulated.lots) {
        if (l.acquiredDate >= session.date) continue;
        const n = Math.min(remaining, l.quantity);
        l.quantity -= n;
        remaining -= n;
      }
      reduced.cashCents += quantity * price;
      budget = dragonBudget(
        reduced,
        session,
        p.code,
        Math.ceil(price * 1.03),
        c.stopCents,
        "T_RECOVERY",
        quantity,
      );
    } else
      budget = dragonBudget(
        book,
        session,
        p.code,
        Math.ceil(price * 1.03),
        c.stopCents,
        "T_FIRST",
        quantity,
      );
    if (budget.quantity < 100) return;
    const desired = Math.min(quantity, budget.quantity);
    const order = addOrder(session, p.code, `T_${direction}`, "做 T 第一腿", {
      side: "PAIR",
      quantity: desired,
    });
    order.maxPriceCents = Math.ceil(price * 1.03);
    const result = fill(
      book,
      session,
      item,
      order,
      direction === "FORWARD" ? "BUY" : "SELL",
      desired,
      ledger,
      budget,
    );
    if (!result) return;
    c.dayAction = session.date;
    t = c.t = {
      id: order.id,
      direction,
      date: session.date,
      firstQuantity: result.quantity,
      secondQuantity: 0,
      firstNotional: result.notional,
      firstPriceCents: result.price,
      cashDeltaCents: result.cashDelta,
      reservePriceCents: Math.ceil(result.price * 1.03),
      lastQuote: item.quote.timestamp,
      spread: conf.advanced.tSpread,
    };
    order.status = "FIRST_LEG";
    order.quantity = result.quantity;
    order.firstFilled = result.quantity;
    return;
  }
  if (!t || Date.parse(item.quote.timestamp) <= Date.parse(t.lastQuote)) return;
  const secondBuy = t.direction === "REVERSE";
  const trigger = secondBuy
    ? price <= t.firstPriceCents * (1 - t.spread)
    : price >= t.firstPriceCents * (1 + t.spread);
  if (!trigger && time < "14:50:00") return;
  const remaining = t.firstQuantity - t.secondQuantity;
  const order = addOrder(session, p.code, "T_RECOVERY", "完成做 T 第二腿", {
    side: secondBuy ? "BUY" : "SELL",
    quantity: remaining,
  });
  order.quantity = order.filledQuantity + remaining;
  order.maxPriceCents = t.reservePriceCents;
  const budget = secondBuy
    ? dragonBudget(
        book,
        session,
        p.code,
        t.reservePriceCents,
        c.stopCents,
        "T_RECOVERY",
        remaining,
      )
    : null;
  const result = fill(
    book,
    session,
    item,
    order,
    secondBuy ? "BUY" : "SELL",
    secondBuy ? budget.quantity : remaining,
    ledger,
    budget,
  );
  if (!result) return;
  c.dayAction = session.date;
  t.secondQuantity += result.quantity;
  t.cashDeltaCents += result.cashDelta;
  t.lastQuote = item.quote.timestamp;
  const firstOrder = session.orders.find((o) => o.id === t.id);
  if (firstOrder) {
    firstOrder.secondFilled = t.secondQuantity;
    firstOrder.status = "SECOND_LEG";
  }
  if (t.secondQuantity === t.firstQuantity) {
    recordT(book, p, "COMPLETED", session.date);
    const first = session.orders.find((o) => o.id === t.id);
    if (first) first.status = "FILLED";
  }
}
function processEntry(book, session, item, observation, ledger, regime) {
  const code = item.quote.code,
    h = session.plan.entryExecutionPolicy.history[code],
    conf = session.plan.dragonPolicy.config;
  const p = qOf(book, code),
    c = p?.dragon,
    path = session.entryState.paths[code];
  if (
    !eligible(
      h,
      observation.entryInputs?.market?.discoveries?.find(
        (s) => s.code === code,
      ),
    ) ||
    !path
  )
    return;
  const sector = observation.entryInputs?.market?.sectors?.find(
    (s) => s.name === h.sector,
  );
  if (
    !Number.isFinite(sector?.score) ||
    sector.score < DRAGON_RULES.sectorMinimum ||
    !regime.open ||
    session.dailyPaused ||
    book.dragonHalted ||
    path.stableQuotes < 1 ||
    !(item.volume > 0) ||
    (h.previousVolumeShares > 0 &&
      item.quote.volumeShares > h.previousVolumeShares * 3)
  )
    return;
  const time = clock(observation.observedAt);
  const types = typesAt(
    session.plan.entryExecutionPolicy,
    h,
    item.quote,
    path,
    time,
    observation.entryInputs?.auction?.[code],
    session.date,
  ).filter((type) => conf.buyPoints[type]);
  const pending = session.orders.find(
    (o) =>
      o.code === code &&
      ["OPEN", "ADD_PROFIT", "ADD_LOSS"].includes(o.intent) &&
      o.filledQuantity > 0 &&
      o.filledQuantity < o.quantity &&
      !terminal.has(o.status),
  );
  if (
    !types.length ||
    c?.exit ||
    c?.t ||
    c?.stage ||
    (c?.startDate === session.date && !pending)
  )
    return;
  let intent = "OPEN",
    maxQuantity = Infinity;
  if (pending) {
    intent = pending.intent;
    maxQuantity = pending.quantity - pending.filledQuantity;
  } else if (c) {
    const r = (item.quote.closeCents - c.p0Cents) / c.r0Cents;
    if (
      regime.profitAdd &&
      conf.operations.profitAdd &&
      r >= 0.5 &&
      r < 1 &&
      !c.profitAdded
    ) {
      intent = "ADD_PROFIT";
      maxQuantity = roundLot(c.initialQuantity * 0.5);
    } else if (
      regime.lossAdd &&
      conf.operations.lossAdd &&
      r >= -0.75 &&
      r <= -0.5 &&
      !c.lossAdded &&
      types[0] !== "limit-up-momentum"
    ) {
      intent = "ADD_LOSS";
      maxQuantity = roundLot(c.initialQuantity * 0.25);
    } else return;
  }
  let order = session.orders.find(
    (o) => o.code === code && o.intent === intent,
  );
  if (c?.dayAction === session.date && (!order || terminal.has(order.status)))
    return;
  if (order && terminal.has(order.status)) return;
  const triggerPrice = order?.triggerPriceCents ?? item.quote.closeCents;
  const maxPrice = Math.floor(triggerPrice * (1 + DRAGON_RULES.maxChase));
  const stop =
    c?.stopCents ?? Math.floor(triggerPrice * (1 - conf.advanced.stopLoss));
  const budget = dragonBudget(
    book,
    session,
    code,
    maxPrice,
    stop,
    intent,
    maxQuantity,
    order?.id,
  );
  if (!order) {
    order = addOrder(session, code, intent, budget.reason, {
      quantity: budget.quantity,
      triggerPriceCents: triggerPrice,
      maxPriceCents: maxPrice,
      stopCents: stop,
      buyPoint: types[0],
      expiresAt: INTRADAY_ENTRY_RULES.windows[types[0]].find(
        ([a, b]) => time >= a && time <= b,
      )?.[1],
    });
  }
  if (time > order.expiresAt) {
    order.status = order.filledQuantity ? "EXPIRED_PARTIAL" : "EXPIRED";
    return;
  }
  if (order.quantity < 100 && !order.filledQuantity)
    order.quantity = budget.quantity;
  const result = fill(
    book,
    session,
    item,
    order,
    "BUY",
    Math.min(budget.quantity, order.quantity - order.filledQuantity),
    ledger,
    budget,
  );
  if (!result) return;
  const position = result.position;
  if (!position.dragon)
    position.dragon = {
      id: `${session.date}:${code}`,
      startDate: session.date,
      p0Cents: result.price + Math.ceil(result.fee / result.quantity),
      r0Cents: Math.max(
        1,
        Math.ceil(
          (result.price + result.fee / result.quantity) *
            conf.advanced.stopLoss,
        ),
      ),
      stopCents: Math.floor(
        (result.price + result.fee / result.quantity) *
          (1 - conf.advanced.stopLoss),
      ),
      initialQuantity: 0,
      strategicQuantity: 0,
      strategicCostCents: 0,
      stage: 0,
      highCents: result.price,
      holdDays: DRAGON_HOLD_DAYS[order.buyPoint],
      buyPoint: order.buyPoint,
      dayAction: session.date,
    };
  const state = position.dragon;
  if (intent === "OPEN") {
    state.initialQuantity += result.quantity;
    state.p0Cents = Math.ceil(
      (state.strategicCostCents + result.notional + result.fee) /
        (state.strategicQuantity + result.quantity),
    );
    state.r0Cents = Math.ceil(state.p0Cents * conf.advanced.stopLoss);
    state.stopCents = Math.max(
      state.stopCents,
      Math.floor(state.p0Cents * (1 - conf.advanced.stopLoss)),
    );
  } else state[intent === "ADD_PROFIT" ? "profitAdded" : "lossAdded"] = true;
  state.strategicQuantity += result.quantity;
  state.strategicCostCents += result.notional + result.fee;
  state.dayAction = session.date;
}
export function advanceDragonSession(inputBook, inputSession, observation) {
  assertDragonPlan(inputSession.plan, inputBook);
  if (!isDragon(inputBook) || !isDragon(inputSession))
    throw new Error("新旧会话政策不能混用");
  const book = clone(inputBook),
    session = clone(inputSession),
    ledger = [];
  if (session.status !== "OPEN") return { book, session, ledger };
  const now = Date.parse(observation.observedAt),
    time = clock(observation.observedAt);
  if (
    !Number.isFinite(now) ||
    new Date(now + 8 * 3600000).toISOString().slice(0, 10) !== session.date ||
    !(
      (time >= "09:30:00" && time <= "11:30:00") ||
      (time >= "13:00:00" && time < "14:57:00")
    )
  )
    throw new Error("不在本交易日连续竞价时段");
  if (session.lastObservedAt && now <= Date.parse(session.lastObservedAt))
    return { book, session, ledger };
  session.sequence++;
  session.lastObservedAt = observation.observedAt;
  for (const o of session.orders)
    if (o.expiresAt && time > o.expiresAt && !terminal.has(o.status))
      o.status = o.filledQuantity ? "EXPIRED_PARTIAL" : "EXPIRED";
  const rule = marketState(session, observation),
    regime = { ...rule, phase: session.regime.phase };
  const history = session.plan.entryExecutionPolicy.history;
  for (const row of observation.entryInputs?.market?.discoveries ?? []) {
    if (
      Object.keys(session.entryState.admissions).length >=
      INTRADAY_ENTRY_RULES.maxCandidates
    )
      break;
    if (eligible(history[row.code], row))
      session.entryState.admissions[row.code] ??= { code: row.code };
  }
  const accepted = [];
  for (const [code, raw] of Object.entries(observation.quotes ?? {})) {
    if (
      !/^\d{6}$/.test(code) ||
      (!session.entryState.admissions[code] && !qOf(book, code))
    )
      continue;
    const quote = { ...raw, code },
      last = session.quotes[code];
    if (
      quote.date !== session.date ||
      !fresh(quote.timestamp, now, 15000) ||
      !(quote.closeCents > 0) ||
      !Number.isFinite(quote.volumeShares) ||
      quote.volumeShares < 0 ||
      (last && Date.parse(quote.timestamp) <= Date.parse(last.timestamp))
    )
      continue;
    const expected =
      session.initialBook.positions.find((p) => p.code === code)?.markCents ??
      history[code]?.previousCloseCents;
    if (
      !expected ||
      Math.abs(quote.previousCloseCents - expected) >
        Math.max(1, expected * 0.001)
    )
      continue;
    const contiguous =
      last && Date.parse(quote.timestamp) - Date.parse(last.timestamp) <= 20000;
    const volume =
      contiguous && quote.volumeShares >= last.volumeShares
        ? quote.volumeShares - last.volumeShares
        : 0;
    session.entryState.admissions[code] ??= { code };
    updateEntryPath(session, code, quote, last, volume, observation.observedAt);
    const path = session.entryState.paths[code];
    path.downQuotes =
      contiguous && volume > 0 && quote.closeCents <= last.closeCents
        ? (path.downQuotes ?? 0) + 1
        : 0;
    session.quotes[code] = quote;
    const position = qOf(book, code);
    if (position) {
      position.markCents = quote.closeCents;
      position.markDate = session.date;
    }
    accepted.push({ quote, volume });
  }
  mark(book);
  session.missingHoldingQuotes = book.positions.some(
    (p) => !fresh(session.quotes[p.code]?.timestamp, now, 15000),
  );
  const risk = session.plan.dragonPolicy.config.risk;
  if (1 - book.equityCents / session.initialBook.equityCents >= risk.dailyLoss)
    session.dailyPaused = true;
  if (
    1 - book.equityCents / (book.dragonRiskPeakCents ?? book.peakEquityCents) >=
    risk.drawdown
  )
    book.dragonHalted = true;
  const blocked = new Set();
  for (const item of accepted)
    if (processProtection(book, session, item, ledger, regime))
      blocked.add(item.quote.code);
  for (const item of accepted)
    if (!blocked.has(item.quote.code))
      processT(book, session, item, ledger, regime, true);
  const rank = (item) => {
    const code = item.quote.code,
      h = history[code],
      path = session.entryState.paths[code];
    return h && path
      ? INTRADAY_ENTRY_RULES.priority.indexOf(
          typesAt(
            session.plan.entryExecutionPolicy,
            h,
            item.quote,
            path,
            time,
            observation.entryInputs?.auction?.[code],
            session.date,
          )[0],
        )
      : 99;
  };
  accepted.sort(
    (a, b) =>
      (rank(a) < 0 ? 99 : rank(a)) - (rank(b) < 0 ? 99 : rank(b)) ||
      (history[b.quote.code]?.amount ?? 0) -
        (history[a.quote.code]?.amount ?? 0) ||
      a.quote.code.localeCompare(b.quote.code),
  );
  for (const item of accepted)
    if (!blocked.has(item.quote.code))
      processEntry(book, session, item, observation, ledger, regime);
  for (const item of accepted)
    if (!blocked.has(item.quote.code))
      processT(book, session, item, ledger, regime);
  mark(book);
  return { book, session, ledger };
}
export function closeDragonSession(inputBook, inputSession, dataset) {
  assertDragonPlan(inputSession.plan, inputBook);
  const book = clone(inputBook),
    session = clone(inputSession),
    notices = [];
  if (session.status !== "OPEN" || dataset.date !== session.date)
    throw new Error("新政策交易日状态无效");
  for (const p of book.positions) {
    const quote = dataset.quotes[p.code],
      old = session.initialBook.positions.find((x) => x.code === p.code);
    if (
      !quote ||
      quote.date !== session.date ||
      !(quote.closeCents > 0) ||
      !Number.isFinite(Date.parse(quote.timestamp)) ||
      clock(quote.timestamp) < "15:00:00"
    )
      throw new Error(`${p.code} 缺少最终收盘价`);
    if (
      old &&
      Math.abs(quote.previousCloseCents - old.markCents) >
        Math.max(1, old.markCents * 0.001)
    )
      throw new Error("昨收与账面价格不一致");
    p.markCents = quote.closeCents;
    p.markDate = session.date;
    p.heldDays++;
    if (quote.closingSource === "FRAME_LAST_OBSERVED")
      notices.push(`${p.code} 缺少最终收盘报价`);
  }
  mark(book);
  book.pendingRecovery = book.positions
    .filter((p) => p.dragon?.t)
    .map((p) => ({
      code: p.code,
      quantity: p.dragon.t.firstQuantity - p.dragon.t.secondQuantity,
      side: p.dragon.t.direction === "FORWARD" ? "SELL" : "BUY",
      tradingPolicyVersion: VERSION,
    }));
  book.pendingExits = book.positions
    .filter((p) => p.dragon?.exit)
    .map((p) => ({ code: p.code }));
  book.pendingOrders = [];
  if (session.cooldownAtStart > 0 && book.dragonCooldownDate !== session.date)
    book.dragonCooldownDays = Math.max(0, session.cooldownAtStart - 1);
  book.lastDate = session.date;
  book.settlementCount++;
  session.status = "CLOSED";
  for (const o of session.orders)
    if (
      ["OPEN", "ADD_PROFIT", "ADD_LOSS"].includes(o.intent) &&
      !terminal.has(o.status)
    )
      o.status = o.filledQuantity ? "EXPIRED_PARTIAL" : "EXPIRED";
  const marketValueCents = book.equityCents - book.cashCents;
  const unrealizedPnlCents = book.positions.reduce(
    (s, p) => s + qty(p) * p.markCents - costBasis(p),
    0,
  );
  if (
    book.equityCents - book.initialCashCents !==
      book.realizedPnlCents + unrealizedPnlCents ||
    book.cashCents < 0
  )
    throw new Error("新政策账本不守恒");
  return {
    book,
    session,
    ledger: [],
    outcomes: session.orders,
    notices,
    equity: {
      date: session.date,
      cashCents: book.cashCents,
      marketValueCents,
      equityCents: book.equityCents,
      dailyPnlCents: book.equityCents - session.initialBook.equityCents,
      dailyReturn: book.equityCents / session.initialBook.equityCents - 1,
      totalReturn: book.equityCents / book.initialCashCents - 1,
      realizedPnlCents: book.realizedPnlCents,
      unrealizedPnlCents,
      feesCents: book.feesCents,
      drawdown: 1 - book.equityCents / book.peakEquityCents,
      complete: !notices.length,
      positionCount: book.positions.length,
      source: dataset.source,
    },
  };
}
