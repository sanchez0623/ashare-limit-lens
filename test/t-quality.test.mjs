import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTTrades,
  applyRecoveryFill,
  summarizeTQuality,
  tCapForWinRate,
  T_QUALITY_RULES_VERSION,
  T_QUALITY_SAMPLE_SIZE,
} from "../backend/domain/t-quality.js";
import { buildTTradeRecords } from "../backend/services/paper.js";
import { createPlan, BASE_STRATEGY } from "../backend/domain/trading.js";
import { newBook } from "../backend/domain/trading.js";
import { snapshot, dateAt } from "./fixtures/trading.mjs";

// 成交行构造（与账本行同形的最小字段集）。realtime 行带 orderId。
const fill = (options) => ({
  id: options.orderId
    ? `${options.date}:live:${options.sequence ?? 0}`
    : `${options.date}:${options.orderRef ?? "x"}:${options.sequence ?? 0}`,
  date: options.date,
  sequence: options.sequence ?? 0,
  code: options.code ?? "600001",
  action: options.action ?? "T_FORWARD",
  side: options.side,
  quantity: options.quantity ?? 200,
  priceCents: options.priceCents ?? 1000,
  realizedPnlCents: options.realizedPnlCents ?? 0,
  ...(options.orderId ? { orderId: options.orderId } : {}),
});

// 质量汇总输入用记录构造器：completed 总盈亏按 wins/losses 生成。
const completedRecord = (index, completedDate, pnl) => ({
  id: `${completedDate}:60000${index}`,
  trade_date: completedDate,
  code: `60000${index}`,
  action: "T_FORWARD",
  buy_price_cents: 1000,
  sell_price_cents: 1020,
  buy_quantity: 200,
  sell_quantity: 200,
  day_pnl_cents: pnl,
  total_pnl_cents: pnl,
  completed_same_day: 1,
  completed_date: completedDate,
});

test("做T记录提取：同日两腿了结，买卖价与当日盈亏如实记录", () => {
  const fills = [
    fill({
      date: dateAt(1),
      sequence: 0,
      action: "T_FORWARD",
      side: "BUY",
      priceCents: 980,
    }),
    fill({
      date: dateAt(1),
      sequence: 1,
      action: "T_FORWARD",
      side: "SELL",
      priceCents: 1000,
      realizedPnlCents: 3000,
    }),
  ];
  const { records, open } = extractTTrades(fills);
  assert.equal(records.length, 1);
  assert.equal(open.length, 0);
  const record = records[0];
  assert.equal(record.id, `${dateAt(1)}:600001`);
  assert.equal(record.action, "T_FORWARD");
  assert.equal(record.buy_price_cents, 980);
  assert.equal(record.sell_price_cents, 1000);
  assert.equal(record.day_pnl_cents, 3000);
  assert.equal(record.total_pnl_cents, 3000);
  assert.equal(record.completed_same_day, 1);
  assert.equal(record.completed_date, dateAt(1));
});

test("做T记录提取：反向 T 先卖后买，卖出腿盈亏计入当日", () => {
  const fills = [
    fill({
      date: dateAt(1),
      sequence: 0,
      action: "T_REVERSE",
      side: "SELL",
      priceCents: 1020,
      realizedPnlCents: 1500,
    }),
    fill({
      date: dateAt(1),
      sequence: 1,
      action: "T_REVERSE",
      side: "BUY",
      priceCents: 1000,
    }),
  ];
  const { records } = extractTTrades(fills);
  assert.equal(records[0].action, "T_REVERSE");
  assert.equal(records[0].sell_price_cents, 1020);
  assert.equal(records[0].buy_price_cents, 1000);
  assert.equal(records[0].day_pnl_cents, 1500);
  assert.equal(records[0].completed_same_day, 1);
});

test("做T记录提取：单腿未了结保持 open，恢复腿跨日补齐即了结", () => {
  // 正向 T 只成交买入腿 → open；次日恢复单（:recovery）卖出补齐 → 了结
  const fills = [
    fill({
      date: dateAt(1),
      sequence: 0,
      action: "T_FORWARD",
      side: "BUY",
      priceCents: 980,
      quantity: 200,
    }),
    fill({
      date: dateAt(3),
      sequence: 5,
      action: "REDUCE",
      side: "SELL",
      priceCents: 1010,
      realizedPnlCents: 2400,
      quantity: 200,
      orderId: `${dateAt(3)}:600001:recovery`,
    }),
  ];
  const { records, open } = extractTTrades(fills);
  assert.equal(records.length, 1);
  assert.equal(open.length, 0);
  const record = records[0];
  assert.equal(record.trade_date, dateAt(1));
  assert.equal(record.completed_date, dateAt(3), "跨日恢复腿了结");
  assert.equal(record.completed_same_day, 0, "非当日了结");
  assert.equal(record.sell_price_cents, 1010);
  // 当日盈亏停留在尝试日（0），恢复腿盈亏计入合计
  assert.equal(record.day_pnl_cents, 0);
  assert.equal(record.total_pnl_cents, 2400);
});

test("做T记录提取：恢复腿数量不足保持 open；部分恢复累计后了结", () => {
  const attempt = fill({
    date: dateAt(1),
    sequence: 0,
    action: "T_FORWARD",
    side: "BUY",
    priceCents: 980,
    quantity: 200,
  });
  const partial = fill({
    date: dateAt(2),
    sequence: 1,
    action: "REDUCE",
    side: "SELL",
    priceCents: 1000,
    realizedPnlCents: 1000,
    quantity: 100,
    orderId: `${dateAt(2)}:600001:recovery`,
  });
  const rest = fill({
    date: dateAt(3),
    sequence: 2,
    action: "REDUCE",
    side: "SELL",
    priceCents: 1010,
    realizedPnlCents: 1200,
    quantity: 100,
    orderId: `${dateAt(3)}:600001:recovery`,
  });
  const first = extractTTrades([attempt, partial]);
  assert.equal(first.records.length, 0);
  assert.equal(first.open.length, 1);
  assert.equal(first.open[0].sell_quantity, 100);
  const both = extractTTrades([attempt, partial, rest]);
  assert.equal(both.records.length, 1);
  assert.equal(both.records[0].total_pnl_cents, 2200);
  assert.equal(both.records[0].completed_date, dateAt(3));
});

test("做T记录提取：盘后 :carry 续单不是恢复腿；旧执行器无恢复语义", () => {
  const fills = [
    fill({
      date: dateAt(1),
      sequence: 0,
      action: "T_FORWARD",
      side: "BUY",
      priceCents: 980,
      quantity: 200,
    }),
    // 未完成减仓的跨日续单（盘后路径，无 orderId，id 以 :carry: 结尾）
    fill({
      date: dateAt(2),
      sequence: 1,
      action: "REDUCE",
      side: "SELL",
      priceCents: 1010,
      realizedPnlCents: 2400,
      quantity: 200,
      orderRef: `${dateAt(2)}:600001:carry`,
    }),
  ];
  const { records, open } = extractTTrades(fills);
  assert.equal(records.length, 0, ":carry 续单不并入做T记录");
  assert.equal(open.length, 1, "单腿尝试保持 open");
  assert.equal(open[0].sell_quantity, 0);
});

test("做T记录提取：成交行乱序输入按日期与序号内部排序", () => {
  const fills = [
    fill({
      date: dateAt(1),
      sequence: 1,
      action: "T_FORWARD",
      side: "SELL",
      priceCents: 1000,
      realizedPnlCents: 3000,
    }),
    fill({
      date: dateAt(1),
      sequence: 0,
      action: "T_FORWARD",
      side: "BUY",
      priceCents: 980,
    }),
  ];
  const { records } = extractTTrades(fills);
  assert.equal(records.length, 1);
  assert.equal(records[0].buy_price_cents, 980);
});

test("胜率档位：>60% 两成、40%~60% 一成、<40% 禁止；边界值归入较低档", () => {
  assert.equal(tCapForWinRate(null), null, "无已了结历史不设上限");
  assert.equal(tCapForWinRate(0.7), 0.2);
  assert.equal(tCapForWinRate(0.61), 0.2);
  assert.equal(tCapForWinRate(0.6), 0.1, "恰为 60% 归入 40%~60% 档");
  assert.equal(tCapForWinRate(0.5), 0.1);
  assert.equal(tCapForWinRate(0.4), 0.1, "恰为 40% 保留一成");
  assert.equal(tCapForWinRate(0.39), 0);
  assert.equal(tCapForWinRate(0), 0);
});

test("质量汇总：样本窗口、状态差标记与空历史", () => {
  assert.equal(T_QUALITY_SAMPLE_SIZE, 10);
  const empty = summarizeTQuality([], {
    signalDate: dateAt(9),
    tradingDates: [],
  });
  assert.equal(empty.rulesVersion, T_QUALITY_RULES_VERSION);
  assert.equal(empty.winRate, null);
  assert.equal(empty.capTraction, null);
  assert.equal(empty.consecutiveLosses, 0);
  assert.equal(empty.statusMark, null);
  assert.equal(empty.blocked, false);

  // 样本只取最近 N 笔：11 笔中最早一笔大亏不进样本（不影响胜率），
  // 但连续亏损计数基于全部已了结记录。
  const dates = Array.from({ length: 11 }, (_, i) => dateAt(i));
  const records = dates.map((date, i) =>
    completedRecord(i + 1, date, i === 0 ? -9000 : i < 8 ? 500 : 400),
  );
  const summary = summarizeTQuality(records, {
    signalDate: dateAt(10),
    tradingDates: dates,
  });
  assert.equal(summary.completedCount, 11);
  assert.equal(summary.winRate, 1, "样本 10 笔全部盈利");
  assert.equal(summary.capTraction, 0.2);
  assert.equal(summary.consecutiveLosses, 0);
  assert.equal(summary.statusMark, null);

  // 最近 10 笔平均盈亏 < 0 → 标记做T状态差（3 胜 7 负，胜率 0.3）
  const mixed = Array.from({ length: 10 }, (_, i) =>
    completedRecord(i + 1, dateAt(i), i < 3 ? 100 : -500),
  );
  const status = summarizeTQuality(mixed, {
    signalDate: dateAt(9),
    tradingDates: [],
  });
  assert.equal(status.winRate, 0.3);
  assert.equal(status.capTraction, 0);
  assert.equal(status.statusMark, "做T状态差");
});

test("停手规则：连续 2 笔亏损后 3 个交易日内信号日禁止做T", () => {
  const tradingDates = Array.from({ length: 10 }, (_, i) => dateAt(i));
  const records = [
    completedRecord(1, dateAt(2), -800),
    completedRecord(2, dateAt(4), -600),
  ];
  // 信号日 = 第 2 笔了结日次日起算：D2+1（不足 3 个交易日）→ 停手
  const inWindow = summarizeTQuality(records, {
    signalDate: dateAt(5),
    tradingDates,
  });
  assert.equal(inWindow.consecutiveLosses, 2);
  assert.equal(inWindow.blocked, true);
  assert.equal(inWindow.blockedUntil, dateAt(7), "停手至第 3 个交易日");

  // 信号日已越过 3 个交易日窗口 → 恢复
  const afterWindow = summarizeTQuality(records, {
    signalDate: dateAt(7),
    tradingDates,
  });
  assert.equal(afterWindow.blocked, false);
  assert.equal(afterWindow.blockedUntil, null);

  // 只有一笔亏损 → 不触发停手
  const singleLoss = summarizeTQuality([records[0]], {
    signalDate: dateAt(3),
    tradingDates,
  });
  assert.equal(singleLoss.blocked, false);

  // 连续亏损后有一笔盈利 → 计数清零，不停手
  const recovered = [
    ...records,
    completedRecord(3, dateAt(6), 500),
    completedRecord(4, dateAt(7), -100),
  ];
  const afterWin = summarizeTQuality(recovered, {
    signalDate: dateAt(8),
    tradingDates,
  });
  assert.equal(afterWin.consecutiveLosses, 1);
  assert.equal(afterWin.blocked, false);
});

// 门控测试用快照：带降级版本标记（触发 assertProgramSnapshot 的重算路径）
const gatedSnapshot = (date) => {
  const snap = snapshot(date);
  snap.downgradeRulesVersion = 1;
  snap.market = { brokenRows: [] };
  snap.stocks = snap.stocks.map(({ height, ...rest }) => rest);
  return snap;
};
const tBook = () => {
  const book = newBook(100000);
  book.positions = [
    {
      code: "600099",
      name: "做T样本",
      sector: "测试行业",
      heldDays: 1,
      markCents: 1000,
      lastScore: 75, // 掉出当日池：信号缺失 → 无 ADD 分支，走做T/HOLD
      lots: [
        {
          acquiredDate: dateAt(0),
          quantity: 1000,
          costCents: 1000000,
          priceCents: 1000,
        },
      ],
    },
  ];
  book.cashCents = book.initialCashCents - 1000000;
  book.equityCents = book.initialCashCents;
  book.peakEquityCents = book.equityCents;
  return book;
};
const tSummary = (overrides = {}) => ({
  rulesVersion: T_QUALITY_RULES_VERSION,
  sampleSize: 10,
  completedCount: 10,
  winRate: 0.5,
  capTraction: 0.1,
  consecutiveLosses: 0,
  statusMark: null,
  blocked: false,
  blockedUntil: null,
  ...overrides,
});

test("做T闸门：胜率档位收紧做T仓位并随订单披露", () => {
  // 底仓 1000 股、tFraction 0.2 → 原本 200 股；限 1 成 → 100 股
  const capped = createPlan(
    gatedSnapshot(dateAt(1)),
    tBook(),
    BASE_STRATEGY,
    "v",
    `${dateAt(1)}T07:10:00.000Z`,
    { tQuality: tSummary({ capTraction: 0.1, winRate: 0.5 }) },
  );
  const tOrder = capped.orders.find(
    (o) => o.action === "T_FORWARD" || o.action === "T_REVERSE",
  );
  assert.ok(tOrder, "限 1 成仍允许做T");
  assert.equal(tOrder.quantity, 100);
  assert.match(tOrder.reason, /限 1 成/);
  assert.deepEqual(capped.tQuality.capTraction, 0.1, "摘要随计划冻结");

  // 无历史（capTraction null）→ 保持 tFraction 原语义
  const uncapped = createPlan(
    gatedSnapshot(dateAt(1)),
    tBook(),
    BASE_STRATEGY,
    "v",
    `${dateAt(1)}T07:10:00.000Z`,
    {
      tQuality: tSummary({
        capTraction: null,
        winRate: null,
        completedCount: 0,
      }),
    },
  );
  const uncappedOrder = uncapped.orders.find(
    (o) => o.action === "T_FORWARD" || o.action === "T_REVERSE",
  );
  assert.equal(uncappedOrder.quantity, 200);
  assert.doesNotMatch(uncappedOrder.reason, /胜率档位/);
});

test("做T闸门：胜率不足 40% 禁止做T，停手期 HOLD 理由披露截止日", () => {
  const banned = createPlan(
    gatedSnapshot(dateAt(1)),
    tBook(),
    BASE_STRATEGY,
    "v",
    `${dateAt(1)}T07:10:00.000Z`,
    {
      tQuality: tSummary({
        capTraction: 0,
        winRate: 0.3,
        statusMark: "做T状态差",
      }),
    },
  );
  const hold = banned.orders.find((o) => o.code === "600099");
  assert.equal(hold.action, "HOLD");
  assert.match(hold.reason, /做T胜率 30% 低于 40%/);

  const stopped = createPlan(
    gatedSnapshot(dateAt(1)),
    tBook(),
    BASE_STRATEGY,
    "v",
    `${dateAt(1)}T07:10:00.000Z`,
    {
      tQuality: tSummary({
        blocked: true,
        blockedUntil: dateAt(3),
        consecutiveLosses: 2,
      }),
    },
  );
  const stoppedOrder = stopped.orders.find((o) => o.code === "600099");
  assert.equal(stoppedOrder.action, "HOLD");
  assert.match(stoppedOrder.reason, /连续 2 笔做T亏损，停手观察（至 /);
});

test("做T闸门：旧计划无 tQuality 字段保持原语义；版本不匹配拒绝生成", () => {
  const legacy = createPlan(
    gatedSnapshot(dateAt(1)),
    tBook(),
    BASE_STRATEGY,
    "v",
    `${dateAt(1)}T07:10:00.000Z`,
  );
  assert.equal(legacy.tQuality, undefined, "旧语义计划不携带 tQuality");
  const legacyOrder = legacy.orders.find(
    (o) => o.action === "T_FORWARD" || o.action === "T_REVERSE",
  );
  assert.equal(legacyOrder.quantity, 200);

  assert.throws(
    () =>
      createPlan(
        gatedSnapshot(dateAt(1)),
        tBook(),
        BASE_STRATEGY,
        "v",
        `${dateAt(1)}T07:10:00.000Z`,
        { tQuality: tSummary({ rulesVersion: 99 }) },
      ),
    /不支持的做T质量规则版本/,
  );
});

test("做T闸门：重算复用计划冻结摘要——新增记录不改变已冻结计划的 T 决策", () => {
  const frozen = createPlan(
    gatedSnapshot(dateAt(1)),
    tBook(),
    BASE_STRATEGY,
    "v",
    `${dateAt(1)}T07:10:00.000Z`,
    { tQuality: tSummary({ capTraction: 0.1 }) },
  );
  // 冻结后记录表新增一笔大亏（会改变 winRate/cap）——重算必须用计划内
  // 副本，订单保持不变。
  const recomputed = createPlan(
    gatedSnapshot(dateAt(1)),
    tBook(),
    frozen.strategy,
    frozen.strategyVersion,
    frozen.createdAt,
    {
      executionCostPolicy: frozen.executionCostPolicy,
      selectionPolicy: frozen.selectionPolicy,
      tQuality: frozen.tQuality,
    },
  );
  assert.deepEqual(recomputed.orders, frozen.orders);
});

test("结算提取：当日做T尝试与跨日恢复腿并入同一 upsert 集合", () => {
  const now = "2026-01-05T00:00:00.000Z";
  const openRecord = {
    id: `${dateAt(1)}:600099`,
    trade_date: dateAt(1),
    code: "600099",
    action: "T_FORWARD",
    buy_price_cents: 980,
    sell_price_cents: null,
    buy_quantity: 200,
    sell_quantity: 0,
    day_pnl_cents: 0,
    total_pnl_cents: 0,
    completed_same_day: 0,
    completed_date: null,
    created_at: "2026-01-02T00:00:00.000Z",
  };
  const dayFills = [
    // 当日新做T（同日了结）
    fill({
      date: dateAt(4),
      sequence: 0,
      code: "600001",
      action: "T_REVERSE",
      side: "SELL",
      priceCents: 1020,
      realizedPnlCents: 1500,
    }),
    fill({
      date: dateAt(4),
      sequence: 1,
      code: "600001",
      action: "T_REVERSE",
      side: "BUY",
      priceCents: 1000,
    }),
    // 跨日恢复腿（600099 的未了结记录）
    fill({
      date: dateAt(4),
      sequence: 2,
      code: "600099",
      action: "REDUCE",
      side: "SELL",
      priceCents: 1010,
      realizedPnlCents: 2400,
      quantity: 200,
      orderId: `${dateAt(4)}:600099:recovery`,
    }),
  ];
  const upserts = buildTTradeRecords({
    fills: dayFills,
    openRecords: [openRecord],
    now,
  });
  assert.equal(upserts.length, 2);
  const fresh = upserts.find((record) => record.code === "600001");
  assert.equal(fresh.completed_same_day, 1);
  assert.equal(fresh.created_at, now);
  const recovered = upserts.find((record) => record.code === "600099");
  assert.equal(recovered.completed_date, dateAt(4), "恢复腿补齐即了结");
  assert.equal(recovered.total_pnl_cents, 2400);
  assert.equal(
    recovered.created_at,
    openRecord.created_at,
    "更新保留首次落库时间",
  );
});
