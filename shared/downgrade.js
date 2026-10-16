// 判断失误降级检测器（方案 6）：持仓期间每日检查"买成跟风股"。
//
// skill 触发条件（满足任一即降级；数据缺失的触发项跳过，不猜）：
//   1. 板块内有另一只股票连板数 > 持仓股（不是板块最强）
//   2. 持仓股今日涨幅 < 板块平均涨幅的 50%（跟涨不领涨）
//   3. 持仓股今日炸板 ≥2 次且未回封（封不住）
//   4. 持仓股今日换手率 > 15% 且涨幅 < 3%（放量滞涨）
//
// 降级链（skill）：连板龙头型 → 强势反包型 → 波段震荡型（终点）。
// 降级后管理（createPlan 按 CLASS_MANAGEMENT 应用）：
//   强势反包型：目标仓位 ×0.7（降 1 档），收益目标上限 10%；
//   波段震荡型：目标仓位 ×0.5（再降 1 档），收益目标上限 10%，
//   最长持有 2 日（快进快出）。
//
// 检测时点：计划冻结（backend/domain/trading.js createPlan 内派生，
// 确定性：同一信号日快照 + 持仓状态 → 同一结论）。结论以 downgrades
// 声明随计划冻结，执行日开盘由 applyPlanDowngrades 套用入账本
// （stockClass / downgradedAt）——主账户、影子、研究重放与核验重放
// 对同一计划收敛，不出现第二条与计划不一致的判定路径。一日最多降
// 一档（downgradedAt === 信号日 的持仓跳过当日检测）。
//
// 数据口径：
//   stocks：当日评分快照行（normalize 后：sector / height / change /
//     turnover / breaks），仅用于板块最高板，不能代表完整板块涨幅；
//   brokenRows：炸板池原始行（出池持仓的 breaks / change / turnover
//     来源，normalize 复用同一字段族）；
//   eodChange：日线涨幅补充；
//   sectorPerformance：冻结的完整板块均值（含日期、来源和覆盖数量），
//     缺失或不完整时仅跳过条件 2，禁止用涨停池的均值/中位数替代。
import { STOCK_CLASSES } from "./stock-class.js";
import { BROKEN_MIN_COUNT } from "./exit-signals.js";
import { normalize } from "./scoring.js";

export const DOWNGRADE_CHAIN = Object.freeze({
  [STOCK_CLASSES.RELAY_LEADER]: STOCK_CLASSES.STRONG_REVERSAL,
  [STOCK_CLASSES.STRONG_REVERSAL]: STOCK_CLASSES.SWING_RANGE,
});

// 降级后管理参数：targetScale 乘到该持仓的目标仓位（仓位降档）；
// takeProfitCap 收益目标上限；maxHoldDays 覆盖策略最长持有（快进快出）。
export const CLASS_MANAGEMENT = Object.freeze({
  [STOCK_CLASSES.RELAY_LEADER]: Object.freeze({
    targetScale: 1,
    maxHoldDays: null,
    takeProfitCap: null,
  }),
  [STOCK_CLASSES.STRONG_REVERSAL]: Object.freeze({
    targetScale: 0.7,
    maxHoldDays: null,
    takeProfitCap: 0.1,
  }),
  [STOCK_CLASSES.SWING_RANGE]: Object.freeze({
    targetScale: 0.5,
    maxHoldDays: 2,
    takeProfitCap: 0.1,
  }),
});

export const FOLLOWER_LAG_RATIO = 0.5; // 触发 2：涨幅不足板块均值的一半
export const STALL_TURNOVER = 15; // 触发 4：换手率下限（%）
export const STALL_MAX_CHANGE = 3; // 触发 4：涨幅上限（%）
export const DOWNGRADE_RULES_VERSION = 1;

const num = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : Number(v);

// 规则版本必须在信号生成时显式冻结；brokenRows 在旧版本就已存在，
// 不能作为启用标记。未标记的历史快照始终保持旧语义，不补写版本。
export function downgradeEnabledForSnapshot(snapshot) {
  if (!Object.hasOwn(snapshot ?? {}, "downgradeRulesVersion")) return false;
  if (snapshot.downgradeRulesVersion !== DOWNGRADE_RULES_VERSION)
    throw new Error("不支持的降级规则版本");
  return true;
}

export function downgradeEnabledForPlan(plan) {
  const enabled = downgradeEnabledForSnapshot(plan);
  if (
    enabled
      ? !Array.isArray(plan.downgrades)
      : Object.hasOwn(plan ?? {}, "downgrades")
  )
    throw new Error("降级规则版本与声明不一致，请重新冻结计划");
  return enabled;
}

function completeSectorMean(performance, sector, date) {
  if (
    !sector ||
    performance?.date !== date ||
    performance.complete !== true ||
    typeof performance.source !== "string" ||
    !performance.source.trim() ||
    !Array.isArray(performance.sectors)
  )
    return null;
  const rows = performance.sectors.filter((row) => row?.name === sector);
  if (rows.length !== 1) return null;
  const row = rows[0];
  return Number.isInteger(row.memberCount) &&
    row.memberCount > 1 &&
    row.observedCount === row.memberCount &&
    Number.isFinite(row.averageChange)
    ? row.averageChange
    : null;
}

// 单条持仓的降级检测。returns { to, triggers, reason } 或 null。
// 未携带管理类别的持仓按连板龙头型检测（策略默认买入动量龙头）。
export function detectDowngradeForPosition({
  position,
  stocks,
  brokenRows,
  eodChange = null,
  sectorPerformance = null,
  today,
}) {
  const from = position?.stockClass ?? STOCK_CLASSES.RELAY_LEADER;
  const to = DOWNGRADE_CHAIN[from];
  if (!to) return null; // 波段震荡型为终点；平庸型无降级语义
  if (position.downgradedAt === today) return null; // 一日最多降一档
  const pool = (stocks ?? []).filter((row) => row?.code);
  const own = pool.find((row) => row.code === position.code) ?? null;
  const broken =
    (brokenRows ?? [])
      .map((row) => normalize(row ?? {}))
      .find((row) => row.code === position.code) ?? null;
  const sector = position.sector ?? own?.sector ?? null;
  const sectorRows = sector ? pool.filter((row) => row.sector === sector) : [];
  // 涨停池可证明同板块存在更高板，但不能证明完整板块的平均涨幅。
  const peerRows = sectorRows.filter((row) => row.code !== position.code);
  const ownHeight = num(own?.height) ?? 0; // 池外 = 今日未涨停，连板归零
  const peerMaxHeight = peerRows.reduce(
    (max, row) => Math.max(max, num(row.height) ?? 0),
    0,
  );
  const sectorMeanChange = completeSectorMean(sectorPerformance, sector, today);
  const ownChange = num(own?.change) ?? num(broken?.change) ?? num(eodChange);
  const ownTurnover = num(own?.turnover) ?? num(broken?.turnover);
  const ownBreaks = num(own?.breaks) ?? num(broken?.breaks);
  const sealed = !!own; // 在涨停池 = 收盘封住（炸板后回封）
  const triggers = [];
  if (peerRows.length && peerMaxHeight > ownHeight)
    triggers.push(
      `板块内出现更高连板（${peerMaxHeight} 板 > 自身 ${ownHeight} 板），失去龙头地位`,
    );
  if (
    ownChange !== null &&
    sectorMeanChange !== null &&
    ownChange < sectorMeanChange * FOLLOWER_LAG_RATIO
  )
    triggers.push(
      `今日涨幅 ${ownChange.toFixed(2)}% 不足完整板块平均涨幅 ${sectorMeanChange.toFixed(2)}% 的一半，跟涨不领涨`,
    );
  if (ownBreaks !== null && ownBreaks >= BROKEN_MIN_COUNT && !sealed)
    triggers.push(`今日炸板 ${ownBreaks} 次且收盘未回封`);
  if (
    ownTurnover !== null &&
    ownTurnover > STALL_TURNOVER &&
    ownChange !== null &&
    ownChange < STALL_MAX_CHANGE
  )
    triggers.push(
      `换手率 ${ownTurnover.toFixed(1)}% 放量滞涨（涨幅仅 ${ownChange.toFixed(2)}%）`,
    );
  if (!triggers.length) return null;
  return { from, to, triggers, reason: triggers.join("；") };
}

// 批量入口：结算时对全部持仓检测，返回 Map<code, demotion>。
export function detectPositionDowngrades({
  positions,
  stocks,
  brokenRows,
  eodChangeByCode = null,
  sectorPerformance = null,
  today,
}) {
  const demotions = new Map();
  for (const position of positions ?? []) {
    const demotion = detectDowngradeForPosition({
      position,
      stocks,
      brokenRows,
      eodChange: eodChangeByCode?.get(position.code) ?? null,
      sectorPerformance,
      today,
    });
    if (demotion) demotions.set(position.code, demotion);
  }
  return demotions;
}
