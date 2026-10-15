import test from "node:test";
import assert from "node:assert/strict";
import {
  computeMa5ByCode,
  getMa5ByCode,
} from "../backend/services/daily-closes.js";
import { analyze, normalize } from "../shared/scoring.js";

// 合成数据集：dates 全局交易日，perCode 为 [date, close, adjFactor?] 序列
function makeDataset(dates, perCode) {
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const codes = new Map();
  for (const [code, series] of perCode) {
    const n = series.length;
    const ds = new Uint32Array(n);
    const cs = new Float64Array(n);
    const as = new Float64Array(n).fill(Number.NaN);
    series.forEach(([d, c, a], k) => {
      ds[k] = dateIdx.get(d);
      cs[k] = c;
      if (a !== undefined) as[k] = a;
    });
    codes.set(code, { dates: ds, closes: cs, adjs: as });
  }
  return { dates, dateIdx, codes };
}

const DATES = ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-12", "2026-10-13", "2026-10-14"];

test("MA5：最近 5 个交易日（含 asOf）的收盘均值", () => {
  const dataset = makeDataset(DATES, [
    ["600001", DATES.map((d) => [d, 10, 1])],
  ]);
  const { ma5ByCode, asOf } = computeMa5ByCode(dataset, "2026-10-14");
  assert.equal(asOf, "2026-10-14");
  assert.equal(ma5ByCode.get("600001"), 10);
});

test("MA5：快照日早于数据末日时取 ≤ 快照日的窗口", () => {
  const dataset = makeDataset(DATES, [
    ["600001", DATES.map((d, i) => [d, 10 + i, 1])],
  ]);
  const { ma5ByCode, asOf } = computeMa5ByCode(dataset, "2026-10-10");
  assert.equal(asOf, "2026-10-10");
  // 窗口 D1..D3 只有 3 根 → 不足 5 根，不产出
  assert.equal(ma5ByCode.size, 0);
});

test("MA5：前复权——窗口内除权，因子对齐到 asOf", () => {
  // D4 除权：价格 10 → 5，因子 1 → 2。前复权到 D6 后全窗都是 5。
  const series = DATES.map((d, i) => [d, i < 3 ? 10 : 5, i < 3 ? 1 : 2]);
  const dataset = makeDataset(DATES, [["600001", series]]);
  const { ma5ByCode } = computeMa5ByCode(dataset, "2026-10-14");
  assert.equal(ma5ByCode.get("600001"), 5);
});

test("MA5：因子缺失时整窗退回未复权口径", () => {
  // 同上价格路径但无因子：未复权 MA5 = (10+10+5+5+5)/5 = 7
  const series = DATES.map((d, i) => [d, i < 3 ? 10 : 5]);
  const dataset = makeDataset(DATES, [["600001", series]]);
  const { ma5ByCode } = computeMa5ByCode(dataset, "2026-10-14");
  assert.equal(ma5ByCode.get("600001"), 7);
});

test("MA5：快照日无收盘（停牌）与不足 5 根 K 线的股票不产出", () => {
  const dataset = makeDataset(DATES, [
    ["600001", DATES.slice(0, 5).map((d) => [d, 10, 1])], // D6 停牌
    ["600002", DATES.slice(3).map((d) => [d, 10, 1])], // 仅 3 根
  ]);
  const { ma5ByCode } = computeMa5ByCode(dataset, "2026-10-14");
  assert.equal(ma5ByCode.size, 0);
});

test("MA5：快照日晚于数据（数据滞后）取最近可用交易日", () => {
  const dataset = makeDataset(DATES, [
    ["600001", DATES.map((d) => [d, 10, 1])],
  ]);
  const { ma5ByCode, asOf } = computeMa5ByCode(dataset, "2026-10-15");
  assert.equal(asOf, "2026-10-14");
  assert.equal(ma5ByCode.get("600001"), 10);
});

test("MA5：快照日早于数据起点时返回空", () => {
  const dataset = makeDataset(DATES, [
    ["600001", DATES.map((d) => [d, 10, 1])],
  ]);
  const { ma5ByCode, asOf } = computeMa5ByCode(dataset, "2026-01-01");
  assert.equal(asOf, null);
  assert.equal(ma5ByCode.size, 0);
});

// ---------- analyze() ma5 注入 ----------

const RAW = {
  c: "600001",
  n: "测试股",
  hybk: "测试板块",
  p: 9500,
  o: 10000,
  h: 10000,
  zdp: -3,
  amount: 1e8,
  ltsz: 1e9,
  fund: null,
  hs: 3,
  fbt: null,
  lbt: null,
  zbc: 0,
  lbc: 0,
  zttj: { days: 3, ct: 2 },
};
const PREV = {
  ...RAW,
  p: 9900,
  o: 9000,
  zdp: 9.9,
  lbc: 3, // 昨日 3 连板（首阴门槛与 skill 对齐：>=3）
};

test("analyze 注入 ma5ByCode（普通对象与 Map 皆可）", () => {
  const rows = [normalize(RAW)];
  const previous = [normalize(PREV)];
  const withObject = analyze(rows, null, previous, undefined, {
    ma5ByCode: { "600001": 9 },
  });
  assert.equal(withObject.stocks[0].ma5, 9);
  const withMap = analyze(rows, null, previous, undefined, {
    ma5ByCode: new Map([["600001", 9]]),
  });
  assert.equal(withMap.stocks[0].ma5, 9);
  const without = analyze(rows, null, previous);
  assert.equal(without.stocks[0].ma5, undefined);
});

test("MA5 注入后首阴买点在真实 analyze 链路激活（3 连板后首阴、未破 5 日线）", () => {
  const rows = [normalize(RAW)];
  const previous = [normalize(PREV)];
  const result = analyze(rows, null, previous, undefined, {
    ma5ByCode: { "600001": 9 },
  });
  assert.equal(result.stocks[0].buyPoint.primary?.type, "first-neg-dip");
  // MA5 未知 → 首阴拒绝（宁缺毋滥）
  const noMa5 = analyze(rows, null, previous);
  assert.notEqual(noMa5.stocks[0].buyPoint.primary?.type, "first-neg-dip");
});

// ---------- 优雅降级 ----------

test("未配置 QUAN_DATA_DIR 时返回空 Map 并说明原因", async () => {
  const saved = process.env.QUAN_DATA_DIR;
  delete process.env.QUAN_DATA_DIR;
  try {
    const result = await getMa5ByCode({}, "2026-10-14");
    assert.equal(result.ma5ByCode.size, 0);
    assert.equal(result.asOf, null);
    assert.match(result.reason, /QUAN_DATA_DIR/);
  } finally {
    if (saved !== undefined) process.env.QUAN_DATA_DIR = saved;
  }
});

test("数据目录存在时烟雾测试（读取真实 parquet）", async (t) => {
  const dir = process.env.QUAN_DATA_DIR;
  if (!dir) return t.skip("未配置 QUAN_DATA_DIR，跳过真实数据烟雾测试");
  const result = await getMa5ByCode({ QUAN_DATA_DIR: dir }, "2026-10-13");
  assert.ok(result.ma5ByCode.size > 0, `应产出 MA5：${result.reason ?? ""}`);
  assert.ok(result.asOf, "应解析出 asOf 交易日");
  // 平安银行 000001 长期在市，必有 MA5
  const ma5 = result.ma5ByCode.get("000001");
  assert.ok(Number.isFinite(ma5) && ma5 > 0, `000001 应有有限 MA5，实际 ${ma5}`);
});
