import { publicFetch } from "./public-fetch.js";
import { symbol, beijingDate } from "./review.js";
import { toCents } from "../domain/trading.js";
import { normalize, promotionStats, parseThemes } from "../../shared/scoring.js";
import { BENCHMARK_CODES } from "../../shared/benchmarks.js";
import { enrichWithIndustry } from "./industry.js";
import {
  batchRecordTagData,
  recordTagReturn,
  latestRecordedDateBefore,
} from "./tag-contribution.js";
import { getLimitUpPool as thsGetLimitUpPool } from "./fuyao.js";
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
// 合并东财涨停池与同花顺补全字段
// 策略: 东财优先且口径不变；同花顺只补东财没有的字段（涨停原因等），
// 拿不到同花顺数据时按纯东财数据返回，不降级也不报错。
// 排除北交所（920xxx 代码），保持沪深主板 + 创业板口径
function mergeLimitUpPools(emPool, thsPool) {
  if (!emPool || !Array.isArray(emPool) || emPool.length === 0) {
    return [];
  }

  // 过滤北交所股票
  const filteredEm = emPool.filter(r => !r.c?.startsWith("920"));

  // 建立同花顺数据索引
  const thsMap = new Map();
  if (thsPool && Array.isArray(thsPool)) {
    for (const r of thsPool) {
      if (r.ticker && !r.ticker.startsWith("920")) {
        thsMap.set(r.ticker, r);
      }
    }
  }

  // 合并数据
  return filteredEm.map(emRow => {
    const thsRow = thsMap.get(emRow.c);
    // 保留所有东财原始字段
    const merged = { ...emRow };
    // 同花顺独有字段（仅当同花顺数据可用时添加）
    if (thsRow) {
      merged.maxSealMoney = thsRow.max_seal_money; // 峰值封单金额
      merged.limitUpReason = thsRow.limit_up_reason; // 涨停原因
      merged.isSt = thsRow.is_st ?? false; // ST 标记
      merged.isNew = thsRow.is_new ?? false; // 新股标记
      merged._dataSource = "eastmoney";
      merged._thsSupplemented = true;
    }
    return merged;
  });
}

// 炸板池直接使用东财口径（zbc 已含炸板次数），不再依赖同花顺。
// 排除北交所（920xxx 代码），保持沪深主板 + 创业板口径
function mergeLimitBreakPools(emPool) {
  if (!emPool || !Array.isArray(emPool)) return [];
  return emPool.filter((r) => !r.c?.startsWith("920"));
}


// 同花顺只做字段补全，不参与主数据取舍：补全源超时/失败一律静默降级，
// 既不能拖慢东财行情返回，也不能把补全失败混进用户可见告警。
const THS_SUPPLEMENT_TIMEOUT_MS = 4000;

export async function marketData(date) {
  const hit = CACHE.get(date);
  if (hit && Date.now() - hit.time < 120000)
    return { ...hit.body, cached: true };

  // 东财优先：涨停池/炸板池/昨日涨停池的权威口径全部来自东财。
  // 同花顺涨停池并行拉取，仅补全东财缺失的字段（涨停原因、峰值封单等）。
  const [main, broken, yesterday, thsLimitUp] = await Promise.allSettled([
    getPool("getTopicZTPool", date),
    getPool("getTopicZBPool", date),
    getPool("getYesterdayZTPool", date),
    thsGetLimitUpPool(date, {
      timeoutMs: THS_SUPPLEMENT_TIMEOUT_MS,
      retries: 0,
    }),
  ]);

  if (main.status === "rejected") throw main.reason;

  const previousRows =
    yesterday.status === "fulfilled" && yesterday.value.pool.length
      ? yesterday.value.pool
      : null;

  const warnings = [];
  if (broken.status === "rejected") warnings.push("炸板池未返回，封板率暂缺。");
  if (!previousRows) warnings.push("昨日涨停池未返回有效样本，晋级率暂缺。");
  else if (
    promotionStats(
      main.value.pool.map(normalize),
      previousRows.map(normalize),
    ).promotion === null
  )
    warnings.push("昨日连板字段缺失或无效，晋级率暂缺。");

  // 同花顺补全失败只留服务端日志：东财主数据不依赖它，用户端不显示补全告警。
  if (thsLimitUp.status === "rejected")
    console.warn(
      `[market] 同花顺补全不可用，按东财数据继续：${thsLimitUp.reason?.message ?? thsLimitUp.reason}`,
    );

  // 合并涨停池数据（东财优先，同花顺补全）
  const mergedRows = mergeLimitUpPools(
    main.value.pool,
    thsLimitUp.status === "fulfilled" ? thsLimitUp.value.item : null,
  );
  const supplementedCount = mergedRows.filter(
    (r) => r._thsSupplemented,
  ).length;

  // 补充行业信息（从 QuanQuant stock.db）
  const enrichedRows = enrichWithIndustry(mergedRows);

  // 记录标签数据（用于标签贡献度计算）
  try {
    const tagRecords = [];
    for (const row of enrichedRows) {
      const tags = parseThemes(row.limitUpReason);
      for (const tag of tags) {
        tagRecords.push({
          code: row.c,
          name: row.n,
          tag: tag,
          nextDayReturn: null, // 次日收益待更新
        });
      }
    }
    if (tagRecords.length > 0) {
      batchRecordTagData(date, tagRecords);
    }
  } catch (err) {
    console.warn(`[market] 标签数据记录失败：${err.message}`);
  }

  // 更新上一交易日的标签次日收益：昨日涨停池行自带今日涨幅 zdp，
  // 直接用它作为次日收益，避免只统计“今天又涨停”的样本造成偏差。
  try {
    const previousDate = latestRecordedDateBefore(date);
    if (previousRows && previousDate) {
      for (const prevRow of previousRows) {
        const nextDayReturn = Number(prevRow?.zdp) / 100;
        if (!prevRow?.c || !Number.isFinite(nextDayReturn)) continue;
        recordTagReturn(previousDate, prevRow.c, nextDayReturn);
      }
    }
  } catch (err) {
    console.warn(`[market] 标签收益更新失败：${err.message}`);
  }

  // 炸板池直接使用东财口径
  const mergedBrokenRows = mergeLimitBreakPools(
    broken.status === "fulfilled" ? broken.value.pool : null,
  );

  const result = {
    date,
    source:
      supplementedCount > 0
        ? "东方财富公开行情（同花顺补全涨停原因）"
        : "东方财富公开行情",
    sourceUrl: "https://quote.eastmoney.com/ztb/detail",
    scope: "沪深主板、创业板；不含 ST、科创板、北交所及连续一字新股",
    fetchedAt: new Date().toISOString(),
    rows: enrichedRows,
    broken: mergedBrokenRows.length || null,
    // 炸板池原始行：出池持仓的炸板次数来源（方案 5 炸板不回封信号）；
    // broken 仅保留家数供封板率/展示，不丢个股记录。
    brokenRows: mergedBrokenRows.length > 0 ? mergedBrokenRows : null,
    previous: previousRows,
    previousLabel: "上一交易日",
    warnings,
    // 同花顺补全状态（仅用于服务端排查，主数据始终来自东财）
    thsData: {
      supplementedCount,
      available:
        thsLimitUp.status === "fulfilled" &&
        Array.isArray(thsLimitUp.value.item),
    },
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
