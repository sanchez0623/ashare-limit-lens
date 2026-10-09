import {
  executeFill,
  totalQuantity,
  availableQuantity,
  costBasis,
  roundLot,
  RISK_LIMITS,
  BASE_STRATEGY,
} from "./trading.js";

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
  if (
    !plan ||
    plan.signalDate !== book.lastDate ||
    plan.signalDate >= date ||
    plan.createdAt >= `${date}T01:15:00.000Z`
  )
    throw new Error("缺少执行日前冻结的计划，自动交易暂停");
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
  const book = structuredClone(inputBook),
    session = structuredClone(inputSession),
    ledger = [];
  if (session.status !== "OPEN") return { book, session, ledger };
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
      (last && quote.timestamp <= last.timestamp)
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
      for (const order of session.orders.filter(
        (o) => o.code === code && !TERMINAL.has(o.status),
      ))
        order.reason = "昨收与冻结参考价不一致，需核对除权，暂停该股交易";
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
    let budget = roundLot(volume * RISK_LIMITS.maxParticipation);
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
        1 - book.equityCents / book.peakEquityCents >= RISK_LIMITS.maxDrawdown
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
          time: quote.timestamp.slice(11, 19),
          priceCents: quote.closeCents,
          volumeShares: volume,
          quality: "realtime_poll",
        },
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
        order.reason = "按实时行情、滑点及费用模拟成交";
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
            dd < RISK_LIMITS.maxDrawdown
          )
            continue;
          order.triggered = true;
          order.action =
            quote.closeCents <= order.stopCents || dd >= RISK_LIMITS.maxDrawdown
              ? "EXIT"
              : "REDUCE";
          const held = quantityOf(book, code);
          order.quantity =
            order.action === "EXIT" ? held : roundLot(held / 2) || held;
          order.reason =
            order.action === "EXIT" ? "保护退出触发" : "分批止盈触发";
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
    session = structuredClone(inputSession);
  if (session.status !== "OPEN" || dataset.date !== session.date)
    throw new Error("实时交易日状态无效");
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
    complete: true,
    positionCount: book.positions.length,
    missingMinuteOrders: 0,
    source: "腾讯实时模拟成交与收盘盯市",
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
    notices: [],
  };
}
