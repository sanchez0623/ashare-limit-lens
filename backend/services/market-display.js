import { database } from "../storage/database.js";
import { beijingDate, readBuyPointParams } from "./review.js";
import { marketData } from "./market.js";
import { getMa5ByCode, getStockFeaturesByCode } from "./daily-closes.js";
import { safeError } from "../http.js";
import { normalize, promotionStats } from "../../shared/scoring.js";

const validPool = (rows) =>
  Array.isArray(rows) &&
  rows.every(
    (row) => row && typeof row.c === "string" && typeof row.n === "string",
  );

// 观测时刻在北京时间 14:30 及以后视为尾盘时点（收盘后同样成立）；
// 盘中早段保持未知，避免把全天回撤误标为尾盘跳水。
function tailSessionNow() {
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  return hm >= "14:30";
}

// Display archived judgments without fetching today's provider data or rescoring
// an old snapshot with current weights. Trading continues to use marketData.
async function archivedMarket(env, date) {
  if (!env?.DB) return null;
  const row = await database(env)
    .prepare(
      "SELECT trade_date, created_at, payload FROM snapshots WHERE trade_date = ?",
    )
    .bind(date)
    .first();
  if (!row) return null;
  const snapshot = JSON.parse(row.payload);
  if (
    row.trade_date !== date ||
    snapshot.date !== date ||
    !Array.isArray(snapshot.stocks) ||
    !Array.isArray(snapshot.sectors)
  )
    throw new Error("历史归档日期或内容不一致，请核对存储中的评分快照");

  const summary = {
    ...(snapshot.marketSummary ?? {
      count: snapshot.stocks.length,
      excluded: null,
      first: snapshot.stocks.filter((stock) => stock.height === 1).length,
      relay: snapshot.stocks.filter((stock) => stock.height > 1).length,
      height: Math.max(0, ...snapshot.stocks.map((stock) => stock.height || 0)),
      sealRate: null,
      emotionCoverage: null,
      promotion: null,
      previousCount: null,
    }),
  };
  const warnings = ["当前展示已保存的盘后评分，个股与板块得分保持当天冻结值。"];
  if (!snapshot.marketSummary)
    warnings.push("旧版归档未保存完整市场统计，无法补算的指标显示为“—”。");
  let promotionBackfilled = false;
  if (summary.promotion == null) {
    const raw = snapshot.market;
    if (
      validPool(raw?.rows) &&
      validPool(raw?.previous) &&
      (raw.date == null || raw.date === date)
    ) {
      const stats = promotionStats(
        raw.rows.map(normalize),
        raw.previous.map(normalize),
      );
      if (stats.promotion !== null) {
        Object.assign(summary, stats);
        promotionBackfilled = true;
        warnings.push("晋级率由归档的当日及昨日涨停池补算，原始快照未改写。");
      } else {
        warnings.push(
          raw.previous.length
            ? "归档昨日连板字段缺失或无效，晋级率暂缺。"
            : "归档昨日涨停池没有有效样本，晋级率暂缺。",
        );
      }
    } else {
      warnings.push("归档缺少同日有效的当日或昨日涨停池原始数据，晋级率暂缺。");
    }
  }
  return {
    date,
    source: snapshot.source ?? "已保存的评分快照",
    archived: true,
    ...(promotionBackfilled ? { promotionBackfilled: true } : {}),
    archivedAt: row.created_at,
    fetchedAt: snapshot.market?.fetchedAt ?? row.created_at,
    rows: snapshot.market?.rows ?? null,
    broken: snapshot.market?.broken ?? null,
    previous: snapshot.market?.previous ?? null,
    warnings,
    cached: false,
    analysis: {
      ...summary,
      stocks: snapshot.stocks,
      // 旧归档无炸板候选字段时补空数组，保持展示形状与服务端 analyze
      // 输出一致（display-only，不参与计划冻结与摘要）。
      brokenStocks: snapshot.brokenStocks ?? [],
      sectors: snapshot.sectors,
      emotion: snapshot.emotion ?? null,
    },
  };
}

export async function marketForDisplay(
  env,
  date,
  { today = beijingDate(), loadMarket = marketData } = {},
) {
  if (date < today) {
    const archive = await archivedMarket(env, date);
    if (archive) return archive;
  }
  try {
    const market = await loadMarket(date);
    // 研究页客户端会用原始行重新 analyze，MA5 随 payload 下发供首阴校验；
    // 只带池内代码避免 payload 膨胀。数据缺失时 ma5ByCode 为空对象（优雅降级）。
    const { ma5ByCode, asOf } = await getMa5ByCode(env, date);
    const poolCodes = new Set(
      (market.rows ?? []).map((row) => row?.c).filter(Boolean),
    );
    const slim = {};
    for (const [code, value] of ma5ByCode)
      if (poolCodes.has(code)) slim[code] = value;
    // 股票分类历史特征随 payload 下发（只带池内代码），研究页客户端
    // 重算 analyze 时口径与服务端一致
    const { featuresByCode } = await getStockFeaturesByCode(env, date);
    const slimFeatures = {};
    for (const [code, value] of featuresByCode)
      if (poolCodes.has(code)) slimFeatures[code] = value;
    // 买点参数（首阴门槛）随 payload 下发，研究页客户端重算时口径一致
    const buyPointParams = await readBuyPointParams(env);
    return {
      ...market,
      ma5ByCode: slim,
      historyByCode: slimFeatures,
      buyPointParams,
      ...(asOf ? { ma5AsOf: asOf } : {}),
      // 研究页客户端用原始行重新 analyze，尾盘时点随观测时刻下发
      ...(tailSessionNow() ? { lateSession: true } : {}),
    };
  } catch (error) {
    if (date === today) {
      const archive = await archivedMarket(env, date);
      if (archive) return archive;
    }
    if (date < today)
      throw new Error(
        `${date} 尚无盘后归档，公开行情未提供该日的可用数据：${safeError(error)}`,
      );
    throw error;
  }
}
