import test from "node:test";
import assert from "node:assert/strict";
import {
  normalize,
  analyze,
  analyzeStock,
  PRESETS,
} from "../shared/scoring.js";
import { BUY_POINT_TYPES } from "../shared/buy-point-type.js";
import {
  correlation,
  evaluateSnapshot,
  parseModelJson,
  reviewHistorySummary,
} from "../backend/services/review.js";
const base = {
  c: "002001",
  n: "测试股份",
  p: 10000,
  hybk: "测试行业",
  amount: 1e8,
  fund: 1e7,
  hs: 8,
  fbt: 93500,
  lbt: 93500,
  zbc: 0,
  lbc: 2,
};

test("Spearman相关支持并列值，常数序列返回不可评价", () => {
  assert.equal(correlation([1, 2, 3], [5, 6, 7]), 1);
  assert.equal(correlation([1, 2, 3], [7, 6, 5]), -1);
  assert.equal(correlation([1, 1, 1], [3, 2, 1]), null);
  assert.equal(correlation([1, 1, 3], [2, 2, 9]), 1);
});
test("事前样本固定，错日与除权行情剔除，不把缺失当作收益0", () => {
  const stocks = Array.from({ length: 15 }, (_, i) => ({
    ...normalize({ ...base, c: String(i), n: `样本${i}` }),
    score: 100 - i,
  }));
  const snapshot = {
    date: "2026-10-08",
    stocks,
    sectors: [{ name: "测试行业", score: 80, count: 15 }],
    weights: PRESETS.balanced,
  };
  const quotes = new Map(
    stocks.map((s, i) => [
      s.code,
      {
        date: "20261009",
        previousClose: 10,
        close: 11 - i * 0.05,
        open: 10.2,
        low: 9.8,
        high: 11.2,
      },
    ]),
  );
  let r = evaluateSnapshot(snapshot, quotes, [{ c: "0" }], "2026-10-09");
  assert.equal(r.topSize, 3);
  assert.ok(r.excess > 0);
  assert.equal(r.rho, 1);
  assert.ok(r.systemScore > 50);
  assert.equal(r.rows[0].score, 100);
  quotes.get("0").date = "20261008";
  quotes.get("1").previousClose = 9;
  r = evaluateSnapshot(snapshot, quotes, [], "2026-10-09");
  assert.equal(r.validCount, 13);
  assert.equal(r.rows[0].available, false);
  assert.equal(r.rows[1].available, false);
  assert.equal(r.systemScore, null);
});
test("少量样本仅展示结果，不伪造系统评价分", () => {
  const snapshot = {
    date: "2026-10-08",
    stocks: [{ ...normalize(base), score: 90 }],
    sectors: [],
    weights: PRESETS.balanced,
  };
  const quotes = new Map([
    [
      "002001",
      {
        date: "20261009",
        previousClose: 10,
        close: 10.5,
        open: 10.1,
        low: 9.9,
        high: 10.6,
      },
    ],
  ]);
  const r = evaluateSnapshot(snapshot, quotes, [], "2026-10-09");
  assert.equal(r.systemScore, null);
  assert.ok(Math.abs(r.topMean - 5) < 0.0001);
});

test("评价历史摘要只提取客观指标，损坏记录跳过", () => {
  const rows = [
    {
      trade_date: "2026-10-09",
      payload: JSON.stringify({
        systemScore: 62,
        rho: 0.2,
        excess: 0.5,
        topContinue: 0.3,
        baseContinue: 0.25,
        coverage: 0.9,
        validCount: 50,
        summary: "不应出现在摘要中",
      }),
    },
    { trade_date: "2026-10-10", payload: "{损坏的JSON" },
  ];
  const s = reviewHistorySummary(rows);
  assert.equal(s.length, 1);
  assert.equal(s[0].date, "2026-10-09");
  assert.equal(s[0].systemScore, 62);
  assert.equal(s[0].rankingCorrelation, 0.2);
  assert.equal(s[0].summary, undefined);
});
