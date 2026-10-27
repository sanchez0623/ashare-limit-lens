import { canonicalJson, digestOf } from "../domain/research-lineage.js";

export async function pendingManualExitRequests(db, book) {
  const rows = (
    await db
      .prepare(
        "SELECT payload,digest FROM paper_manual_exit_requests WHERE cycle_id=? ORDER BY created_at,id",
      )
      .bind(book.tradingCycleId ?? "primary")
      .all()
  ).results;
  const requests = [];
  for (const row of rows) {
    const request = JSON.parse(row.payload);
    if ((await digestOf(request)) !== row.digest)
      throw new Error("用户清仓指令摘要不一致");
    if (
      book.positions.some(
        (p) => p.code === request.code && p.dragon?.id === request.positionId,
      )
    )
      requests.push(request);
  }
  return requests;
}

export async function assertManualExitReferences(
  db,
  plan,
  scope = "main",
  book = null,
) {
  const requests = plan.manualExitRequests ?? [];
  if (scope !== "main" && requests.length)
    throw new Error("用户清仓指令仅限主账户");
  for (const request of requests) {
    const row = await db
      .prepare(
        "SELECT payload,digest FROM paper_manual_exit_requests WHERE id=?",
      )
      .bind(request.id)
      .first();
    if (
      !row ||
      (await digestOf(request)) !== row.digest ||
      canonicalJson(JSON.parse(row.payload)) !== canonicalJson(request)
    )
      throw new Error("冻结计划缺少独立登记的用户清仓依据");
  }
  if (scope === "main" && book) {
    const pending = await pendingManualExitRequests(db, book);
    if (
      pending.some((row) => !requests.some((request) => request.id === row.id))
    )
      throw new Error("用户清仓指令尚未冻结进计划，暂停执行等待准备");
  }
}

export async function exportedManualExitReferences(bundle, plan) {
  for (const request of plan.manualExitRequests ?? []) {
    const row = bundle.manualExitRequests?.find(
      (row) => row.payload.id === request.id,
    );
    if (
      !row ||
      row.digest !== (await digestOf(request)) ||
      canonicalJson(row.payload) !== canonicalJson(request)
    )
      return false;
  }
  return true;
}
