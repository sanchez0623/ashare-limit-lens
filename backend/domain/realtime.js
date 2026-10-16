import {
  executeFill,
  executionPolicyBundle,
  totalQuantity,
  availableQuantity,
  costBasis,
  roundLot,
  protectivePyramidReduce,
  applyPlanDowngrades,
  BASE_STRATEGY,
} from "./trading.js";
import {
  CLASS_MANAGEMENT,
  downgradeEnabledForPlan,
} from "../../shared/downgrade.js";
import { planRiskLimits } from "../../shared/risk-limits.js";
import { frozenSelectionPolicy } from "./signal-selection.js";
import { assertProgramPlan } from "./strategy-program.js";

export const TERMINAL = new Set([
  "FILLED",
  "CANCELLED",
  "EXPIRED",
  "EXPIRED_PARTIAL",
  "INCOMPLETE_T",
]);
export function marketClock(now = new Date()) {
  const value = new Date(now.getTime() + 8 * 3600000).toISOString();
  return {
    date: value.slice(0, 10),
    time: value.slice(11, 19),
    weekday: now.getUTCDay(),
  };
}
export function inSession(time) {
  return (
    (time >= "09:30:00" && time <= "11:30:00") ||
    (time >= "13:00:00" && time < "14:57:00")
  );
}
const quantityOf = (book, code) => {
  const p = book.positions.find((p) => p.code === code);
  return p ? totalQuantity(p) : 0;
};
function running(order) {
  return {
    ...structuredClone(order),
    status: "PENDING",
    filledQuantity: 0,
    firstFilled: 0,
    secondFilled: 0,
    phase: "FIRST",
    attempts: 0,
    reason: order.reason || "等待触发",
  };
}
export function openSession(book, plan, date) {
  if (plan) frozenSelectionPolicy(plan);
  if (plan) assertProgramPlan(plan, book);
  if (
    plan?.strategy?.program &&
    (!Number.isFinite(Date.parse(plan.createdAt)) ||
      Date.parse(plan.createdAt) >= Date.parse(`${date}T01:15:00.000Z`))
  )
    throw new Error("策略程序计划实际冻结时间晚于执行日前闸门");
  if (
    !plan ||
    plan.signalDate !== book.lastDate ||
    plan.signalDate >= date ||
    plan.createdAt >= `${date}T01:15:00.000Z`
  )
    throw new Error("缺少执行日前冻结的计划，自动交易暂停");
  // 新版本计划缺政策/摘要时暂停执行（§3.2）；旧计划返回 null 走旧执行器。
  const policyBundle = executionPolicyBundle(plan);
  const carry = new Set([
    ...(book.pendingExits || []).map((x) => x.code),
    ...(book.pendingRecovery || []).map((x) => x.code),
    ...(book.pendingOrders || []).map((x) => x.code),
  ]);
  const plannedExits = new Set(
    plan.orders.filter((o) => o.action === "EXIT").map((o) => o.code),
  );
  const orders = plan.orders
    .filter(
      (o) =>
        o.action !== "HOLD" && (!carry.has(o.code) || plannedExits.has(o.code)),
    )
    .map(running);
  for (const recovery of book.pendingRecovery || []) {
    if (
      plannedExits.has(recovery.code) ||
      (book.pendingExits || []).some((x) => x.code === recovery.code)
    )
      continue;
    orders.push(
      running({
        ...recovery,
        id: `${date}:${recovery.code}:recovery`,
        recovery: true,
        action: recovery.side === "BUY" ? "ADD" : "REDUCE",
        allDay: true,
        reason: "恢复上一交易日未完成的做 T 第二腿",
      }),
    );
  }
  for (const exit of (book.pendingExits || []).filter(
    (x) => !plannedExits.has(x.code),
  ))
    orders.push(
      running({
        ...exit,
        id: `${date}:${exit.code}:carried-exit`,
        action: "EXIT",
        side: "SELL",
        quantity: quantityOf(book, exit.code),
        allDay: true,
        reason: "继续执行上一交易日受 T+1 或跌停阻塞的退出",
      }),
    );
  for (const pending of book.pendingOrders || []) {
    if (
      plannedExits.has(pending.code) ||
      (book.pendingExits || []).some((x) => x.code === pending.code)
    )
      continue;
    orders.push(
      running({
        ...pending,
        id: `${date}:${pending.code}:carried-reduce`,
        action: "REDUCE",
        side: "SELL",
        allDay: true,
        carried: true,
        reason: "继续执行上一交易日尚未完成的减仓",
      }),
    );
  }
  for (const position of book.positions) {
    const original = plan.orders.find((o) => o.code === position.code) || {};
    const basis = costBasis(position) / totalQuantity(position);
    orders.push(
      running({
        ...original,
        id: `${date}:${position.code}:protect`,
        code: position.code,
        name: position.name,
        sector: position.sector,
        protective: true,
        action: "EXIT",
        side: "SELL",
        quantity: 0,
        stopCents:
          original.stopCents ||
          Math.round(basis * (1 - plan.strategy.stopLoss)),
        takeProfitCents:
          original.takeProfitCents ||
          Math.round(basis * (1 + plan.strategy.takeProfit)),
        reason: "持续监控旧仓风险",
      }),
    );
  }
  return {
    date,
    signalDate: plan.signalDate,
    status: "OPEN",
    plan: structuredClone(plan),
    initialBook: structuredClone(book),
    sequence: 0,
    fillCount: 0,
    quotes: {},
    orders,
    lastObservedAt: null,
    // 同股区间成本状态（§4.4）：policyDigest + byCode 区间游标随会话
    // 持久化，与账本同一次 CAS 提交，失败重读原状态再试。
    executionState: policyBundle
      ? { policyDigest: policyBundle.payloadDigest, byCode: {} }
      : null,
  };
}

function mark(book) {
  book.positions = book.positions.filter((p) => totalQuantity(p) > 0);
  book.equityCents =
    book.cashCents +
    book.positions.reduce((sum, p) => sum + totalQuantity(p) * p.markCents, 0);
}

// One observation advances only durable state. No future bars, timers or side effects.
export function advanceSession(inputBook, inputSession, observation) {
  assertProgramPlan(inputSession.plan, inputSession.initialBook);
  if (inputSession.plan) frozenSelectionPolicy(inputSession.plan);
  const book = structuredClone(inputBook),
    session = structuredClone(inputSession),
    ledger = [];
  if (session.status !== "OPEN") return { book, session, ledger };
  // 计划冻结的风控约束：回撤熔断与旧模型参与率/滑点按会话计划执行。
  const riskLimits = planRiskLimits(session.plan);
  const observed = new Date(observation.observedAt),
    clock = marketClock(observed);
  if (
    !Number.isFinite(observed.getTime()) ||
    clock.date !== session.date ||
    !inSession(clock.time)
  )
    throw new Error("不在本交易日连续竞价时段");
  session.sequence++;
  session.lastObservedAt = observation.observedAt;
  // 方案 6：首帧开盘套用计划冻结的降级声明（与 executePlan 同一口径），
  // 当日保护单的降级收益上限随即生效；零帧会话由 closeSession 套用。
  if (session.sequence === 1) applyPlanDowngrades(book, session.plan);
  const accepted = [];
  for (const [code, quote] of Object.entries(observation.quotes)) {
    const quoteTime = new Date(quote.timestamp).getTime(),
      age = observed.getTime() - quoteTime;
    const last = session.quotes[code];
    if (
      quote.date !== session.date ||
      !/^\d{6}$/.test(code) ||
      !Number.isFinite(quoteTime) ||
      age < -3000 ||
      age > 15000 ||
      !(quote.closeCents > 0) ||
      !Number.isFinite(quote.volumeShares) ||
      quote.volumeShares < 0 ||
      // 去重按时刻比较而非字符串：同一时刻的 UTC/+08:00 表示不得被
      // 误判为重复或乱序报价（§3.1）。
      (last && quoteTime <= new Date(last.timestamp).getTime())
    )
      continue;
    const expected =
      session.initialBook.positions.find((p) => p.code === code)?.markCents ||
      session.plan.orders.find((o) => o.code === code)?.referenceCents;
    if (
      expected &&
      Math.abs(quote.previousCloseCents - expected) >
        Math.max(1, expected * 0.001)
    ) {
      // 结构化标记：告警器只认枚举，不解析中文原因（§3.1 除权不匹配
      // 属于"需要处理的运行阻塞，立即告警"）。
      for (const order of session.orders.filter(
        (o) => o.code === code && !TERMINAL.has(o.status),
      )) {
        order.reason = "昨收与冻结参考价不一致，需核对除权，暂停该股交易";
        order.holdCode = "CORPORATE_ACTION_UNVERIFIED";
      }
      continue;
    }
    // A warm-up quote establishes the cumulative-volume baseline. Gaps never supply invented liquidity.
    const gap = last
      ? quoteTime - new Date(last.timestamp).getTime()
      : Infinity;
    const volume =
      gap <=
        Math.max(
          20000,
          Math.min(60, observation.pollIntervalSeconds || 10) * 2000,
        ) && quote.volumeShares >= last.volumeShares
        ? quote.volumeShares - last.volumeShares
        : 0;
    session.quotes[code] = structuredClone(quote);
    // 报价已被接受：该股此前的除权暂停标记必须清除，否则会自动永远挂着。
    for (const order of session.orders)
      if (order.code === code && order.holdCode) order.holdCode = null;
    const position = book.positions.find((p) => p.code === code);
    if (position) {
      position.markCents = quote.closeCents;
      position.markDate = session.date;
    }
    accepted.push({ code, quote, volume });
  }
  mark(book);
  const prices = new Map(
    Object.entries(session.quotes).map(([code, q]) => [code, q.closeCents]),
  );
  const clockTime = clock.time;
  // Expire buys even when the provider is unavailable; sells and risk exits keep retrying.
  for (const order of session.orders)
    if (
      !TERMINAL.has(order.status) &&
      !order.protective &&
      order.side === "BUY" &&
      !order.allDay &&
      clockTime > "09:35:00"
    ) {
      order.status = order.filledQuantity ? "EXPIRED_PARTIAL" : "EXPIRED";
      order.reason = "建仓/加仓窗口结束，取消剩余买入数量";
    }
  for (const { code, quote, volume } of accepted.sort((a, b) =>
    a.code.localeCompare(b.code),
  )) {
    // 新成本模型（§4.4）：同一报价区间内的订单共享绝对成交容量，由
    // executeFill 依据 session.executionState 的区间游标执行；旧模型保持
    // 原有的每帧预算分派。
    const useCostModel = !!session.executionState;
    let budget = useCostModel
      ? Infinity
      : roundLot(volume * riskLimits.maxParticipation);
    const list = session.orders
      .filter((o) => o.code === code)
      .sort(
        (a, b) =>
          Number(b.protective) - Number(a.protective) ||
          Number(b.side === "SELL") - Number(a.side === "SELL") ||
          a.id.localeCompare(b.id),
      );
    function fill(order, side, desired) {
      order.attempts++;
      if (
        side === "BUY" &&
        1 - book.equityCents / book.peakEquityCents >= riskLimits.maxDrawdown
      ) {
        order.status = "BLOCKED";
        order.reason = "账户回撤达到上限，暂停买入";
        return { ok: false };
      }
      const before = ledger.length;
      const result = executeFill(
        book,
        session.plan,
        {
          date: session.date,
          quotes: session.quotes,
          source: "腾讯 qt.gtimg.cn HTTP 轮询",
        },
        prices,
        ledger,
        order,
        side,
        Math.min(desired, budget),
        {
          // 分段时刻取可因果执行的观察时刻（§3.1）：本帧在 clock.time
          // （Asia/Shanghai）尝试成交，报价自身时间戳只用于新鲜度与
          // 区间标识——09:31:05 观测到 09:30:55 的报价按 09:31 计费。
          time: clock.time,
          priceCents: quote.closeCents,
          volumeShares: volume,
          // 采样质量来自观测本身：分钟采样重放与实时轮询分别声明（§4.5）。
          quality: observation.observationQuality || "realtime_poll",
          intervalKey: quote.timestamp,
        },
        session.executionState,
      );
      if (result.ok) {
        budget -= result.quantity;
        const row = ledger[before];
        row.sequence = session.fillCount++;
        row.id = `${session.date}:live:${row.sequence}`;
        row.orderId = order.id;
        row.quoteTimestamp = quote.timestamp;
        row.observationSequence = session.sequence;
        order.lastFillAt = quote.timestamp;
        order.reason = "按实时行情、成本模型及费用模拟成交";
      } else {
        order.reason = result.reason;
        order.status =
          order.filledQuantity || order.firstFilled ? "PARTIAL" : "BLOCKED";
      }
      return result;
    }
    for (const order of list) {
      if (TERMINAL.has(order.status)) continue;
      if (order.protective) {
        if (!order.triggered) {
          const dd = 1 - book.equityCents / book.peakEquityCents;
          if (
            quote.closeCents > order.stopCents &&
            quote.closeCents < order.takeProfitCents &&
            dd < riskLimits.maxDrawdown
          )
            continue;
          const stopHit =
            quote.closeCents <= order.stopCents || dd >= riskLimits.maxDrawdown;
          const heldPosition = book.positions.find((p) => p.code === code);
          // 方案 6：降级持仓的收益目标即清仓线——保护触达直接全退，
          // 不走金字塔档位（收益目标上限已收紧保护触发位）。仅对冻结
          // 了显式降级规则版本的新计划启用。
          const classCap = downgradeEnabledForPlan(session.plan)
            ? (CLASS_MANAGEMENT[heldPosition?.stockClass]?.takeProfitCap ??
              null)
            : null;
          const capExit = !stopHit && classCap != null;
          // 方案 4：止盈触发按金字塔下一未执行档减仓（价格须触达该档
          // 里程碑），未触达时保护单保持武装、不取消原计划——不再固定
          // 减半覆盖计划的比例；旧计划无 pyramidReduce 向量 → 保持原
          // 减半语义。
          const rung =
            stopHit || capExit
              ? null
              : protectivePyramidReduce(
                  heldPosition,
                  quote.closeCents,
                  session.plan.strategy?.pyramidReduce,
                );
          const held = quantityOf(book, code);
          const pyramidActive = Array.isArray(
            session.plan.strategy?.pyramidReduce,
          );
          // 方案 4：同档减仓尚有未完成跨日剩余量时，保护止盈不得取消它
          // 也不得跳到下一档——保持武装，由续单完成未竟档位后再评估。
          const unfinishedRung =
            pyramidActive &&
            list.some(
              (other) =>
                other !== order &&
                !other.protective &&
                !TERMINAL.has(other.status) &&
                other.side === "SELL" &&
                other.action === "REDUCE" &&
                Number.isInteger(other.pyramidRung) &&
                other.filledQuantity < other.quantity,
            );
          const reduceQuantity = rung
            ? roundLot(held * rung.ratio)
            : roundLot(held / 2) || held;
          if (
            !stopHit &&
            !capExit &&
            pyramidActive &&
            (!rung || reduceQuantity <= 0 || unfinishedRung)
          )
            continue; // 未到档位里程碑或档位未完成，等待价格/续单
          order.triggered = true;
          if (stopHit || capExit) {
            order.action = "EXIT";
            order.quantity = held;
            order.reason = stopHit
              ? "保护退出触发"
              : "降级后收益目标兑现（保护触发）";
          } else if (rung) {
            order.action = "REDUCE";
            order.quantity = reduceQuantity;
            order.pyramidRung = rung.rung;
            order.reason = `保护止盈按金字塔减仓：第 ${rung.rung} 档减 ${Math.round(rung.ratio * 10)} 成`;
          } else {
            order.action = "REDUCE";
            order.quantity = reduceQuantity;
            order.reason = "分批止盈触发";
          }
          for (const other of list)
            if (other !== order && !TERMINAL.has(other.status)) {
              other.status = "CANCELLED";
              other.reason = "保护订单触发，取消原计划；实际仓位已保留";
            }
        }
      }
      if (order.side === "PAIR") {
        if (clockTime < "09:35:00") continue;
        const forward = order.action === "T_FORWARD";
        const secondTrigger = forward
          ? quote.closeCents >= order.sellTriggerCents
          : quote.closeCents <= order.buyTriggerCents;
        if (order.firstFilled && (secondTrigger || clockTime >= "14:50:00")) {
          order.phase = "SECOND";
          order.status = "SECOND_LEG";
        }
        if (order.phase === "FIRST") {
          if (order.firstFilled >= order.quantity) {
            order.status = "FIRST_LEG";
            continue;
          }
          if (clockTime >= "14:45:00") {
            order.status = "EXPIRED";
            order.reason = "尾盘不再开启做 T";
            continue;
          }
          const triggered = forward
            ? quote.closeCents <= order.buyTriggerCents
            : quote.closeCents >= order.sellTriggerCents;
          if (!triggered) continue;
          const position = book.positions.find((p) => p.code === code);
          if (
            !position ||
            (forward &&
              availableQuantity(position, session.date) < order.quantity)
          ) {
            order.reason = "T+1 可卖底仓不足";
            order.status = "BLOCKED";
            continue;
          }
          const result = fill(
            order,
            forward ? "BUY" : "SELL",
            order.quantity - order.firstFilled,
          );
          if (result.ok) {
            order.firstFilled += result.quantity;
            order.status = "FIRST_LEG";
          }
          continue;
        }
        if (quote.timestamp <= order.lastFillAt && order.secondFilled === 0)
          continue;
        if (!secondTrigger && clockTime < "14:50:00") continue;
        const result = fill(
          order,
          forward ? "SELL" : "BUY",
          order.firstFilled - order.secondFilled,
        );
        if (result.ok) {
          order.secondFilled += result.quantity;
          order.filledQuantity = order.secondFilled;
          order.status =
            order.secondFilled === order.firstFilled ? "FILLED" : "SECOND_LEG";
        }
      } else {
        if (order.protective && !order.triggered) continue;
        if (order.side === "BUY" && !order.allDay && clockTime > "09:35:00")
          continue;
        if (
          order.side === "BUY" &&
          order.maxPriceCents &&
          quote.closeCents > order.maxPriceCents
        ) {
          order.reason = "现价超过事前买入上限，等待窗口内回落";
          continue;
        }
        const result = fill(
          order,
          order.side,
          order.quantity - order.filledQuantity,
        );
        if (result.ok) {
          order.filledQuantity += result.quantity;
          order.status =
            order.filledQuantity >= order.quantity ? "FILLED" : "PARTIAL";
        }
      }
    }
  }
  // Newly acquired stock is monitored, too. Its T+1-blocked exit persists to the next day.
  for (const p of book.positions)
    if (!session.orders.some((o) => o.code === p.code && o.protective)) {
      const original = session.plan.orders.find((o) => o.code === p.code) || {};
      const basis = costBasis(p) / totalQuantity(p);
      session.orders.push(
        running({
          ...original,
          id: `${session.date}:${p.code}:protect-new`,
          code: p.code,
          name: p.name,
          sector: p.sector,
          protective: true,
          side: "SELL",
          action: "EXIT",
          quantity: 0,
          stopCents:
            original.stopCents ||
            Math.round(basis * (1 - BASE_STRATEGY.stopLoss)),
          takeProfitCents:
            original.takeProfitCents ||
            Math.round(basis * (1 + BASE_STRATEGY.takeProfit)),
        }),
      );
    }
  mark(book);
  return { book, session, ledger };
}

export function closeSession(inputBook, inputSession, dataset) {
  const book = structuredClone(inputBook),
    session = structuredClone(inputSession),
    notices = [];
  if (session.status !== "OPEN" || dataset.date !== session.date)
    throw new Error("实时交易日状态无效");
  // 方案 6：零帧会话（开盘后没有任何轮询推进）没有首帧套用时机，在
  // 收盘结算前套用计划冻结的降级声明，账本与有帧路径一致。
  if (session.sequence === 0) applyPlanDowngrades(book, session.plan, notices);
  for (const p of book.positions) {
    const q = dataset.quotes[p.code];
    if (
      !q ||
      q.date !== session.date ||
      q.timestamp < `${session.date}T15:00:00` ||
      !(q.closeCents > 0)
    )
      throw new Error(`${p.code} 缺少当天最终收盘报价，结算暂停`);
    const original = session.initialBook.positions.find(
      (old) => old.code === p.code,
    );
    if (
      original &&
      Math.abs(q.previousCloseCents - original.markCents) >
        Math.max(1, original.markCents * 0.001)
    )
      throw new Error(`${p.code} 昨收与账面价格不一致，需核对除权，结算暂停`);
    p.markCents = q.closeCents;
    p.markDate = session.date;
    p.heldDays++;
    // 帧末观测价盯市不是真实收盘：如实记 notice 并把当日净值标记为
    // 不完整，资格由覆盖闸门暴露，不用盘中价冒充收盘价。
    if (q.closingSource === "FRAME_LAST_OBSERVED")
      notices.push(
        `${p.code} 缺少最终收盘报价，按帧末观测价盯市；当日净值不完整`,
      );
  }
  book.pendingRecovery = [];
  book.pendingExits = [];
  book.pendingOrders = [];
  for (const order of session.orders) {
    if (TERMINAL.has(order.status)) continue;
    if (order.side === "PAIR" && order.firstFilled > order.secondFilled) {
      order.status = "INCOMPLETE_T";
      order.reason = "做 T 第二腿尚未完成，保留实际仓位并转入下一交易日恢复";
      book.pendingRecovery.push({
        code: order.code,
        name: order.name,
        sector: order.sector,
        side: order.action === "T_FORWARD" ? "SELL" : "BUY",
        quantity: order.firstFilled - order.secondFilled,
      });
    } else {
      if (
        order.action === "EXIT" &&
        (!order.protective || order.triggered) &&
        quantityOf(book, order.code)
      )
        book.pendingExits.push({
          code: order.code,
          name: order.name,
          sector: order.sector,
        });
      if (order.recovery && order.filledQuantity < order.quantity)
        book.pendingRecovery.push({
          code: order.code,
          name: order.name,
          sector: order.sector,
          side: order.side,
          quantity: order.quantity - order.filledQuantity,
        });
      if (
        order.side === "SELL" &&
        order.action === "REDUCE" &&
        !order.recovery &&
        order.filledQuantity < order.quantity &&
        quantityOf(book, order.code)
      )
        book.pendingOrders.push({
          code: order.code,
          name: order.name,
          sector: order.sector,
          quantity: Math.min(
            order.quantity - order.filledQuantity,
            quantityOf(book, order.code),
          ),
          // 方案 4：保留档位声明——跨日续单成交仍推进 pyramidStage，
          // 否则次日计划会重复生成同档减仓。
          ...(Number.isInteger(order.pyramidRung)
            ? { pyramidRung: order.pyramidRung }
            : {}),
        });
      order.status = order.filledQuantity ? "EXPIRED_PARTIAL" : "EXPIRED";
      if (!order.protective || order.triggered)
        order.reason = `${order.reason}；收盘未完成部分已记录`;
    }
  }
  mark(book);
  const marketValueCents = book.equityCents - book.cashCents;
  const unrealizedPnlCents = book.positions.reduce(
    (sum, p) => sum + totalQuantity(p) * p.markCents - costBasis(p),
    0,
  );
  const dailyPnlCents = book.equityCents - session.initialBook.equityCents;
  book.peakEquityCents = Math.max(book.peakEquityCents, book.equityCents);
  book.lastDate = session.date;
  book.settlementCount++;
  const equity = {
    date: session.date,
    cashCents: book.cashCents,
    marketValueCents,
    equityCents: book.equityCents,
    dailyPnlCents,
    dailyReturn: dailyPnlCents / session.initialBook.equityCents,
    totalReturn: book.equityCents / book.initialCashCents - 1,
    realizedPnlCents: book.realizedPnlCents,
    unrealizedPnlCents,
    feesCents: book.feesCents,
    drawdown: 1 - book.equityCents / book.peakEquityCents,
    complete: notices.length === 0,
    positionCount: book.positions.length,
    missingMinuteOrders: 0,
    source: "腾讯实时模拟成交与收盘盯市",
    executionCost: session.plan?.executionCostPolicy
      ? {
          modelVersion: session.plan.executionCostPolicy.modelVersion,
          policyDigest: session.plan.executionCostPolicy.payloadDigest,
        }
      : null,
  };
  if (
    book.cashCents < 0 ||
    book.equityCents - book.initialCashCents !==
      book.realizedPnlCents + unrealizedPnlCents
  )
    throw new Error("实时资金账本与盈亏不一致");
  session.status = "CLOSED";
  return {
    book,
    session,
    equity,
    ledger: [],
    outcomes: session.orders.filter((o) => !o.protective || o.triggered),
    notices,
  };
}
