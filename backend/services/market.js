import { publicFetch } from "./public-fetch.js";
import { symbol } from "./review.js";
import { toCents } from "../domain/trading.js";
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
  if (sourceDate !== date.replaceAll("-", ""))
    throw new Error("来源数据日期与请求日期不一致");
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

export async function tradingCalendar(startDate, endDate) {
  const url = new URL("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get");
  url.searchParams.set("param", `sh000001,day,${startDate},${endDate},80,qfq`);
  const response = await publicFetch(url, 12000);
  if (!response.ok) throw new Error("交易日行情暂不可用");
  const body = await response.json();
  const item = body.data?.sh000001;
  if (!item) throw new Error("缺少交易日校验数据");
  const days = (item.day || item.qfqday || []).filter(
    (row) => row[0] >= startDate && row[0] <= endDate,
  );
  const quote = item.qt?.sh000001;
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
  return {
    dates: days.map((day) => day[0]).sort(),
    benchmark: days.map((day) => ({
      date: day[0],
      closeCents: toCents(day[2]),
      openCents: toCents(day[1]),
    })),
  };
}

export async function tradingQuotes(codes, date) {
  const validCodes = [...new Set(codes)].filter((code) => /^\d{6}$/.test(code));
  const quotes = {};
  for (let index = 0; index < validCodes.length; index += 150) {
    const part = validCodes.slice(index, index + 150);
    const url = `https://qt.gtimg.cn/q=${part.map(symbol).join(",")}`;
    const response = await publicFetch(url, 12000);
    if (!response.ok) throw new Error("持仓行情获取失败");
    const text = await response.text();
    for (const match of text.matchAll(/v_(sh|sz)(\d{6})="([^"]*)"/g)) {
      const fields = match[3].split("~");
      const actualDate = fields[30]?.slice(0, 8);
      if (actualDate !== date.replaceAll("-", "")) continue;
      const positive = (value) =>
        Number.isFinite(Number(value)) && Number(value) > 0
          ? toCents(value)
          : null;
      if (!positive(fields[3]) || !positive(fields[4])) continue;
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
        timestamp: fields[30],
      };
    }
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
