import { ResearchRepository } from "./research.js";
import { CohortRepository } from "./cohorts.js";
import { digestOf, eventDigest } from "../domain/research-lineage.js";
import { frozenParamDistance } from "../domain/cohort-policy.js";
import { verifyStressFreeze } from "../domain/execution-stress.js";
import {
  selectionPolicyFields,
  frozenSelectionPolicy,
} from "../domain/signal-selection.js";
import { researchForwardBuildMatches } from "../domain/research-build.js";

// 单候选复用前瞻执行器。仅将已预留的窗口交给一个 SINGLE 运行组；
// 不调用模型，不消耗新预算，不改变提案清单，也不重新登记历史样本。
export async function adoptSingleExperiment(env, experimentId) {
  const research = new ResearchRepository(env);
  const cohorts = new CohortRepository(env);
  const prior = await cohorts.memberByExperiment(experimentId);
  if (prior) return { cohortId: prior.cohortId, duplicate: true };
  const experiment = await research.getExperiment(experimentId);
  if (!experiment || experiment.stage !== "AWAITING_SHADOW")
    throw new Error("只有等待影子验证的单候选可以开户");
  const protocol = experiment.reservationPayload.singleForward;
  if (!protocol) {
    await research.recordInvalidated(
      experimentId,
      experiment.candidateVersion,
      "旧候选未在提案前冻结前瞻和成本压力规则；保留记录，使用新日期重新提案",
      experiment.revision,
    );
    return {
      scheduled: false,
      invalidated: true,
      reason: "旧候选缺少事前冻结协议",
    };
  }
  const { digest: protocolDigest, ...protocolSource } = protocol;
  if ((await digestOf(protocolSource)) !== protocolDigest)
    throw new Error("单候选事前协议摘要不一致");
  if (!(await researchForwardBuildMatches(protocol.ruleBuildDigest))) {
    await research.recordInvalidated(
      experimentId,
      experiment.candidateVersion,
      "单候选前瞻规则源码已变化，冻结资格失效",
      experiment.revision,
    );
    return {
      scheduled: false,
      invalidated: true,
      reason: "单候选前瞻规则源码已变化",
    };
  }
  await verifyStressFreeze(protocol.executionStress);
  if ((await research.getPolicy()).id !== experiment.policyId) {
    await research.recordInvalidated(
      experimentId,
      experiment.candidateVersion,
      "研究政策在捕获前已变化，冻结资格失效",
      experiment.revision,
    );
    return {
      scheduled: false,
      invalidated: true,
      reason: "研究政策在捕获前已变化",
    };
  }
  const manifest = experiment.proposalManifest;
  if (
    !manifest ||
    (await digestOf(manifest)) !== experiment.proposalDigest ||
    (await digestOf(manifest.candidateParams)) ===
      (await digestOf(protocol.executionStress.parentParams)) ||
    manifest.parentParamsDigest !==
      (await digestOf(protocol.executionStress.parentParams)) ||
    manifest.feeConfigDigest !== protocol.feeConfigDigest
  )
    throw new Error("单候选提案与事前冻结环境不一致");
  const version = await research.db
    .prepare("SELECT params FROM strategy_versions WHERE id=?")
    .bind(experiment.candidateVersion)
    .first();
  if (
    !version ||
    (await digestOf(JSON.parse(version.params))) !==
      (await digestOf(manifest.candidateParams))
  )
    throw new Error("单候选策略版本与冻结参数不一致");
  const screened = await research.db
    .prepare(
      "SELECT payload,digest FROM research_reports WHERE experiment_id=? AND stage=?",
    )
    .bind(
      experimentId,
      experiment.kind === "BOOTSTRAP" ? "dev_screen" : "historical",
    )
    .first();
  if (
    !screened ||
    (await digestOf(JSON.parse(screened.payload))) !== screened.digest ||
    (experiment.kind !== "BOOTSTRAP" &&
      JSON.parse(screened.payload).passed !== true)
  )
    throw new Error("单候选筛查报告缺失或未通过");
  const cohortId = `single-${experimentId.slice(4)}`;
  const now = new Date().toISOString();
  const reservation = {
    cohortId,
    namespace: experiment.namespace,
    mode: "SINGLE",
    experimentId,
    parentVersion: experiment.parentVersion,
    attemptSequences: [experiment.reservationPayload.attemptSequence],
    trainingDates: experiment.reservationPayload.trainingDates,
    testDates: experiment.reservationPayload.testDates,
    researchPolicyId: experiment.policyId,
    researchPolicyDigest: protocol.policyDigest,
    cohortPolicy: protocol,
    feeConfig: protocol.feeConfig,
    feeConfigDigest: protocol.feeConfigDigest,
    executionStress: protocol.executionStress,
    ...selectionPolicyFields(
      frozenSelectionPolicy(experiment.reservationPayload),
    ),
    originalReservationDigest: await digestOf(experiment.reservationPayload),
    reservedAt: experiment.reservationPayload.reservedAt,
  };
  const reservationDigest = await digestOf(reservation);
  const proposal = {
    mode: "SINGLE",
    experimentId,
    proposalDigest: experiment.proposalDigest,
    statisticsBudget: protocol.statisticsBudget,
    executionVersion: manifest.executionVersion,
    scoringVersion: manifest.scoringVersion,
  };
  const last = await research.lastEvent(experimentId);
  const event = {
    sequence: (last?.sequence ?? 0) + 1,
    eventType: "SINGLE_FORWARD_ADOPTED",
    createdAt: now,
    payload: { cohortId, protocolDigest, reservationDigest },
    previousDigest: last?.digest ?? null,
  };
  const cohortEvent = { ...event, sequence: 1, previousDigest: null };
  const nonce = crypto.randomUUID();
  const guard =
    "EXISTS (SELECT 1 FROM research_experiments WHERE id=? AND revision=? AND last_run_id=?)";
  const guarded = (sql, args) =>
    research.db
      .prepare(`${sql} WHERE ${guard}`)
      .bind(...args, experimentId, experiment.revision + 1, nonce);
  const results = await research.db.batch([
    research.db
      .prepare(
        "UPDATE research_experiments SET stage='SCHEDULED', revision=revision+1, last_run_id=? WHERE id=? AND stage='AWAITING_SHADOW' AND revision=? AND EXISTS(SELECT 1 FROM research_window_owners WHERE namespace=? AND owner_type='EXPERIMENT' AND owner_id=?)",
      )
      .bind(
        nonce,
        experimentId,
        experiment.revision,
        experiment.namespace,
        experimentId,
      ),
    guarded(
      "INSERT INTO strategy_cohorts(id,namespace,parent_version,policy_id,policy_digest,research_policy_id,research_policy_digest,mode,stage,max_candidates,forward_days,reservation_manifest,proposal_manifest,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'SINGLE','SCHEDULED',1,?,?,?,?,?",
      [
        cohortId,
        experiment.namespace,
        experiment.parentVersion,
        experiment.policyId,
        protocol.policyDigest,
        experiment.policyId,
        protocol.policyDigest,
        protocol.forwardDays,
        JSON.stringify({ ...reservation, reservationDigest }),
        JSON.stringify(proposal),
        now,
        now,
      ],
    ),
    guarded(
      "INSERT INTO strategy_cohort_members(cohort_id,member_id,slot_index,experiment_id,strategy_version,k,params,params_digest,params_distance,stage,created_at,updated_at) SELECT ?,'m1',1,?,?,?,?,?,?,'SCHEDULED',?,?",
      [
        cohortId,
        experimentId,
        experiment.candidateVersion,
        experiment.reservationPayload.attemptSequence,
        JSON.stringify(manifest.candidateParams),
        await digestOf(manifest.candidateParams),
        frozenParamDistance(
          manifest.candidateParams,
          protocol.executionStress.parentParams,
        ),
        now,
        now,
      ],
    ),
    research.db
      .prepare(
        `UPDATE research_window_owners SET owner_type='COHORT',owner_id=?,last_run_id=? WHERE namespace=? AND owner_type='EXPERIMENT' AND owner_id=? AND ${guard}`,
      )
      .bind(
        cohortId,
        nonce,
        experiment.namespace,
        experimentId,
        experimentId,
        experiment.revision + 1,
        nonce,
      ),
    research.db
      .prepare(
        `UPDATE research_test_claims SET owner_type='COHORT',owner_id=? WHERE namespace=? AND experiment_id=? AND owner_type='EXPERIMENT' AND ${guard}`,
      )
      .bind(
        cohortId,
        experiment.namespace,
        experimentId,
        experimentId,
        experiment.revision + 1,
        nonce,
      ),
    guarded(
      "INSERT INTO research_events(experiment_id,sequence,event_type,created_at,payload,previous_digest,digest) SELECT ?,?,?,?,?,?,?",
      [
        experimentId,
        event.sequence,
        event.eventType,
        now,
        JSON.stringify(event.payload),
        event.previousDigest,
        await eventDigest(event),
      ],
    ),
    guarded(
      "INSERT INTO cohort_events(cohort_id,sequence,event_type,created_at,payload,previous_digest,digest) SELECT ?,1,?,?,?,NULL,?",
      [
        cohortId,
        cohortEvent.eventType,
        now,
        JSON.stringify(cohortEvent.payload),
        await eventDigest(cohortEvent),
      ],
    ),
  ]);
  if (results[0].meta.changes !== 1) {
    const concurrent = await cohorts.memberByExperiment(experimentId);
    if (concurrent) return { cohortId: concurrent.cohortId, duplicate: true };
    throw new Error("单候选开户状态或窗口占用已变化，请重试");
  }
  return { cohortId, adopted: true };
}

export async function adoptPendingSingle(env) {
  const active = await new ResearchRepository(env).activeExperiment();
  if (
    active?.ownerType !== "EXPERIMENT" ||
    active.experiment?.stage !== "AWAITING_SHADOW"
  )
    return null;
  return adoptSingleExperiment(env, active.experimentId);
}
