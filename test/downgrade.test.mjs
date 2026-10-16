import test from "node:test";
import assert from "node:assert/strict";
import {
  detectDowngradeForPosition,
  detectPositionDowngrades,
  DOWNGRADE_CHAIN,
  CLASS_MANAGEMENT,
  FOLLOWER_LAG_RATIO,
  STALL_TURNOVER,
  STALL_MAX_CHANGE,
} from "../shared/downgrade.js";
import { STOCK_CLASSES } from "../shared/stock-class.js";

const TODAY = "2026-10-15";
const RELAY = STOCK_CLASSES.RELAY_LEADER;
const REVERSAL = STOCK_CLASSES.STRONG_REVERSAL;
const SWING = STOCK_CLASSES.SWING_RANGE;

// 板块池行（normalize 后形状）：同板块两只涨停股 + 自身
const poolRows = [
  {
    code: "600099",
    sector: "测试行业",
    height: 3,
    change: 10.02,
    turnover: 12,
    breaks: 0,
  },
  {
    code: "600100",
    sector: "测试行业",
    height: 2,
    change: 10.01,
    turnover: 10,
    breaks: 1,
  },
  {
    code: "300200",
    sector: "其他板块",
    height: 5,
    change: 19.9,
    turnover: 20,
    breaks: 0,
  },
];

test("降级链与降级后管理参数（skill 对齐）", () => {
  assert.deepEqual(DOWNGRADE_CHAIN, {
    [RELAY]: REVERSAL,
    [REVERSAL]: SWING,
  });
  assert.equal(CLASS_MANAGEMENT[RELAY].targetScale, 1);
  assert.equal(CLASS_MANAGEMENT[REVERSAL].targetScale, 0.7);
  assert.equal(CLASS_MANAGEMENT[REVERSAL].takeProfitCap, 0.1);
  assert.equal(CLASS_MANAGEMENT[SWING].targetScale, 0.5);
  assert.equal(CLASS_MANAGEMENT[SWING].maxHoldDays, 2);
  assert.equal(CLASS_MANAGEMENT[SWING].takeProfitCap, 0.1);
});

test("触发 1：板块内另一只股票连板数更高（失去龙头地位）", () => {
  // 自身 2 板、同板块他股 3 板 → 不是最强
  const demotion = detectDowngradeForPosition({
    position: { code: "600100", stockClass: RELAY, sector: "测试行业" },
    stocks: poolRows,
    today: TODAY,
  });
  assert.equal(demotion.to, REVERSAL);
  assert.match(demotion.reason, /失去龙头地位/);
  // 自身就是板块最高板 → 不触发
  assert.equal(
    detectDowngradeForPosition({
      position: { code: "600099", stockClass: RELAY, sector: "测试行业" },
      stocks: poolRows,
      today: TODAY,
    }),
    null,
  );
  // 出池持仓连板归零：板块内任一涨停即触发
  const outOfPool = detectDowngradeForPosition({
    position: { code: "600099", stockClass: RELAY, sector: "测试行业" },
    stocks: [],
    today: TODAY,
  });
  assert.equal(outOfPool, null, "板块池行缺失（无同板块数据）时跳过，不猜");
  const withPeer = detectDowngradeForPosition({
    position: { code: "600099", stockClass: RELAY, sector: "测试行业" },
    stocks: [{ code: "600100", sector: "测试行业", height: 1, change: 10 }],
    today: TODAY,
  });
  assert.match(withPeer.reason, /失去龙头地位/);
});

test("触发 2：今日涨幅不足板块平均涨幅的一半（跟涨不领涨）", () => {
  // 板块均值取同板块其他涨停股（不含自身）：自身 4% < 同板块 10.01% 的一半
  const lagging = detectDowngradeForPosition({
    position: { code: "600099", stockClass: REVERSAL, sector: "测试行业" },
    stocks: [
      { code: "600099", sector: "测试行业", height: 1, change: 4 },
      { code: "600100", sector: "测试行业", height: 2, change: 10.01 },
    ],
    eodChange: 4,
    today: TODAY,
  });
  assert.ok(lagging.triggers.some((t) => t.includes("跟涨不领涨")));
  // 自身就是板块最高板且涨幅达标 → 不触发
  assert.equal(
    detectDowngradeForPosition({
      position: { code: "600099", stockClass: REVERSAL, sector: "测试行业" },
      stocks: [
        { code: "600099", sector: "测试行业", height: 3, change: 9.8 },
        { code: "600100", sector: "测试行业", height: 2, change: 10.01 },
      ],
      today: TODAY,
    }),
    null,
  );
});

test("触发 3：炸板 ≥2 次且未回封（炸板池记录；池内回封不触发）", () => {
  // 出池 + 炸板池记录 zbc=2 → 触发
  const broken = detectDowngradeForPosition({
    position: { code: "600099", stockClass: REVERSAL, sector: "测试行业" },
    stocks: [],
    brokenRows: [{ c: "600099", n: "炸板样本", zbc: 2, zdp: 5 }],
    today: TODAY,
  });
  assert.ok(broken.triggers.some((t) => t.includes("炸板 2 次且收盘未回封")));
  // 池内持仓 = 收盘回封，zbc ≥2 也不触发（板块内自身为最高板，无触发 1）
  assert.equal(
    detectDowngradeForPosition({
      position: { code: "600100", stockClass: REVERSAL, sector: "测试行业" },
      stocks: [{ code: "600100", sector: "测试行业", height: 2, breaks: 1 }],
      today: TODAY,
    }),
    null,
  );
});

test("触发 4：换手率超限且涨幅不足（放量滞涨）", () => {
  // 炸板池行：换手 18%、涨幅 2% → 触发
  const stalled = detectDowngradeForPosition({
    position: { code: "600099", stockClass: REVERSAL, sector: "测试行业" },
    stocks: [],
    brokenRows: [{ c: "600099", n: "炸板样本", hs: 18, zdp: 2 }],
    today: TODAY,
  });
  assert.ok(stalled.triggers.some((t) => t.includes("放量滞涨")));
  // 涨幅达标或换手不足 → 不触发
  assert.equal(
    detectDowngradeForPosition({
      position: { code: "600099", stockClass: REVERSAL, sector: "测试行业" },
      stocks: [],
      brokenRows: [{ c: "600099", n: "炸板样本", hs: 18, zdp: 5 }],
      today: TODAY,
    }),
    null,
  );
  assert.equal(
    detectDowngradeForPosition({
      position: { code: "600099", stockClass: REVERSAL, sector: "测试行业" },
      stocks: [],
      brokenRows: [{ c: "600099", n: "炸板样本", hs: 10, zdp: 2 }],
      today: TODAY,
    }),
    null,
  );
});

test("降级链终点与一日一档：波段震荡型/平庸型/当日已降级不再检测", () => {
  for (const stockClass of [SWING, STOCK_CLASSES.MEDIOCRE, undefined, null]) {
    assert.equal(
      detectDowngradeForPosition({
        position: { code: "600099", stockClass, sector: "测试行业" },
        stocks: poolRows,
        today: TODAY,
      }),
      null,
      `${stockClass ?? "未分类"} 无降级目标或语义`,
    );
  }
  assert.equal(
    detectDowngradeForPosition({
      position: {
        code: "600099",
        stockClass: RELAY,
        sector: "测试行业",
        downgradedAt: TODAY,
      },
      stocks: poolRows,
      today: TODAY,
    }),
    null,
    "当日已降级不再连降（每日检查、每次降一档）",
  );
  // 次日恢复检测：持仓已出池（自身涨幅 4% 取自日线，不足同板块
  // 10.01% 的一半 → 触发 2）
  const nextDay = detectDowngradeForPosition({
    position: {
      code: "600099",
      stockClass: RELAY,
      sector: "测试行业",
      downgradedAt: "2026-10-14",
    },
    stocks: poolRows.filter((row) => row.code !== "600099"),
    eodChange: 4,
    today: TODAY,
  });
  assert.equal(nextDay.to, REVERSAL);
});

test("批量入口：normalize 炸板池原始行并按代码返回降级", () => {
  const demotions = detectPositionDowngrades({
    positions: [
      { code: "600099", stockClass: RELAY, sector: "测试行业" },
      { code: "600999", stockClass: RELAY, sector: "测试行业" },
    ],
    stocks: [],
    brokenRows: [
      { c: "600099", n: "炸板样本", zbc: 3, zdp: 4, hs: 20 },
      { c: "600999", n: "滞涨样本", hs: 20 },
    ],
    eodChangeByCode: new Map([["600999", 1]]),
    today: TODAY,
  });
  assert.equal(demotions.size, 2);
  assert.match(demotions.get("600099").reason, /炸板 3 次/);
  // 600999：炸板池行提供换手 20%，eodChange 提供涨幅 1% → 放量滞涨
  assert.match(demotions.get("600999").reason, /放量滞涨/);
});

test("阈值常量与 skill 对齐", () => {
  assert.equal(FOLLOWER_LAG_RATIO, 0.5);
  assert.equal(STALL_TURNOVER, 15);
  assert.equal(STALL_MAX_CHANGE, 3);
});
