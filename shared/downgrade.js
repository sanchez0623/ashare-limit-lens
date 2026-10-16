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
// 检测时点：每日结算（backend/services/paper.js settlePaperDay），
// 随结算账本一次 CAS 落库；当日已降级（downgradedAt === today）不再
// 连降——skill 语义为每日检查、每次降一档。
//
// 数据口径：
//   stocks：当日评分快照行（normalize 后：sector / height / change /
//     turnover / breaks），板块统计（最高板 / 平均涨幅）只来自涨停池
//     ——池外股没有板块归属数据，宁缺毋滥；
//   brokenRows：炸板池原始行（出池持仓的 breaks / change / turnover
//     来源，normalize 复用同一字段族）；
//   eodChange：日线涨幅补充（出池且不在炸板池时触发条件 2 的唯一来源）。
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

const num = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : Number(v);

// 单条持仓的降级检测。returns { to, triggers, reason } 或 null。
export function detectDowngradeForPosition({
  position,
  stocks,
  brokenRows,
  eodChange = null,
  today,
}) {
  const from = position?.stockClass;
  const to = DOWNGRADE_CHAIN[from];
  if (!to) return null; // 波段震荡型为终点；平庸型/未分类无降级语义
  if (position.downgradedAt === today) return null; // 一日最多降一档
  const pool = (stocks ?? []).filter((row) => row?.code);
  const own = pool.find((row) => row.code === position.code) ?? null;
  const broken =
    (brokenRows ?? [])
      .map((row) => normalize(row ?? {}))
      .find((row) => row.code === position.code) ?? null;
  const sector = position.sector ?? own?.sector ?? null;
  const sectorRows = sector ? pool.filter((row) => row.sector === sector) : [];
  // 板块统计以"同板块其他涨停股"为基准（不含自身）：跟风对照的是其他
  // 强势股，自身涨跌会污染均值。
  const peerRows = sectorRows.filter((row) => row.code !== position.code);
  const ownHeight = num(own?.height) ?? 0; // 池外 = 今日未涨停，连板归零
  const peerMaxHeight = peerRows.reduce(
    (max, row) => Math.max(max, num(row.height) ?? 0),
    0,
  );
  const sectorAvgChange = peerRows.length
    ? peerRows.reduce((sum, row) => sum + (num(row.change) ?? 0), 0) /
      peerRows.length
    : null;
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
    sectorAvgChange !== null &&
    ownChange < sectorAvgChange * FOLLOWER_LAG_RATIO
  )
    triggers.push(
      `今日涨幅 ${ownChange.toFixed(2)}% 不足板块均值 ${sectorAvgChange.toFixed(2)}% 的一半，跟涨不领涨`,
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
  today,
}) {
  const demotions = new Map();
  for (const position of positions ?? []) {
    const demotion = detectDowngradeForPosition({
      position,
      stocks,
      brokenRows,
      eodChange: eodChangeByCode?.get(position.code) ?? null,
      today,
    });
    if (demotion) demotions.set(position.code, demotion);
  }
  return demotions;
}
