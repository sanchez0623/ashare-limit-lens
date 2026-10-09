import test from "node:test";
import assert from "node:assert/strict";
import {
  normalize,
  analyze,
  analyzeStock,
  PRESETS,
} from "../shared/scoring.js";
import { correlation, evaluateSnapshot } from "../backend/services/review.js";
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
test("单位转换正确，缺失指标重新归一化而非当零分", () => {
  const row = normalize(base);
  assert.equal(row.price, 10);
  assert.equal(analyzeStock(row, 100).score, 99);
  const missing = analyzeStock(normalize({ ...base, fund: null }), 100);
  assert.equal(missing.coverage, 80);
  assert.equal(missing.factors.find((f) => f.key === "capital").value, null);
  assert.ok(missing.score >= 98);
});
test("涨停与炸板分母一致，ST个股剔除并保留说明", () => {
  const result = analyze(
    [normalize(base), normalize({ ...base, c: "002002", n: "ST测试" })],
    1,
  );
  assert.equal(result.count, 1);
  assert.equal(result.excluded, 1);
  assert.ok(Math.abs(result.sealRate - 200 / 3) < 0.01);
  assert.equal(analyze([normalize(base)], null).sealRate, null);
});
test("多项风险扣分最多20分，不能将一字封板当成易成交", () => {
  const row = normalize({ ...base, lbc: 6, hs: 45, zbc: 4, lbt: 145500 });
  const r = analyzeStock(row, 90);
  assert.equal(r.deduction, 20);
  assert.ok(r.risks.some((x) => x.text === "高位连板"));
  assert.ok(r.score >= 0 && r.score <= 100);
});
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
