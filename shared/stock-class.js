// 股票分类器（方案 3）：把涨停池候选路由到不同策略家族，从源头过滤平庸股。
//
// 四类（skill：连板龙头型 / 强势反包型 / 波段震荡型 / 平庸型）：
//   连板龙头型 relay-leader：
//     连板数 >= 3 AND 是所属行业板块内最高板 AND 成交额 >= 3 亿
//     —— 只需当日快照数据即可判定。
//   强势反包型 strong-reversal：
//     近 10 日内有涨停（涨停基因）AND 未达连板龙头 AND 收盘站上 20 日均线。
//   波段震荡型 swing-range：
//     有题材标签 AND 近 20 日区间振幅 10%~25% AND 非涨停股或首板。
//   平庸型 mediocre：
//     在历史特征齐全的前提下不满足以上任一 → 选股阶段直接排除。
//
// 分类前置条件：除连板龙头外，其余两类依赖历史特征（limitUp10d / ma20 /
// amplitude20）。特征不足时返回 null（"未分类"）而不是断言平庸——数据缺失
// 不能证明平庸，选股阶段只排除被明确判定为 mediocre 的股票。
//
// 权重路由（与三套预设一一对应）：
//   连板龙头型 → relay；强势反包型 → balanced；波段震荡型 → first。
// 路由只在选股政策 stockClassRouting === true（signal-ranking-v3）时生效。

const num = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : Number(v);

export const STOCK_CLASSES = Object.freeze({
  RELAY_LEADER: "relay-leader",
  STRONG_REVERSAL: "strong-reversal",
  SWING_RANGE: "swing-range",
  MEDIOCRE: "mediocre",
});

// 类别 → 评分权重预设名（与 shared/scoring.js PRESETS 对应）
export const CLASS_WEIGHT_PRESETS = Object.freeze({
  [STOCK_CLASSES.RELAY_LEADER]: "relay",
  [STOCK_CLASSES.STRONG_REVERSAL]: "balanced",
  [STOCK_CLASSES.SWING_RANGE]: "first",
});

export const RELAY_LEADER_MIN_HEIGHT = 3;
export const RELAY_LEADER_MIN_AMOUNT = 3e8; // 成交额 3 亿（元）
export const REVERSAL_LOOKBACK_DAYS = 10;
export const SWING_LOOKBACK_DAYS = 20;
export const SWING_AMPLITUDE_MIN = 10; // 20 日区间振幅下限（%）
export const SWING_AMPLITUDE_MAX = 25; // 20 日区间振幅上限（%）

// 分类输入：
//   row：当日快照行（height / amount / sector / isLimitUp / close|price）
//   sectorMaxHeight：该股所属板块内的最高连板数（快照内统计）
//   history：历史特征 { limitUp10d, ma20, amplitude20 }，字段可缺失
// 返回 { stockClass, reason } 或 null（特征不足以分类，且非连板龙头）。
export function classifyStock({ row, sectorMaxHeight, history }) {
  const height = num(row.height) ?? 0;
  const amount = num(row.amount);
  // 1) 连板龙头型：当日数据即可判定
  if (
    height >= RELAY_LEADER_MIN_HEIGHT &&
    sectorMaxHeight !== null &&
    sectorMaxHeight === height &&
    amount !== null &&
    amount >= RELAY_LEADER_MIN_AMOUNT
  )
    return {
      stockClass: STOCK_CLASSES.RELAY_LEADER,
      reason: `${height} 连板且为板块最高板，成交额 ${(amount / 1e8).toFixed(2)} 亿`,
    };

  // 2) 历史特征未知 → 不分类（不能断言平庸）
  if (!history) return null;
  const { limitUp10d, ma20, amplitude20 } = history;
  const close = num(row.close) ?? num(row.price);

  // 3) 强势反包型：涨停基因 + 站上 20 日线（且未达龙头标准——龙头已先行返回）
  if (
    limitUp10d === true &&
    close !== null &&
    ma20 !== null &&
    close > ma20
  )
    return {
      stockClass: STOCK_CLASSES.STRONG_REVERSAL,
      reason: "近 10 日有涨停基因，收盘站上 20 日均线",
    };

  // 4) 波段震荡型：有题材标签 + 20 日振幅适中 + 非涨停股或首板
  const hasThemeTag = !!row.sector && row.sector !== "未分类";
  if (
    hasThemeTag &&
    amplitude20 !== null &&
    amplitude20 >= SWING_AMPLITUDE_MIN &&
    amplitude20 <= SWING_AMPLITUDE_MAX &&
    (!row.isLimitUp || height === 1)
  )
    return {
      stockClass: STOCK_CLASSES.SWING_RANGE,
      reason: `20 日振幅 ${amplitude20.toFixed(1)}% 适中，非连板股`,
    };

  // 5) 平庸的断言前提：反包（MA20）与波段（振幅）两类特征都齐全。
  // 任一特征缺失（如仅 15 根日线 → MA20/振幅为 null）时保持"未分类"，
  // 缺失数据不能证明平庸。
  if (ma20 === null || amplitude20 === null) return null;
  return {
    stockClass: STOCK_CLASSES.MEDIOCRE,
    reason: "不满足连板龙头 / 强势反包 / 波段震荡任一特征",
  };
}
