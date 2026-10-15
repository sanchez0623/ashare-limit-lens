// 卖出上下文构建（方案 5）：主账户、影子组合与回测共用同一构建逻辑，
// 同一快照在任一链路都得到同一卖出上下文，卖出决策可跨链路复现。
//
// 组成部分独立降级（缺失数据不产生卖出建议，也不阻断计划冻结）：
//   - 日线历史特征 / 当日 EOD 行：QUAN_DATA_DIR 未配置或未覆盖快照日
//     时为空 Map，对应信号跳过；
//   - 板块退潮：昨日涨停池缺失时为空集合，不产生该信号；
//   - 炸板池记录：炸板池归档缺失（旧快照 / 历史重构数据集）时为空，
//     出池持仓的炸板次数保持未知；
//   - 情绪切换：昨日情绪周期缺失时不判切换。
import {
  getStockFeaturesByCode,
  getExitEodRowsByCode,
} from "./daily-closes.js";
import { sectorLimitUpDrops } from "../../shared/exit-signals.js";
import { normalize } from "../../shared/scoring.js";
import { CYCLE_PHASES } from "../../shared/sentiment-cycle.js";

// 情绪周期切换：昨日在高潮/上升期，今日退潮/冰点 → true。
export function phaseShiftOf(todayPhase, yesterdayPhase) {
  const prevHot =
    yesterdayPhase === CYCLE_PHASES.CLIMAX ||
    yesterdayPhase === CYCLE_PHASES.RISING;
  const todayCold =
    todayPhase === CYCLE_PHASES.EBBING || todayPhase === CYCLE_PHASES.FREEZING;
  return prevHot && todayCold;
}

// 板块退潮集合：今日池传规范化行（sector/height，评分快照即此形状），
// 昨日池传原始行（hybk/ylbc；规范化行请先转 { hybk: sector, ylbc: height }，
// 与 sectorLimitUpDrops 的输入约定一致）。
export function sectorDropsOf(todayStocks, previousRawRows) {
  return sectorLimitUpDrops(
    (todayStocks ?? []).map((stock) => ({
      ...stock,
      sector: stock.sector ?? "未分类",
      height: stock.height ?? 0,
    })),
    previousRawRows ?? [],
  );
}

// 炸板池记录 → Map<code, breaks>：出池持仓的炸板次数来自当日炸板池
// 归档（涨停池行只覆盖封住涨停的股票）。zbc 缺失的行跳过（不猜 0）。
export function exitBreaksFromBrokenRows(brokenRows) {
  const map = new Map();
  for (const row of brokenRows ?? []) {
    const normalized = normalize(row ?? {});
    if (normalized.code && normalized.breaks !== null)
      map.set(normalized.code, normalized.breaks);
  }
  return map;
}

// db 快照库 + 当日评分快照 → 完整卖出上下文（主账户与影子组合冻结共用）。
// 昨日情绪周期直接查快照库最近一条早于 date 的归档，避免窗口截断。
export async function buildExitContext({ env, db, snapshot, date }) {
  const [featuresResult, eodResult] = await Promise.all([
    getStockFeaturesByCode(env, date),
    getExitEodRowsByCode(env, date),
  ]);
  const yesterdayRow = db
    ? await db
        .prepare(
          "SELECT payload FROM snapshots WHERE trade_date < ? ORDER BY trade_date DESC LIMIT 1",
        )
        .bind(date)
        .first()
        .then((row) => (row ? JSON.parse(row.payload) : null))
        .catch(() => null)
    : null;
  return {
    exitFeaturesByCode: featuresResult.featuresByCode,
    exitEodRowsByCode: eodResult.rowsByCode,
    exitBreaksByCode: exitBreaksFromBrokenRows(snapshot?.market?.brokenRows),
    sectorLimitDrops: sectorDropsOf(
      snapshot?.stocks,
      snapshot?.market?.previous,
    ),
    phaseShift: phaseShiftOf(
      snapshot?.cycle ?? snapshot?.marketSummary?.cycle?.phase ?? null,
      yesterdayRow?.cycle ?? yesterdayRow?.marketSummary?.cycle?.phase ?? null,
    ),
  };
}
