import { STEP_LIMITS, DEFAULT_RESEARCH_POLICY } from "./research-policy.js";
import {
  STRATEGY_SPACE_VERSION,
  programIdentity,
} from "../../shared/strategy-program.js";

// 赛马政策（§3）：数量、预算、窗口与排序规则全部事前冻结；
// AI 不能修改候选数量、比较方式、统计预算、费用、初始资金或风控。
export const TOURNAMENT_MODE = "TOURNAMENT";
export const DEFAULT_COHORT_POLICY = Object.freeze({
  version: 1,
  mode: TOURNAMENT_MODE,
  maxCandidates: 4,
  maxCandidatesMin: 2,
  maxCandidatesMax: 4,
  monthlyGenerationLimit: 1,
  maxActiveCohorts: 1,
  trainingDays: 60,
  historicalTestDays: 20,
  forwardDays: 60,
  forwardDaysAllowed: [30, 60, 90],
  minimumCompletedRounds: 10,
  pollIntervalSeconds: 10,
  pollIntervalMinSeconds: 3,
  pollIntervalMaxSeconds: 60,
  rankingRule: "NET_RETURN_THEN_DRAWDOWN",
  promotionLimitPerCohort: 1,
  statistical: {
    familyAlpha: 0.05,
    blockLength: 5,
    resampleFloor: 10000,
    resampleCap: 1000000,
  },
  methodNote:
    "同一冻结批次内固定候选并行前瞻；全部候选共享测试日期与统计预算；批次结束从合格集合按冻结排序启用至多一个候选",
});

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function validateCohortPolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("赛马政策结构无效");
  for (const key of Object.keys(input))
    if (FORBIDDEN_KEYS.has(key)) throw new Error("赛马政策包含未授权字段");
  const policy = { ...DEFAULT_COHORT_POLICY, ...input };
  if (![1, 2].includes(policy.version)) throw new Error("赛马政策版本不支持");
  if (policy.version === 2) {
    if (
      policy.strategySpaceVersion !== STRATEGY_SPACE_VERSION ||
      !["AI", "FAMILIES", "SELECTORS", "ALLOCATIONS"].includes(
        policy.generationMode,
      )
    )
      throw new Error("新版赛马策略空间或生成方式无效");
  } else if (
    policy.strategySpaceVersion !== undefined ||
    (policy.generationMode !== undefined && policy.generationMode !== "AI")
  )
    throw new Error("离散策略需要新版策略空间政策");
  if (
    !Number.isInteger(policy.maxCandidates) ||
    policy.maxCandidates < policy.maxCandidatesMin ||
    policy.maxCandidates > policy.maxCandidatesMax
  )
    throw new Error(
      `赛马候选数量无效：应在 ${policy.maxCandidatesMin}-${policy.maxCandidatesMax} 之间`,
    );
  if (
    !Number.isInteger(policy.monthlyGenerationLimit) ||
    policy.monthlyGenerationLimit < 1 ||
    policy.monthlyGenerationLimit > 12
  )
    throw new Error("赛马月度生成批次上限无效");
  if (policy.maxActiveCohorts !== 1)
    throw new Error("首期只允许一个活动赛马批次");
  if (
    !Number.isInteger(policy.trainingDays) ||
    policy.trainingDays < DEFAULT_RESEARCH_POLICY.trainMinDays ||
    policy.trainingDays > DEFAULT_RESEARCH_POLICY.trainMaxDays
  )
    throw new Error("赛马训练窗口无效");
  if (
    !Number.isInteger(policy.historicalTestDays) ||
    policy.historicalTestDays < DEFAULT_RESEARCH_POLICY.histTestMinDays ||
    policy.historicalTestDays > DEFAULT_RESEARCH_POLICY.histTestMaxDays
  )
    throw new Error("赛马历史测试窗口无效");
  if (!policy.forwardDaysAllowed.includes(policy.forwardDays))
    throw new Error(
      `赛马前瞻窗口只能事前设为 ${policy.forwardDaysAllowed.join("/")} 日，不能中途延长`,
    );
  if (
    !Number.isInteger(policy.minimumCompletedRounds) ||
    policy.minimumCompletedRounds < 1
  )
    throw new Error("赛马完整轮次门槛无效");
  if (
    !Number.isInteger(policy.pollIntervalSeconds) ||
    policy.pollIntervalSeconds < policy.pollIntervalMinSeconds ||
    policy.pollIntervalSeconds > policy.pollIntervalMaxSeconds
  )
    throw new Error("赛马轮询间隔无效");
  if (policy.rankingRule !== "NET_RETURN_THEN_DRAWDOWN")
    throw new Error("赛马排序规则无效");
  if (policy.promotionLimitPerCohort !== 1)
    throw new Error("一个批次最多启用一个候选");
  const stats = policy.statistical ?? {};
  if (
    typeof stats.familyAlpha !== "number" ||
    stats.familyAlpha <= 0 ||
    stats.familyAlpha >= 1
  )
    throw new Error("赛马族错误率无效");
  if (
    !Number.isInteger(stats.blockLength) ||
    stats.blockLength < 2 ||
    stats.blockLength > 20
  )
    throw new Error("赛马统计区块长度无效");
  if (
    !Number.isInteger(stats.resampleFloor) ||
    !Number.isInteger(stats.resampleCap) ||
    stats.resampleFloor > stats.resampleCap
  )
    throw new Error("赛马统计重采样预算无效");
  return policy;
}

// §5.3：alpha_k = 0.05 / [k × (k + 1)]；每个对照的单侧 alpha = alpha_k / 2。
export function alphaPerComparisonForK(k, familyAlpha = 0.05) {
  const integer = Number(k);
  if (!Number.isInteger(integer) || integer < 1)
    throw new Error("统计比较序号 k 必须为正整数");
  return familyAlpha / (integer * (integer + 1)) / 2;
}

// 统计计算预算预检：不足时返回 sufficient:false，保持当前策略，不调用模型。
export function computeStatisticsBudget({ ks, statistical }) {
  const stats = { ...DEFAULT_COHORT_POLICY.statistical, ...statistical };
  const ksSorted = [...ks].sort((a, b) => a - b);
  if (!ksSorted.length) throw new Error("统计预算预检缺少比较序号");
  const tightest = Math.min(
    ...ksSorted.map((k) => alphaPerComparisonForK(k, stats.familyAlpha)),
  );
  const required = Math.max(stats.resampleFloor, Math.ceil(50 / tightest));
  return {
    alphaPerComparison: tightest,
    resamples: Math.min(required, stats.resampleCap),
    requiredResamples: required,
    sufficient: required <= stats.resampleCap,
    resampleCap: stats.resampleCap,
    blockLength: stats.blockLength,
    note:
      required > stats.resampleCap
        ? `本批按全历史序号需要的重采样次数 ${required} 超过计算额度 ${stats.resampleCap}，返回 COMPUTE_BUDGET_INSUFFICIENT 并保持当前策略`
        : null,
  };
}

// 参数距离在提案冻结时保存（§8.2）：按每个数值分量的 |候选-父| / 冻结单次步长 求和。
export function frozenParamDistance(candidateParams, parentParams) {
  const steps = STEP_LIMITS;
  let distance = 0;
  if (programIdentity(candidateParams) !== programIdentity(parentParams))
    distance++;
  for (const [key, value] of Object.entries(candidateParams)) {
    if (key === "weights") continue;
    const parent = parentParams[key];
    if (parent === undefined) continue;
    const step = steps[key];
    if (step === undefined) continue;
    distance += Math.abs(value - parent) / step;
  }
  const weights = candidateParams.weights;
  if (Array.isArray(weights) && Array.isArray(parentParams.weights)) {
    const weightStep = DEFAULT_RESEARCH_POLICY.weightsMaxStep;
    for (let index = 0; index < weights.length; index++)
      distance +=
        Math.abs(weights[index] - parentParams.weights[index]) / weightStep;
  }
  return distance;
}
