import { clamp, PRESETS } from "../../shared/scoring.js";
import {
  DEFAULT_INITIAL_CAPITAL,
  DEFAULT_FEES,
  LEGACY_FEES,
  normalizeFees,
  feesForBook,
} from "../../shared/fees.js";
import {
  EXECUTION_COST_MODEL,
  defaultExecutionCostPolicy,
} from "../../shared/execution-cost.js";
import {
  DEFAULT_RISK_LIMITS,
  normalizeRiskLimits,
  riskLimitsForBook,
  planRiskLimits,
} from "../../shared/risk-limits.js";
import { buildExecutionContext, solveFillQuantity } from "./execution-cost.js";

export const ACTIONS = Object.freeze({
  OPEN: "建仓",
  ADD: "加仓",
  REDUCE: "减仓",
  EXIT: "清仓",
  T_FORWARD: "正向 T",
  T_REVERSE: "反向 T",
  HOLD: "持有",
});
export const BASE_STRATEGY = Object.freeze({
  weights: PRESETS.balanced,
  minScore: 80,
  minSectorScore: 55,
  maxPositions: 4,
  maxHoldDays: 5,
  stopLoss: 0.06,
  takeProfit: 0.12,
  maxBuyGap: 0.03,
  tFraction: 0.2,
  tBuyDip: 0.02,
  tSellRise: 0.02,
});
// 兼容别名：旧执行器与既有引用仍使用默认风控；账户级自定义值
// 通过 book.riskLimits / plan.riskLimits 传递（shared/risk-limits.js）。
export const RISK_LIMITS = DEFAULT_RISK_LIMITS;
export const toCents = (value) => Math.round(Number(value) * 100);
export const roundLot = (quantity) =>
  Math.floor(Math.max(0, quantity) / 100) * 100;
export const totalQuantity = (position) =>
  position.lots.reduce((sum, lot) => sum + lot.quantity, 0);
export const availableQuantity = (position, date) =>
  position.lots
    .filter((lot) => lot.acquiredDate < date)
    .reduce((sum, lot) => sum + lot.quantity, 0);
export const costBasis = (position) =>
  position.lots.reduce((sum, lot) => sum + lot.costCents, 0);

export function newBook(
  initialCapital = DEFAULT_INITIAL_CAPITAL,
  feeConfig = DEFAULT_FEES,
) {
  if (
    !Number.isFinite(initialCapital) ||
    initialCapital < 10000 ||
    initialCapital > 100000000
  ) {
    throw new Error("初始资金必须在 1 万至 1 亿元之间");
  }
  const initialCashCents = toCents(initialCapital);
  return {
    initialCashCents,
    cashCents: initialCashCents,
    realizedPnlCents: 0,
    feesCents: 0,
    positions: [],
    lastDate: null,
    equityCents: initialCashCents,
    peakEquityCents: initialCashCents,
    activeStrategy: "baseline-v1",
    settlementCount: 0,
    feeModel: "itemized-v2",
    feeConfig: normalizeFees(feeConfig),
    feeConfigVersion: 1,
    riskLimits: normalizeRiskLimits(DEFAULT_RISK_LIMITS),
    riskLimitsVersion: 1,
  };
}

export function transactionFees(
  notionalCents,
  side,
  config = DEFAULT_FEES,
  model = "itemized-v2",
) {
  const commission = Math.max(
    Math.round(config.commission_min * 100),
    Math.round(notionalCents * config.commission_rate),
  );
  const transfer = Math.round(notionalCents * config.transfer_fee);
  const stamp =
    side === "SELL" ? Math.round(notionalCents * config.stamp_tax) : 0;
  if (model === "legacy-v1")
    return {
      commission,
      transfer,
      stamp,
      total: commission + transfer + stamp,
    };
  const handling = Math.round(notionalCents * config.handling_fee);
  const regulatory = Math.round(notionalCents * config.regulatory_fee);
  return {
    commission,
    transfer,
    stamp,
    handling,
    regulatory,
    total: commission + transfer + stamp + handling + regulatory,
  };
}

export function scoreSignals(snapshot, strategy) {
  const sectorScores = new Map(
    snapshot.sectors.map((sector) => [sector.name, sector.score]),
  );
  return snapshot.stocks
    .map((stock) => {
      const factors = stock.factors.filter((factor) => factor.value !== null);
      const weight = factors.reduce(
        (sum, factor) => sum + strategy.weights[stock.factors.indexOf(factor)],
        0,
      );
      const weighted = factors.reduce(
        (sum, factor) =>
          sum + factor.value * strategy.weights[stock.factors.indexOf(factor)],
        0,
      );
      return {
        ...stock,
        originalScore: stock.score,
        score: weight
          ? Math.round(clamp(weighted / weight - stock.deduction))
          : null,
        sectorScore: sectorScores.get(stock.sector) ?? null,
      };
    })
    .sort(
      (a, b) =>
        (b.score ?? -1) - (a.score ?? -1) || a.code.localeCompare(b.code),
    );
}

export function createPlan(
  snapshot,
  book,
  strategy,
  strategyVersion,
  createdAt,
  options = {},
) {
  // 政策冻结（§3.2）：订单计划保存完整规范化政策与内容摘要；
  // 新政策从下一个尚未冻结的计划生效，持仓本身不重置。
  const executionCostPolicy =
    options.executionCostPolicy ?? defaultExecutionCostPolicy();
  // 原始分跨日回查：持仓股掉出当日涨停池时，按最近一次快照归档评分回填，
  // 查不到才如实置空；不参与任何策略决策，仅还原展示口径。
  const originalScoreLookup = options.originalScoreLookup ?? null;
  const previousLimitUpCodes = (snapshot.stocks ?? [])
    .filter((stock) => Number(stock.height) >= 1)
    .map((stock) => stock.code);
  const signals = scoreSignals(snapshot, strategy);
  const byCode = new Map(signals.map((stock) => [stock.code, stock]));
  const equity = book.equityCents;
  const drawdown = book.peakEquityCents ? 1 - equity / book.peakEquityCents : 0;
  const riskLimits = riskLimitsForBook(book);
  const emotion = snapshot.emotion ?? 0;
  const targetExposure =
    drawdown >= riskLimits.maxDrawdown
      ? 0
      : emotion >= 65
        ? 0.55
        : emotion >= 40
          ? 0.35
          : 0.15;
  const orders = [];
  const holdings = new Set(book.positions.map((position) => position.code));
  let plannedBudget = 0;
  let plannedExposure = book.positions.reduce(
    (sum, position) => sum + totalQuantity(position) * position.markCents,
    0,
  );
  const addOrder = (order) =>
    orders.push({
      ...order,
      id: `${snapshot.date}:${order.code}:${order.action}`,
    });

  for (const position of book.positions) {
    const quantity = totalQuantity(position);
    const signal = byCode.get(position.code);
    const score = signal?.score ?? position.lastScore ?? 0;
    const referenceCents = position.markCents;
    const pnl = costBasis(position)
      ? (quantity * referenceCents) / costBasis(position) - 1
      : 0;
    const base = {
      code: position.code,
      name: position.name,
      sector: position.sector,
      score,
      originalScore:
        signal?.originalScore ?? originalScoreLookup?.(position.code) ?? null,
      referenceCents,
      stopCents: Math.round(
        (costBasis(position) / quantity) * (1 - strategy.stopLoss),
      ),
      takeProfitCents: Math.round(
        (costBasis(position) / quantity) * (1 + strategy.takeProfit),
      ),
    };
    if (
      drawdown >= riskLimits.maxDrawdown ||
      pnl <= -strategy.stopLoss ||
      position.heldDays >= strategy.maxHoldDays
    ) {
      addOrder({
        ...base,
        action: "EXIT",
        side: "SELL",
        quantity,
        reason:
          drawdown >= riskLimits.maxDrawdown
            ? "账户回撤触及风险上限"
            : pnl <= -strategy.stopLoss
              ? "收盘亏损达到止损阈值"
              : "持仓达到最长观察期",
      });
      plannedExposure -= quantity * referenceCents;
      continue;
    }
    if (pnl >= strategy.takeProfit || (signal && score < 65) || emotion < 40) {
      const reduceQuantity = roundLot(quantity / 2) || quantity;
      addOrder({
        ...base,
        action: "REDUCE",
        side: "SELL",
        quantity: reduceQuantity,
        reason:
          pnl >= strategy.takeProfit
            ? "分批兑现达到止盈阈值的仓位"
            : emotion < 40
              ? "市场情绪较弱，降低敞口"
              : "个股评分走弱，降低仓位",
      });
      plannedExposure -= reduceQuantity * referenceCents;
      continue;
    }
    const target = Math.round(
      equity * Math.min(0.175, targetExposure / strategy.maxPositions),
    );
    const addBudget = target - quantity * referenceCents;
    const addQuantity = roundLot(addBudget / referenceCents);
    if (
      signal &&
      score >= 88 &&
      addQuantity >= 100 &&
      emotion >= 65 &&
      plannedExposure + addQuantity * referenceCents <= equity * targetExposure
    ) {
      addOrder({
        ...base,
        action: "ADD",
        side: "BUY",
        quantity: addQuantity,
        maxPriceCents: Math.round(referenceCents * (1 + strategy.maxBuyGap)),
        reason: "高分信号延续，补足目标仓位",
      });
      plannedBudget +=
        addQuantity * referenceCents +
        transactionFees(
          addQuantity * referenceCents,
          "BUY",
          feesForBook(book),
          book.feeModel || "legacy-v1",
        ).total;
      plannedExposure += addQuantity * referenceCents;
      continue;
    }
    const tQuantity = roundLot(quantity * strategy.tFraction);
    if (tQuantity >= 100 && score >= 65 && emotion >= 40) {
      addOrder({
        ...base,
        action: score >= 82 ? "T_FORWARD" : "T_REVERSE",
        side: "PAIR",
        quantity: tQuantity,
        buyTriggerCents: Math.round(referenceCents * (1 - strategy.tBuyDip)),
        sellTriggerCents: Math.round(referenceCents * (1 + strategy.tSellRise)),
        reason:
          score >= 82
            ? "保留底仓，低吸后在预设价差上兑现旧仓"
            : "先减旧仓，在预设回落价上买回",
      });
    } else {
      addOrder({
        ...base,
        action: "HOLD",
        side: "NONE",
        quantity: 0,
        reason: "保持底仓，条件不足时不强行交易",
      });
    }
  }

  const slots = Math.max(0, strategy.maxPositions - book.positions.length);
  let opened = 0;
  for (const signal of signals) {
    if (opened >= slots || emotion < 40 || drawdown >= riskLimits.maxDrawdown)
      break;
    if (
      holdings.has(signal.code) ||
      !/^\d{6}$/.test(signal.code) ||
      signal.coverage < 80 ||
      signal.score < strategy.minScore ||
      signal.sectorScore < strategy.minSectorScore ||
      signal.height >= 5 ||
      signal.risks.some((risk) => ["一字特征", "高换手"].includes(risk.text)) ||
      !(signal.price > 0)
    )
      continue;
    const referenceCents = toCents(signal.price);
    const budget = Math.max(
      0,
      Math.min(
        (equity * targetExposure) / strategy.maxPositions,
        equity * targetExposure - plannedExposure,
        book.cashCents - plannedBudget - 1000,
      ),
    );
    const quantity = roundLot(budget / referenceCents);
    if (quantity < 100) continue;
    addOrder({
      code: signal.code,
      name: signal.name,
      sector: signal.sector,
      score: signal.score,
      originalScore: signal.originalScore,
      referenceCents,
      action: "OPEN",
      side: "BUY",
      quantity,
      maxPriceCents: Math.round(referenceCents * (1 + strategy.maxBuyGap)),
      stopCents: Math.round(referenceCents * (1 - strategy.stopLoss)),
      takeProfitCents: Math.round(referenceCents * (1 + strategy.takeProfit)),
      reason: "高分且板块协同较强，下一交易日开盘条件满足时建仓",
    });
    plannedBudget +=
      quantity * referenceCents +
      transactionFees(
        quantity * referenceCents,
        "BUY",
        feesForBook(book),
        book.feeModel || "legacy-v1",
      ).total;
    plannedExposure += quantity * referenceCents;
    opened++;
  }
  return {
    signalDate: snapshot.date,
    feeModel: book.feeModel || "legacy-v1",
    feeConfig: structuredClone(feesForBook(book)),
    feeConfigVersion: book.feeConfigVersion || 0,
    riskLimits: structuredClone(riskLimits),
    riskLimitsVersion: book.riskLimitsVersion || 0,
    createdAt,
    strategyVersion,
    strategy,
    executionCostModel: EXECUTION_COST_MODEL,
    executionCostPolicy: structuredClone(executionCostPolicy),
    previousLimitUpCodes,
    previousLimitUpKnown: true,
    emotion,
    targetExposure,
    maxExposure: riskLimits.maxGrossExposure,
    orders: carriedPlanOrders(
      orders,
      book,
      snapshot.date,
      strategy,
      originalScoreLookup,
    ),
    constraints:
      "下一交易日执行；T+1；整手买入；涨跌停不保证成交；成交费用和滑点计入账本。",
  };
}

function consumeLots(position, quantity, date) {
  let remaining = quantity;
  let basis = 0;
  for (const lot of position.lots) {
    if (remaining <= 0) break;
    if (lot.acquiredDate >= date) continue;
    const taken = Math.min(remaining, lot.quantity);
    const takenCost =
      taken === lot.quantity
        ? lot.costCents
        : Math.round((lot.costCents * taken) / lot.quantity);
    lot.quantity -= taken;
    lot.costCents -= takenCost;
    basis += takenCost;
    remaining -= taken;
  }
  position.lots = position.lots.filter((lot) => lot.quantity > 0);
  if (remaining) throw new Error("成交数量超过 T+1 可卖数量");
  return basis;
}
function carriedPlanOrders(orders, book, date, strategy, originalScoreLookup) {
  const carried = new Map();
  const create = (item, action, side, quantity, reason) => {
    const p = book.positions.find((p) => p.code === item.code);
    if (!p || !quantity) return;
    const basis = costBasis(p) / totalQuantity(p);
    carried.set(item.code, {
      id: `${date}:${item.code}:carry`,
      code: item.code,
      name: p.name,
      sector: p.sector,
      score: p.lastScore ?? null,
      originalScore: originalScoreLookup?.(item.code) ?? null,
      referenceCents: p.markCents,
      stopCents: Math.round(basis * (1 - strategy.stopLoss)),
      takeProfitCents: Math.round(basis * (1 + strategy.takeProfit)),
      action,
      side,
      quantity,
      allDay: true,
      carried: true,
      recovery: !!item.side,
      reason,
    });
  };
  for (const item of book.pendingOrders || [])
    create(
      item,
      "REDUCE",
      "SELL",
      item.quantity,
      "继续执行上日未完成的减仓，连续竞价时段重试",
    );
  for (const item of book.pendingRecovery || [])
    create(
      item,
      item.side === "BUY" ? "ADD" : "REDUCE",
      item.side,
      item.quantity,
      "继续恢复上日做 T 第二腿，按实时行情及费用执行",
    );
  for (const item of book.pendingExits || []) {
    const p = book.positions.find((p) => p.code === item.code);
    create(
      item,
      "EXIT",
      "SELL",
      p ? totalQuantity(p) : 0,
      "继续执行受 T+1 或跌停阻塞的清仓",
    );
  }
  // A newly planned risk exit takes precedence over restoring an unfinished T.
  for (const order of orders)
    if (order.action === "EXIT") carried.delete(order.code);
  return [...orders.filter((o) => !carried.has(o.code)), ...carried.values()];
}

export function defensivePlan(
  date,
  book,
  strategy,
  strategyVersion,
  createdAt,
  options = {},
) {
  // 缺少昨日冻结信息时如实声明：昨日涨停风险项不适用，不猜测。
  const executionCostPolicy =
    options.executionCostPolicy ?? defaultExecutionCostPolicy();
  // 当日评分整体缺失，策略加权分保持为空；原始分仍按最近归档回查展示。
  const originalScoreLookup = options.originalScoreLookup ?? null;
  const drawdown = 1 - book.equityCents / book.peakEquityCents;
  const riskLimits = riskLimitsForBook(book);
  return {
    signalDate: date,
    feeModel: book.feeModel || "legacy-v1",
    feeConfig: structuredClone(feesForBook(book)),
    feeConfigVersion: book.feeConfigVersion || 0,
    riskLimits: structuredClone(riskLimits),
    riskLimitsVersion: book.riskLimitsVersion || 0,
    createdAt,
    strategyVersion,
    strategy,
    executionCostModel: EXECUTION_COST_MODEL,
    executionCostPolicy: structuredClone(executionCostPolicy),
    previousLimitUpCodes: [],
    previousLimitUpKnown: false,
    sourceSnapshotMissing: true,
    emotion: null,
    targetExposure: 0,
    maxExposure: riskLimits.maxGrossExposure,
    orders: carriedPlanOrders(
      book.positions.map((position) => {
        const quantity = totalQuantity(position),
          basis = costBasis(position);
        const exit =
          drawdown >= riskLimits.maxDrawdown ||
          (quantity * position.markCents) / basis - 1 <= -strategy.stopLoss ||
          position.heldDays >= strategy.maxHoldDays;
        return {
          id: `${date}:${position.code}:defensive`,
          code: position.code,
          name: position.name,
          sector: position.sector,
          score: null,
          originalScore: originalScoreLookup?.(position.code) ?? null,
          referenceCents: position.markCents,
          stopCents: Math.round((basis / quantity) * (1 - strategy.stopLoss)),
          takeProfitCents: Math.round(
            (basis / quantity) * (1 + strategy.takeProfit),
          ),
          action: exit ? "EXIT" : "HOLD",
          side: exit ? "SELL" : "NONE",
          quantity: exit ? quantity : 0,
          reason: exit
            ? "当日评分缺失，按已有持仓风险阈值清仓"
            : "当日评分缺失，停止新增交易并保留旧仓保护",
        };
      }),
      book,
      date,
      strategy,
      originalScoreLookup,
    ),
    constraints: "缺少评分时不构造信号；只允许基于已结算持仓执行风险保护。",
  };
}

export function executePlan(inputBook, plan, dataset) {
  const book = structuredClone(inputBook);
  const date = dataset.date;
  if (
    plan &&
    (plan.signalDate >= date || plan.createdAt >= `${date}T01:15:00.000Z`)
  ) {
    throw new Error("交易计划必须在执行日开盘前冻结，禁止使用当日收盘评分交易");
  }
  // 新版本计划缺政策/摘要时暂停执行（§3.2）；旧计划无标记则分派旧 10bps 执行器。
  const policyBundle = plan ? executionPolicyBundle(plan) : null;
  const execution = policyBundle
    ? { policyDigest: policyBundle.payloadDigest, byCode: {} }
    : null;
  const ledger = [];
  const outcomes = [];
  const notices = [];
  const orders = structuredClone(plan?.orders || []).filter(
    (order) => order.action !== "HOLD",
  );
  const runtime = new Map(
    orders.map((order) => [
      order.id,
      { order, stage: 0, firstTime: null, filled: 0 },
    ]),
  );
  const quotes = dataset.quotes;
  for (const position of book.positions) {
    const quote = quotes[position.code];
    if (!quote || quote.date !== date || !(quote.closeCents > 0))
      throw new Error(`${position.code} 缺少当天持仓行情，结算暂停`);
    if (
      Math.abs(quote.previousCloseCents - position.markCents) >
      Math.max(1, position.markCents * 0.001)
    ) {
      throw new Error(
        `${position.code} 昨收与账面价格不一致，需核对除权或缺失交易日，结算暂停`,
      );
    }
  }
  const prices = new Map(
    book.positions.map((position) => [position.code, position.markCents]),
  );
  const events = [];
  let missingMinuteOrders = 0;

  for (const order of orders) {
    const quote = quotes[order.code];
    if (
      !quote ||
      quote.date !== date ||
      !(quote.openCents > 0) ||
      !(quote.closeCents > 0) ||
      quote.volumeShares === 0
    ) {
      outcomes.push({
        ...order,
        status: "SKIPPED",
        reason: "缺少日期匹配的可交易行情",
      });
      runtime.delete(order.id);
      continue;
    }
    if (
      Math.abs(quote.previousCloseCents - order.referenceCents) >
      Math.max(1, order.referenceCents * 0.001)
    ) {
      outcomes.push({
        ...order,
        status: "SKIPPED",
        reason: "计划参考价与昨收不一致，可能除权，跳过交易",
      });
      runtime.delete(order.id);
      continue;
    }
    const bars = dataset.minutes[order.code] || [];
    const pair = order.side === "PAIR";
    if (pair && !completeMinutes(bars)) {
      missingMinuteOrders++;
      outcomes.push({
        ...order,
        status: "SKIPPED",
        reason: "盘中时序数据不足，不推断做 T 的先后顺序",
      });
      runtime.delete(order.id);
      continue;
    }
    if (bars.length) {
      for (const bar of bars)
        events.push({
          ...bar,
          orderId: order.id,
          code: order.code,
          quality: "minute",
          intervalKey: `${date}:${bar.time}`,
        });
    } else {
      events.push({
        orderId: order.id,
        code: order.code,
        time: "09:30",
        priceCents: quote.openCents,
        volumeShares: null,
        quality: "daily_open_assumption",
        intervalKey: `${date}:09:30`,
      });
    }
  }
  // Protective orders apply only to inventory owned before this trading day.
  for (const original of plan?.orders || []) {
    const position = book.positions.find((item) => item.code === original.code);
    if (!position || ["EXIT", "REDUCE"].includes(original.action)) continue;
    const quantity = availableQuantity(position, date);
    const bars = dataset.minutes[original.code] || [];
    if (!quantity || !bars.length) continue;
    const order = {
      ...structuredClone(original),
      id: `${original.id}:protect`,
      side: "SELL",
      quantity,
      protective: true,
    };
    runtime.set(order.id, { order, stage: 0, filled: 0 });
    for (const bar of bars)
      events.push({
        ...bar,
        orderId: order.id,
        code: order.code,
        quality: "minute",
        intervalKey: `${date}:${bar.time}`,
      });
  }
  events.sort(
    (a, b) =>
      a.time.localeCompare(b.time) ||
      (runtime.get(a.orderId)?.order.side === "SELL" ? 0 : 1) -
        (runtime.get(b.orderId)?.order.side === "SELL" ? 0 : 1) ||
      a.code.localeCompare(b.code),
  );

  const fill = (order, side, quantity, event) =>
    executeFill(
      book,
      plan,
      dataset,
      prices,
      ledger,
      order,
      side,
      quantity,
      event,
      execution,
    );

  for (const event of events) {
    const running = runtime.get(event.orderId);
    if (!running) continue;
    const { order } = running;
    prices.set(order.code, event.priceCents);
    if (order.protective) {
      if (running.stage || event.time > "14:55") continue;
      if (
        !running.triggered &&
        event.priceCents > order.stopCents &&
        event.priceCents < order.takeProfitCents
      )
        continue;
      if (!running.triggered) {
        running.triggered = true;
        order.action = event.priceCents <= order.stopCents ? "EXIT" : "REDUCE";
        order.reason =
          order.action === "EXIT" ? "事前保护止损触发" : "事前分批止盈触发";
        order.quantity =
          order.action === "EXIT"
            ? order.quantity
            : roundLot(order.quantity / 2) || order.quantity;
        for (const [id, other] of runtime) {
          if (
            id !== order.id &&
            other.order.code === order.code &&
            !other.stage
          ) {
            outcomes.push({
              ...other.order,
              status: "SKIPPED",
              reason: "保护订单触发，取消原交易计划",
            });
            runtime.delete(id);
          }
          if (
            id !== order.id &&
            other.order.code === order.code &&
            other.order.side === "PAIR" &&
            other.stage === 1
          ) {
            outcomes.push({
              ...other.order,
              status: "PARTIAL",
              reason: "保护订单触发，做 T 第二腿取消，保留实际仓位",
            });
            runtime.delete(id);
          }
        }
      }
      const result = fill(
        order,
        "SELL",
        order.quantity - running.filled,
        event,
      );
      if (result.ok) running.filled += result.quantity;
      else running.lastReason = result.reason;
      if (running.filled === order.quantity) {
        running.stage = 1;
        outcomes.push({
          ...order,
          status: "FILLED",
          filledQuantity: running.filled,
        });
      }
      continue;
    }
    if (order.side !== "PAIR") {
      if (running.stage) continue;
      if (event.time > "09:35") {
        running.stage = 1;
        outcomes.push({
          ...order,
          status: "SKIPPED",
          // 拒绝原因进入订单 outcome（§5.2）：保留窗口内最后一次真实拒绝原因，
          // 并记录最终未成交数量；不只记录成功交易。
          reason: running.lastReason || "开盘执行窗口内未取得可成交数据",
          unfilledQuantity: order.quantity - running.filled,
        });
        continue;
      }
      if (order.side === "BUY" && event.priceCents > order.maxPriceCents) {
        running.stage = 1;
        outcomes.push({
          ...order,
          status: "SKIPPED",
          reason: "开盘涨幅超过事前买入上限",
        });
        continue;
      }
      const result = fill(order, order.side, order.quantity, event);
      if (result.ok) {
        running.stage = 1;
        outcomes.push({
          ...order,
          status: result.quantity === order.quantity ? "FILLED" : "PARTIAL",
          filledQuantity: result.quantity,
          reason:
            result.quantity < order.quantity
              ? "受现金、仓位或参与率限制，部分成交"
              : order.reason,
        });
      } else running.lastReason = result.reason;
      continue;
    }
    if (event.time < "09:35" || event.time > "14:50" || running.stage >= 2)
      continue;
    const forward = order.action === "T_FORWARD";
    if (running.stage === 0) {
      const position = book.positions.find((item) => item.code === order.code);
      if (!position || availableQuantity(position, date) < order.quantity) {
        running.lastReason = "T+1 可卖底仓不足";
        continue;
      }
      const triggered = forward
        ? event.priceCents <= order.buyTriggerCents
        : event.priceCents >= order.sellTriggerCents;
      if (!triggered) continue;
      const result = fill(
        order,
        forward ? "BUY" : "SELL",
        order.quantity,
        event,
      );
      if (result.ok) {
        running.stage = 1;
        running.firstTime = event.time;
        running.filled = result.quantity;
      } else running.lastReason = result.reason;
    } else if (event.time > running.firstTime) {
      const triggered = forward
        ? event.priceCents >= order.sellTriggerCents
        : event.priceCents <= order.buyTriggerCents;
      if (!triggered) continue;
      const result = fill(
        order,
        forward ? "SELL" : "BUY",
        running.remaining ?? running.filled,
        event,
      );
      if (result.ok) {
        running.remaining =
          (running.remaining ?? running.filled) - result.quantity;
        if (running.remaining <= 0) {
          running.stage = 2;
          outcomes.push({
            ...order,
            status: "FILLED",
            filledQuantity: running.filled,
          });
        }
      } else running.lastReason = result.reason;
    }
  }
  for (const running of runtime.values()) {
    if (running.order.protective && !running.triggered) continue;
    if (!outcomes.some((outcome) => outcome.id === running.order.id)) {
      outcomes.push({
        ...running.order,
        status:
          running.stage === 1 || running.filled > 0 ? "PARTIAL" : "SKIPPED",
        reason:
          running.stage === 1
            ? "做 T 的第二腿未完成，实际新增或减少的仓位保留到账本"
            : running.lastReason || "预设条件未触发",
        unfilledQuantity: running.order.quantity - running.filled,
      });
    }
  }
  book.positions = book.positions.filter(
    (position) => totalQuantity(position) > 0,
  );
  for (const position of book.positions) {
    const quote = quotes[position.code];
    if (quote?.date === date && quote.closeCents > 0) {
      position.markCents = quote.closeCents;
      position.markDate = date;
    } else
      notices.push(
        `${position.code} 缺少当天收盘价，保留旧估值，收益标记不完整`,
      );
    position.heldDays++;
  }
  const marketValueCents = book.positions.reduce(
    (sum, position) => sum + totalQuantity(position) * position.markCents,
    0,
  );
  const unrealizedPnlCents = book.positions.reduce(
    (sum, position) =>
      sum + totalQuantity(position) * position.markCents - costBasis(position),
    0,
  );
  const equityCents = book.cashCents + marketValueCents;
  const dailyPnlCents = equityCents - book.equityCents;
  const dailyReturn = book.equityCents ? dailyPnlCents / book.equityCents : 0;
  book.equityCents = equityCents;
  book.peakEquityCents = Math.max(book.peakEquityCents, equityCents);
  book.lastDate = date;
  book.settlementCount++;
  const equity = {
    date,
    cashCents: book.cashCents,
    marketValueCents,
    equityCents,
    dailyPnlCents,
    dailyReturn,
    totalReturn: equityCents / book.initialCashCents - 1,
    realizedPnlCents: book.realizedPnlCents,
    unrealizedPnlCents,
    feesCents: book.feesCents,
    drawdown: 1 - equityCents / book.peakEquityCents,
    complete: notices.length === 0,
    positionCount: book.positions.length,
    missingMinuteOrders,
    source: dataset.source,
    executionCost: policyBundle
      ? {
          modelVersion: policyBundle.modelVersion,
          policyDigest: policyBundle.payloadDigest,
        }
      : null,
  };
  if (
    equityCents - book.initialCashCents !==
    book.realizedPnlCents + unrealizedPnlCents
  )
    throw new Error("资金账本与盈亏不一致");
  if (book.cashCents < 0) throw new Error("模拟账户不能透支");
  return { book, ledger, equity, outcomes, notices };
}

export function executeFill(
  book,
  plan,
  dataset,
  prices,
  ledger,
  order,
  side,
  desiredQuantity,
  event,
  execution = null,
) {
  // 版本分派（§3.2/§5.4）：旧计划无政策标记 → 明确分派旧 10bps 兼容执行器；
  // 新版本计划缺政策/摘要或版本未知 → 暂停执行，不静默回退。
  const bundle = executionPolicyBundle(plan);
  if (!bundle) return executeFillLegacy(...arguments);
  return executeFillWithCostModel(
    book,
    plan,
    dataset,
    prices,
    ledger,
    order,
    side,
    desiredQuantity,
    event,
    execution,
    bundle,
  );
}

// 校验并返回计划冻结的成本政策 bundle；旧计划返回 null。
export function executionPolicyBundle(plan) {
  const bundle = plan?.executionCostPolicy ?? null;
  if (!bundle && !plan?.executionCostModel) return null;
  if (!bundle?.payload || !bundle?.payloadDigest)
    throw new Error("计划版本要求成本政策，但缺少政策或摘要，暂停执行");
  if (bundle.modelVersion !== EXECUTION_COST_MODEL)
    throw new Error(`未知执行成本模型 ${bundle.modelVersion}，暂停执行`);
  return bundle;
}

function executeFillWithCostModel(
  book,
  plan,
  dataset,
  prices,
  ledger,
  order,
  side,
  desiredQuantity,
  event,
  execution,
  bundle,
) {
  const date = dataset.date;
  const quotes = dataset.quotes;
  const feeConfig = plan?.feeConfig || LEGACY_FEES;
  const feeModel = plan?.feeModel || "legacy-v1";
  // 计划冻结的风控约束（§3.2 同一模式）：旧计划回退默认值。
  const riskLimits = planRiskLimits(plan);
  const quote = quotes[order.code];
  const point = event.priceCents;
  if (
    (side === "BUY" && quote.limitUpCents && point >= quote.limitUpCents) ||
    (side === "SELL" && quote.limitDownCents && point <= quote.limitDownCents)
  )
    return {
      ok: false,
      reason: side === "BUY" ? "涨停排队不假设成交" : "跌停卖出不假设成交",
    };
  let position = book.positions.find((item) => item.code === order.code);
  const desired =
    side === "BUY"
      ? roundLot(desiredQuantity)
      : Math.min(
          desiredQuantity,
          position ? availableQuantity(position, date) : 0,
        );
  // 同股区间共享容量与冲击游标（§4.4）：保护单、普通卖单、买单和 T 两腿
  // 共享同股区间的绝对成交容量；只有成交成功才推进状态。
  const context = buildExecutionContext({
    plan,
    code: order.code,
    event,
    quote,
    intervalState: execution?.byCode?.[order.code] ?? null,
  });
  let capCents = null;
  if (side === "BUY") {
    const value = book.positions.reduce(
      (sum, item) =>
        sum + totalQuantity(item) * (prices.get(item.code) || item.markCents),
      0,
    );
    const equity = book.cashCents + value;
    const current = position
      ? totalQuantity(position) * (prices.get(order.code) || point)
      : 0;
    capCents = Math.min(
      book.cashCents,
      equity * riskLimits.maxPositionWeight - current,
      equity * riskLimits.maxGrossExposure - value,
    );
  }
  const solved = solveFillQuantity({
    policy: bundle,
    context,
    side,
    desiredQuantity: desired,
    limits: {
      maxPriceCents: order.maxPriceCents,
      limitUpCents: quote.limitUpCents,
      limitDownCents: quote.limitDownCents,
      capCents,
      availableQuantity: desired,
    },
    estimateFees: (notional, fillSide) =>
      transactionFees(notional, fillSide, feeConfig, feeModel).total,
  });
  if (!solved.quantity)
    return {
      ok: false,
      reason: solved.reason,
      detail: solved.detail,
      executionCost: solved.executionCost?.costBreakdown ?? null,
    };
  if (execution) execution.byCode[order.code] = solved.nextIntervalState;
  const fillPriceCents = solved.executionCost.fillPriceCents;
  const quantity = solved.quantity;
  const notional = quantity * fillPriceCents;
  const fees = transactionFees(notional, side, feeConfig, feeModel);
  let basisCents = 0;
  let realizedPnlCents = 0;
  const cashDeltaCents =
    side === "BUY" ? -notional - fees.total : notional - fees.total;
  if (side === "BUY") {
    if (!position) {
      position = {
        code: order.code,
        name: order.name,
        sector: order.sector,
        lots: [],
        heldDays: 0,
        markCents: point,
        lastScore: order.score,
        markDate: date,
      };
      book.positions.push(position);
    }
    position.lots.push({
      acquiredDate: date,
      quantity,
      costCents: notional + fees.total,
      priceCents: fillPriceCents,
    });
  } else {
    basisCents = consumeLots(position, quantity, date);
    realizedPnlCents = cashDeltaCents - basisCents;
    book.realizedPnlCents += realizedPnlCents;
  }
  book.cashCents += cashDeltaCents;
  book.feesCents += fees.total;
  prices.set(order.code, point);
  ledger.push({
    id: `${date}:${order.id}:${ledger.length}`,
    date,
    signalDate: plan.signalDate,
    sequence: ledger.length,
    time: event.time,
    code: order.code,
    name: order.name,
    action: order.action,
    side,
    quantity,
    priceCents: fillPriceCents,
    notionalCents: notional,
    feeCents: fees.total,
    feeBreakdown: fees,
    ...(feeModel === "itemized-v2"
      ? {
          feeModel,
          feeConfig: structuredClone(feeConfig),
          feeConfigVersion: plan.feeConfigVersion || 1,
        }
      : {}),
    cashDeltaCents,
    basisCents,
    realizedPnlCents,
    cashAfterCents: book.cashCents,
    strategyVersion: plan.strategyVersion,
    dataQuality: event.quality,
    source: dataset.source,
    sourcePriceCents: point,
    executionCost: solved.executionCost.costBreakdown,
  });
  return { ok: true, quantity, priceCents: fillPriceCents };
}

// 旧 10bps 兼容执行器（LEGACY_FIXED_10BPS_V1）：历史计划与旧导出重放
// 仍按原 Math.round、10bps 及原容量规则执行（§5.4），不得重写历史成交。
function executeFillLegacy(
  book,
  plan,
  dataset,
  prices,
  ledger,
  order,
  side,
  desiredQuantity,
  event,
) {
  const date = dataset.date;
  const quotes = dataset.quotes;
  const feeConfig = plan?.feeConfig || LEGACY_FEES;
  const feeModel = plan?.feeModel || "legacy-v1";
  const quote = quotes[order.code];
  const point = event.priceCents;
  if (
    (side === "BUY" && quote.limitUpCents && point >= quote.limitUpCents) ||
    (side === "SELL" && quote.limitDownCents && point <= quote.limitDownCents)
  )
    return {
      ok: false,
      reason: side === "BUY" ? "涨停排队不假设成交" : "跌停卖出不假设成交",
    };
  let position = book.positions.find((item) => item.code === order.code);
  let quantity =
    side === "BUY"
      ? roundLot(desiredQuantity)
      : Math.min(
          desiredQuantity,
          position ? availableQuantity(position, date) : 0,
        );
  if (event.volumeShares !== null)
    quantity = Math.min(
      quantity,
      roundLot(event.volumeShares * RISK_LIMITS.maxParticipation),
    );
  const priceCents = Math.round(
    point * (1 + ((side === "BUY" ? 1 : -1) * RISK_LIMITS.slippageBps) / 10000),
  );
  if (side === "BUY" && order.maxPriceCents && priceCents > order.maxPriceCents)
    return { ok: false, reason: "含滑点价格超过事前买入上限" };
  if (
    (side === "BUY" &&
      quote.limitUpCents &&
      priceCents >= quote.limitUpCents) ||
    (side === "SELL" &&
      quote.limitDownCents &&
      priceCents <= quote.limitDownCents)
  )
    return { ok: false, reason: "加入滑点后触及涨跌停边界" };
  if (side === "BUY") {
    const value = book.positions.reduce(
      (sum, item) =>
        sum + totalQuantity(item) * (prices.get(item.code) || item.markCents),
      0,
    );
    const equity = book.cashCents + value;
    const current = position
      ? totalQuantity(position) * (prices.get(order.code) || point)
      : 0;
    const cap = Math.min(
      book.cashCents,
      equity * RISK_LIMITS.maxPositionWeight - current,
      equity * RISK_LIMITS.maxGrossExposure - value,
    );
    quantity = Math.min(
      quantity,
      roundLot(Math.max(0, cap - 1000) / priceCents),
    );
    while (
      quantity >= 100 &&
      quantity * priceCents +
        transactionFees(quantity * priceCents, side, feeConfig, feeModel)
          .total >
        cap
    )
      quantity -= 100;
  }
  if (quantity <= 0 || (side === "BUY" && quantity < 100))
    return {
      ok: false,
      reason:
        side === "SELL"
          ? "没有 T+1 可卖底仓或流动性不足"
          : "现金、仓位或流动性约束不足一手",
    };
  const notional = quantity * priceCents;
  const fees = transactionFees(notional, side, feeConfig, feeModel);
  let basisCents = 0;
  let realizedPnlCents = 0;
  const cashDeltaCents =
    side === "BUY" ? -notional - fees.total : notional - fees.total;
  if (side === "BUY") {
    if (!position) {
      position = {
        code: order.code,
        name: order.name,
        sector: order.sector,
        lots: [],
        heldDays: 0,
        markCents: point,
        lastScore: order.score,
        markDate: date,
      };
      book.positions.push(position);
    }
    position.lots.push({
      acquiredDate: date,
      quantity,
      costCents: notional + fees.total,
      priceCents,
    });
  } else {
    basisCents = consumeLots(position, quantity, date);
    realizedPnlCents = cashDeltaCents - basisCents;
    book.realizedPnlCents += realizedPnlCents;
  }
  book.cashCents += cashDeltaCents;
  book.feesCents += fees.total;
  prices.set(order.code, point);
  ledger.push({
    id: `${date}:${order.id}:${ledger.length}`,
    date,
    signalDate: plan.signalDate,
    sequence: ledger.length,
    time: event.time,
    code: order.code,
    name: order.name,
    action: order.action,
    side,
    quantity,
    priceCents,
    notionalCents: notional,
    feeCents: fees.total,
    feeBreakdown: fees,
    ...(feeModel === "itemized-v2"
      ? {
          feeModel,
          feeConfig: structuredClone(feeConfig),
          feeConfigVersion: plan.feeConfigVersion || 1,
        }
      : {}),
    cashDeltaCents,
    basisCents,
    realizedPnlCents,
    cashAfterCents: book.cashCents,
    strategyVersion: plan.strategyVersion,
    dataQuality: event.quality,
    source: dataset.source,
    sourcePriceCents: point,
  });
  return { ok: true, quantity, priceCents };
}

export function completeMinutes(bars) {
  if (bars.length < 230 || bars[0].time > "09:35" || bars.at(-1).time < "14:55")
    return false;
  const minutes = (time) =>
    Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  return bars.every(
    (bar, index) =>
      /^\d{2}:\d{2}$/.test(bar.time) &&
      bar.priceCents > 0 &&
      Number.isFinite(bar.volumeShares) &&
      bar.volumeShares >= 0 &&
      (!index ||
        (bars[index - 1].time < bar.time &&
          (minutes(bar.time) - minutes(bars[index - 1].time) <= 5 ||
            (bars[index - 1].time >= "11:25" && bar.time <= "13:05")))),
  );
}

export function auditLedger(initialCashCents, ledger, latestEquity, positions) {
  const cashCents =
    initialCashCents +
    ledger.reduce((sum, fill) => sum + fill.cashDeltaCents, 0);
  const realizedPnlCents = ledger.reduce(
    (sum, fill) => sum + fill.realizedPnlCents,
    0,
  );
  const marketValueCents = positions.reduce(
    (sum, position) => sum + totalQuantity(position) * position.markCents,
    0,
  );
  const unrealizedPnlCents = positions.reduce(
    (sum, position) =>
      sum + totalQuantity(position) * position.markCents - costBasis(position),
    0,
  );
  const checks = {
    cash: cashCents === latestEquity.cashCents,
    equity: cashCents + marketValueCents === latestEquity.equityCents,
    pnl:
      latestEquity.equityCents - initialCashCents ===
      realizedPnlCents + unrealizedPnlCents,
    fees:
      ledger.reduce((sum, fill) => sum + fill.feeCents, 0) ===
      latestEquity.feesCents,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    cashCents,
    equityCents: cashCents + marketValueCents,
    realizedPnlCents,
    unrealizedPnlCents,
    formula:
      "权益 = 初始资金 + 全部成交现金流 + 当前持仓市值；累计盈亏 = 已实现盈亏 + 浮动盈亏",
  };
}
