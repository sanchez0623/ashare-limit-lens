// 历史日线行情兜底（补结算专用）：实时行情快照只覆盖当天，历史交易日的
// 持仓收盘价从腾讯 fqkline 日线（前复权口径）构造，供收盘结算的最终价
// 盯市与昨收对账使用。若结算日至今发生过除权，前复权昨收与账面原价不一致，
// 由 closeSession 的除权守卫原样阻断（不静默混用复权口径）；不提供盘口与
// 涨跌停字段，不用于盘中成交。单只代码取数失败时跳过（该代码由结算守卫
// 按"缺少最终收盘价"阻断）。
import { publicFetch } from "./public-fetch.js";
import { symbol } from "./review.js";

export async function historicalDailyQuotes(codes, date, previousDate) {
  const quotes = {};
  for (const code of [...new Set(codes)]) {
    try {
      const url = new URL("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get");
      url.searchParams.set(
        "param",
        `${symbol(code)},day,${previousDate},${date},10,qfq`,
      );
      const response = await publicFetch(url, 12000);
      const body = await response.json();
      const item = body.data?.[symbol(code)];
      const rows = (item?.day || item?.qfqday || []).filter(
        (row) => row[0] >= previousDate && row[0] <= date,
      );
      const bar = rows.find((row) => row[0] === date);
      const prior = rows.filter((row) => row[0] < date).at(-1);
      const toCents = (value) => Math.round(Number(value) * 100);
      const closeOf = (row) => toCents(row[2]);
      const closeCents = closeOf(bar ?? []);
      const openCents = toCents(bar?.[1]);
      if (
        !(closeCents > 0) ||
        !(openCents > 0) ||
        rows.some((row) => !(closeOf(row) > 0))
      )
        continue;
      quotes[code] = {
        date,
        timestamp: `${date}T15:00:01+08:00`,
        closeCents,
        previousCloseCents: prior ? closeOf(prior) : null,
        openCents,
        highCents: toCents(bar[3]),
        lowCents: toCents(bar[4]),
        closingSource: "DAILY_BAR",
        quoteSchemaVersion: "tencent-fqkline-day-v1",
      };
    } catch {
      // 单只失败保持缺失：结算守卫会按缺失收盘价阻断，不静默造数。
    }
  }
  return quotes;
}
