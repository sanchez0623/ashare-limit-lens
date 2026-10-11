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

export function windowMetrics({ initial, finalBook, equities, windowDates }) {
  // initial: {equityCents, feesCents, realizedPnlCents, unrealizedPnlCents}（捕获时点快照）
  const finalEquityCents = finalBook.equityCents;
  const initialEquityCents = initial.equityCents;
  if (!initialEquityCents || initialEquityCents <= 0)
    throw new Error("期初权益无效，无法计算窗口指标");
  const netReturn = finalEquityCents / initialEquityCents - 1;
  const feesDeltaCents = finalBook.feesCents - initial.feesCents;
  const profitCents =
    finalBook.realizedPnlCents -
    initial.realizedPnlCents +
    unrealizedPnlCents(finalBook) -
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
      if (entry.quantity === 0 && !entry.inherited) entry.openedInWindow = true;
      entry.quantity += fill.quantity;
    } else {
      entry.quantity = Math.max(0, entry.quantity - fill.quantity);
      if (entry.quantity === 0) {
        if (entry.openedInWindow) {
          entry.rounds += 1;
          entry.openedInWindow = false;
        }
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
  return { rounds, byCode };
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
