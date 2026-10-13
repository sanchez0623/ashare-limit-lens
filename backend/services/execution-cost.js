// 执行成本设置、生效计划、诊断与校准编排（§5.3）。
// 写操作沿用校验与跨站保护；GET 不执行校准或完整回测。
import {
  EXECUTION_COST_MODEL,
  DEFAULT_EXECUTION_COST_PAYLOAD,
  EXECUTION_COST_FIELDS,
  defaultExecutionCostPolicy,
  normalizeExecutionCostPayload,
} from "../../shared/execution-cost.js";
import {
  ExecutionCostRepository,
  latestPolicyBundle,
  policyDigest,
} from "../storage/execution-cost.js";
import { CohortRepository } from "../storage/cohorts.js";
import {
  exportExecutionCalibration,
  calibrationForPolicy,
} from "./execution-calibration.js";
import { PaperRepository } from "../storage/paper.js";

export async function effectiveExecutionCostPolicy(env) {
  return latestPolicyBundle(env.DB);
}

export async function getExecutionCostConfig(env) {
  const repository = new ExecutionCostRepository(env);
  const policy = await repository.latest();
  return {
    policy,
    default: defaultExecutionCostPolicy(),
    defaultPayload: DEFAULT_EXECUTION_COST_PAYLOAD,
    fields: EXECUTION_COST_FIELDS,
    calibration:
      policy.calibrationStatus === "PRIOR_UNCALIBRATED"
        ? null
        : (await calibrationForPolicy(env, policy.id))?.report,
    modelVersion: EXECUTION_COST_MODEL,
    note:
      policy.calibrationStatus === "PRIOR_UNCALIBRATED"
        ? "当前参数是工程先验与压力假设；修改产生新版本并从下一个尚未冻结的计划生效，活动研究窗口内不允许更换政策。"
        : "校准范围与保留先验的分层以校准报告为准；修改产生新版本并从下一个尚未冻结的计划生效，活动研究窗口内不允许更换政策。",
  };
}

export async function saveExecutionCostPolicy(env, input) {
  const cohorts = new CohortRepository(env);
  const owner = await cohorts.windowOwner();
  if (owner)
    throw new Error(
      "存在活动研究窗口，冻结政策继续服务已有批次，不能混用成本政策",
    );
  const repository = new ExecutionCostRepository(env);
  const current = await repository.latest();
  const calibration = input?.calibrationId
    ? await exportExecutionCalibration(env, input.calibrationId)
    : null;
  if (
    input?.calibrationStatus &&
    input.calibrationStatus !== "PRIOR_UNCALIBRATED" &&
    !calibration
  )
    throw new Error("不能手工声明成本已校准，请先导入真实数据并通过校准验证");
  if (calibration && input?.payload)
    throw new Error("采用校准政策时不能另传参数，须使用校准报告冻结的参数");
  const payload = calibration
    ? calibration.report.payload
    : normalizeExecutionCostPayload({
        ...DEFAULT_EXECUTION_COST_PAYLOAD,
        ...input?.payload,
        periodBaseBps: {
          ...DEFAULT_EXECUTION_COST_PAYLOAD.periodBaseBps,
          ...input?.payload?.periodBaseBps,
        },
      });
  const next = await repository.save({
    payload,
    calibrationStatus:
      calibration?.report.calibrationStatus ?? "PRIOR_UNCALIBRATED",
    calibrationCutoff: calibration?.report.cutoff ?? null,
    calibrationId: calibration?.id ?? null,
    effectiveFrom: calibration
      ? (input?.effectiveFrom ??
        new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10))
      : input?.effectiveFrom,
  });
  return {
    saved: true,
    previous: {
      id: current.id,
      version: current.version,
      payloadDigest: current.payloadDigest,
    },
    policy: next,
  };
}

export async function executionCostDiagnostics(env) {
  const repository = new ExecutionCostRepository(env);
  const policy = await repository.latest();
  const paper = new PaperRepository(env);
  const planRows = (await paper.history("paper_plans", 40))
    .map((row) => {
      const payload = JSON.parse(row.payload);
      const bundle = payload.executionCostPolicy;
      return {
        signalDate: payload.signalDate,
        createdAt: payload.createdAt,
        modelVersion: bundle?.modelVersion ?? "LEGACY_FIXED_10BPS_V1",
        policyVersion: bundle?.version ?? null,
        payloadDigest: bundle?.payloadDigest ?? null,
        policyPayload: bundle?.payload ?? null,
      };
    })
    .filter((plan) => plan.modelVersion !== "LEGACY_FIXED_10BPS_V1")
    .slice(0, 12);
  const plans = await Promise.all(
    planRows.map(async (plan) => {
      const digestVerified = plan.policyPayload
        ? (await policyDigest(plan.policyPayload)) === plan.payloadDigest
        : null;
      const { policyPayload: _payload, ...rest } = plan;
      return { ...rest, digestVerified };
    }),
  );
  const ledger = (await paper.history("paper_ledger", 60))
    .map((row) => JSON.parse(row.payload))
    .filter((fill) => fill.executionCost)
    .slice(0, 12)
    .map((fill) => ({
      date: fill.date,
      code: fill.code,
      side: fill.side,
      quantity: fill.quantity,
      priceCents: fill.priceCents,
      sourcePriceCents: fill.sourcePriceCents,
      totalBps: fill.executionCost.totalBps,
      residualBps: fill.executionCost.residualBps,
      spreadSource: fill.executionCost.spreadSource,
      period: fill.executionCost.period,
      quality: fill.executionCost.quality,
    }));
  const runs = await repository.listSensitivityRuns(5);
  return {
    policy,
    modelVersion: EXECUTION_COST_MODEL,
    plansUsingPolicy: plans,
    recentCostFills: ledger,
    sensitivityRuns: runs,
    note: "诊断只展示后端已落库结果；纸面成交由本模型生成，不能反过来证明模型参数正确。",
  };
}
