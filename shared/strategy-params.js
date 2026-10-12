// 策略参数与情绪档位：默认值、字段元数据、校验与归一化，供前后端共用。
// 与 fees.js / risk-limits.js 同一模式：手动改动登记为新策略版本
// （strategy_versions，evidence.type = "manual"），随下一计划冻结；
// 计划保存完整 strategy，历史成交按当时参数核验。
// 纯数据与纯函数，不读数据库、不做交易计算。

import { PRESETS } from "./scoring.js";

// 情绪档位：highEmotion/midEmotion 为两档情绪阈值（整数），
// high/mid/low 为对应目标敞口。阈值同时驱动加仓、做 T、开仓与减仓闸门，
// 使"情绪档位"成为唯一的 regime 定义。
export const EXPOSURE_TIERS_DEFAULTS = Object.freeze({
  highEmotion: 65,
  midEmotion: 40,
  high: 0.55,
  mid: 0.35,
  low: 0.15,
});

// 与 AI 提案约束一致（backend/domain/validation.js、improvement.js 提示词）。
export const STRATEGY_RANGES = Object.freeze({
  minScore: [70, 95],
  minSectorScore: [40, 80],
  maxPositions: [2, 5],
  maxHoldDays: [2, 10],
  stopLoss: [0.02, 0.08],
  takeProfit: [0.06, 0.2],
  maxBuyGap: [0, 0.04],
  tFraction: [0.1, 0.25],
  tBuyDip: [0.01, 0.04],
  tSellRise: [0.01, 0.04],
});

export const STRATEGY_INTEGER_KEYS = Object.freeze([
  "minScore",
  "minSectorScore",
  "maxPositions",
  "maxHoldDays",
]);

// 因子权重顺序与 shared/scoring.js FACTORS 一致。
export const WEIGHT_FIELDS = Object.freeze([
  { key: "quality", label: "封板质量" },
  { key: "capital", label: "封单强度" },
  { key: "liquidity", label: "换手结构" },
  { key: "timing", label: "首封时点" },
  { key: "sector", label: "板块协同" },
  { key: "ladder", label: "连板结构" },
]);

// 计划与成交闸门使用的策略参数（区别于研究页观察权重）。
export const STRATEGY_FIELDS = Object.freeze([
  {
    key: "maxPositions",
    label: "最大持仓数",
    unit: "只",
    percent: false,
    min: 2,
    max: 5,
    step: 1,
    hint: "同时持有的股票数量上限",
  },
  {
    key: "minScore",
    label: "建仓最低评分",
    unit: "分",
    percent: false,
    min: 70,
    max: 95,
    step: 1,
    hint: "新开仓要求的策略评分下限",
  },
  {
    key: "minSectorScore",
    label: "建仓最低板块分",
    unit: "分",
    percent: false,
    min: 40,
    max: 80,
    step: 1,
    hint: "新开仓要求的板块协同评分下限",
  },
  {
    key: "maxHoldDays",
    label: "最长持有天数",
    unit: "天",
    percent: false,
    min: 2,
    max: 10,
    step: 1,
    hint: "持有达到该天数后清仓",
  },
  {
    key: "stopLoss",
    label: "止损幅度",
    unit: "%",
    percent: true,
    min: 2,
    max: 8,
    step: 0.1,
    hint: "亏损达到该比例触发清仓",
  },
  {
    key: "takeProfit",
    label: "分批止盈幅度",
    unit: "%",
    percent: true,
    min: 6,
    max: 20,
    step: 0.1,
    hint: "盈利达到该比例触发减仓兑现",
  },
  {
    key: "maxBuyGap",
    label: "开盘买入上限",
    unit: "%",
    percent: true,
    min: 0,
    max: 4,
    step: 0.1,
    hint: "买入价相对昨收的最大上浮，超出则放弃",
  },
  {
    key: "tFraction",
    label: "做 T 仓位比例",
    unit: "%",
    percent: true,
    min: 10,
    max: 25,
    step: 0.1,
    hint: "每次做 T 使用底仓的比例",
  },
  {
    key: "tBuyDip",
    label: "做 T 低吸价差",
    unit: "%",
    percent: true,
    min: 1,
    max: 4,
    step: 0.1,
    hint: "正向 T 的买入触发回落幅度",
  },
  {
    key: "tSellRise",
    label: "做 T 兑现价差",
    unit: "%",
    percent: true,
    min: 1,
    max: 4,
    step: 0.1,
    hint: "正向 T 的卖出触发上浮幅度",
  },
]);

export const TIER_FIELDS = Object.freeze([
  {
    key: "highEmotion",
    label: "高档情绪阈值",
    unit: "分",
    percent: false,
    min: 0,
    max: 100,
    step: 1,
    hint: "情绪达到该值进入高档：目标敞口取高档，并允许加仓",
  },
  {
    key: "midEmotion",
    label: "低档情绪阈值",
    unit: "分",
    percent: false,
    min: 0,
    max: 100,
    step: 1,
    hint: "情绪低于该值进入防守：目标敞口取低档，停止开新仓与做 T 并减仓",
  },
  {
    key: "high",
    label: "高档目标敞口",
    unit: "%",
    percent: true,
    min: 5,
    max: 95,
    step: 0.1,
    hint: "高档情绪下的目标总仓位",
  },
  {
    key: "mid",
    label: "中档目标敞口",
    unit: "%",
    percent: true,
    min: 5,
    max: 95,
    step: 0.1,
    hint: "中性情绪下的目标总仓位",
  },
  {
    key: "low",
    label: "低档目标敞口",
    unit: "%",
    percent: true,
    min: 5,
    max: 95,
    step: 0.1,
    hint: "防守情绪下的目标总仓位",
  },
]);

// baseline-v1 的完整默认参数；交易内核 BASE_STRATEGY 由此展开。
export const STRATEGY_DEFAULTS = Object.freeze({
  weights: Object.freeze([...PRESETS.balanced]),
  minScore: 80,
  minSectorScore: 55,
  maxPositions: 4,
  maxHoldDays: 5,
  stopLoss: 0.06,
  takeProfit: 0.12,
  maxBuyGap: 0.03,
  tFraction: 0.2,
  tBuyDip: 0.02,
  tSellRise: 0.02,
  exposureTiers: EXPOSURE_TIERS_DEFAULTS,
});

const TIER_BOUNDS = Object.freeze({
  highEmotion: [0, 100],
  midEmotion: [0, 100],
  high: [0.05, 0.95],
  mid: [0.05, 0.95],
  low: [0.05, 0.95],
});

// 手动编辑的完整参数校验与归一化：字段集合固定，输出键序稳定，
// 便于与现有版本做 JSON 级比较判断是否需要登记新版本。
export function normalizeStrategyParams(value) {
  const invalid = (reason) => {
    throw new Error(`策略参数无效：${reason}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("结构无效");
  const keys = Object.keys(value);
  const expected = [
    ...Object.keys(STRATEGY_RANGES),
    "weights",
    "exposureTiers",
  ];
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  )
    invalid("字段必须为 weights、10 项策略参数与 exposureTiers");
  const weights = value.weights;
  if (
    !Array.isArray(weights) ||
    weights.length !== WEIGHT_FIELDS.length ||
    weights.some((v) => !Number.isInteger(v) || v < 0 || v > 50) ||
    !weights.some((v) => v > 0)
  )
    invalid("权重必须为 6 个 0–50 的整数且不全为零");
  const params = { weights: [...weights] };
  for (const [key, [min, max]] of Object.entries(STRATEGY_RANGES)) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number))
      invalid(`${key} 必须为数值`);
    if (STRATEGY_INTEGER_KEYS.includes(key)) {
      if (!Number.isInteger(number) || number < min || number > max)
        invalid(`${key} 必须为 ${min}–${max} 的整数`);
      params[key] = number;
    } else {
      if (number < min || number > max) invalid(`${key} 超出 ${min}–${max}`);
      params[key] = Math.round(number * 1e6) / 1e6;
    }
  }
  const tiers = value.exposureTiers;
  if (!tiers || typeof tiers !== "object" || Array.isArray(tiers))
    invalid("exposureTiers 结构无效");
  const tierKeys = Object.keys(TIER_BOUNDS);
  if (
    Object.keys(tiers).length !== tierKeys.length ||
    tierKeys.some((key) => !(key in tiers))
  )
    invalid("exposureTiers 字段集合无效");
  const exposureTiers = {};
  for (const [key, [min, max]] of Object.entries(TIER_BOUNDS)) {
    const number = tiers[key];
    if (typeof number !== "number" || !Number.isFinite(number))
      invalid(`情绪档位 ${key} 必须为数值`);
    if (key.endsWith("Emotion")) {
      if (!Number.isInteger(number) || number < min || number > max)
        invalid(`情绪档位 ${key} 必须为 ${min}–${max} 的整数`);
      exposureTiers[key] = number;
    } else {
      if (number < min || number > max)
        invalid(`情绪档位 ${key} 超出 ${min}%–${max}%`);
      exposureTiers[key] = Math.round(number * 1e6) / 1e6;
    }
  }
  if (exposureTiers.highEmotion <= exposureTiers.midEmotion)
    invalid("高档情绪阈值必须大于低档情绪阈值");
  if (
    exposureTiers.high < exposureTiers.mid ||
    exposureTiers.mid < exposureTiers.low
  )
    invalid("目标敞口必须满足 高档 ≥ 中档 ≥ 低档");
  params.exposureTiers = exposureTiers;
  return params;
}

// 兼容历史版本：旧策略版本缺少 exposureTiers 时按默认档位补齐。
export function withExposureTiers(params) {
  return {
    ...params,
    exposureTiers: params?.exposureTiers ?? EXPOSURE_TIERS_DEFAULTS,
  };
}
