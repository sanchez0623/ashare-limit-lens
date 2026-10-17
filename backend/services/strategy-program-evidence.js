import { assertProgramSnapshot } from "../domain/trading.js";
import { digestOf, canonicalJson } from "../domain/research-lineage.js";
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
import {
  downgradeEnabledForPlan,
  downgradeEnabledForSnapshot,
} from "../../shared/downgrade.js";
import {
  tQualityEnabledForPlan,
  buildTQualityEvidence,
  extractTTrades,
} from "../domain/t-quality.js";
import {
  assertFrozenTQuality,
  frozenQualityRow,
  freezeQualityStatement,
  qualityPayload,
} from "../storage/t-quality.js";
import { tradingCalendar } from "./market.js";

export { assertFrozenTQuality } from "../storage/t-quality.js";

// 方案 7 第三轮：做T质量摘要的执行前独立锚点。计划冻结时把摘要与证据
// 固化到账户作用域副本表（frozen_t_quality，首写固化，同日重冻不覆盖）；
// 执行前核验回读副本与计划比对。只改计划（保留规则标记、把记录与证据
// 一起改成空历史并重算订单）无法通过——副本里保存的是冻结时的真实
// 输入，且不在计划 JSON 内，无法随计划一起改写。
export async function ensureFrozenTQuality(env, plan, scope) {
  if (!tQualityEnabledForPlan(plan)) return;
  const db = env.DB;
  if (await frozenQualityRow(db, plan, scope)) {
    await assertFrozenTQuality(db, plan, scope);
    return;
  }
  const shadow = scope.startsWith("shadow:");
  if (scope !== "main" && (!shadow || !scope.slice(7)))
    throw new Error("无效做T质量账户作用域");
  const accountId = shadow ? scope.slice(7) : null;
  // 只修复确实已冻结的计划。会话中的计划也必须关联同一已存输入，
  // 不能把调用方送入的任意 JSON 直接升级成可信副本。
  const stored = await db
    .prepare(
      `SELECT payload,digest FROM ${shadow ? "shadow_plans" : "paper_plans"}
       WHERE signal_date=? ${shadow ? "AND account_id=?" : ""}`,
    )
    .bind(plan.signalDate, ...(shadow ? [accountId] : []))
    .first();
  const payload = qualityPayload(plan);
  if (
    !stored ||
    (await digestOf(JSON.parse(stored.payload))) !== stored.digest ||
    canonicalJson(qualityPayload(JSON.parse(stored.payload))) !==
      canonicalJson(payload)
  )
    throw new Error("做T质量摘要冻结副本缺失，原计划关联不一致");
  const ledger = await db
    .prepare(
      `SELECT payload FROM ${shadow ? "shadow_ledger" : "paper_ledger"}
       WHERE trade_date<=? ${shadow ? "AND account_id=?" : ""} ORDER BY trade_date,id`,
    )
    .bind(plan.signalDate, ...(shadow ? [accountId] : []))
    .all();
  const records = extractTTrades(
    (ledger.results ?? []).map((row) => JSON.parse(row.payload)),
  ).records;
  const evidence = plan.tQualityEvidence;
  if (
    canonicalJson(buildTQualityEvidence(records, []).records) !==
    canonicalJson(evidence.records)
  )
    throw new Error("做T质量证据与原始账本不一致，拒绝恢复冻结副本");
  const dates = evidence.tradingDates;
  if (
    !Array.isArray(dates) ||
    canonicalJson([...new Set(dates)].sort()) !== canonicalJson(dates) ||
    dates.some((date) => typeof date !== "string" || date > plan.signalDate)
  )
    throw new Error("做T质量证据交易日无效，拒绝恢复冻结副本");
  // 空日历保留当时的保守停手语义；非空日期需用独立日历核对，
  // 不能靠在计划中编造交易日提前解除停手。只在升级恢复时查询。
  if (dates.length) {
    const calendar = await tradingCalendar(
      dates[0],
      plan.signalDate,
      null,
      500,
    );
    if (dates.some((date) => !calendar.dates.includes(date)))
      throw new Error("做T质量证据与真实交易日历不一致，拒绝恢复冻结副本");
  }
  const storedPlan = JSON.parse(stored.payload);
  const statement = await freezeQualityStatement(
    db,
    storedPlan,
    scope,
    stored.digest,
  );
  await statement.run();
  await assertFrozenTQuality(db, plan, scope);
}

export async function assertStoredProgramPlan(
  env,
  plan,
  book,
  { tQualityScope = "main" } = {},
) {
  if (!plan) return;
  const version = plan.strategyVersion
    ? await env.DB.prepare("SELECT params FROM strategy_versions WHERE id=?")
        .bind(plan.strategyVersion)
        .first()
    : null;
  const params = version && JSON.parse(version.params);
  const program = Boolean(plan.strategy?.program || params?.program);
  const downgradeEnabled = downgradeEnabledForPlan(plan);
  // 摘要比较不得对 pyramidReduce 补齐默认值：字段缺席 = 旧减半规则，
  // 显式向量 = 金字塔阶梯，两者执行语义不同——计划删除该字段属于规则
  // 漂移，必须在此拦截（与 exposureTiers 的默认档位语义不同）。
  if (
    program &&
    (!params ||
      !plan.strategy?.program ||
      (await digestOf(withExposureTiers(params))) !==
        (await digestOf(withExposureTiers(plan.strategy))))
  )
    throw new Error("冻结计划程序与登记策略版本不一致");
  let snapshot = await frozenProgramSignal(env.DB, plan);
  // 普通策略也必须绑定降级声明的原始输入。未标记计划回查信号日归档，
  // 防止删掉版本和全部声明后伪装成历史计划绕过重算。
  if (!snapshot && !program) {
    const frozen = await env.DB.prepare(
      "SELECT payload FROM strategy_signal_snapshots WHERE signal_date=?",
    )
      .bind(plan.signalDate)
      .all();
    snapshot = (frozen.results ?? [])
      .map((row) => JSON.parse(row.payload))
      .find(
        (source) =>
          downgradeEnabledForSnapshot(source) &&
          source.createdAt <= plan.createdAt,
      );
  }
  if (!snapshot && !program) {
    const row = await env.DB.prepare(
      "SELECT payload FROM snapshots WHERE trade_date=?",
    )
      .bind(plan.signalDate)
      .first();
    snapshot = row && JSON.parse(row.payload);
  }
  const sourceDowngradeEnabled = downgradeEnabledForSnapshot(snapshot);
  const planTQualityEnabled = tQualityEnabledForPlan(plan);
  if (
    !program &&
    !downgradeEnabled &&
    !sourceDowngradeEnabled &&
    !planTQualityEnabled
  )
    return;
  if (sourceDowngradeEnabled && !plan.selectionAudit?.snapshotDigest)
    throw new Error("降级计划缺少原始信号快照引用");
  if (
    snapshot &&
    plan.selectionAudit?.snapshotDigest &&
    (await selectionSnapshotDigest(snapshot)) !==
      plan.selectionAudit.snapshotDigest
  )
    throw new Error("策略程序原始快照与冻结摘要不一致");
  // 方案 7 第三轮：执行前用账户冻结副本独立核对做T质量摘要——伪造
  // 的"空历史"计划（保留规则标记）在此处即被拦截，不必等导出核验。
  await ensureFrozenTQuality(env, plan, tQualityScope);
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
