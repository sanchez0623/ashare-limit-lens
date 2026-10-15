import test from "node:test";
import assert from "node:assert/strict";
import {
  checkExitSignals,
  sectorLimitUpDrops,
  EXIT_SIGNALS,
} from "../shared/exit-signals.js";

const position = { code: "000001", sector: "银行" };

test("放量滞涨：量超1.5倍均量且涨幅<2%", () => {
  const result = checkExitSignals(position, {
    row: {
      change: 1.2,
      close: 10,
      high: 10.1,
      open: 9.9,
      isLimitUp: false,
      breaks: 0,
    },
    features: { todayVolume: 300, vol20Avg: 100, ma5: 9, high20Prev: 8 },
  });
  assert.ok(result.exit);
  assert.ok(result.signals.some((s) => s.type === EXIT_SIGNALS.VOLUME_STALL));
});

test("放量滞涨：量达标但涨幅≥2% 不触发", () => {
  const result = checkExitSignals(position, {
    row: {
      change: 3.5,
      close: 10,
      high: 10.1,
      open: 9.9,
      isLimitUp: false,
      breaks: 0,
    },
    features: { todayVolume: 300, vol20Avg: 100, ma5: 9, high20Prev: 8 },
  });
  assert.ok(!result.signals.some((s) => s.type === EXIT_SIGNALS.VOLUME_STALL));
});

test("放量滞涨：量/均量特征缺失时跳过，不猜", () => {
  const result = checkExitSignals(position, {
    row: {
      change: 1.0,
      close: 10,
      high: 10.1,
      open: 9.9,
      isLimitUp: false,
      breaks: 0,
    },
    features: null,
  });
  assert.ok(!result.signals.some((s) => s.type === EXIT_SIGNALS.VOLUME_STALL));
});

test("炸板不回封：炸板≥2次且收盘未封涨停", () => {
  const result = checkExitSignals(position, {
    row: {
      change: 5,
      close: 10,
      high: 10.5,
      open: 9.8,
      isLimitUp: false,
      breaks: 3,
    },
    features: null,
  });
  assert.ok(
    result.signals.some((s) => s.type === EXIT_SIGNALS.BROKEN_NO_RESEAL),
  );
});

test("炸板不回封：炸板1次或收盘封板均不触发", () => {
  const fewBreaks = checkExitSignals(position, {
    row: {
      change: 5,
      close: 10,
      high: 10.5,
      open: 9.8,
      isLimitUp: false,
      breaks: 1,
    },
    features: null,
  });
  const sealed = checkExitSignals(position, {
    row: {
      change: 10,
      close: 11,
      high: 11,
      open: 10,
      isLimitUp: true,
      breaks: 3,
    },
    features: null,
  });
  assert.ok(
    !fewBreaks.signals.some((s) => s.type === EXIT_SIGNALS.BROKEN_NO_RESEAL),
  );
  assert.ok(
    !sealed.signals.some((s) => s.type === EXIT_SIGNALS.BROKEN_NO_RESEAL),
  );
});

test("跌破5日均线：收盘 < MA5", () => {
  const result = checkExitSignals(position, {
    row: {
      change: -2,
      close: 9.5,
      high: 9.8,
      open: 9.9,
      isLimitUp: false,
      breaks: 0,
    },
    features: { ma5: 10 },
  });
  assert.ok(result.signals.some((s) => s.type === EXIT_SIGNALS.BELOW_MA5));
});

test("跌破5日均线：收盘在MA5上方不触发", () => {
  const result = checkExitSignals(position, {
    row: {
      change: 1,
      close: 10.2,
      high: 10.3,
      open: 10,
      isLimitUp: false,
      breaks: 0,
    },
    features: { ma5: 10 },
  });
  assert.ok(!result.signals.some((s) => s.type === EXIT_SIGNALS.BELOW_MA5));
});

test("高位长上影：20日新高且上影>3%", () => {
  const result = checkExitSignals(position, {
    // high=11, open=10, close=10 → (11-10)/10 = 10% > 3%，close 10 >= 前19根最高 9.5
    row: {
      change: 0,
      close: 10,
      high: 11,
      open: 10,
      isLimitUp: false,
      breaks: 0,
    },
    features: { high20Prev: 9.5 },
  });
  assert.ok(
    result.signals.some((s) => s.type === EXIT_SIGNALS.HIGH_UPPER_SHADOW),
  );
});

test("高位长上影：未创20日新高或上影不足均不触发", () => {
  const notNewHigh = checkExitSignals(position, {
    row: {
      change: 0,
      close: 10,
      high: 11,
      open: 10,
      isLimitUp: false,
      breaks: 0,
    },
    features: { high20Prev: 10.5 },
  });
  const smallShadow = checkExitSignals(position, {
    row: {
      change: 0,
      close: 10,
      high: 10.2,
      open: 10,
      isLimitUp: false,
      breaks: 0,
    },
    features: { high20Prev: 9.5 },
  });
  assert.ok(
    !notNewHigh.signals.some((s) => s.type === EXIT_SIGNALS.HIGH_UPPER_SHADOW),
  );
  assert.ok(
    !smallShadow.signals.some((s) => s.type === EXIT_SIGNALS.HIGH_UPPER_SHADOW),
  );
});

test("板块退潮与情绪切换：由调用方传入布尔", () => {
  const result = checkExitSignals(position, {
    row: null,
    sectorLimitDrop: true,
    phaseShift: true,
  });
  assert.ok(result.exit);
  assert.ok(result.signals.some((s) => s.type === EXIT_SIGNALS.SECTOR_EBB));
  assert.ok(result.signals.some((s) => s.type === EXIT_SIGNALS.PHASE_SHIFT));
  assert.match(result.reason, /；/);
});

test("全部上下文缺失 → 不产生任何卖出信号", () => {
  const result = checkExitSignals(position, { row: null, features: null });
  assert.equal(result.exit, false);
  assert.equal(result.signals.length, 0);
  assert.equal(result.reason, "");
});

test("sectorLimitUpDrops：同板块涨停数降幅≥50%", () => {
  const today = [
    { sector: "银行", height: 1 },
    { sector: "券商", height: 2 },
  ];
  const previous = [
    { hybk: "银行", lbc: 1 },
    { hybk: "券商", lbc: 1 },
  ];
  const drops = sectorLimitUpDrops(today, previous);
  // 银行：昨日1 → 今日1（无降幅）；券商：昨日1 → 今日1；
  // 构造退潮：昨日4家银行，今日1家 → 降幅75%
  const drops2 = sectorLimitUpDrops(
    [{ sector: "银行", height: 1 }],
    [
      { hybk: "银行", lbc: 1 },
      { hybk: "银行", lbc: 1 },
      { hybk: "银行", lbc: 1 },
      { hybk: "银行", lbc: 1 },
    ],
  );
  assert.equal(drops.get("银行"), undefined);
  assert.equal(drops2.get("银行"), true);
});

test("sectorLimitUpDrops：昨日无数据返回空Map；今日清零也算退潮", () => {
  assert.equal(sectorLimitUpDrops([], []).size, 0);
  const drops = sectorLimitUpDrops(
    [],
    [
      { hybk: "银行", lbc: 2 },
      { hybk: "银行", lbc: 2 },
    ],
  );
  assert.equal(drops.get("银行"), true);
});

test("sectorLimitUpDrops：昨日字段优先读 ylbc，回退 lbc（修复字段错位漏判）", () => {
  // 昨日 4 家银行（ylbc=1），今日 1 家 → 降幅 75%，应触发退潮。
  // 此前只统计 lbc 会读到 0（旧字段为空），昨日家数被误判为 0。
  const dropsY = sectorLimitUpDrops(
    [{ sector: "银行", height: 1 }],
    [
      { hybk: "银行", ylbc: 1 },
      { hybk: "银行", ylbc: 1 },
      { hybk: "银行", ylbc: 1 },
      { hybk: "银行", ylbc: 1 },
    ],
  );
  assert.equal(dropsY.get("银行"), true);
  // ylbc 缺失时回退 lbc。
  const dropsFallback = sectorLimitUpDrops(
    [{ sector: "银行", height: 1 }],
    [
      { hybk: "银行", lbc: 1 },
      { hybk: "银行", lbc: 1 },
      { hybk: "银行", lbc: 1 },
      { hybk: "银行", lbc: 1 },
    ],
  );
  assert.equal(dropsFallback.get("银行"), true);
  // ylbc=0（昨日无板）但 lbc=1（旧口径残留）时，按字段优先：ylbc 取到 0
  // 后短路（0 是 falsy），立即回退 lbc=1 → 仍算退潮；这与"ylbc 优先"语义
  // 一致（ylbc 字段存在但值为 0 时，旧口径 lbc 才有参考价值）。
  const dropsYlbcsZero = sectorLimitUpDrops(
    [{ sector: "银行", height: 1 }],
    [
      { hybk: "银行", ylbc: 0, lbc: 1 },
      { hybk: "银行", ylbc: 0, lbc: 1 },
      { hybk: "银行", ylbc: 0, lbc: 1 },
      { hybk: "银行", ylbc: 0, lbc: 1 },
    ],
  );
  assert.equal(dropsYlbcsZero.get("银行"), true);
});
