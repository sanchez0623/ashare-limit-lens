import { database } from "../storage/database.js";
import { beijingDate } from "./review.js";
import { marketData } from "./market.js";
import { safeError } from "../http.js";

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

  const summary = snapshot.marketSummary ?? {
    count: snapshot.stocks.length,
    excluded: null,
    first: snapshot.stocks.filter((stock) => stock.height === 1).length,
    relay: snapshot.stocks.filter((stock) => stock.height > 1).length,
    height: Math.max(0, ...snapshot.stocks.map((stock) => stock.height || 0)),
    sealRate: null,
    emotionCoverage: null,
    promotion: null,
    previousCount: null,
  };
  const warnings = ["当前展示已保存的盘后评分，个股与板块得分保持当天冻结值。"];
  if (!snapshot.marketSummary)
    warnings.push("旧版归档未保存炸板池与晋级统计，缺失指标显示为“—”。");
  return {
    date,
    source: snapshot.source ?? "已保存的评分快照",
    archived: true,
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
    return await loadMarket(date);
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
