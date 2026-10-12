import { publicFetch } from "./public-fetch.js";
import { symbol, beijingDate } from "./review.js";
import { toCents } from "../domain/trading.js";
import { normalize, promotionStats } from "../../shared/scoring.js";
import { BENCHMARK_CODES } from "../../shared/benchmarks.js";
const CACHE = new Map();
const EM_BASE = "https://push2ex.eastmoney.com/";
const TOKEN = "7eea3edcaed734bea9cbfc24409ed989";
export async function getPool(endpoint, date) {
  const u = new URL(endpoint, EM_BASE);
  u.search = new URLSearchParams({
    ut: TOKEN,
    dpt: "wz.ztzt",
    Pageindex: "0",
    pagesize: "10000",
    sort: endpoint === "getYesterdayZTPool" ? "zs:desc" : "fbt:asc",
    date: date.replaceAll("-", ""),
  }).toString();
  const response = await fetch(u.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://quote.eastmoney.com/",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`行情源 HTTP ${response.status}`);
  const body = await response.json();
  if (body.rc !== 0 || !body.data || !Array.isArray(body.data.pool))
    throw new Error("行情源未返回该日期的有效涨停池");
  const pool = body.data.pool;
  if (pool.some((r) => typeof r.c !== "string" || typeof r.n !== "string"))
    throw new Error("行情字段格式变化");
  const sourceDate = String(body.data.qdate ?? "").replaceAll("-", "");
  if (sourceDate !== date.replaceAll("-", "")) {
    const actualDate = /^\d{8}$/.test(sourceDate)
      ? `${sourceDate.slice(0, 4)}-${sourceDate.slice(4, 6)}-${sourceDate.slice(6, 8)}`
      : "未确认";
    throw new Error(
      `来源数据日期与请求日期不一致（请求 ${date}，来源 ${actualDate}）`,
    );
  }
  return {
    pool,
    date,
    sourceDate: body.data.qdate ?? null,
    total: body.data.tc ?? pool.length,
  };
}
export async function marketData(date) {
  const hit = CACHE.get(date);
  if (hit && Date.now() - hit.time < 120000)
    return { ...hit.body, cached: true };
  const [main, broken, yesterday] = await Promise.allSettled([
    getPool("getTopicZTPool", date),
    getPool("getTopicZBPool", date),
    getPool("getYesterdayZTPool", date),
  ]);
  if (main.status === "rejected") throw main.reason;
  const warnings = [];
  if (broken.status === "rejected") warnings.push("炸板池未返回，封板率暂缺。");
  if (yesterday.status === "rejected" || !yesterday.value?.pool.length)
    warnings.push("昨日涨停池未返回有效样本，晋级率暂缺。");
  else if (
    promotionStats(
      main.value.pool.map(normalize),
      yesterday.value.pool.map(normalize),
    ).promotion === null
  )
    warnings.push("昨日连板字段缺失或无效，晋级率暂缺。");
  const result = {
    date,
    source: "东方财富公开行情",
    sourceUrl: "https://quote.eastmoney.com/ztb/detail",
    scope: "沪深主板、创业板；不含 ST、科创板及连续一字新股",
    fetchedAt: new Date().toISOString(),
    rows: main.value.pool,
    broken: broken.status === "fulfilled" ? broken.value.pool.length : null,
    previous:
      yesterday.status === "fulfilled" && yesterday.value.pool.length
        ? yesterday.value.pool
        : null,
    previousLabel: "上一交易日",
    warnings,
    cached: false,
  };
  if (CACHE.size >= 20) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(date, { time: Date.now(), body: result });
  return result;
}

// 拉取单个指数的日线（含当日实时报价合并）；交易日历与基准曲线共用。
async function indexKline(code, startDate, endDate, limit = 80) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("交易日历条数限制无效");
  const url = new URL("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get");
  url.searchParams.set(
    "param",
    `${code},day,${startDate},${endDate},${limit},qfq`,
  );
  const response = await publicFetch(url, 12000);
  if (!response.ok) throw new Error("交易日行情暂不可用");
  const body = await response.json();
  const item = body.data?.[code];
  if (!item) throw new Error("缺少交易日校验数据");
  const days = (item.day || item.qfqday || []).filter(
    (row) => row[0] >= startDate && row[0] <= endDate,
  );
  const quote = item.qt?.[code];
  const quoteDate = quote?.[30]?.slice(0, 8);
  const format = (value) =>
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (
    quoteDate &&
    format(quoteDate) === endDate &&
    !days.some((day) => day[0] === endDate)
  ) {
    days.push([endDate, quote[5], quote[3], quote[33], quote[34], quote[6]]);
  }
  return days;
}

export async function tradingCalendar(
  startDate,
  endDate,
  benchmarkCode,
  calendarLimit = 80,
) {
  // 交易日历固定取上证指数；基准曲线用账户所选指数，缺失时回退上证。
  // calendarLimit 供证据服务等长日历消费方使用，默认保持原 80 条行为。
  const days = await indexKline("sh000001", startDate, endDate, calendarLimit);
  let benchmarkDays = days;
  if (benchmarkCode && benchmarkCode !== "sh000001") {
    try {
      const rows = await indexKline(
        benchmarkCode,
        startDate,
        endDate,
        calendarLimit,
      );
      if (rows.length) benchmarkDays = rows;
    } catch {
      benchmarkDays = days;
    }
  }
  return {
    dates: days.map((day) => day[0]).sort(),
    benchmark: benchmarkDays.map((day) => ({
      date: day[0],
      closeCents: toCents(day[2]),
      openCents: toCents(day[1]),
    })),
  };
}

const INDEX_CLOSES_CACHE = new Map();
// 按日期查询指数收盘价（分）；用于账户收益曲线按所选基准指数整体重算。
export async function indexDailyCloses(code, startDate, endDate) {
  if (!BENCHMARK_CODES.has(code)) throw new Error("不支持的基准指数");
  const key = `${code}|${startDate}|${endDate}`;
  const hit = INDEX_CLOSES_CACHE.get(key);
  if (hit && Date.now() - hit.time < 600000) return hit.value;
  const days = await indexKline(code, startDate, endDate);
  const closes = new Map(days.map((day) => [day[0], toCents(day[2])]));
  if (INDEX_CLOSES_CACHE.size >= 20)
    INDEX_CLOSES_CACHE.delete(INDEX_CLOSES_CACHE.keys().next().value);
  INDEX_CLOSES_CACHE.set(key, { time: Date.now(), value: closes });
  return closes;
}

// 首页默认日期用：返回不晚于 today 的最后一个真实交易日，取不到返回 null。
export async function latestTradingDate(today = beijingDate()) {
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  const { dates } = await tradingCalendar(start, today);
  return dates.filter((date) => date <= today).at(-1) ?? null;
}

export async function tradingQuotes(codes, date) {
  const validCodes = [...new Set(codes)].filter((code) => /^\d{6}$/.test(code));
  const quotes = {};
  for (let index = 0; index < validCodes.length; index += 150) {
    const part = validCodes.slice(index, index + 150);
    const url = `https://qt.gtimg.cn/q=${part.map(symbol).join(",")}`;
    const response = await publicFetch(url, 12000);
    if (!response.ok) throw new Error("持仓行情获取失败");
    const text = new TextDecoder("gb18030").decode(
      await response.arrayBuffer(),
    );
    Object.assign(quotes, parseTencentQuotes(text, date));
  }
  return quotes;
}

export function parseTencentQuotes(text, date) {
  const quotes = {};
  for (const match of text.matchAll(/v_(sh|sz)(\d{6})="([^"]*)"/g)) {
    const fields = match[3].split("~");
    if (
      !/^\d{14}$/.test(fields[30]) ||
      Number(fields[30].slice(8, 10)) > 23 ||
      Number(fields[30].slice(10, 12)) > 59 ||
      Number(fields[30].slice(12, 14)) > 59 ||
      !Number.isFinite(Number(fields[6])) ||
      Number(fields[6]) < 0
    )
      continue;
    const actualDate = fields[30]?.slice(0, 8);
    if (actualDate !== date.replaceAll("-", "")) continue;
    const positive = (value) =>
      Number.isFinite(Number(value)) && Number(value) > 0
        ? toCents(value)
        : null;
    if (!positive(fields[3]) || !positive(fields[4])) continue;
    // 可选盘口（§5.1）：腾讯响应缺少稳定正式字段契约，买一/卖一取
    // fields[9]/fields[19]（价格）与 fields[10]/fields[20]（量，手）。
    // 解析失败必须降级并记录质量标志，不能假定索引永远代表相同字段。
    const bid1Cents = positive(fields[9]);
    const ask1Cents = positive(fields[19]);
    const bid1Shares = Number.isFinite(Number(fields[10]))
      ? Math.max(0, Math.round(Number(fields[10]) * 100))
      : null;
    const ask1Shares = Number.isFinite(Number(fields[20]))
      ? Math.max(0, Math.round(Number(fields[20]) * 100))
      : null;
    let orderBookQuality = "OK";
    let orderBook = {};
    if (bid1Cents && ask1Cents && bid1Shares !== null && ask1Shares !== null) {
      if (bid1Cents > ask1Cents) {
        // 倒挂盘口不可作为价格锚点：降级为声明的回退假设并留痕。
        orderBookQuality = "INVERTED";
      } else {
        orderBook = {
          bid1Cents,
          ask1Cents,
          bid1Shares,
          ask1Shares,
        };
      }
    } else orderBookQuality = "MISSING";
    quotes[match[2]] = {
      date,
      closeCents: positive(fields[3]),
      previousCloseCents: positive(fields[4]),
      openCents: positive(fields[5]),
      highCents: positive(fields[33]),
      lowCents: positive(fields[34]),
      volumeShares: Math.round(Number(fields[6]) * 100),
      limitUpCents: positive(fields[47]),
      limitDownCents: positive(fields[48]),
      ...orderBook,
      orderBookQuality,
      orderBookTimestamp: /^\d{14}$/.test(fields[30])
        ? `${date}T${fields[30].slice(8, 10)}:${fields[30].slice(10, 12)}:${fields[30].slice(12, 14)}+08:00`
        : null,
      quoteSchemaVersion: "tencent-qt-v1",
      timestamp: /^\d{14}$/.test(fields[30])
        ? `${date}T${fields[30].slice(8, 10)}:${fields[30].slice(10, 12)}:${fields[30].slice(12, 14)}+08:00`
        : null,
    };
  }
  return quotes;
}

export async function minuteBars(code, date) {
  const url = new URL("https://web.ifzq.gtimg.cn/appstock/app/day/query");
  url.searchParams.set("code", symbol(code));
  const response = await publicFetch(url, 10000);
  if (!response.ok) throw new Error("盘中数据暂不可用");
  const body = await response.json();
  const days = body.data?.[symbol(code)]?.data;
  const day = Array.isArray(days)
    ? days.find((item) => item.date === date.replaceAll("-", ""))
    : null;
  if (!day || !Array.isArray(day.data)) throw new Error("盘中数据日期不匹配");
  let previousVolume = 0;
  const bars = [];
  for (const row of day.data) {
    const [time, price, volume] = String(row).trim().split(/\s+/);
    if (
      !/^\d{4}$/.test(time) ||
      !(Number(price) > 0) ||
      !(Number(volume) >= previousVolume)
    )
      continue;
    const formattedTime = `${time.slice(0, 2)}:${time.slice(2)}`;
    if (
      formattedTime < "09:30" ||
      formattedTime > "15:00" ||
      (formattedTime > "11:30" && formattedTime < "13:00") ||
      (bars.length && bars.at(-1).time >= formattedTime)
    )
      throw new Error("分钟行情时间序列无效");
    const volumeShares = Math.round((Number(volume) - previousVolume) * 100);
    previousVolume = Number(volume);
    bars.push({
      time: formattedTime,
      priceCents: toCents(price),
      volumeShares,
    });
  }
  return bars;
}

export async function collectTradingDay(date, codes, minuteCodes, benchmark) {
  const quotes = await tradingQuotes(codes, date);
  const minutes = {};
  const warnings = [];
  const queue = [...new Set(minuteCodes)].slice(0, 12);
  for (let index = 0; index < queue.length; index += 4) {
    const part = queue.slice(index, index + 4);
    const results = await Promise.allSettled(
      part.map((code) => minuteBars(code, date)),
    );
    results.forEach((result, offset) => {
      if (result.status === "fulfilled") minutes[part[offset]] = result.value;
      else
        warnings.push(
          `${part[offset]} 盘中数据缺失，只允许开盘价假设成交，不执行做 T`,
        );
    });
  }
  return {
    date,
    quotes,
    minutes,
    benchmark,
    warnings,
    fetchedAt: new Date().toISOString(),
    source: "腾讯公开行情",
    executionModel: "分钟采样价格加滑点；缺少分钟数据时只模拟开盘成交",
  };
}
