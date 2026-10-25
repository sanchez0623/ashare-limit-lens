import { selectionSnapshotDigest } from "../domain/signal-selection.js";
import { downgradeEnabledForPlan } from "../../shared/downgrade.js";

export async function preserveProgramSignal(db, plan, snapshot = null) {
  const downgradeEnabled = downgradeEnabledForPlan(plan);
  const requiresSnapshot =
    Boolean(plan.strategyProgram) ||
    downgradeEnabled ||
    !!plan.entryExecutionPolicy;
  if (!requiresSnapshot || plan.sourceSnapshotMissing) return;
  const reference =
    plan.strategyProgram?.snapshotDigest ?? plan.selectionAudit?.snapshotDigest;
  if (!snapshot && reference) {
    const existing = await db
      .prepare("SELECT digest FROM strategy_signal_snapshots WHERE digest=?")
      .bind(reference)
      .first();
    if (existing) {
      await frozenProgramSignal(db, plan);
      return;
    }
  }
  if (!snapshot) {
    const row = await db
      .prepare("SELECT payload FROM snapshots WHERE trade_date=?")
      .bind(plan.signalDate)
      .first();
    snapshot = row && JSON.parse(row.payload);
  }
  if (
    !snapshot ||
    snapshot.date !== plan.signalDate ||
    !Number.isFinite(Date.parse(snapshot.createdAt)) ||
    Date.parse(snapshot.createdAt) > Date.parse(plan.createdAt)
  )
    throw new Error("不能冻结缺失或晚于计划的策略信号快照");
  const digest = await selectionSnapshotDigest(snapshot);
  if (
    plan.selectionAudit.snapshotDigest &&
    plan.selectionAudit.snapshotDigest !== digest
  )
    throw new Error("策略信号快照与计划摘要不一致");
  plan.selectionAudit.snapshotDigest = digest;
  if (plan.strategyProgram) plan.strategyProgram.snapshotDigest = digest;
  await db
    .prepare(
      "INSERT OR IGNORE INTO strategy_signal_snapshots(digest,signal_date,payload) VALUES(?,?,?)",
    )
    .bind(digest, plan.signalDate, JSON.stringify(snapshot))
    .run();
  await frozenProgramSignal(db, plan);
}
export async function frozenProgramSignal(db, plan) {
  if (!plan || plan.sourceSnapshotMissing) return null;
  const downgradeEnabled = downgradeEnabledForPlan(plan);
  const requiresSnapshot =
    Boolean(plan.strategyProgram) ||
    downgradeEnabled ||
    !!plan.entryExecutionPolicy;
  const reference =
    plan.strategyProgram?.snapshotDigest ?? plan.selectionAudit?.snapshotDigest;
  if (!reference && !requiresSnapshot) return null;
  if (
    requiresSnapshot &&
    (!reference || reference !== plan.selectionAudit?.snapshotDigest)
  )
    throw new Error("策略程序缺少原信号快照引用");
  const row = await db
    .prepare(
      "SELECT payload,signal_date FROM strategy_signal_snapshots WHERE digest=?",
    )
    .bind(reference)
    .first();
  if (!row && !requiresSnapshot) return null;
  const snapshot = row && JSON.parse(row.payload);
  if (
    !snapshot ||
    row.signal_date !== plan.signalDate ||
    snapshot.date !== plan.signalDate ||
    (await selectionSnapshotDigest(snapshot)) !== reference
  )
    throw new Error("冻结策略信号快照缺失或摘要不一致");
  return snapshot;
}
export async function exportProgramSignals(db, plans) {
  const unique = new Map();
  for (const plan of plans)
    if (
      !plan.sourceSnapshotMissing &&
      (plan.strategyProgram || plan.selectionAudit?.snapshotDigest)
    ) {
      const snapshot = await frozenProgramSignal(db, plan);
      if (!snapshot) continue;
      const reference =
        plan.strategyProgram?.snapshotDigest ??
        plan.selectionAudit.snapshotDigest;
      unique.set(reference, {
        digest: reference,
        payload: snapshot,
      });
    }
  return [...unique.values()];
}
