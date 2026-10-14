import { BASE_STRATEGY } from "./trading.js";
import { RANGES } from "./validation.js";
import { STEP_LIMITS } from "./research-policy.js";
import {
  FAMILY_DEFINITIONS,
  STRATEGY_SPACE_VERSION,
  normalizeStrategyProgram,
  programIdentity,
  familyProgram,
} from "../../shared/strategy-program.js";
import { validateCandidatePatch } from "./research-policy.js";
import { digestOf } from "./research-lineage.js";

// 白名单策略家族（§4.2）与 v2 声明式选择器、共享分配器。
// 家族只能读取信号日当时可获得的数据；服务端按注册表执行，禁止 eval 或加载模型生成的任意代码。
// 离散变化受事前冻结的策略空间和新版赛马政策约束。

export const STRATEGY_FAMILIES = Object.freeze({
  "limit-momentum-v1": Object.freeze({
    familyId: "limit-momentum-v1",
    familyVersion: 1,
    description:
      "涨停池六因子打分策略：评分筛选、仓位上限、持有天数、止损止盈与做 T 触发由参数控制",
    defaultParams: Object.freeze(structuredClone(BASE_STRATEGY)),
    numericParameters: Object.freeze(
      Object.entries(RANGES).map(([key, range]) => ({
        key,
        range,
        step: STEP_LIMITS[key],
        integer: [
          "minScore",
          "minSectorScore",
          "maxPositions",
          "maxHoldDays",
        ].includes(key),
      })),
    ),
    supportsWeights: true,
  }),
  ...Object.fromEntries(
    Object.entries(FAMILY_DEFINITIONS)
      .filter(([id]) => id !== "limit-momentum-v1")
      .map(([id, definition]) => [
        id,
        Object.freeze({
          familyId: id,
          familyVersion: definition.version,
          description: definition.description,
          defaultParams: {
            ...structuredClone(BASE_STRATEGY),
            program: familyProgram(id),
          },
          numericParameters: Object.entries(RANGES).map(([key, range]) => ({
            key,
            range,
            step: STEP_LIMITS[key],
          })),
          supportsWeights: true,
        }),
      ]),
  ),
  "emotion-selector-v1": {
    familyId: "emotion-selector-v1",
    familyVersion: 1,
    description: "按信号日冻结情绪选择家族，持仓使用共享风险与退出规则",
    numericParameters: [],
    supportsWeights: true,
  },
  "shared-allocation-v1": {
    familyId: "shared-allocation-v1",
    familyVersion: 1,
    description: "固定权重共享现金、仓位及同股成交容量，统一持仓保护",
    numericParameters: [],
    supportsWeights: true,
  },
});

export function assertFamilyRegistered(familyId, familyVersion = 1) {
  const family = STRATEGY_FAMILIES[familyId];
  if (!family) throw new Error(`未登记的策略家族：${familyId}`);
  if (family.familyVersion !== familyVersion)
    throw new Error(`策略家族版本不匹配：${familyId}@${familyVersion}`);
  return family;
}

export function describeStrategySpace() {
  return {
    version: STRATEGY_SPACE_VERSION,
    families: Object.values(STRATEGY_FAMILIES).map((family) => ({
      familyId: family.familyId,
      familyVersion: family.familyVersion,
      description: family.description,
      numericParameters: family.numericParameters,
      supportsWeights: family.supportsWeights,
      note: "家族变化、选择器和共享分配必须采用 v2 赛马政策，在新前瞻窗口验证",
    })),
    programRules: {
      version: 1,
      kinds: ["FAMILY", "EMOTION_SELECTOR", "ALLOCATION"],
      families: Object.keys(FAMILY_DEFINITIONS),
      maxComponents: 4,
      weightStepBps: 500,
      weightTotalBps: 10000,
      selectorThresholds: "strategy.exposureTiers",
      holdingRules:
        "统一风险、退出与做 T 参数；家族控制新增需求；未用分配保留现金",
      allocationRules: "单账本、单股净需求、合并容量、实际费用按成交归属分配",
    },
    note: "数值参数继续遵守原小步政策；程序变化算一组。无变化、重复或不合法候选登记失败并占用尝试序号",
  };
}

export async function strategySpaceManifest() {
  const payload = describeStrategySpace();
  return { payload, digest: await digestOf(payload) };
}
export function validateStrategyCandidate({
  proposal,
  parentParams,
  frozenPolicy,
  cohortPolicy,
}) {
  const patch = proposal?.patch;
  if (!patch || !Object.hasOwn(patch, "program"))
    return validateCandidatePatch({ proposal, parentParams, frozenPolicy });
  if (
    cohortPolicy?.version !== 2 ||
    cohortPolicy.strategySpaceVersion !== STRATEGY_SPACE_VERSION
  )
    throw new Error("家族与组合变化未获得冻结策略空间授权");
  const program = normalizeStrategyProgram(patch.program);
  const programChanged =
    programIdentity({ program }) !== programIdentity(parentParams);
  const { program: _, ...numeric } = patch;
  let candidate = {
    params: structuredClone(parentParams),
    patch: {},
    changedGroups: 0,
    rationale: proposal.rationale,
  };
  if (Object.keys(numeric).length)
    candidate = validateCandidatePatch({
      proposal: { ...proposal, patch: numeric },
      parentParams,
      frozenPolicy,
    });
  if (programChanged) {
    candidate.params.program = program;
    candidate.patch.program = program;
    candidate.changedGroups++;
  }
  if (!candidate.changedGroups) throw new Error("候选与父策略无实际差异");
  if (candidate.changedGroups > frozenPolicy.maxParamGroups)
    throw new Error("策略程序与数值变化超过逻辑参数组上限");
  return candidate;
}

export function programTemplates(mode, count = 4) {
  const ref = (familyId) => ({ familyId, familyVersion: 1 });
  let programs;
  const first = "first-board-v1",
    relay = "relay-board-v1",
    sector = "sector-resonance-v1",
    low = "low-turnover-v1";
  if (mode === "FAMILIES")
    programs = [first, relay, sector, low].map(familyProgram);
  else if (mode === "SELECTORS")
    programs = [
      [relay, first],
      [sector, low],
      [relay, low],
      [first, sector],
    ].map(([high, mid]) =>
      normalizeStrategyProgram({
        version: 1,
        kind: "EMOTION_SELECTOR",
        regimes: { high: ref(high), mid: ref(mid), low: ref("cash-v1") },
      }),
    );
  else if (mode === "ALLOCATIONS")
    programs = [
      [5000, 3000, 2000],
      [4000, 4000, 2000],
      [3000, 5000, 2000],
      [2000, 3000, 5000],
    ].map((weights) =>
      normalizeStrategyProgram({
        version: 1,
        kind: "ALLOCATION",
        components: [first, sector, low].map((id, index) => ({
          id: id.replace("-v1", ""),
          weightBps: weights[index],
          family: ref(id),
        })),
      }),
    );
  else throw new Error("模板生成方式无效");
  return {
    candidates: programs.slice(0, count).map((program, index) => ({
      rationale: `事前固定 ${mode} 模板 ${index + 1}，不依据测试收益补选`,
      patch: { program },
    })),
    requestDigest: null,
    modelAlias: "DETERMINISTIC_TEMPLATES_V2",
  };
}
