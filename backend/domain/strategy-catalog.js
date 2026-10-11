import { BASE_STRATEGY } from "./trading.js";
import { RANGES } from "./validation.js";
import { STEP_LIMITS } from "./research-policy.js";

// 白名单策略家族（§4.2）：首期只有一个家族——现有六因子策略。
// 家族只能读取信号日当时可获得的数据；服务端按注册表执行，禁止 eval 或加载模型生成的任意代码。
// 第二阶段的离散家族（首板、连板、板块共振等）必须先在此登记并另立策略空间政策。

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
    families: Object.values(STRATEGY_FAMILIES).map((family) => ({
      familyId: family.familyId,
      familyVersion: family.familyVersion,
      description: family.description,
      numericParameters: family.numericParameters,
      supportsWeights: family.supportsWeights,
      note: "离散策略变化（关闭做 T、换仓位分配、新入场规则）不在本家族参数空间内，须另立政策",
    })),
    note: "候选只能对父策略参数做合法小步变化；无变化、重复或不合法的候选登记失败并占用尝试序号",
  };
}
