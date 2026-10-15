// 统一指标与固定排序（§8）：可核验、与账本一致、不重复累计。
// 期间费用 = 期末累计费用 - 期初累计费用；原账本费用已进入成本和现金，不再扣一次。

export function unrealizedPnlCents(book) {
  // lot.costCents 是该批次的总成本（含分摊费用，与 trading.js costBasis 同构），
  // 不能再乘数量；乘错会把期初浮盈放大为持仓市值级偏差（平价退出显示巨额盈利）。
  return (book.positions ?? []).reduce((sum, position) => {
    const quantity = position.lots.reduce((a, lot) => a + lot.quantity, 0);
    const cost = position.lots.reduce((a, lot) => a + lot.costCents, 0);
    return sum + quantity * position.markCents - cost;
  }, 0);
}

export function windowMetrics({ initial, final, equities, windowDates }) {
  // initial/final：{equityCents, feesCents, realizedPnlCents, unrealizedPnlCents}
  // 期初为捕获时点快照；期末取窗口内最后一个已结算净值行，而不是账本当前
  // 状态——末日登记后中断、次日盘中轮询会继续推进影子账本，当前权益已含
  // 窗口外盈亏，直接引用会把窗口外收益混进报告。
  const finalEquityCents = final.equityCents;
  const initialEquityCents = initial.equityCents;
  if (!initialEquityCents || initialEquityCents <= 0)
    throw new Error("期初权益无效，无法计算窗口指标");
  const netReturn = finalEquityCents / initialEquityCents - 1;
  const feesDeltaCents = final.feesCents - initial.feesCents;
  const profitCents =
    final.realizedPnlCents -
    initial.realizedPnlCents +
    final.unrealizedPnlCents -
    initial.unrealizedPnlCents;
  // 守恒校验（§8.1）：账本不变式保证 权益变化 = 已实现增量 + 未实现增量。
  // 期初快照（净值摘要）与账本真实状态不符时在此暴露，而不是输出矛盾指标。
  const equityDeltaCents = finalEquityCents - initialEquityCents;
  if (profitCents !== equityDeltaCents)
    throw new Error(
      `期间盈利 ${profitCents} 与权益变化 ${equityDeltaCents} 不一致：期初快照与账本状态不匹配`,
    );
  // 窗口回撤：1 - 当日权益 / 窗口内截至当日权益峰值（含期初捕获点）。
  let peak = initialEquityCents;
  let windowDrawdown = 0;
  const drawdownByDate = new Map();
  for (const row of [...equities].sort((a, b) =>
    (a.tradeDate ?? a.trade_date).localeCompare(b.tradeDate ?? b.trade_date),
  )) {
    const date = row.tradeDate ?? row.trade_date;
    peak = Math.max(peak, row.equityCents);
    const drawdown = 1 - row.equityCents / peak;
    drawdownByDate.set(date, drawdown);
    if (drawdown > windowDrawdown) windowDrawdown = drawdown;
  }
  const settledDates = equities.map((row) => row.tradeDate ?? row.trade_date);
  // 盯市完整性（§8.1）：按帧末观测价盯市的净值行不视为收盘数据，
  // 由覆盖闸门当作数据缺失暴露，不用盘中价冒充收盘价参与晋级。
  const incompleteDates = equities
    .filter((row) => row.complete === false)
    .map((row) => row.tradeDate ?? row.trade_date);
  const missingDates = (windowDates ?? []).filter(
    (date) => !settledDates.includes(date),
  );
  return {
    initialEquityCents,
    finalEquityCents,
    netReturn,
    feesDeltaCents,
    profitCents,
    windowDrawdown,
    windowDrawdownPpm: Math.round(windowDrawdown * 1_000_000),
    settledDays: settledDates.length,
    missingDates,
    incompleteDates,
    dataCoverage:
      windowDates && windowDates.length
        ? settledDates.filter((date) => windowDates.includes(date)).length /
          windowDates.length
        : 1,
  };
}

// 完整轮次：窗口内从零建仓到归零的新轮次；继承持仓平仓与 T 两腿不凑次数。
// initialPositionsByCode 为捕获时点的继承持仓数量（code → quantity）：
// 从该数量起步重建持仓流，只有继承持仓清零之后的新建仓轮次才计数。
// 每轮记录 buyPoint（来自 BUY 行的 order.buyPoint）、累计成本、累计卖出收入
// 与已实现盈亏，供上层按买点类型分组统计胜率与盈亏比。
export function completeRounds(
  ledgerRows,
  windowDates,
  initialPositionsByCode = {},
) {
  const windowStart = windowDates[0];
  const windowEnd = windowDates[windowDates.length - 1];
  const fills = ledgerRows
    .filter((row) => row.date >= windowStart && row.date <= windowEnd)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || (a.sequence ?? 0) - (b.sequence ?? 0),
    );
  const state = new Map();
  const roundsList = [];
  for (const fill of fills) {
    let entry = state.get(fill.code);
    if (!entry) {
      const inherited = Math.max(0, initialPositionsByCode[fill.code] ?? 0);
      entry = {
        quantity: inherited,
        inherited: inherited > 0,
        openedInWindow: false,
        rounds: 0,
      };
    }
    if (fill.side === "BUY" || fill.action === "BUY") {
      if (entry.quantity === 0 && !entry.inherited) {
        entry.openedInWindow = true;
        entry.currentRound = {
          code: fill.code,
          buyPoint: fill.buyPoint ?? null,
          buyNotional: 0,
          sellNotional: 0,
          realizedPnlCents: 0,
        };
      }
      entry.quantity += fill.quantity;
      if (entry.currentRound) {
        entry.currentRound.buyNotional += fill.notionalCents ?? 0;
      }
    } else {
      entry.quantity = Math.max(0, entry.quantity - fill.quantity);
      if (entry.currentRound) {
        entry.currentRound.sellNotional += fill.notionalCents ?? 0;
        entry.currentRound.realizedPnlCents += fill.realizedPnlCents ?? 0;
      }
      if (entry.quantity === 0) {
        if (entry.openedInWindow && entry.currentRound) {
          roundsList.push(entry.currentRound);
          entry.rounds += 1;
          entry.openedInWindow = false;
        }
        entry.currentRound = null;
        entry.inherited = false;
      }
    }
    state.set(fill.code, entry);
  }
  let rounds = 0;
  const byCode = {};
  for (const [code, entry] of state) {
    rounds += entry.rounds ?? 0;
    if (entry.rounds) byCode[code] = entry.rounds;
  }
  // 按买点类型分组统计胜率与盈亏比。
  const byBuyPoint = {};
  for (const r of roundsList) {
    const key = r.buyPoint ?? "unknown";
    if (!byBuyPoint[key])
      byBuyPoint[key] = { count: 0, wins: 0, losses: 0, pnlCents: 0, avgWin: 0, avgLoss: 0 };
    const g = byBuyPoint[key];
    g.count += 1;
    g.pnlCents += r.realizedPnlCents;
    if (r.realizedPnlCents > 0) {
      g.wins += 1;
      g.avgWin += r.realizedPnlCents;
    } else if (r.realizedPnlCents < 0) {
      g.losses += 1;
      g.avgLoss += r.realizedPnlCents;
    }
  }
  for (const key of Object.keys(byBuyPoint)) {
    const g = byBuyPoint[key];
    g.winRate = g.count > 0 ? g.wins / g.count : 0;
    g.avgWin = g.wins > 0 ? g.avgWin / g.wins : 0;
    g.avgLoss = g.losses > 0 ? g.avgLoss / g.losses : 0;
    g.profitFactor =
      g.avgLoss < 0 && g.losses > 0
        ? g.avgWin / Math.abs(g.avgLoss)
        : g.wins > 0
          ? Number.POSITIVE_INFINITY
          : 0;
  }
  return { rounds, byCode, roundsList, byBuyPoint };
}

// 固定排序（§8.2）：期末权益分较高 → 窗口回撤百万分值较低 → 期间费用分较低
// → 参数距离较小 → 成员 ID 字典序；所有匹配组合期初权益相同。
export function rankEligibleMembers(eligible) {
  return [...eligible].sort((a, b) => {
    if (b.finalEquityCents !== a.finalEquityCents)
      return b.finalEquityCents - a.finalEquityCents;
    if (b.windowDrawdownPpm !== a.windowDrawdownPpm)
      return a.windowDrawdownPpm - b.windowDrawdownPpm;
    if (a.feesDeltaCents !== b.feesDeltaCents)
      return a.feesDeltaCents - b.feesDeltaCents;
    if (a.paramsDistance !== b.paramsDistance)
      return a.paramsDistance - b.paramsDistance;
    return a.memberId.localeCompare(b.memberId);
  });
}
