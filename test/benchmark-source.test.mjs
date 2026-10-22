import test from "node:test";
import assert from "node:assert/strict";
import {
  tradingCalendar,
  indexDailyCloses,
} from "../backend/services/market.js";

// 回归：账户收益曲线的基准必须始终取自账户所选指数。
// 历史缺陷：所选指数（沪深300）行情取不到时静默换成上证指数，基准价被锚在
// 上证 3813.79 的收盘上，而真实沪深300 首日是 4317.25——一条 -4.7% 的下跌
// 行情因此整条曲线显示成 +7.8%～+12.1%。
// 现在：腾讯主源不可用时用新浪补取同一指数；两条源都不可用时交回空基准，
// 绝不跨指数。
//
// 说明：备源有 5 分钟进程内缓存（按代码键控），四个用例各用不同指数代码
// 以避免用例之间串缓存；各用例的指数行都是同一组合成数据，只用于验证
// 取数路径与口径，不验证真实数值。
const ROWS = [
  ["2026-10-09", 4317.25],
  ["2026-10-12", 4287.98],
  ["2026-10-13", 4275.68],
  ["2026-10-14", 4217.68],
  ["2026-10-15", 4166.01],
  ["2026-10-16", 4170.61],
  ["2026-10-19", 4174.54],
  ["2026-10-20", 4151.69],
  ["2026-10-21", 4111.88],
];
// 交易日历固定的上证指数：数值与 ROWS 刻意不同，用于证明基准没有串指数。
const CALENDAR_ROWS = [
  ["2026-10-09", 3813.79],
  ["2026-10-12", 3797.24],
  ["2026-10-13", 3800.86],
  ["2026-10-14", 3767.23],
  ["2026-10-15", 3707.48],
  ["2026-10-16", 3716.28],
  ["2026-10-19", 3730.92],
  ["2026-10-20", 3718.44],
  ["2026-10-21", 3701.25],
];
const cents = (rows) =>
  rows.map(([date, close]) => [date, Math.round(close * 100)]);
const tencentBody = (code, rows) => ({
  data: {
    [code]: {
      day: rows.map(([date, close]) => [
        date,
        close,
        close,
        close,
        close,
        1000,
      ]),
    },
  },
});
const sinaBody = (rows) =>
  rows.map(([date, close]) => ({
    day: date,
    open: String(close),
    high: String(close),
    low: String(close),
    close: String(close),
    volume: "1000",
  }));

function installFetch({ tencent = {}, sina = "OK" } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    const code = (target.match(/[?&](?:param|symbol)=(\w{8})/) || [])[1];
    if (target.includes("ifzq.gtimg.cn")) {
      calls.push(`tencent:${code}`);
      const body = tencent[code];
      if (body === undefined) throw new Error("synthetic tencent unavailable");
      return Response.json(body);
    }
    if (target.includes("money.finance.sina.com.cn")) {
      calls.push(`sina:${code}`);
      if (sina === "OK") return Response.json(sinaBody(ROWS));
      if (sina === "STALE") return Response.json(sinaBody(ROWS.slice(0, -1)));
      throw new Error("synthetic sina unavailable");
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("腾讯主源不可用时用新浪补取同一指数，绝不换成上证指数", async () => {
  const fake = installFetch({
    tencent: { sh000001: tencentBody("sh000001", CALENDAR_ROWS) },
    sina: "OK",
  });
  try {
    const calendar = await tradingCalendar(
      "2026-10-09",
      "2026-10-21",
      "sh000300",
    );
    assert.equal(calendar.benchmarkCode, "sh000300");
    assert.deepEqual(
      calendar.benchmark.map((row) => [row.date, row.closeCents]),
      cents(ROWS),
      "基准曲线必须是所选指数（沪深300）的收盘，不能是上证指数",
    );
    assert.ok(
      !calendar.benchmark.some((row) => row.closeCents === 381379),
      "基准曲线里不得出现上证指数的收盘",
    );
    assert.equal(
      calendar.dates.length,
      CALENDAR_ROWS.length,
      "交易日历仍应来自上证指数",
    );
    assert.ok(
      fake.calls.includes("sina:sh000300"),
      "主源失败后应请求新浪的同一指数备源",
    );
  } finally {
    fake.restore();
  }
});

test("两条源都不可用时交回空基准与空代码，绝不拿上证指数冒充", async () => {
  const fake = installFetch({
    tencent: { sh000001: tencentBody("sh000001", CALENDAR_ROWS) },
    sina: "DOWN",
  });
  try {
    const calendar = await tradingCalendar(
      "2026-10-09",
      "2026-10-21",
      "sh000905",
    );
    assert.deepEqual(calendar.benchmark, [], "所选指数取不到时必须交回空基准");
    assert.equal(calendar.benchmarkCode, null, "基准代码必须显式交空");
    assert.equal(
      calendar.dates.length,
      CALENDAR_ROWS.length,
      "交易日历仍应来自上证指数，不受基准缺失影响",
    );
  } finally {
    fake.restore();
  }
});

test("indexDailyCloses 走同一指数备源，返回所选指数收盘且严格裁剪区间", async () => {
  const fake = installFetch({ tencent: {}, sina: "OK" });
  try {
    const closes = await indexDailyCloses(
      "sh000852",
      "2026-10-13",
      "2026-10-21",
    );
    assert.equal(closes.get("2026-10-13"), 427568);
    assert.equal(closes.get("2026-10-21"), 411188);
    assert.equal(closes.size, 7, "只保留请求区间内的交易日");
    assert.equal(closes.get("2026-10-09"), undefined, "区间外日期不得进入结果");
  } finally {
    fake.restore();
  }
});

test("备源当日 K 线尚未落库时不冒充当日收盘，按行情不可用处理", async () => {
  const fake = installFetch({ tencent: {}, sina: "STALE" });
  try {
    await assert.rejects(
      () => indexDailyCloses("sz399001", "2026-10-20", "2026-10-21"),
      /行情暂不可用/,
    );
  } finally {
    fake.restore();
  }
});
