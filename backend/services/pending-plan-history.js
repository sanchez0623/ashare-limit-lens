import { PaperRepository } from "../storage/paper.js";
import {
  frozenProgramSignal,
  preserveProgramSignal,
} from "../storage/strategy-signals.js";
import { marketClock } from "../domain/realtime.js";
import { createDragonPlan, isDragon } from "../domain/dragon-risk.js";
import { assertProgramSnapshot } from "../domain/trading.js";
import { canonicalJson, digestOf } from "../domain/research-lineage.js";
import { selectionSnapshotDigest } from "../domain/signal-selection.js";
import { resolveDailyPriceInputs } from "./price-history.js";
import { buildSnapshotPayload } from "./review.js";
import { exportPaper, verifyExport } from "./paper.js";

function preparationOpen(date, now) {
  const clock = marketClock(now);
  return (
    (clock.date === date && clock.time >= "15:05:00") ||
    (clock.date > date && clock.time < "09:30:00")
  );
}

async function assertUnused(db, date) {
  const used = await db
    .prepare(
      "SELECT 1 FROM paper_live_sessions WHERE json_extract(payload,'$.plan.signalDate')=? LIMIT 1",
    )
    .bind(date)
    .first();
  if (used) throw new Error("计划已开始执行，不能补改冻结依据");
  const shadow = await db
    .prepare("SELECT 1 FROM shadow_plans WHERE signal_date=? LIMIT 1")
    .bind(date)
    .first();
  if (shadow) throw new Error("该信号日影子计划已冻结，需一并核对后再修订");
  if (
    await db
      .prepare(
        "SELECT 1 FROM research_window_owners WHERE namespace='main' LIMIT 1",
      )
      .first()
  )
    throw new Error("主账户研究正在使用冻结输入，不能修订计划");
}

// Explicit maintenance of an unexecuted plan, never an amendment to a live day.
// Keep its runtime/configuration unchanged: the running server can consume this
// data revision, and a later engine upgrade uses the normal version lifecycle.
export async function repairPendingPlanHistory(env, options = {}) {
  const papers = new PaperRepository(env),
    account = await papers.account();
  const date = account?.book.lastDate;
  const previousRow =
    date &&
    (await env.DB.prepare(
      "SELECT payload,digest FROM paper_plans WHERE signal_date=?",
    )
      .bind(date)
      .first());
  const previous = previousRow && JSON.parse(previousRow.payload);
  if (!isDragon(previous)) throw new Error("仅支持尚未执行的独立政策计划");
  const clockNow = () => options.now ?? new Date();
  if (!preparationOpen(date, clockNow()))
    throw new Error("仅可在盘后或开盘前修订下一交易日计划");
  await assertUnused(env.DB, date);
  if ((await digestOf(previous)) !== previousRow.digest)
    throw new Error("原计划摘要不一致");
  const before = await exportPaper(env);
  const verified = await verifyExport(before);
  if (!verified.passed) throw new Error("原账本或冻结依据重放核验未通过");
  const source = await frozenProgramSignal(env.DB, previous);
  if (!source?.market?.rows)
    throw new Error("缺少信号日原始行情，不能重建观察依据");
  const snapshotRow = await env.DB.prepare(
    "SELECT payload FROM snapshots WHERE trade_date=?",
  )
    .bind(date)
    .first();
  if (
    !snapshotRow ||
    (await selectionSnapshotDigest(JSON.parse(snapshotRow.payload))) !==
      previous.selectionAudit.snapshotDigest
  )
    throw new Error("当日归档与待修订计划引用不一致");

  const inputs =
    options.dailyInputs ??
    (await resolveDailyPriceInputs(env, date, {
      rows: [
        ...source.market.rows,
        ...(source.market.brokenRows ?? []),
        ...(source.market.previous ?? []),
      ],
      codes: account.book.positions.map((p) => p.code),
      ...(options.localDataset !== undefined
        ? { localDataset: options.localDataset }
        : {}),
      ...(options.history ? { history: options.history } : {}),
      now: clockNow(),
    }));
  if (inputs.status.pendingCodes?.length || inputs.status.limited)
    return {
      changed: false,
      status: "WAITING_PRICE_HISTORY",
      signalDate: date,
      ...inputs.status,
    };
  if (
    canonicalJson(inputs.evidence) === canonicalJson(source.dailyPriceInputs) &&
    !source.dailyPriceSources?.limited
  )
    return {
      changed: false,
      status: "ALREADY_COMPLETE",
      signalDate: date,
      candidates: previous.entryExecutionPolicy.candidates.length,
    };

  const stamp = clockNow().toISOString();
  const revised = await buildSnapshotPayload(
    env,
    {
      ...source.market,
      date,
      source: source.source,
      industryContext: source.industryContext,
      ...(source.sectorPerformance
        ? { sectorPerformance: source.sectorPerformance }
        : {}),
    },
    source.weights,
    inputs,
    {
      createdAt: stamp,
      firstNegMinPrevHeight:
        previous.entryExecutionPolicy.firstNegMinPrevHeight,
    },
  );
  if (
    revised.industryContext?.stockEmSnapshotId !==
    previous.entryExecutionPolicy.industrySnapshotId
  )
    throw new Error("修订必须沿用原冻结行业快照");
  const planBook = {
    ...account.book,
    dragonConfig: previous.dragonPolicy.config,
    dragonConfigId: previous.dragonPolicy.configId,
    dragonConfigDigest: previous.dragonPolicy.configDigest,
    dragonConfigProvenance: previous.dragonPolicy.provenance,
    dragonEngineBuild: previous.engineBuild,
    feeConfig: previous.feeConfig,
    feeModel: previous.feeModel,
    feeConfigVersion: previous.feeConfigVersion,
  };
  const replacement = createDragonPlan(revised, planBook, stamp, {
    engineBuild: previous.engineBuild,
    dragonTemplateVersion: previous.dragonPolicy.templateVersion,
    adaptiveRiskPolicy: previous.dragonPolicy.adaptiveRiskPolicy,
    entryOrderPolicy: previous.dragonPolicy.entryOrderPolicy ?? null,
    tCapitalPolicy: previous.dragonPolicy.tCapitalPolicy ?? null,
    manualExitRequests: previous.manualExitRequests,
    executionCostPolicy: previous.executionCostPolicy,
    snapshotDigest: await selectionSnapshotDigest(revised),
  });
  assertProgramSnapshot(replacement, revised, planBook);
  const hash = await digestOf(replacement),
    id = `history-repair-${crypto.randomUUID()}`;
  const event = {
    type: "PENDING_PLAN_HISTORY_COMPLETED",
    createdAt: stamp,
    signalDate: date,
    oldPlanDigest: previousRow.digest,
    planDigest: hash,
    oldSourceDigest: previous.selectionAudit.snapshotDigest,
    sourceDigest: replacement.selectionAudit.snapshotDigest,
    originalCandidates: previous.entryExecutionPolicy.candidates.length,
    candidates: replacement.entryExecutionPolicy.candidates.length,
    runtimeBuild: previous.engineBuild,
    inputStatus: inputs.status,
  };
  if (options.dryRun) return { changed: false, status: "PREVIEW", ...event };

  await env.DB.transaction(async () => {
    if (!preparationOpen(date, clockNow())) throw new Error("已过盘前修订窗口");
    await assertUnused(env.DB, date);
    const current = await papers.account();
    const currentPlan = await env.DB.prepare(
      "SELECT digest FROM paper_plans WHERE signal_date=?",
    )
      .bind(date)
      .first();
    const currentSnapshot = await env.DB.prepare(
      "SELECT payload FROM snapshots WHERE trade_date=?",
    )
      .bind(date)
      .first();
    if (
      current.revision !== account.revision ||
      canonicalJson(current.book) !== canonicalJson(account.book) ||
      currentPlan?.digest !== previousRow.digest ||
      currentSnapshot?.payload !== snapshotRow.payload
    )
      throw new Error("账户或计划已变化，修订已回滚");
    await env.DB.prepare(
      "INSERT INTO paper_plan_revisions(id,signal_date,created_at,payload,digest) VALUES(?,?,?,?,?)",
    )
      .bind(id, date, stamp, previousRow.payload, previousRow.digest)
      .run();
    await preserveProgramSignal(env.DB, replacement, revised);
    await env.DB.prepare("DELETE FROM paper_plans WHERE signal_date=?")
      .bind(date)
      .run();
    await env.DB.prepare(
      "DELETE FROM dragon_plan_bindings WHERE scope='main' AND signal_date=?",
    )
      .bind(date)
      .run();
    await papers.savePlan(replacement);
    await env.DB.prepare(
      "UPDATE snapshots SET created_at=?,payload=? WHERE trade_date=?",
    )
      .bind(stamp, JSON.stringify(revised), date)
      .run();
    await env.DB.prepare(
      "INSERT INTO paper_configuration_history(id,created_at,payload,digest) VALUES(?,?,?,?)",
    )
      .bind(id, stamp, JSON.stringify(event), await digestOf(event))
      .run();
    const after = await exportPaper(env);
    for (const key of [
      "book",
      "ledger",
      "datasets",
      "equities",
      "realtimeSessions",
      "realtimeObservations",
    ])
      if (canonicalJson(after[key]) !== canonicalJson(before[key]))
        throw new Error(`修订不得改变 ${key}`);
    if (!(await verifyExport(after)).passed)
      throw new Error("修订后重放核验未通过，已回滚");
  });
  return { changed: true, status: "REPAIRED", ...event };
}
