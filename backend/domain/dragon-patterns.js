import {
  normalizeDragonConfig,
  defaultDragonConfig,
} from "../../shared/dragon-risk-config.js";
import { canonicalJson } from "./research-lineage.js";
import { completedPracticeCycles } from "./practice-review.js";
import {
  computeStatisticsBudget,
  DEFAULT_COHORT_POLICY,
  alphaPerComparisonForK,
} from "./cohort-policy.js";
import {
  pairedLowerBoundTest,
  resampleIndexMatrix,
} from "./research-statistics.js";

export const PATTERN_POLICY = Object.freeze({
  version: "dragon-pattern-research-v1",
  trainDays: 60,
  testDays: 20,
  forwardDays: 30,
  maxCandidates: 4,
  monthlyLimit: 1,
  maxChanges: 2,
  minimumCompletedRounds: 10,
  minExcess: 0.001,
  drawdownTolerance: 0.005,
  multipliers: [1, 1.5, 2],
  statistical: DEFAULT_COHORT_POLICY.statistical,
  ranking: "NET_RETURN_DRAWDOWN_DISTANCE_ID",
});
export const PATTERN_PATHS = Object.freeze([
  ...Object.keys(defaultDragonConfig().advanced).map((k) => `advanced.${k}`),
  ...Object.keys(defaultDragonConfig().operations).map(
    (k) => `operations.${k}`,
  ),
  ...Object.keys(defaultDragonConfig().buyPoints).map((k) => `buyPoints.${k}`),
]);
export function patternPatch(base, proposal) {
  if (
    !proposal ||
    typeof proposal.rationale !== "string" ||
    !proposal.rationale.trim() ||
    proposal.rationale.length > 2000 ||
    !proposal.patch ||
    typeof proposal.patch !== "object" ||
    Array.isArray(proposal.patch)
  )
    throw new Error("研究候选结构无效");
  const entries = Object.entries(proposal.patch);
  if (!entries.length || entries.length > PATTERN_POLICY.maxChanges)
    throw new Error("每个候选最多改变两项");
  if (
    new Set(entries.map(([p]) => (p.includes(".") ? p : `advanced.${p}`)))
      .size !== entries.length
  )
    throw new Error("候选参数路径重复");
  const config = structuredClone(base),
    steps = { stopLoss: 0.005, tFraction: 0.02, tSpread: 0.005 };
  let distance = 0;
  for (const [raw, value] of entries) {
    const path = raw.includes(".") ? raw : `advanced.${raw}`;
    if (!PATTERN_PATHS.includes(path))
      throw new Error("研究候选包含账户风险或未授权字段");
    const [group, key] = path.split(".");
    const previous = config[group][key];
    if (value === previous) throw new Error("候选字段没有实际变化");
    if (group === "advanced") {
      if (
        !Number.isFinite(value) ||
        typeof value !== "number" ||
        Math.abs(value - previous) > steps[key] + 1e-9
      )
        throw new Error("高级参数超过冻结步长");
      distance += Math.abs(value - previous) / steps[key];
    } else {
      if (typeof value !== "boolean")
        throw new Error("买点和操作开关必须为布尔值");
      distance++;
    }
    config[group][key] = value;
  }
  if (!Object.values(config.buyPoints).some(Boolean))
    throw new Error("研究候选须保留至少一个买点");
  return { config: normalizeDragonConfig(config), distance };
}
export function fixedPatternConfig(parent) {
  return normalizeDragonConfig({
    ...defaultDragonConfig(),
    risk: structuredClone(parent.risk),
  });
}
export function patternMetrics(equities, fills, start) {
  let previous = start,
    peak = start,
    maxDrawdown = 0;
  const returns = equities.map((e) => {
    if (!(e.equityCents > 0) || e.complete !== true)
      throw new Error("研究净值缺失或未通过结算核对");
    peak = Math.max(peak, e.equityCents);
    maxDrawdown = Math.max(
      maxDrawdown,
      1 - e.equityCents / peak,
      e.maxObservedDrawdown ?? 0,
    );
    const value = e.equityCents / previous - 1;
    previous = e.equityCents;
    return value;
  });
  return {
    netReturn: previous / start - 1,
    maxDrawdown,
    returns,
    fills: fills.length,
    completedRounds: completedPracticeCycles(fills).length,
    feesCents: fills.reduce((n, f) => n + f.feeCents, 0),
  };
}
export function patternEconomicPass(
  candidate,
  reference,
  risk,
  policy = PATTERN_POLICY,
) {
  return (
    candidate.completedRounds >= policy.minimumCompletedRounds &&
    candidate.netReturn > 0 &&
    candidate.netReturn >= reference.netReturn + policy.minExcess &&
    candidate.maxDrawdown <= reference.maxDrawdown + policy.drawdownTolerance &&
    candidate.maxDrawdown <= risk.drawdown
  );
}
export async function comparePatternWindow({
  dates,
  candidate,
  parent,
  baseline,
  risk,
  k,
  seed,
  policy = PATTERN_POLICY,
}) {
  const budget = computeStatisticsBudget({
    ks: [k],
    statistical: policy.statistical,
  });
  if (!budget.sufficient)
    return { passed: false, status: "COMPUTE_BUDGET_INSUFFICIENT", budget };
  if (
    ![candidate, parent, baseline].every(
      (m) => m.returns.length === dates.length,
    )
  )
    throw new Error("候选与对照日期不一致");
  const economic =
    patternEconomicPass(candidate, parent, risk, policy) &&
    patternEconomicPass(candidate, baseline, risk, policy);
  if (!economic)
    return {
      passed: false,
      status:
        candidate.completedRounds < policy.minimumCompletedRounds
          ? "INSUFFICIENT_ROUNDS"
          : "ECONOMIC_GATE_FAILED",
      candidate,
      parent,
      baseline,
    };
  const matrix = await resampleIndexMatrix({
    dates,
    blockLength: budget.blockLength,
    resamples: budget.resamples,
    seedInput: seed,
  });
  const alphaPerComparison = alphaPerComparisonForK(
    k,
    policy.statistical.familyAlpha,
  );
  const test = (reference) =>
    pairedLowerBoundTest({
      memberReturns: candidate.returns,
      comparisonReturns: reference.returns,
      matrix,
      alphaPerComparison,
    });
  const againstParent = test(parent),
    againstBaseline = test(baseline);
  return {
    passed: againstParent.passed && againstBaseline.passed,
    status:
      againstParent.passed && againstBaseline.passed
        ? "PASSED"
        : "INCONCLUSIVE",
    candidate,
    parent,
    baseline,
    againstParent,
    againstBaseline,
    matrixDigest: matrix.digest,
    budget,
  };
}
export function rankPatterns(candidates) {
  return [...candidates].sort(
    (a, b) =>
      b.metrics.netReturn - a.metrics.netReturn ||
      a.metrics.maxDrawdown - b.metrics.maxDrawdown ||
      a.distance - b.distance ||
      a.id.localeCompare(b.id),
  );
}
export function samePatternRisk(a, b) {
  return canonicalJson(a.risk) === canonicalJson(b.risk);
}
