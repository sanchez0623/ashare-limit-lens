import { canonicalJson } from "./research-lineage.js";
import { BUY_POINT_TYPES as TYPES } from "../../shared/buy-point-type.js";
import { STOCK_CLASSES } from "../../shared/stock-class.js";
import { planRiskLimits } from "../../shared/risk-limits.js";
import { allocationState, allocateEntry } from "./strategy-program.js";

export const INTRADAY_ENTRY_VERSION = "intraday-entry-v1";
export const ENTRY_EXECUTION_MODES = Object.freeze([
  "next-open",
  "intraday-conditional",
]);
export function assertEntryHistoryProcessed(snapshot) {
  const pending = new Set([
    ...(snapshot?.dailyPriceSources?.pendingCodes ?? []),
    ...(snapshot?.intradayEntryContext?.dataSources?.pendingCodes ?? []),
  ]);
  if (pending.size)
    throw new Error(
      `日线回补尚有 ${pending.size} 只未处理，等待补齐后冻结计划`,
    );
}
export const INTRADAY_ENTRY_RULES = Object.freeze({
  version: INTRADAY_ENTRY_VERSION,
  maxCandidates: 200,
  maxPremarketCandidates: 100,
  minTurnoverCny: 300000000,
  quoteMaxAgeMs: 15000,
  marketMaxAgeMs: 120000,
  confirmationQuotes: 2,
  maxVolumeMultiple: 3,
  windows: {
    [TYPES.AUCTION_DIP]: [["09:30:00", "10:00:00"]],
    [TYPES.FAKE_NEG_LIMIT_DIP]: [["09:30:00", "10:00:00"]],
    [TYPES.LIMIT_UP_MOMENTUM]: [
      ["09:30:00", "10:30:00"],
      ["13:00:00", "14:30:00"],
    ],
    [TYPES.BROKEN_BOARD_DIP]: [
      ["09:30:00", "11:30:00"],
      ["13:00:00", "14:55:00"],
    ],
    [TYPES.FIRST_NEG_DIP]: [["14:30:00", "14:55:00"]],
    [TYPES.LATE_DIP]: [["14:30:00", "14:55:00"]],
  },
  priority: [
    TYPES.LIMIT_UP_MOMENTUM,
    TYPES.FAKE_NEG_LIMIT_DIP,
    TYPES.BROKEN_BOARD_DIP,
    TYPES.FIRST_NEG_DIP,
    TYPES.AUCTION_DIP,
    TYPES.LATE_DIP,
  ],
});
const lot = (n) => Math.floor(Math.max(0, n) / 100) * 100;
const quantity = (p) => p.lots.reduce((n, l) => n + l.quantity, 0);
const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const hm = (stamp) =>
  new Date(Date.parse(stamp) + 8 * 3600000).toISOString().slice(11, 19);
const windowFor = (type, time) =>
  INTRADAY_ENTRY_RULES.windows[type]?.find(
    ([start, end]) => time >= start && time <= end,
  );
const ageOk = (stamp, now, maxAge) =>
  Number.isFinite(Date.parse(stamp)) &&
  now - Date.parse(stamp) >= 0 &&
  now - Date.parse(stamp) <= maxAge;

export function assertEntryPolicy(plan) {
  const policy = plan?.entryExecutionPolicy;
  if (!policy) return null;
  if (
    policy.version !== INTRADAY_ENTRY_VERSION ||
    canonicalJson(policy.rules) !== canonicalJson(INTRADAY_ENTRY_RULES)
  )
    throw new Error("盘中入场规则版本或内容不一致");
  if (
    policy.sourceDate !== plan.signalDate ||
    !policy.history ||
    !Array.isArray(policy.candidates)
  )
    throw new Error("盘中入场缺少冻结的候选准入依据");
  return policy;
}

export function withIntradayEntry(plan, snapshot, book) {
  if ((book.entryExecutionMode ?? "next-open") === "next-open")
    return snapshot.intradayEntryContext
      ? { ...plan, entryExecutionMode: "next-open" }
      : plan;
  if (book.entryExecutionMode !== "intraday-conditional")
    throw new Error("未知交易执行方式");
  assertEntryHistoryProcessed(snapshot);
  if (plan.selectionPolicy?.version !== "signal-ranking-v5")
    throw new Error("盘中条件执行需要 V5 选股政策");
  if (!plan.executionCostPolicy)
    throw new Error("盘中条件执行需要冻结的成交成本政策");
  const context = snapshot.intradayEntryContext;
  if (
    !plan.sourceSnapshotMissing &&
    (context?.version !== INTRADAY_ENTRY_VERSION ||
      context.asOf !== plan.signalDate)
  )
    throw new Error("信号快照缺少当日冻结的盘中候选历史，请等待新快照");
  const history = context?.history ?? {};
  const ranked = [
    ...(snapshot.stocks ?? []),
    ...(snapshot.brokenStocks ?? []),
    ...(snapshot.extraStocks ?? []),
  ]
    .filter(
      (s) => history[s.code] && !book.positions.some((p) => p.code === s.code),
    )
    .sort(
      (a, b) =>
        (b.scoreValue ?? b.score ?? 0) - (a.scoreValue ?? a.score ?? 0) ||
        a.code.localeCompare(b.code),
    )
    .map((s) => s.code);
  const candidates = [
    ...new Set([
      ...ranked,
      ...Object.keys(history)
        .filter(
          (code) =>
            eligible(history[code], null) &&
            !book.positions.some((p) => p.code === code),
        )
        .sort(),
    ]),
  ].slice(0, INTRADAY_ENTRY_RULES.maxPremarketCandidates);
  return {
    ...plan,
    entryExecutionMode: "intraday-conditional",
    entryExecutionPolicy: {
      version: INTRADAY_ENTRY_VERSION,
      rules: structuredClone(INTRADAY_ENTRY_RULES),
      sourceDate: plan.signalDate,
      ...(context?.industrySnapshotId
        ? { industrySnapshotId: context.industrySnapshotId }
        : {}),
      history: structuredClone(history),
      candidates,
      firstNegMinPrevHeight: context?.firstNegMinPrevHeight ?? 3,
    },
    // 条件执行取代原来的 OPEN/ADD。已有仓位的保护、减仓及做 T 继续由原引擎管理。
    orders: plan.orders.filter(
      (o) => !["OPEN", "ADD"].includes(o.action) || o.recovery,
    ),
    constraints:
      "盘前冻结规则；盘中条件触发；T+1；整手及共享资金上限；缺少可成交证据不模拟成交。",
  };
}

export function initialEntryState(plan) {
  const policy = assertEntryPolicy(plan);
  if (!policy) return null;
  return {
    version: policy.version,
    admissions: Object.fromEntries(
      policy.candidates.map((code) => [
        code,
        { code, source: "PREMARKET", admittedAt: plan.createdAt },
      ]),
    ),
    paths: {},
    openedCodes: [],
    coverage: { acceptedQuotes: 0, marketFrames: 0 },
  };
}

export function eligible(history, marketRow) {
  if (!history) return false;
  const amount = Math.max(
    num(history.amount) ?? 0,
    num(marketRow?.amount) ?? 0,
  );
  return (
    history.recentLimitUp === true &&
    amount >= INTRADAY_ENTRY_RULES.minTurnoverCny &&
    typeof history.name === "string" &&
    !/ST|退/i.test(history.name) &&
    history.sector &&
    history.sector !== "未分类" &&
    history.previousCloseCents > 0 &&
    [
      STOCK_CLASSES.RELAY_LEADER,
      STOCK_CLASSES.STRONG_REVERSAL,
      STOCK_CLASSES.SWING_RANGE,
    ].includes(history.stockClass)
  );
}

export function updateEntryAdmissions(session, observation) {
  const policy = assertEntryPolicy(session.plan);
  if (!policy) return;
  const state = session.entryState;
  const market = observation.entryInputs?.market;
  const now = Date.parse(observation.observedAt);
  const validMarket =
    market?.date === session.date &&
    ageOk(market.observedAt, now, policy.rules.marketMaxAgeMs);
  if (validMarket) {
    state.coverage.marketFrames++;
    for (const row of [...(market.discoveries ?? [])].sort((a, b) =>
      a.code.localeCompare(b.code),
    )) {
      if (Object.keys(state.admissions).length >= policy.rules.maxCandidates)
        break;
      const history = policy.history[row.code];
      if (!history || state.admissions[row.code] || !eligible(history, row))
        continue;
      state.admissions[row.code] = {
        code: row.code,
        source: "INTRADAY_POOL",
        admittedAt: observation.observedAt,
        sourceObservedAt: market.observedAt,
      };
    }
  }
  for (const [code, admission] of Object.entries(state.admissions)) {
    if (session.orders.some((o) => o.conditionalEntry && o.code === code))
      continue;
    const history = policy.history[code];
    session.orders.push({
      id: `${session.date}:${code}:conditional-entry`,
      code,
      name: history.name,
      sector: history.sector,
      stockClass: history.stockClass,
      referenceCents: history.previousCloseCents,
      action: "OPEN",
      side: "BUY",
      quantity: 0,
      filledQuantity: 0,
      firstFilled: 0,
      secondFilled: 0,
      attempts: 0,
      status: "WATCHING",
      allDay: true,
      conditionalEntry: true,
      admission: structuredClone(admission),
      reason: "观察买点，尚未达到触发条件",
    });
  }
}

export function updateEntryPath(
  session,
  code,
  quote,
  previous,
  volume,
  observedAt,
) {
  if (!session.entryState || !session.entryState.admissions[code]) return;
  const state = session.entryState;
  const time = hm(observedAt);
  const last = state.paths[code] ?? {
    stableQuotes: 0,
    touched: false,
    opened: false,
    tailHighCents: null,
  };
  const contiguous =
    previous &&
    Date.parse(quote.timestamp) - Date.parse(previous.timestamp) <= 20000 &&
    volume > 0;
  last.stableQuotes =
    contiguous && quote.closeCents >= previous.closeCents
      ? last.stableQuotes + 1
      : 0;
  if (quote.limitUpCents > 0 && quote.closeCents >= quote.limitUpCents) {
    if (!last.touched) last.firstTouchAt = observedAt;
    if (last.opened) last.resealedAt = observedAt;
    last.touched = true;
    last.momentumAt = observedAt;
  }
  if (last.touched && quote.closeCents < quote.limitUpCents) last.opened = true;
  // 日内最高价可证明曾触板，但不能证明触板发生在某个特定时间。
  if (quote.highCents >= quote.limitUpCents && quote.limitUpCents > 0)
    last.touched = true;
  if (time >= "14:30:00" && time <= "14:55:00") {
    last.tailHighCents = Math.max(
      last.tailHighCents ?? quote.closeCents,
      quote.closeCents,
    );
    if (!last.tailStartedAt) last.tailStartedAt = observedAt;
  }
  last.lastObservedAt = observedAt;
  state.paths[code] = last;
  state.coverage.acceptedQuotes++;
}

export function typesAt(policy, history, quote, path, time, auction, date) {
  const result = [];
  const pct = (quote.closeCents / quote.previousCloseCents - 1) * 100;
  const gap = (quote.openCents / quote.previousCloseCents - 1) * 100;
  const level =
    quote.limitUpCents > 0
      ? (quote.limitUpCents / quote.previousCloseCents) * 100 - 100
      : null;
  const pullback =
    quote.limitUpCents > 0
      ? (1 - quote.closeCents / quote.limitUpCents) * 100
      : null;
  const isLeader = history.stockClass === STOCK_CLASSES.RELAY_LEADER;
  const strong =
    isLeader || history.stockClass === STOCK_CLASSES.STRONG_REVERSAL;
  const auctionValid =
    auction?.date === date &&
    auction.final === true &&
    auction.openCents === quote.openCents &&
    auction.previousCloseCents === quote.previousCloseCents;
  if (
    strong &&
    auctionValid &&
    history.previousChange >= 5 &&
    gap <= -5 &&
    level !== null &&
    gap > -level + 0.5
  )
    result.push(TYPES.AUCTION_DIP);
  if (
    strong &&
    auctionValid &&
    history.previousOpenCents > history.previousCloseCents &&
    history.previousChange >= -2 &&
    history.previousChange <= 2 &&
    history.previousTouchedLimit === true &&
    gap <= -8 &&
    quote.closeCents > quote.limitDownCents
  )
    result.push(TYPES.FAKE_NEG_LIMIT_DIP);
  const momentumFresh =
    path.momentumAt &&
    Date.parse(path.lastObservedAt) - Date.parse(path.momentumAt) <= 60000;
  if (
    isLeader &&
    momentumFresh &&
    quote.closeCents >= quote.limitUpCents * 0.99 &&
    (time < "13:00:00" || path.resealedAt)
  )
    result.push(TYPES.LIMIT_UP_MOMENTUM);
  if (isLeader && path.touched && pullback >= 3 && pullback <= 7)
    result.push(TYPES.BROKEN_BOARD_DIP);
  const ma5 =
    history.lastFourCloseSumCents > 0
      ? (history.lastFourCloseSumCents + quote.closeCents) / 5
      : null;
  if (
    strong &&
    history.previousHeight >= policy.firstNegMinPrevHeight &&
    quote.openCents > quote.closeCents &&
    pct < 0 &&
    pct >= -5 &&
    ma5 !== null &&
    quote.closeCents >= ma5
  )
    result.push(TYPES.FIRST_NEG_DIP);
  const latePullback = path.tailHighCents
    ? (1 - quote.closeCents / path.tailHighCents) * 100
    : null;
  if (
    latePullback >= 3 &&
    latePullback <= 5 &&
    quote.closeCents > quote.limitDownCents &&
    quote.closeCents < quote.limitUpCents
  )
    result.push(TYPES.LATE_DIP);
  return policy.rules.priority.filter(
    (type) => result.includes(type) && windowFor(type, time),
  );
}

export function assessEntry(session, book, order, observation, quote, volume) {
  const policy = assertEntryPolicy(session.plan);
  const now = Date.parse(observation.observedAt);
  const time = hm(observation.observedAt);
  const expired = order.entryTrigger
    ? time > order.entryTrigger.expiresAt
    : time > "14:55:00";
  if (expired)
    return { expired: true, reason: "买点有效窗口结束，取消剩余买入" };
  const market = observation.entryInputs?.market;
  const history = policy.history[order.code];
  const row = market?.discoveries?.find((s) => s.code === order.code);
  if (
    !market ||
    market.date !== session.date ||
    !ageOk(market.observedAt, now, policy.rules.marketMaxAgeMs)
  )
    return {
      status: "DATA_INSUFFICIENT",
      reason: "缺少当日有效的板块及市场风险数据",
    };
  if (!eligible(history, row))
    return {
      status: "DATA_INSUFFICIENT",
      reason: "分类、涨停基因或三亿元流动性资格未验证",
    };
  const sector = market.sectors?.find((s) => s.name === history.sector);
  if (
    !Number.isFinite(sector?.score) ||
    sector.score < session.plan.strategy.minSectorScore ||
    !Number.isFinite(market.emotion) ||
    market.emotion < (session.plan.strategy.exposureTiers?.midEmotion ?? 40) ||
    !Number.isFinite(market.cycle?.maxGrossExposure) ||
    market.cycle.maxGrossExposure <= 0.2
  )
    return {
      status: "WATCHING",
      reason: "市场情绪、板块协同或周期限制新增建仓",
    };
  const path = session.entryState.paths[order.code];
  const types = path
    ? typesAt(
        policy,
        history,
        quote,
        path,
        time,
        observation.entryInputs?.auction?.[order.code],
        session.date,
      )
    : [];
  const type = order.entryTrigger?.type ?? types[0];
  if (!type || !types.includes(type))
    return { status: "WATCHING", reason: "当前未满足有效买点，继续观察" };
  if (path.stableQuotes < policy.rules.confirmationQuotes - 1 || !(volume > 0))
    return {
      status: "WAITING_CONFIRMATION",
      reason: "等待连续有效报价确认企稳与成交量",
    };
  if (
    quote.orderBookQuality !== "OK" ||
    !(quote.ask1Cents > 0) ||
    !(quote.ask1Shares > 0) ||
    !ageOk(quote.orderBookTimestamp, now, policy.rules.quoteMaxAgeMs)
  )
    return {
      status: "DATA_INSUFFICIENT",
      reason: "缺少可验证的卖盘，不能假设成交",
    };
  if (
    history.previousVolumeShares > 0 &&
    quote.volumeShares >
      history.previousVolumeShares * policy.rules.maxVolumeMultiple
  )
    return { status: "WATCHING", reason: "成交量异常放大，暂停该买点" };
  const owned = book.positions.find((p) => p.code === order.code);
  if (
    (owned || session.entryState.openedCodes.includes(order.code)) &&
    !order.filledQuantity
  )
    return { status: "BLOCKED", reason: "同股当日只新建仓一次，不追加补仓" };
  if (!owned && book.positions.length >= session.plan.strategy.maxPositions)
    return { status: "BLOCKED", reason: "实际持仓名额已用完" };
  const risk = planRiskLimits(session.plan);
  const equity = book.equityCents;
  const exposure = book.positions.reduce(
    (n, p) => n + quantity(p) * p.markCents,
    0,
  );
  const cap = Math.min(
    session.plan.targetExposure,
    session.plan.maxExposure ?? 1,
    risk.maxGrossExposure,
    market.cycle.maxGrossExposure,
  );
  const budget = Math.floor(
    Math.max(
      0,
      Math.min(
        book.cashCents - 1000,
        equity * cap - exposure,
        equity * risk.maxPositionWeight -
          (owned ? quantity(owned) * owned.markCents : 0),
        (equity * cap) / session.plan.strategy.maxPositions,
      ),
    ),
  );
  if (budget < quote.ask1Cents * 100)
    return { status: "BLOCKED", reason: "剩余现金或共享仓位预算不足一手" };
  const trigger = order.entryTrigger ?? {
    type,
    observedAt: observation.observedAt,
    priceCents: quote.closeCents,
    expiresAt: windowFor(type, time)[1],
  };
  const maxPriceCents = Math.round(
    trigger.priceCents * (1 + session.plan.strategy.maxBuyGap),
  );
  if (quote.ask1Cents > maxPriceCents)
    return { status: "WATCHING", reason: "现价超过首次触发时确定的追价上限" };
  let desired = order.filledQuantity
    ? order.quantity - order.filledQuantity
    : lot(budget / maxPriceCents);
  let strategyAllocations;
  if (session.plan.strategyProgram && !order.filledQuantity) {
    const allocation = allocateEntry(
      {
        ...row,
        ...history,
        code: order.code,
        sectorScore: sector.score,
        height: row?.height ?? history.previousHeight,
        consecutiveBoards: row?.height ?? history.previousHeight,
      },
      { stocks: market.discoveries ?? [] },
      allocationState(session.plan.strategyProgram, book, cap),
      desired,
      maxPriceCents,
    );
    desired = allocation.quantity;
    strategyAllocations = allocation.allocations;
  }
  if (desired < 100)
    return { status: "BLOCKED", reason: "家族分配或剩余预算不足一手" };
  return {
    ready: true,
    type,
    trigger,
    desired,
    budgetCents: budget,
    maxPriceCents,
    strategyAllocations,
    evidence: {
      version: policy.version,
      type,
      observedAt: observation.observedAt,
      quoteTimestamp: quote.timestamp,
      marketObservedAt: market.observedAt,
      sourceDate: policy.sourceDate,
      admission: order.admission,
      openCents: quote.openCents,
      previousCloseCents: quote.previousCloseCents,
      priceCents: quote.closeCents,
      tailHighCents: path.tailHighCents,
      dynamicMa5Cents:
        history.lastFourCloseSumCents > 0
          ? (history.lastFourCloseSumCents + quote.closeCents) / 5
          : null,
    },
  };
}

export function conditionalFillGuard(plan, order, side, event, dataset) {
  const policy = assertEntryPolicy(plan);
  if (!policy || side !== "BUY" || order.recovery || order.side === "PAIR")
    return null;
  const evidence = event.entryEvidence;
  if (
    !order.conditionalEntry ||
    !evidence ||
    evidence.version !== policy.version ||
    evidence.sourceDate !== plan.signalDate ||
    evidence.observedAt !== event.observedAt ||
    evidence.quoteTimestamp !== dataset.quotes[order.code]?.timestamp ||
    !windowFor(evidence.type, event.time)
  )
    return "盘中建仓必须由当前行情帧的买点条件触发，不接受开盘假设或缺失证据";
  return null;
}
