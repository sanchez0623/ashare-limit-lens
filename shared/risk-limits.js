// 风控约束（单股上限 / 总仓位上限 / 回撤熔断 / 参与率 / 旧模型滑点）：
// 默认值、字段元数据、校验与归一化，供前后端共用。纯数据与纯函数，
// 不读数据库、不做交易计算（交易内核在 backend/domain/trading.js）。
// 与 fees.js 同一模式：账户级可配置，随计划冻结，历史成交按当时配置核验。

export const DEFAULT_RISK_LIMITS = Object.freeze({
  maxPositionWeight: 0.2,
  maxGrossExposure: 0.6,
  maxDrawdown: 0.1,
  maxParticipation: 0.01,
  slippageBps: 10,
});

export const RISK_FIELDS = Object.freeze([
  {
    key: "maxPositionWeight",
    label: "单股仓位上限",
    unit: "%",
    percent: true,
    hint: "单只个股市值占账户权益的上限",
  },
  {
    key: "maxGrossExposure",
    label: "总仓位上限",
    unit: "%",
    percent: true,
    hint: "全部持仓市值占账户权益的上限",
  },
  {
    key: "maxDrawdown",
    label: "回撤熔断线",
    unit: "%",
    percent: true,
    hint: "权益自峰值回撤达到该比例时清仓并暂停买入",
  },
  {
    key: "maxParticipation",
    label: "分钟成交量参与上限",
    unit: "%",
    percent: true,
    hint: "旧成本模型下单分钟最多消耗的成交量比例",
  },
  {
    key: "slippageBps",
    label: "旧模型固定滑点",
    unit: "bps",
    percent: false,
    hint: "旧成本模型成交价相对参考价的固定偏移",
  },
]);

const BOUNDS = Object.freeze({
  maxPositionWeight: [0.01, 1],
  maxGrossExposure: [0.01, 1],
  maxDrawdown: [0.005, 1],
  maxParticipation: [0.0001, 0.1],
  slippageBps: [0, 200],
});

export function validRiskLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== RISK_FIELDS.length) return false;
  return RISK_FIELDS.every(({ key, percent }) => {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) return false;
    const [min, max] = BOUNDS[key];
    if (number < min || number > max) return false;
    return percent ? true : Math.abs(number - Math.round(number)) < 1e-9;
  });
}

export function normalizeRiskLimits(value) {
  if (!validRiskLimits(value))
    throw new Error(
      "风控限制无效：仓位与参与率上限为 0.01%–100%，回撤熔断线为 0.5%–100%，旧滑点为 0–200 的整数 bps",
    );
  const normalized = Object.fromEntries(
    RISK_FIELDS.map(({ key, percent }) => [
      key,
      percent ? Math.round(value[key] * 1e6) / 1e6 : Math.round(value[key]),
    ]),
  );
  if (normalized.maxGrossExposure < normalized.maxPositionWeight)
    throw new Error("总仓位上限不能低于单股仓位上限");
  return normalized;
}

export function riskLimitsForBook(book) {
  return book?.riskLimits || DEFAULT_RISK_LIMITS;
}

// 计划冻结的风控配置；旧计划无标记时回退默认值（与历史硬编码一致，
// 保证旧计划重放语义不变）。
export function planRiskLimits(plan) {
  return plan?.riskLimits || DEFAULT_RISK_LIMITS;
}
