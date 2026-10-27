import * as v2 from "./adaptive-risk-v2.js";
import * as v1 from "./adaptive-risk-v1.js";
import {
  advanceEnvironment,
  MARKET_ENVIRONMENT_POLICY,
} from "./market-environment.js";
export const ADAPTIVE_RISK_POLICY_V1 = v1.ADAPTIVE_RISK_POLICY;
export const ADAPTIVE_RISK_POLICY_V2 = v2.ADAPTIVE_RISK_POLICY;
export const ADAPTIVE_RISK_POLICY = Object.freeze({
  ...ADAPTIVE_RISK_POLICY_V2,
  version: "dragon-adaptive-risk-v3",
  environmentVersion: MARKET_ENVIRONMENT_POLICY.version,
});
export const NEUTRAL_ADAPTIVE_RISK_POLICY = Object.freeze({
  ...ADAPTIVE_RISK_POLICY,
  version: "dragon-adaptive-risk-neutral-v1",
});
export function adaptiveRiskPolicyForVersion(version) {
  const p = [
    ADAPTIVE_RISK_POLICY_V1,
    ADAPTIVE_RISK_POLICY_V2,
    ADAPTIVE_RISK_POLICY,
    NEUTRAL_ADAPTIVE_RISK_POLICY,
  ].find((x) => x.version === version);
  if (!p) throw new Error("不支持的动态风控政策版本");
  return p;
}
export function validAdaptiveRiskPolicy(input) {
  try {
    const p = adaptiveRiskPolicyForVersion(input?.version);
    return (
      Object.keys(input).length === Object.keys(p).length &&
      Object.keys(p).every((k) => p[k] === input[k])
    );
  } catch {
    return false;
  }
}
const old = (state) =>
  state?.version === ADAPTIVE_RISK_POLICY_V1.version ? v1 : v2;
const modern = (state) =>
  [ADAPTIVE_RISK_POLICY.version, NEUTRAL_ADAPTIVE_RISK_POLICY.version].includes(
    state?.version,
  );
const legacyState = (state) => ({
  ...state,
  version: ADAPTIVE_RISK_POLICY_V2.version,
});
function effectiveState(state, options = {}) {
  const result = legacyState(state),
    market = { ...state.market };
  if (state.version === NEUTRAL_ADAPTIVE_RISK_POLICY.version)
    Object.assign(market, {
      applied: 1,
      raw: 1,
      ready: true,
      protectionApplied: 1,
      protectionKnown: true,
    });
  else if (options.intent !== "T_RECOVERY")
    market.applied = Math.min(market.applied, state.environment?.cap ?? 1);
  result.market = market;
  return result;
}
export function initialAdaptiveRisk(date, policy = ADAPTIVE_RISK_POLICY) {
  if (!validAdaptiveRiskPolicy(policy))
    throw new Error("动态风控政策内容与版本不一致");
  if (policy.version === ADAPTIVE_RISK_POLICY_V1.version)
    return v1.initialAdaptiveRisk(date);
  const state = v2.initialAdaptiveRisk(date);
  state.version = policy.version;
  return state;
}
export const hasAdaptiveMarketEvidence = v2.hasAdaptiveMarketEvidence;
export function advanceAdaptiveRisk(state, inputs) {
  if (!modern(state)) return old(state).advanceAdaptiveRisk(state, inputs);
  const version = state.version;
  state.version = ADAPTIVE_RISK_POLICY_V2.version;
  try {
    v2.advanceAdaptiveRisk(state, inputs);
  } finally {
    state.version = version;
  }
  if (state.observedAt === inputs.observedAt)
    state.environment = advanceEnvironment(state.environment, {
      ...inputs,
      date: state.date,
      cohort: inputs.environmentCohort,
      quotes: inputs.environmentQuotes ?? inputs.quotes,
      baseline: state.market,
    });
  return state;
}
export function adaptiveEffective(config, state, options = {}) {
  if (!modern(state))
    return old(state).adaptiveEffective(config, state, options);
  return v2.adaptiveEffective(config, effectiveState(state, options), options);
}
export function adaptiveEntryOrderDecision(config, state, options = {}) {
  if (!modern(state))
    return old(state).adaptiveEntryOrderDecision(config, state, options);
  return v2.adaptiveEntryOrderDecision(
    config,
    effectiveState(state, options),
    options,
  );
}
export function adaptiveRiskView(config, state, options = {}) {
  if (!modern(state))
    return old(state).adaptiveRiskView(config, state, options);
  const view = v2.adaptiveRiskView(
    config,
    effectiveState(state, options),
    options,
  );
  return {
    ...view,
    version: state.version,
    environment: state.environment ?? null,
  };
}
