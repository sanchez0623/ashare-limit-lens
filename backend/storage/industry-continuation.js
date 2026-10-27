import { digestOf } from "../domain/research-lineage.js";
import { executionEngineBuildDigest } from "../domain/execution-build.js";
import { frozenProgramSignal } from "./strategy-signals.js";
import { openSession, advanceSession } from "../domain/realtime.js";
import { ENTRY_ORDER_POLICY } from "../../shared/entry-order-policy.js";
import { validAdaptiveRiskPolicy } from "../../shared/adaptive-risk.js";

export const INDUSTRY_CONTINUATION = "DRAGON_INDUSTRY_RUNTIME_CONTINUED";

export function planPayload(plan) {
  const { digest: _digest, ...payload } = plan;
  return payload;
}

// A queued configuration affects a future plan, not execution of this frozen
// plan. Preserve it in the account, while comparing all current execution state.
export function continuationBookPayload(book) {
  const { pendingDragonConfigId: _pending, ...payload } = book;
  return payload;
}

export async function industryContinuationId(
  plan,
  runtimeBuild,
  scope = "main",
) {
  return `industry-continuation-${await digestOf({
    scope,
    planDigest: await digestOf(planPayload(plan)),
    runtimeBuild,
  })}`;
}

export async function verifyEntryOrderObservation(
  bundle,
  plan,
  date,
  sequence,
  observation,
) {
  const hasEntry = Object.hasOwn(observation, "entryOrderPolicy");
  const hasRisk = Object.hasOwn(observation, "adaptiveRiskPolicy");
  if (!hasEntry && !hasRisk) return true;
  if (hasEntry && observation.entryOrderPolicy !== ENTRY_ORDER_POLICY)
    return false;
  if (hasRisk && !validAdaptiveRiskPolicy(observation.adaptiveRiskPolicy))
    return false;
  if (
    (!hasEntry ||
      plan?.dragonPolicy?.entryOrderPolicy === ENTRY_ORDER_POLICY) &&
    (!hasRisk ||
      plan?.dragonPolicy?.adaptiveRiskPolicy?.version ===
        observation.adaptiveRiskPolicy.version)
  )
    return true;
  if (!plan) return false;
  const planDigest = await digestOf(plan);
  for (const row of bundle.configurationHistory ?? []) {
    const event = row.payload;
    if (
      event.type === INDUSTRY_CONTINUATION &&
      event.scope === "main" &&
      (!hasEntry || event.entryOrderPolicy === observation.entryOrderPolicy) &&
      (!hasRisk ||
        (validAdaptiveRiskPolicy(event.adaptiveRiskPolicy) &&
          event.adaptiveRiskPolicy.version ===
            observation.adaptiveRiskPolicy.version)) &&
      event.tradeDate === date &&
      event.planDigest === planDigest &&
      event.verifiedPrefix.sequence < sequence &&
      Date.parse(event.createdAt) <= Date.parse(observation.observedAt) &&
      (await digestOf(event)) === row.digest &&
      event.id === (await industryContinuationId(plan, event.runtimeBuild))
    )
      return true;
  }
  return false;
}

// Offline exports retain the amendment as well as its unchanged source prefix.
// Recompute its exact state/fills rather than trusting a "passed" flag.
export async function verifyIndustryContinuationEvidence(bundle, event) {
  const plan = bundle.plans.find(
    (row) => row.payload.signalDate === event.signalDate,
  )?.payload;
  const saved = bundle.realtimeSessions?.find(
    (row) => row.payload.date === event.tradeDate,
  )?.payload;
  const source = bundle.signalSnapshots?.find(
    (row) => row.digest === event.sourceDigest,
  )?.payload;
  const prefix = event.verifiedPrefix;
  const ticks =
    bundle.realtimeObservations
      ?.find((row) => row.date === event.tradeDate)
      ?.observations.slice(0, prefix?.sequence) ?? [];
  if (
    !plan ||
    !saved ||
    event.id !== (await industryContinuationId(plan, event.runtimeBuild)) ||
    event.type !== INDUSTRY_CONTINUATION ||
    event.scope !== "main" ||
    (prefix?.bookDigestMode !== undefined &&
      prefix.bookDigestMode !== "EXECUTION_STATE_V1") ||
    (event.entryOrderPolicy !== undefined &&
      event.entryOrderPolicy !== ENTRY_ORDER_POLICY) ||
    (event.adaptiveRiskPolicy !== undefined &&
      !validAdaptiveRiskPolicy(event.adaptiveRiskPolicy)) ||
    event.planEngineBuild !== plan.engineBuild ||
    event.planDigest !== (await digestOf(plan)) ||
    event.sourceDigest !== plan.selectionAudit?.snapshotDigest ||
    source?.industryRevision?.metadataSnapshotId !== event.industrySnapshotId ||
    source.industryRevision.metadataDigest !== event.metadataDigest ||
    source.industryRevision.originalSignalFrozenAt !== plan.createdAt ||
    !Number.isInteger(prefix?.sequence) ||
    prefix.sequence < 1 ||
    ticks.length !== prefix.sequence ||
    (await digestOf(saved.initialBook)) !== prefix.initialBookDigest ||
    (await digestOf(
      ticks.map((row, index) => ({ sequence: index + 1, digest: row.digest })),
    )) !== prefix.ticksDigest
  )
    return false;
  let book = structuredClone(saved.initialBook);
  let session = openSession(book, plan, event.tradeDate);
  const fills = [];
  for (const [index, tick] of ticks.entries()) {
    if (
      !(await verifyEntryOrderObservation(
        bundle,
        plan,
        event.tradeDate,
        index + 1,
        tick.payload,
      )) ||
      (await digestOf(tick.payload)) !== tick.digest ||
      Date.parse(tick.payload.observedAt) > Date.parse(event.createdAt) ||
      (tick.payload.entryInputs?.market &&
        tick.payload.entryInputs.market.industryContext?.stockEmSnapshotId !==
          event.industrySnapshotId)
    )
      return false;
    const step = advanceSession(book, session, tick.payload);
    book = step.book;
    session = step.session;
    fills.push(...step.ledger);
  }
  const ledger = bundle.ledger.filter(
    (row) => row.date === event.tradeDate && row.sequence < prefix.fillCount,
  );
  return (
    session.fillCount === prefix.fillCount &&
    (await digestOf(session)) === prefix.sessionDigest &&
    (await digestOf(
      prefix.bookDigestMode === "EXECUTION_STATE_V1"
        ? continuationBookPayload(book)
        : book,
    )) === prefix.bookDigest &&
    (await digestOf(fills)) === prefix.ledgerDigest &&
    (await digestOf(ledger)) === prefix.ledgerDigest
  );
}

// This is an independently stored, replay-verified runtime amendment. The
// original plan/configuration fingerprint remains intact. An amendment applies
// only to its exact frozen plan and the exact runtime that verified its prefix.
export async function industryContinuation(db, plan, scope = "main") {
  if (!db || !plan?.entryExecutionPolicy || scope !== "main") return null;
  const runtimeBuild = await executionEngineBuildDigest();
  const id = await industryContinuationId(plan, runtimeBuild, scope);
  const row = await db
    .prepare(
      "SELECT payload,digest FROM paper_configuration_history WHERE id=?",
    )
    .bind(id)
    .first();
  if (!row) return null;
  const event = JSON.parse(row.payload);
  const source = await frozenProgramSignal(db, plan);
  const revision = source?.industryRevision;
  const prefix = event.verifiedPrefix;
  if (
    (await digestOf(event)) !== row.digest ||
    event.id !== id ||
    event.type !== INDUSTRY_CONTINUATION ||
    event.scope !== scope ||
    (prefix?.bookDigestMode !== undefined &&
      prefix.bookDigestMode !== "EXECUTION_STATE_V1") ||
    event.runtimeBuild !== runtimeBuild ||
    (event.entryOrderPolicy !== undefined &&
      event.entryOrderPolicy !== ENTRY_ORDER_POLICY) ||
    (event.adaptiveRiskPolicy !== undefined &&
      !validAdaptiveRiskPolicy(event.adaptiveRiskPolicy)) ||
    event.planEngineBuild !== plan.engineBuild ||
    event.planDigest !== (await digestOf(planPayload(plan))) ||
    event.sourceDigest !== plan.selectionAudit?.snapshotDigest ||
    event.signalDate !== plan.signalDate ||
    !Number.isFinite(Date.parse(event.createdAt)) ||
    revision?.version !== "eastmoney-code-industry-amendment-v1" ||
    revision.metadataSnapshotId !== event.industrySnapshotId ||
    revision.metadataDigest !== event.metadataDigest ||
    revision.originalSignalFrozenAt !== plan.createdAt ||
    Date.parse(revision.correctedAt) > Date.parse(event.createdAt) ||
    !Number.isInteger(prefix?.sequence) ||
    prefix.sequence < 1 ||
    !Number.isInteger(prefix.fillCount) ||
    prefix.fillCount < 0
  )
    throw new Error("行业续跑证明与原冻结计划或当前执行构建不一致");
  const sessionRow = await db
    .prepare("SELECT payload FROM paper_live_sessions WHERE trade_date=?")
    .bind(event.tradeDate)
    .first();
  const session = sessionRow && JSON.parse(sessionRow.payload);
  const ticks = (
    await db
      .prepare(
        "SELECT sequence,digest FROM paper_live_ticks WHERE trade_date=? AND sequence<=? ORDER BY sequence",
      )
      .bind(event.tradeDate, prefix.sequence)
      .all()
  ).results;
  if (
    !session ||
    session.sequence < prefix.sequence ||
    (await digestOf(session.plan)) !== event.planDigest ||
    (await digestOf(session.initialBook)) !== prefix.initialBookDigest ||
    ticks.length !== prefix.sequence ||
    ticks.some((tick, index) => tick.sequence !== index + 1) ||
    (await digestOf(ticks)) !== prefix.ticksDigest
  )
    throw new Error("行业续跑证明的原始会话或观测前缀不一致");
  return event;
}
