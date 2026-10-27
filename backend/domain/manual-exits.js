export const MANUAL_EXIT_VERSION = "paper-manual-exit-v1";

export function assertManualExitRequests(requests = [], plan, book) {
  if (
    !Array.isArray(requests) ||
    new Set(requests.map((row) => row.code)).size !== requests.length
  )
    throw new Error("用户清仓指令重复或格式无效");
  for (const row of requests) {
    const position = book?.positions?.find((p) => p.code === row.code);
    if (
      row.version !== MANUAL_EXIT_VERSION ||
      row.requestedBy !== "USER" ||
      !row.id ||
      !/^\d{6}$/.test(row.code) ||
      !row.positionId ||
      !row.cycleId ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.tradeDate) ||
      !Number.isSafeInteger(row.quantity) ||
      row.quantity <= 0 ||
      !Number.isFinite(Date.parse(row.createdAt)) ||
      Date.parse(row.createdAt) > Date.parse(plan.createdAt) ||
      row.signalDate > plan.signalDate ||
      !row.reason ||
      (book &&
        (!position ||
          position.dragon?.id !== row.positionId ||
          row.cycleId !== (book.tradingCycleId ?? "primary") ||
          position.lots.reduce((n, lot) => n + lot.quantity, 0) > row.quantity))
    )
      throw new Error("用户清仓指令与冻结持仓或时点不一致");
  }
}

export function manualExitFor(plan, position) {
  return plan.manualExitRequests?.find(
    (row) =>
      row.code === position.code && row.positionId === position.dragon?.id,
  );
}
