// 情绪周期分类器：把 skill 里定性描述的"上升/高潮/退潮/冰点"映射成
// 可量化的情绪分 S，并输出仓位上限闸门。
// 输入：当日涨停数、炸板数、最高板、过去5日最高板均值（可选）、
//      昨日涨停股今日平均溢价（可选）。
// 输出：cycle（four phases）、score(0-1)、maxGrossExposure（0-1）、
//      reason（人类可读判定）。
//
// 设计原则：
// 1. 纯函数、不读数据库，可被 scoring / risk-limits / 赛马任意复用。
// 2. 缺数据时降级：缺失分项按中性 0.5 计，不抛错；但"炸板数缺失"
//    不能被解释为"没有炸板"，必须保留未知状态以避免封板率被高估。
// 3. 仓位闸门是"上限"而非"目标"——用户/策略可以更保守，不能更激进。
// 4. 阈值与 skill 文档对齐：
//    上升期 S>=0.70 仓位上限 0.80
//    高潮期 0.50<=S<0.70 仓位上限 0.50
//    退潮期 0.30<=S<0.50 仓位上限 0.20
//    冰点期 S<0.30 仓位上限 0.00
// 5. 高潮期有独立硬触发：高度足够高（>=7 板）且涨停数足够多（>=60），
//    无论子项加权分多高都直接归高潮，避免"过热被误判为上升期"。

export const CYCLE_PHASES = Object.freeze({
  RISING: "rising",
  CLIMAX: "climax",
  EBBING: "ebbing",
  FREEZING: "freezing",
});

export const CYCLE_LABELS = Object.freeze({
  [CYCLE_PHASES.RISING]: "上升期",
  [CYCLE_PHASES.CLIMAX]: "高潮期",
  [CYCLE_PHASES.EBBING]: "退潮期",
  [CYCLE_PHASES.FREEZING]: "冰点期",
});

// 各阶段对应的总仓位上限（占权益比例）。
export const CYCLE_MAX_EXPOSURE = Object.freeze({
  [CYCLE_PHASES.RISING]: 0.8,
  [CYCLE_PHASES.CLIMAX]: 0.5,
  [CYCLE_PHASES.EBBING]: 0.2,
  [CYCLE_PHASES.FREEZING]: 0.0,
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// 子项归一化：
//  - limitUpRatio: 涨停家数。经验上 80 家以上为高，20 家以下为低。
//  - sealRate: 封板率 = 涨停 / (涨停 + 炸板)。高=强，低=弱。
//  - heightTrend: 今日最高板 / 过去5日最高板均值。>1 高度在打开，<1 高度在压缩。
//  - premium: 昨日涨停今日平均溢价率。正=赚钱效应好，负=亏钱效应扩散。
function subscores(input) {
  const limitUp = Number.isFinite(input.limitUp) ? input.limitUp : 0;
  // 炸板数缺失（null/undefined/NaN）时不强制视为 0——保留 null 让
  // sealRate 走"未知"分支给中性分，否则会把缺数据误判为封板率满分。
  const broken = Number.isFinite(input.broken) ? input.broken : null;
  const limitDown = Number.isFinite(input.limitDown) ? input.limitDown : 0;
  const height = Number.isFinite(input.height) ? input.height : 0;
  const heightAvg5 = Number.isFinite(input.heightAvg5)
    ? input.heightAvg5
    : null;
  const premium = Number.isFinite(input.premium) ? input.premium : null;

  // 涨停数归一化：0→0，80→1。同时若跌停数超过涨停数，直接压半。
  let limitUpScore = clamp01(limitUp / 80);
  if (limitDown > limitUp && limitUp > 0) limitUpScore *= 0.5;

  // 封板率：炸板数未知时不给满分，走中性 0.5（等同无信号）。
  // 分母为 0（无涨停也无炸板）同样返回 null。
  let sealRate = null;
  if (broken !== null && limitUp + broken > 0) {
    sealRate = limitUp / (limitUp + broken);
  }
  const sealScore = sealRate === null ? 0.5 : clamp01((sealRate - 0.4) / 0.4);

  // 高度趋势：无历史均值时按高度本身估计（>=5 板为强）。
  let heightScore;
  if (heightAvg5 && heightAvg5 > 0) {
    const ratio = height / heightAvg5;
    // ratio 0→0.5, 1→0.65, 1.5→1.0
    heightScore = clamp01(0.35 + ratio * 0.4);
  } else {
    heightScore = clamp01(height / 6);
  }

  // 溢价率：-5%→0，0→0.5，+5%→1。
  const premiumScore = premium === null ? 0.5 : clamp01((premium + 5) / 10);

  return { limitUpScore, sealScore, heightScore, premiumScore };
}

// 权重总和在调用时动态调整：缺项按中性 0.5 补回，避免缺数据导致整体偏低。
function compose(subs) {
  const weights = {
    limitUpScore: 0.4,
    sealScore: 0.3,
    heightScore: 0.2,
    premiumScore: 0.1,
  };
  let totalW = 0;
  let acc = 0;
  for (const [key, w] of Object.entries(weights)) {
    acc += subs[key] * w;
    totalW += w;
  }
  return totalW > 0 ? acc / totalW : 0.5;
}

// 高潮硬触发：高度 ≥7 板且涨停 ≥60 家，无论加权分多高都归高潮期。
// 这对应 skill 中"涨停百股、高度打开"的过热描述——此时再按高分判上升期
// 会错过退潮前的最后风险窗口。
function isClimaxOverride(input) {
  const height = Number.isFinite(input.height) ? input.height : 0;
  const limitUp = Number.isFinite(input.limitUp) ? input.limitUp : 0;
  return height >= 7 && limitUp >= 60;
}

function phaseOf(score, input) {
  if (isClimaxOverride(input)) return CYCLE_PHASES.CLIMAX;
  if (score >= 0.7) return CYCLE_PHASES.RISING;
  if (score >= 0.5) return CYCLE_PHASES.CLIMAX;
  if (score >= 0.3) return CYCLE_PHASES.EBBING;
  return CYCLE_PHASES.FREEZING;
}

// 主入口。
// input = { limitUp, broken, limitDown?, height, heightAvg5?, premium? }
export function classifySentimentCycle(input = {}) {
  const subs = subscores(input);
  const score = Math.round(compose(subs) * 100) / 100;
  const phase = phaseOf(score, input);
  const maxExposure = CYCLE_MAX_EXPOSURE[phase];
  const reason = describe(input, subs, phase);
  return {
    phase,
    label: CYCLE_LABELS[phase],
    score,
    maxGrossExposure: maxExposure,
    subscores: subs,
    reason,
  };
}

function describe(input, subs, phase) {
  const bits = [];
  bits.push(
    `涨停 ${input.limitUp ?? 0} 家（子项 ${subs.limitUpScore.toFixed(2)}）`,
  );
  bits.push(`封板率子项 ${subs.sealScore.toFixed(2)}`);
  bits.push(`高度子项 ${subs.heightScore.toFixed(2)}`);
  if (Number.isFinite(input.premium))
    bits.push(`昨涨停溢价 ${input.premium.toFixed(2)}%`);
  return `判定为${CYCLE_LABELS[phase]}：${bits.join("，")}。`;
}

// 计划实际敞口上限的唯一口径：周期闸门（若有）与账户硬限制取较小值。
// createPlan 冻结 targetExposure、executeFillWithCostModel 计算成交上限、
// strategy-program 家族核验重算资源分配，三处必须共用本函数，避免口径漂移。
// 计划持久化的 riskLimits 始终保持账户原始 5 字段严格 schema
// （normalizeRiskLimits 禁止 0 或多余字段，改写 maxGrossExposure 会被拒）；
// 周期上限单独冻结在 plan.cycle.maxGrossExposure，读取时在此处统一叠加。
export function resolveExposureCap(riskLimits, cycle) {
  const base = Number(riskLimits?.maxGrossExposure);
  const gated = Number(cycle?.maxGrossExposure);
  if (Number.isFinite(gated))
    return Number.isFinite(base) ? Math.min(base, gated) : gated;
  return base;
}
