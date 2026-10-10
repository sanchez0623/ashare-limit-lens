import { publicFetch } from "./public-fetch.js";
import { symbol } from "./review.js";
import { toCents } from "../domain/trading.js";
import { getPool, minuteBars } from "./market.js";
import {
  mergeSegmentedDates,
  sanitizeMinuteSeries,
} from "../domain/historical-input.js";

const KLINE_MAX_ROWS = 80;
const KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
function prevDay(date) {
  return addDays(date, -1);
}

async function fetchKlineWindow(symbolCode, start, end, rows) {
  const url = new URL(KLINE_URL);
  url.searchParams.set(
    "param",
    `${symbolCode},day,${start},${end},${rows},qfq`,
  );
  const response = await publicFetch(url, 12000);
  if (!response.ok) throw new Error(`历史日线请求失败 HTTP ${response.status}`);
  const body = await response.json();
  const item = body.data?.[symbolCode];
  if (!item) throw new Error(`历史日线缺少 ${symbolCode} 数据`);
  const list = item.day || item.qfqday || [];
  return list
    .map((row) => ({
      date: row[0],
      openYuan: Number(row[1]),
      closeYuan: Number(row[2]),
      highYuan: Number(row[3]),
      lowYuan: Number(row[4]),
      volumeHands: Number(row[5]),
    }))
    .filter((row) => row.date >= start && row.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function createTencentHistoricalProvider(options = {}) {
  const maxRows = options.maxRows ?? KLINE_MAX_ROWS;
  return {
    id: "tencent-free",
    providerSchemaVersion: "tencent-v1",
    taxonomyId: "东财行业分类（近期）/未分类（历史日线）",
    notes: [
      "腾讯日线接口按窗口返回，最多约 80 条；超过范围需分段回溯",
      "东方财富涨停池仅保证近期日期；历史日期会被来源日期校验拒绝",
      "腾讯分时数据仅覆盖近期交易日，且存在时段外记录，需隔离",
    ],
    async capabilities({ start, end }) {
      const probe = {
        provider: "tencent-free",
        probedAt: new Date().toISOString(),
        requestedRange: { start, end },
        limitFeatures: { available: null, availableFrom: null, rejections: [] },
        dailyPrices: { available: null, observedFrom: null, observedTo: null },
        minuteBars: { recentOnly: true, notes: "仅近期交易日，存在时段外记录" },
        notes: this.notes,
      };
      const mid = addDays(
        start,
        Math.floor((Date.parse(end) - Date.parse(start)) / 86400000 / 2),
      );
      for (const date of [end, mid, start]) {
        try {
          await this.limitFeatures({ date });
          if (
            probe.limitFeatures.availableFrom === null ||
            date < probe.limitFeatures.availableFrom
          )
            probe.limitFeatures.availableFrom = date;
          probe.limitFeatures.available = true;
        } catch (error) {
          probe.limitFeatures.rejections.push({
            date,
            reason: String(error.message ?? error).slice(0, 120),
          });
        }
      }
      if (probe.limitFeatures.availableFrom !== null)
        probe.limitFeatures.available = true;
      try {
        const calendar = await this.tradingCalendar({ start, end });
        probe.dailyPrices.available = calendar.dates.length > 0;
        probe.dailyPrices.observedFrom = calendar.dates[0] ?? null;
        probe.dailyPrices.observedTo = calendar.dates.at(-1) ?? null;
        probe.dailyPrices.segmentCount = calendar.segments.length;
        probe.dailyPrices.coverageIssues = calendar.issues;
      } catch (error) {
        probe.dailyPrices.available = false;
        probe.dailyPrices.reason = String(error.message ?? error).slice(0, 120);
      }
      return probe;
    },
    async tradingCalendar({ start, end }) {
      const segments = [];
      let cursor = end;
      const dates = new Set();
      let guard = 0;
      while (cursor >= start && guard < 60) {
        guard++;
        const windowStart = addDays(cursor, -(maxRows * 2));
        const rows = await fetchKlineWindow(
          "sh000001",
          windowStart,
          cursor,
          maxRows,
        );
        const inRange = rows.filter((row) => row.date >= start);
        const segment = {
          requestRange: `${windowStart}..${cursor}`,
          actualRange: inRange.length
            ? `${inRange[0].date}..${inRange.at(-1).date}`
            : null,
          rows: inRange.length,
          dates: inRange.map((row) => row.date),
        };
        segments.push(segment);
        for (const row of inRange) dates.add(row.date);
        const earliest = rows.length ? rows[0].date : null;
        if (!earliest || earliest <= start) break;
        if (rows.length < maxRows) break;
        cursor = prevDay(earliest);
      }
      const merged = mergeSegmentedDates(segments, { start, end });
      return {
        dates: merged.dates,
        segments,
        issues: merged.issues,
        complete: merged.issues.length === 0,
      };
    },
    async dailyPrices({ codes, start, end }) {
      const results = {};
      const segments = [];
      for (const code of codes) {
        const symbolCode = symbol(code);
        const rows = [];
        const codeSegments = [];
        let cursor = end;
        let guard = 0;
        while (cursor >= start && guard < 60) {
          guard++;
          const windowStart = addDays(cursor, -(maxRows * 2));
          const window = await fetchKlineWindow(
            symbolCode,
            windowStart,
            cursor,
            maxRows,
          );
          const inRange = window.filter((row) => row.date >= start);
          codeSegments.push({
            requestRange: `${windowStart}..${cursor}`,
            actualRange: inRange.length
              ? `${inRange[0].date}..${inRange.at(-1).date}`
              : null,
            rows: inRange.length,
          });
          for (const row of inRange)
            rows.push({
              code,
              tradeDate: row.date,
              openYuan: row.openYuan,
              closeYuan: row.closeYuan,
              highYuan: row.highYuan,
              lowYuan: row.lowYuan,
              volumeShares: Math.round(row.volumeHands * 100),
            });
          const earliest = window.length ? window[0].date : null;
          if (!earliest || earliest <= start) break;
          if (window.length < maxRows) break;
          cursor = prevDay(earliest);
        }
        const seen = new Set();
        rows.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
        const deduped = rows.filter((row) => {
          if (seen.has(row.tradeDate)) return false;
          seen.add(row.tradeDate);
          return true;
        });
        results[code] = deduped;
        segments.push({ code, segments: codeSegments, rows: deduped.length });
      }
      return {
        rows: results,
        segments,
        adjustment: "QFQ",
        adjustmentNote:
          "腾讯日线使用前复权（QFQ）价格：适合观察研究特征；历史数值会随未来除权修订，不能直接代入未复权资金账本",
      };
    },
    async limitFeatures({ date }) {
      const [main, broken] = await Promise.allSettled([
        getPool("getTopicZTPool", date),
        getPool("getTopicZBPool", date),
      ]);
      if (main.status === "rejected") throw main.reason;
      return {
        date,
        rows: main.value.pool,
        broken: broken.status === "fulfilled" ? broken.value.pool.length : null,
        sourceDate: main.value.sourceDate,
        fetchedAt: new Date().toISOString(),
      };
    },
    async minuteSeries({ code, date }) {
      const bars = await minuteBars(code, date);
      return sanitizeMinuteSeries(bars, date);
    },
  };
}
