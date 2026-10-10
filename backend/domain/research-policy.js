import { RANGES } from "./validation.js";

export const STEP_LIMITS = Object.freeze({
  minScore: 2,
  minSectorScore: 2,
  maxPositions: 1,
  maxHoldDays: 1,
  stopLoss: 0.005,
  takeProfit: 0.01,
  maxBuyGap: 0.005,
  tBuyDip: 0.005,
  tSellRise: 0.005,
  tFraction: 0.02,
});
export const DEFAULT_RESEARCH_POLICY = Object.freeze({
  version: 1,
  trainDays: 60,
  trainMinDays: 60,
  trainMaxDays: 120,
  histTestDays: 20,
  histTestMinDays: 20,
  histTestMaxDays: 60,
  forwardDays: 30,
  forwardMinDays: 20,
  forwardMaxDays: 90,
  monthlyProposalLimit: 1,
  maxParamGroups: 2,
  weightsMaxComponents: 2,
  weightsMaxStep: 2,
  stepLimits: STEP_LIMITS,
  ranges: RANGES,
  statistical: { familyAlpha: 0.05, blockLength: 5 },
  methodNote:
    "训练与历史测试窗口按冻结政策划分；测试日期全历史一次性占用；历史通过只获得影子阶段资格，不构成启用权",
});
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function checkPolicyRanges(ranges) {
  for (const [key, value] of Object.entries(ranges)) {
    if (!Array.isArray(value) || value.length !== 2 || value[0] > value[1])
      throw new Error(`政策参数范围无效：${key}`);
  }
}
function checkPolicySteps(steps) {
  for (const [key, value] of Object.entries(steps)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw new Error(`政策步长无效：${key}`);
  }
}
export function validateResearchPolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("研究政策结构无效");
  const policy = { ...DEFAULT_RESEARCH_POLICY, ...input };
  const integerChecks = [
    ["trainDays", policy.trainMinDays, policy.trainMaxDays],
    ["histTestDays", policy.histTestMinDays, policy.histTestMaxDays],
    ["forwardDays", policy.forwardMinDays, policy.forwardMaxDays],
  ];
  for (const [key, min, max] of integerChecks) {
    const value = policy[key];
    if (
      !Number.isInteger(value) ||
      value < min ||
      value > max ||
      !Number.isInteger(min) ||
      !Number.isInteger(max)
    )
      throw new Error(`研究政策窗口无效：${key}`);
  }
  if (
    !Number.isInteger(policy.monthlyProposalLimit) ||
    policy.monthlyProposalLimit < 1 ||
    policy.monthlyProposalLimit > 12
  )
    throw new Error("研究政策月度提案次数无效");
  if (
    !Number.isInteger(policy.maxParamGroups) ||
    policy.maxParamGroups < 1 ||
    policy.maxParamGroups > 4
  )
    throw new Error("研究政策参数组上限无效");
  checkPolicySteps(policy.stepLimits);
  checkPolicyRanges(policy.ranges);
  if (
    !Number.isInteger(policy.weightsMaxComponents) ||
    policy.weightsMaxComponents < 1 ||
    policy.weightsMaxComponents > 6 ||
    !Number.isInteger(policy.weightsMaxStep) ||
    policy.weightsMaxStep < 1 ||
    policy.weightsMaxStep > 10
  )
    throw new Error("研究政策权重步长无效");
  return policy;
}
export function changedGroups(patch) {
  return Object.keys(patch).length;
}
export function validateCandidatePatch({
  proposal,
  parentParams,
  frozenPolicy,
}) {
  const policy = validateResearchPolicy(frozenPolicy);
  const patch = proposal?.patch;
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    !Object.keys(patch).length
  )
    throw new Error("候选缺少有效参数变化");
  for (const key of Object.keys(patch))
    if (FORBIDDEN_KEYS.has(key)) throw new Error("候选包含未授权字段");
  const effective = {};
  for (const [key, value] of Object.entries(patch)) {
    const parent = parentParams[key];
    if (parent === undefined) throw new Error("候选包含父策略不存在的参数");
    if (key === "weights") {
      if (
        !Array.isArray(value) ||
        value.length !== 6 ||
        value.some((v) => !Number.isInteger(v) || v < 0 || v > 50) ||
        !value.some((v) => v > 0)
      )
        throw new Error("权重数组不符合约束");
      const changed = value
        .map((v, index) => ({ index, delta: v - parent[index] }))
        .filter((row) => row.delta !== 0);
      if (!changed.length) continue;
      if (changed.length > policy.weightsMaxComponents)
        throw new Error(
          `权重一次最多调整 ${policy.weightsMaxComponents} 个分量`,
        );
      if (changed.some((row) => Math.abs(row.delta) > policy.weightsMaxStep))
        throw new Error(`权重单分量变化不能超过 ${policy.weightsMaxStep}`);
      if (
        value.reduce((a, b) => a + b, 0) !== parent.reduce((a, b) => a + b, 0)
      )
        throw new Error("权重总和必须与父策略一致");
      effective.weights = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("候选参数必须是有限数值");
    if (value === parent) continue;
    const range = policy.ranges[key];
    if (
      !range ||
      value < range[0] ||
      value > range[1] ||
      parent < range[0] ||
      parent > range[1]
    )
      throw new Error("候选提出了未授权或越界的参数");
    if (
      ["minScore", "minSectorScore", "maxPositions", "maxHoldDays"].includes(
        key,
      ) &&
      !Number.isInteger(value)
    )
      throw new Error("整数参数无效");
    const step = policy.stepLimits[key];
    if (step === undefined || Math.abs(value - parent) > step + 1e-9)
      throw new Error(`参数 ${key} 单次变化超过政策步长 ${step ?? "未授权"}`);
    effective[key] = value;
  }
  if (!Object.keys(effective).length)
    throw new Error("候选与父策略无实际差异，拒绝占用提案次数");
  if (changedGroups(effective) > policy.maxParamGroups)
    throw new Error(`一次最多修改 ${policy.maxParamGroups} 个逻辑参数组`);
  return {
    params: { ...structuredClone(parentParams), ...effective },
    patch: effective,
    rationale: proposal.rationale,
    changedGroups: changedGroups(effective),
  };
}
