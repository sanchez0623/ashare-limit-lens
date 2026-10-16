// 卖出上下文构建（方案 5）：主账户、影子组合、回测与研究重放共用同一
// 构建逻辑，同一快照在任一链路都得到同一卖出上下文，卖出决策可跨链路复现。
//
// 组成部分独立降级（缺失数据不产生卖出建议，也不阻断计划冻结）：
//   - 日线历史特征 / 当日 EOD 行：QUAN_DATA_DIR 未配置或未覆盖快照日
//     时为空 Map，对应信号跳过；
//   - 板块退潮：昨日涨停池缺失时为空集合，不产生该信号；
//   - 炸板池记录：炸板池归档缺失（旧快照 / 历史重构数据集）时为空，
//     出池持仓的炸板次数保持未知；
//   - 情绪切换：昨日情绪周期缺失时不判切换。
//
// 输入固化：每日上下文一经计算即按日期持久化并绑定内容摘要
// （exit_context_inputs 表，首写固化）。日线 Parquet 是可变文件——主
// 账户冻结后补齐当日数据会让按次重算的影子/研究重放得到不同特征、
// 决策漂移（ADD 变 EXIT）；固化后各链路引用同一版本。
import {
  getStockFeaturesByCode,
  getExitEodRowsByCode,
} from "./daily-closes.js";
import { sectorLimitUpDrops } from "../../shared/exit-signals.js";
import { normalize } from "../../shared/scoring.js";
import { CYCLE_PHASES } from "../../shared/sentiment-cycle.js";
import { digest } from "../storage/paper.js";

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

// 输入快照序列化（Map → 纯对象，形状与 createPlan 的 exitContextFrozen
// 一致）。注意：这里保存全市场未裁剪输入——研究重放的模拟持仓也需要
// 同一输入；裁剪到持仓代码只发生在计划冻结时（freezeExitContext）。
function serializeExitInputs({
  exitFeaturesByCode,
  exitEodRowsByCode,
  exitBreaksByCode,
  sectorLimitDrops,
  phaseShift,
}) {
  return {
    ...(exitFeaturesByCode?.size
      ? { features: Object.fromEntries(exitFeaturesByCode) }
      : {}),
    ...(exitEodRowsByCode?.size
      ? { eodRows: Object.fromEntries(exitEodRowsByCode) }
      : {}),
    ...(exitBreaksByCode?.size
      ? { breaks: Object.fromEntries(exitBreaksByCode) }
      : {}),
    ...(sectorLimitDrops?.size
      ? { sectorDrops: [...sectorLimitDrops.keys()].sort() }
      : {}),
    ...(phaseShift ? { phaseShift: true } : {}),
  };
}

function deserializeExitInputs(payload) {
  return {
    exitFeaturesByCode: payload?.features
      ? new Map(Object.entries(payload.features))
      : new Map(),
    exitEodRowsByCode: payload?.eodRows
      ? new Map(Object.entries(payload.eodRows))
      : new Map(),
    exitBreaksByCode: payload?.breaks
      ? new Map(Object.entries(payload.breaks))
      : new Map(),
    sectorLimitDrops: new Map(
      (payload?.sectorDrops ?? []).map((sector) => [sector, true]),
    ),
    phaseShift: payload?.phaseShift === true,
  };
}

// 读取某日固化的输入。摘要不一致（数据损坏）视为缺失，不静默使用；
// 表不存在（旧库未迁移）同样降级为缺失。
export async function loadPersistedExitInputs(db, date) {
  if (!db) return null;
  try {
    const row = await db
      .prepare(
        "SELECT payload, digest FROM exit_context_inputs WHERE trade_date = ?",
      )
      .bind(date)
      .first();
    if (!row) return null;
    const payload = JSON.parse(row.payload);
    if ((await digest(payload)) !== row.digest) return null;
    return payload;
  } catch {
    return null;
  }
}

// 首写固化：同日输入一经落盘不再随 Parquet 更新（INSERT OR IGNORE）。
// 持久化失败不阻断计划冻结，退化为按次计算（旧行为）。
async function persistExitInputs(db, date, context) {
  if (!db) return;
  try {
    const payload = serializeExitInputs(context);
    await db
      .prepare(
        "INSERT OR IGNORE INTO exit_context_inputs (trade_date, payload, digest, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(
        date,
        JSON.stringify(payload),
        await digest(payload),
        new Date().toISOString(),
      )
      .run();
  } catch {
    // 固化失败保持旧行为：后续链路按当前数据重算。
  }
}

// 主账户 / 影子组合 / 回测共用入口：优先引用该日已固化版本，缺失时
// 计算并（persist !== false 时）落盘。返回对象带 persisted 标记：true
// 表示来自固化版本（与主账户冻结时同源），false 表示按当前数据计算。
// 回测数据集日期多且已有自身归档，传 persist:false 只读不写，避免研究库
// 膨胀；persisted 为 true 时调用方不得再覆盖其中字段。
export async function loadOrBuildExitContext({
  env,
  db,
  snapshot,
  date,
  persist = true,
}) {
  const persisted = await loadPersistedExitInputs(db, date);
  if (persisted)
    return { ...deserializeExitInputs(persisted), persisted: true };
  const built = await buildExitContext({ env, db, snapshot, date });
  if (persist) {
    await persistExitInputs(db, date, built);
    // 回读实际落盘版本：并发首写时本链路的 INSERT OR IGNORE 可能败给
    // 先到者，各链路必须收敛到同一条已固化输入——直接返回本地计算结果
    // 会出现主账户与影子各用各的版本（ADD vs EXIT）的分裂。
    const stored = await loadPersistedExitInputs(db, date);
    if (stored) return { ...deserializeExitInputs(stored), persisted: true };
  }
  return { ...built, persisted: false };
}
