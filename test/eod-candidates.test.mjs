import test from "node:test";
import assert from "node:assert/strict";
import { buildEodCandidates } from "../backend/services/eod-candidates.js";
import { computeEodRowsWithPrev } from "../backend/services/daily-closes.js";
import { analyze, normalize, PRESETS } from "../shared/scoring.js";
import { BUY_POINT_TYPES } from "../shared/buy-point-type.js";
import { selectionSnapshotDigest } from "../backend/domain/signal-selection.js";

const firstNeg = {
  close: 10.5,
  open: 10.8,
  high: 10.9,
  change: -3,
  prevClose: 10.82,
  prevOpen: null,
  prevChange: 10,
  prevBreaks: null,
  limitUpPct: 10,
};
const fakeNeg = {
  close: 9.4,
  open: 9,
  high: 9.5,
  change: -6,
  prevClose: 10,
  prevOpen: 10.9,
  prevChange: 0,
  prevBreaks: 1,
  limitUpPct: 10,
};

test("EOD 候选到评分链路：首阴及假阴买点保留昨日字段，且不改变市场统计", async () => {
  const previous = [
    { code: "600003", name: "合成首阴", sector: "测试行业", height: 3 },
  ];
  const eodRows = new Map([
    ["600003", firstNeg],
    ["600004", fakeNeg],
  ]);
  const ma5ByCode = new Map([
    ["600003", 10],
    ["600004", 9.5],
  ]);
  const extraCandidates = buildEodCandidates({
    previous,
    eodRows,
    ma5ByCode,
    stockInfoByCode: new Map([
      ["600004", { name: "合成假阴", industryName: "测试行业" }],
    ]),
    firstNegMinPrevHeight: 3,
  });
  assert.equal(extraCandidates.length, 2);
  const main = [
    normalize({
      c: "600001",
      n: "合成涨停",
      p: 11000,
      zdp: 10,
      lbc: 1,
      hybk: "测试行业",
      hs: 5,
      fbt: 93000,
    }),
  ];
  const base = analyze(main, 0, previous, PRESETS.balanced);
  const actual = analyze(main, 0, previous, PRESETS.balanced, {
    extraCandidates,
    ma5ByCode,
    prevEodByCode: eodRows,
  });
  assert.ok(
    actual.extraStocks
      .find((s) => s.code === "600003")
      .buyPoint.labels.includes(BUY_POINT_TYPES.FIRST_NEG_DIP),
  );
  assert.ok(
    actual.extraStocks
      .find((s) => s.code === "600004")
      .buyPoint.labels.includes(BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP),
  );
  assert.deepEqual(actual.stocks, base.stocks);
  assert.deepEqual(actual.sectors, base.sectors);
  assert.deepEqual(actual.emotion, base.emotion);
  const snapshot = {
    stocks: actual.stocks,
    sectors: actual.sectors,
    extraStocks: actual.extraStocks,
  };
  const original = await selectionSnapshotDigest(snapshot);
  assert.equal(
    await selectionSnapshotDigest({
      ...snapshot,
      extraStocks: [...snapshot.extraStocks].reverse(),
    }),
    original,
  );
  const changed = structuredClone(snapshot);
  changed.extraStocks[0].buyPoint.labels = [];
  assert.notEqual(await selectionSnapshotDigest(changed), original);
});

test("EOD 候选拒绝无买点、未知身份、ST、科创板及已在其他候选池的股票", () => {
  const eodRows = new Map([
    ["600003", { ...firstNeg, change: -6 }],
    ["600004", fakeNeg],
    ["600005", fakeNeg],
    ["688001", fakeNeg],
    ["600006", fakeNeg],
    ["600007", { ...fakeNeg, prevBreaks: null }],
  ]);
  const extra = buildEodCandidates({
    previous: [
      { code: "600003", name: "首阴过深", sector: "测试行业", height: 3 },
    ],
    eodRows,
    ma5ByCode: new Map([["600003", 10]]),
    existingCodes: new Set(["600006"]),
    stockInfoByCode: new Map([
      ["600005", { name: "ST样本", industryName: "测试行业" }],
      ["688001", { name: "科创样本", industryName: "测试行业" }],
      ["600006", { name: "重复样本", industryName: "测试行业" }],
      ["600007", { name: "未触板样本", industryName: "测试行业" }],
    ]),
    firstNegMinPrevHeight: 3,
  });
  assert.deepEqual(extra, []);
});

test("EOD 日线读取限制在快照日，近涨停不冒充触板，停牌及缺复权因子不补造", () => {
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"];
  const series = (high) => ({
    dates: [0, 1, 2, 3],
    closes: [10, 10, 9.4, 99],
    opens: [10, 10.9, 9, 99],
    highs: [10, high, 9.5, 99],
    volumes: [100, 100, 100, 100],
    hasFactor: false,
  });
  const dataset = {
    dates,
    dateIdx: new Map(dates.map((d, i) => [d, i])),
    codes: new Map([
      ["600001", series(11)],
      ["600002", series(10.9)],
      ["600003", { ...series(11), dates: [0, 2, 3] }],
      ["600004", { ...series(11), hasFactor: true, adjs: [1, 1, NaN, 1] }],
    ]),
  };
  const { rowsByCode, asOf } = computeEodRowsWithPrev(dataset, "2026-10-21");
  assert.equal(asOf, "2026-10-21");
  assert.equal(rowsByCode.get("600001").close, 9.4);
  assert.equal(rowsByCode.get("600001").prevBreaks, 1);
  assert.equal(rowsByCode.get("600002").prevBreaks, null);
  assert.equal(rowsByCode.has("600003"), false);
  assert.equal(rowsByCode.has("600004"), false);
  assert.equal(
    computeEodRowsWithPrev(dataset, "2026-10-23").rowsByCode.size,
    0,
  );
});
