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
// 触发 2 的对照下限：板块均值取同板块涨停池中位数，至少 2 家对照才
// 采信——单一极端对照（如唯一一只 20cm 涨停）不足以判定跟风。
export const SECTOR_MEDIAN_MIN_PEERS = 2;

const num = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : Number(v);

// 快照版本门控：炸板池字段（方案 5 第二轮）随本检测器同期接入归档，
// 据此区分新旧快照——旧快照（无该字段）重建的计划保持旧语义（不启用
// 降级检测与类别管理），新快照启用。旧计划重算因此与冻结版本一致。
export function downgradeEnabledForSnapshot(snapshot) {
  return Boolean(snapshot?.market && "brokenRows" in (snapshot.market ?? {}));
}

// 单条持仓的降级检测。returns { to, triggers, reason } 或 null。
// 未携带管理类别的持仓按连板龙头型检测（策略默认买入动量龙头）。
export function detectDowngradeForPosition({
  position,
  stocks,
  brokenRows,
  eodChange = null,
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
  // 板块统计以"同板块其他涨停股"为对照（不含自身）；均值用中位数并
  // 要求至少 2 家对照——单一极端对照（唯一 20cm 涨停）不得判定跟风。
  const peerRows = sectorRows.filter((row) => row.code !== position.code);
  const ownHeight = num(own?.height) ?? 0; // 池外 = 今日未涨停，连板归零
  const peerMaxHeight = peerRows.reduce(
    (max, row) => Math.max(max, num(row.height) ?? 0),
    0,
  );
  const peerChanges = peerRows
    .map((row) => num(row.change))
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  const sectorMedianChange =
    peerChanges.length >= SECTOR_MEDIAN_MIN_PEERS
      ? peerChanges.length % 2
        ? peerChanges[(peerChanges.length - 1) / 2]
        : (peerChanges[peerChanges.length / 2 - 1] +
            peerChanges[peerChanges.length / 2]) /
          2
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
    sectorMedianChange !== null &&
    ownChange < sectorMedianChange * FOLLOWER_LAG_RATIO
  )
    triggers.push(
      `今日涨幅 ${ownChange.toFixed(2)}% 不足板块中位涨幅 ${sectorMedianChange.toFixed(2)}% 的一半，跟涨不领涨`,
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
