import { assertProgramSnapshot } from "../domain/trading.js";
import { digestOf } from "../domain/research-lineage.js";
import { selectionSnapshotDigest } from "../domain/signal-selection.js";
import {
  strategySpaceManifest,
  validateStrategyCandidate,
} from "../domain/strategy-catalog.js";
import {
  programFamily,
  normalizeStrategyProgram,
} from "../../shared/strategy-program.js";
import { frozenProgramSignal } from "../storage/strategy-signals.js";
import { withExposureTiers } from "../../shared/strategy-params.js";

export async function assertStoredProgramPlan(env, plan, book) {
  if (!plan) return;
  const version = plan.strategyVersion
    ? await env.DB.prepare("SELECT params FROM strategy_versions WHERE id=?")
        .bind(plan.strategyVersion)
        .first()
    : null;
  const params = version && JSON.parse(version.params);
  if (!plan.strategy?.program && !params?.program) return;
  // 摘要比较不得对 pyramidReduce 补齐默认值：字段缺席 = 旧减半规则，
  // 显式向量 = 金字塔阶梯，两者执行语义不同——计划删除该字段属于规则
  // 漂移，必须在此拦截（与 exposureTiers 的默认档位语义不同）。
  if (
    !params ||
    !plan.strategy?.program ||
    (await digestOf(withExposureTiers(params))) !==
      (await digestOf(withExposureTiers(plan.strategy)))
  )
    throw new Error("冻结计划程序与登记策略版本不一致");
  const snapshot = await frozenProgramSignal(env.DB, plan);
  if (
    snapshot &&
    plan.selectionAudit?.snapshotDigest &&
    (await selectionSnapshotDigest(snapshot)) !==
      plan.selectionAudit.snapshotDigest
  )
    throw new Error("策略程序原始快照与冻结摘要不一致");
  assertProgramSnapshot(plan, snapshot, book);
}

export async function assertFrozenStrategyPrograms(env, cohort, members) {
  const current = await strategySpaceManifest();
  if (
    cohort.reservationManifest.strategySpace &&
    (await digestOf(cohort.reservationManifest.strategySpace)) !==
      (await digestOf(current))
  )
    throw new Error("策略空间规则与事前冻结声明不一致");
  for (const member of members.filter(
    (row) => row.strategyVersion || row.params,
  )) {
    const row = await env.DB.prepare(
      "SELECT proposal_manifest,proposal_digest FROM research_experiments WHERE id=?",
    )
      .bind(member.experimentId)
      .first();
    const proposal =
      row?.proposal_manifest && JSON.parse(row.proposal_manifest);
    if (
      !cohort.reservationManifest.strategySpace &&
      !member.params?.program &&
      !proposal?.candidateParams?.program
    )
      continue;
    if (!proposal || !member.params)
      throw new Error("策略程序冻结提案或参数缺失");
    if (member.params.program) normalizeStrategyProgram(member.params.program);
    const family = programFamily(member.params);
    const policyRow = await env.DB.prepare(
      "SELECT payload,digest FROM research_policy_versions WHERE id=?",
    )
      .bind(cohort.researchPolicyId)
      .first();
    if (
      !policyRow ||
      (await digestOf(JSON.parse(policyRow.payload))) !== policyRow.digest ||
      policyRow.digest !== cohort.researchPolicyDigest
    )
      throw new Error("冻结研究政策缺失或摘要不一致");
    const candidate = validateStrategyCandidate({
      proposal: { patch: proposal?.patch, rationale: proposal?.rationale },
      parentParams: cohort.reservationManifest.executionStress.parentParams,
      frozenPolicy: JSON.parse(policyRow.payload),
      cohortPolicy: cohort.reservationManifest.cohortPolicy,
    });
    if (
      !proposal ||
      (await digestOf(proposal)) !== row.proposal_digest ||
      (await digestOf(proposal.candidateParams)) !== member.paramsDigest ||
      (await digestOf(member.params)) !== member.paramsDigest ||
      (await digestOf(candidate.params)) !== member.paramsDigest ||
      proposal.familyId !== family.familyId ||
      proposal.familyVersion !== family.familyVersion ||
      member.familyId !== family.familyId ||
      member.familyVersion !== family.familyVersion ||
      ((member.params.program || proposal.candidateParams?.program) &&
        (await digestOf(proposal.strategySpace)) !== (await digestOf(current)))
    )
      throw new Error("策略程序参数、家族或空间与冻结提案不一致");
  }
}
