import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTTrades,
  summarizeTQuality,
  buildTQualityEvidence,
  tCapForWinRate,
  T_QUALITY_RULES_VERSION,
  T_QUALITY_SAMPLE_SIZE,
  T_QUALITY_EVIDENCE_WINDOW,
} from "../backend/domain/t-quality.js";
import { buildTTradeRecords } from "../backend/services/paper.js";
import {
  createPlan,
  assertProgramSnapshot,
  BASE_STRATEGY,
  newBook,
} from "../backend/domain/trading.js";
import { snapshot, dateAt } from "./fixtures/trading.mjs";

// 成交行构造（与账本行同形的最小字段集）。cashDeltaCents 为该腿净现金
// 流（卖出为正、买入为负，含费用）；realizedPnlCents 是旧仓 FIFO 口径，
// 只用于验证其不参与做T盈亏。realtime 行带 orderId。
const fill = (options) => {
  const notional = (options.priceCents ?? 1000) * (options.quantity ?? 200);
  return {
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
    cashDeltaCents:
      options.cashDeltaCents ??
      (options.side === "SELL" ? notional : -notional),
    realizedPnlCents: options.realizedPnlCents ?? 0,
    ...(options.orderId ? { orderId: options.orderId } : {}),
  };
};

// 质量汇总输入用记录构造器。
const completedRecord = (index, completedDate, pnl, sequence = index) => ({
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
  completed_sequence: sequence,
});

test("做T记录提取：同日两腿了结，盈亏为配对腿净现金流（含双边费用）", () => {
  const fills = [
    fill({
      date: dateAt(1),
      sequence: 0,
      action: "T_FORWARD",
      side: "BUY",
      priceCents: 980,
      cashDeltaCents: -196010,
    }),
    fill({
      date: dateAt(1),
      sequence: 1,
      action: "T_FORWARD",
      side: "SELL",
      priceCents: 1000,
      cashDeltaCents: 199940,
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
  // 净现金流 = 199940 - 196010 = 3930（价差减双边费用）
  assert.equal(record.day_pnl_cents, 3930);
  assert.equal(record.total_pnl_cents, 3930);
  assert.equal(record.completed_same_day, 1);
  assert.equal(record.completed_date, dateAt(1));
  assert.equal(record.completed_sequence, 1);
});

test("做T盈亏与旧仓成本无关：realizedPnlCents 漂移不改变记录", () => {
  // 用户复现：同一笔 T 净赚 64.72 元，仅改变旧仓成本，realizedPnl
  // 变成 +1031.85 或 -968.15——记录必须取配对现金流，不受其影响。
  const legs = (realizedPnl) => [
    fill({
      date: dateAt(1),
      sequence: 0,
      action: "T_FORWARD",
      side: "BUY",
      priceCents: 980,
      cashDeltaCents: -196010,
    }),
    fill({
      date: dateAt(1),
      sequence: 1,
      action: "T_FORWARD",
      side: "SELL",
      priceCents: 1000,
      cashDeltaCents: 199940,
      realizedPnlCents: realizedPnl,
    }),
  ];
  const one = extractTTrades(legs(6472)).records[0];
  const other = extractTTrades(legs(103185)).records[0];
  const third = extractTTrades(legs(-96815)).records[0];
  assert.equal(one.total_pnl_cents, 3930);
  assert.equal(other.total_pnl_cents, 3930);
  assert.equal(third.total_pnl_cents, 3930);
});

test("做T记录提取：反向 T 先卖后买，卖出腿现金流计入当日", () => {
  const fills = [
    fill({
      date: dateAt(1),
      sequence: 0,
      action: "T_REVERSE",
      side: "SELL",
      priceCents: 1020,
      cashDeltaCents: 101800,
    }),
    fill({
      date: dateAt(1),
      sequence: 1,
      action: "T_REVERSE",
      side: "BUY",
      priceCents: 1000,
      cashDeltaCents: -100010,
    }),
  ];
  const { records } = extractTTrades(fills);
  assert.equal(records[0].action, "T_REVERSE");
  assert.equal(records[0].sell_price_cents, 1020);
  assert.equal(records[0].buy_price_cents, 1000);
  assert.equal(records[0].day_pnl_cents, 101800 - 100010);
  assert.equal(records[0].completed_same_day, 1);
});

test("做T记录提取：分批成交按日聚合，不提前了结也不产生重复记录", () => {
  // 用户复现：买两笔、卖两笔各 100 股——同日聚合为一条已了结记录；
  // 旧实现按"买卖都大于零"提前关闭并生成同 ID 覆盖。
  const fills = [
    fill({
      date: dateAt(1),
      sequence: 0,
      action: "T_FORWARD",
      side: "BUY",
      priceCents: 980,
      quantity: 100,
    }),
    fill({
      date: dateAt(1),
      sequence: 1,
      action: "T_FORWARD",
      side: "BUY",
      priceCents: 985,
      quantity: 100,
    }),
    fill({
      date: dateAt(1),
      sequence: 2,
      action: "T_FORWARD",
      side: "SELL",
      priceCents: 1000,
      quantity: 100,
    }),
    fill({
      date: dateAt(1),
      sequence: 3,
      action: "T_FORWARD",
      side: "SELL",
      priceCents: 1002,
      quantity: 100,
    }),
  ];
  const { records, open } = extractTTrades(fills);
  assert.equal(records.length, 1, "同日聚合为一条记录");
  assert.equal(open.length, 0);
  const record = records[0];
  assert.equal(record.buy_quantity, 200);
  assert.equal(record.sell_quantity, 200);
  assert.equal(record.buy_price_cents, 983, "买入价记加权均价");
  assert.equal(record.completed_same_day, 1, "日终才判定当日了结");
  assert.equal(record.completed_sequence, 3);
});

test("做T记录提取：单腿未了结保持 open，恢复腿跨日补齐即了结", () => {
  const fills = [
    fill({
      date: dateAt(1),
      sequence: 0,
      action: "T_FORWARD",
      side: "BUY",
      priceCents: 980,
      quantity: 200,
      cashDeltaCents: -196010,
    }),
    fill({
      date: dateAt(3),
      sequence: 5,
      action: "REDUCE",
      side: "SELL",
      priceCents: 1010,
      quantity: 200,
      cashDeltaCents: 201900,
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
  // 当日盈亏停留在尝试日（买入腿现金流），恢复腿盈亏计入合计
  assert.equal(record.day_pnl_cents, -196010);
  assert.equal(record.total_pnl_cents, 201900 - 196010);
  assert.equal(record.completed_sequence, 5);
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
    quantity: 100,
    cashDeltaCents: 99900,
    orderId: `${dateAt(2)}:600001:recovery`,
  });
  const rest = fill({
    date: dateAt(3),
    sequence: 2,
    action: "REDUCE",
    side: "SELL",
    priceCents: 1010,
    quantity: 100,
    cashDeltaCents: 100900,
    orderId: `${dateAt(3)}:600001:recovery`,
  });
  const first = extractTTrades([attempt, partial]);
  assert.equal(first.records.length, 0);
  assert.equal(first.open.length, 1);
  assert.equal(first.open[0].sell_quantity, 100);
  const both = extractTTrades([attempt, partial, rest]);
  assert.equal(both.records.length, 1);
  assert.equal(both.records[0].total_pnl_cents, 99900 + 100900 - 196000);
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
    fill({
      date: dateAt(2),
      sequence: 1,
      action: "REDUCE",
      side: "SELL",
      priceCents: 1010,
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
      cashDeltaCents: 199940,
    }),
    fill({
      date: dateAt(1),
      sequence: 0,
      action: "T_FORWARD",
      side: "BUY",
      priceCents: 980,
      cashDeltaCents: -196010,
    }),
  ];
  const { records } = extractTTrades(fills);
  assert.equal(records.length, 1);
  assert.equal(records[0].buy_price_cents, 980);
});

test("胜率档位：>60% 两成、40%~60% 一成、<40% 禁止；边界值归入较低档", () => {
  assert.equal(tCapForWinRate(null), null);
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
  assert.equal(empty.stopTriggerDate, null);

  // 样本只取最近 N 笔：11 笔中最早一笔大亏不进样本（不影响胜率），
  // 但连续亏损计数基于证据窗口内全部已了结记录。
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
  const inWindow = summarizeTQuality(records, {
    signalDate: dateAt(5),
    tradingDates,
  });
  assert.equal(inWindow.consecutiveLosses, 2);
  assert.equal(inWindow.blocked, true);
  assert.equal(
    inWindow.stopTriggerDate,
    dateAt(4),
    "停手锚点为最近一笔亏损了结日",
  );

  const afterWindow = summarizeTQuality(records, {
    signalDate: dateAt(7),
    tradingDates,
  });
  assert.equal(afterWindow.blocked, false);
  assert.equal(afterWindow.stopTriggerDate, null);

  const singleLoss = summarizeTQuality([records[0]], {
    signalDate: dateAt(3),
    tradingDates,
  });
  assert.equal(singleLoss.blocked, false);

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

test("连续亏损按了结顺序统计：同日了结不按代码字典序打乱", () => {
  // 用户复现：实际了结顺序 B 盈利 → A 亏损 → C 亏损（A/C 码序更小，
  // 旧实现按 id 排序会得到 亏-盈-亏，只识别一次连续亏损）。
  const tradingDates = Array.from({ length: 8 }, (_, i) => dateAt(i));
  const day = dateAt(3);
  const records = [
    completedRecord(1, day, 300, 1), // B：先了结，盈利
    completedRecord(2, day, -400, 2), // A：后了结，亏损
    completedRecord(3, day, -200, 3), // C：最后了结，亏损
  ];
  const summary = summarizeTQuality(records, {
    signalDate: dateAt(4),
    tradingDates,
  });
  assert.equal(
    summary.consecutiveLosses,
    2,
    "按 completed_sequence 识别连续 2 笔亏损",
  );
  assert.equal(summary.blocked, true);
  assert.equal(summary.stopTriggerDate, day);
});

test("质量证据：与摘要共用同一窗口截断，重算一致", () => {
  assert.equal(T_QUALITY_EVIDENCE_WINDOW, 40);
  // 空历史：证据为空壳（记录与日期都置空）——空状态在任一链路一致。
  const emptyEvidence = buildTQualityEvidence([], []);
  assert.deepEqual(emptyEvidence, { records: [], tradingDates: [] });

  const dates = Array.from({ length: 50 }, (_, i) => dateAt(i));
  const records = dates.map((date, i) =>
    completedRecord(i + 1, date, i % 2 ? 300 : -100),
  );
  const evidence = buildTQualityEvidence(records, dates);
  assert.equal(evidence.records.length, T_QUALITY_EVIDENCE_WINDOW);
  assert.equal(evidence.tradingDates.length, T_QUALITY_EVIDENCE_WINDOW);
  // 证据是摘要的实际输入：全量汇总与证据重算结果一致
  const fromAll = summarizeTQuality(records, {
    signalDate: dates[49],
    tradingDates: dates,
  });
  const fromEvidence = summarizeTQuality(evidence.records, {
    signalDate: dates[49],
    tradingDates: evidence.tradingDates,
  });
  assert.deepEqual(fromEvidence, fromAll);
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
  stopTriggerDate: null,
  ...overrides,
});
const freezeGated = (
  tQuality,
  tQualityEvidence = { records: [], tradingDates: [] },
) =>
  createPlan(
    gatedSnapshot(dateAt(1)),
    tBook(),
    BASE_STRATEGY,
    "v",
    `${dateAt(1)}T07:10:00.000Z`,
    { tQuality, tQualityEvidence },
  );

test("做T闸门：胜率档位收紧做T仓位并随订单披露", () => {
  // 底仓 1000 股、tFraction 0.2 → 原本 200 股；限 1 成 → 100 股
  const capped = freezeGated(tSummary({ capTraction: 0.1, winRate: 0.5 }));
  const tOrder = capped.orders.find(
    (o) => o.action === "T_FORWARD" || o.action === "T_REVERSE",
  );
  assert.ok(tOrder, "限 1 成仍允许做T");
  assert.equal(tOrder.quantity, 100);
  assert.match(tOrder.reason, /限 1 成/);
  assert.equal(capped.tQuality.capTraction, 0.1, "摘要随计划冻结");
  assert.deepEqual(capped.tQualityEvidence.tradingDates, [], "证据随计划冻结");

  // 无历史（capTraction null）→ 保持 tFraction 原语义
  const uncapped = freezeGated(
    tSummary({ capTraction: null, winRate: null, completedCount: 0 }),
  );
  const uncappedOrder = uncapped.orders.find(
    (o) => o.action === "T_FORWARD" || o.action === "T_REVERSE",
  );
  assert.equal(uncappedOrder.quantity, 200);
  assert.doesNotMatch(uncappedOrder.reason, /胜率档位/);
});

test("做T闸门：胜率不足 40% 禁止做T，停手期 HOLD 理由披露触发日", () => {
  const banned = freezeGated(
    tSummary({ capTraction: 0, winRate: 0.3, statusMark: "做T状态差" }),
  );
  const hold = banned.orders.find((o) => o.code === "600099");
  assert.equal(hold.action, "HOLD");
  assert.match(hold.reason, /做T胜率 30% 低于 40%/);

  const stopped = freezeGated(
    tSummary({
      blocked: true,
      stopTriggerDate: dateAt(1),
      consecutiveLosses: 2,
    }),
  );
  const stoppedOrder = stopped.orders.find((o) => o.code === "600099");
  assert.equal(stoppedOrder.action, "HOLD");
  assert.match(stoppedOrder.reason, /连续 2 笔做T亏损，停手观察（自 /);
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
    () => freezeGated(tSummary({ rulesVersion: 99 })),
    /不支持的做T质量规则版本/,
  );
});

test("做T闸门：重算复用冻结证据重算出的摘要，新增记录不影响已冻结计划", () => {
  const evidence = buildTQualityEvidence(
    [completedRecord(1, dateAt(1), 500)],
    [dateAt(0), dateAt(1)],
  );
  const summary = summarizeTQuality([completedRecord(1, dateAt(1), 500)], {
    signalDate: dateAt(1),
    tradingDates: [dateAt(0), dateAt(1)],
  });
  const frozen = freezeGated(summary, evidence);
  // 重算输入与冻结时一致（证据内记录）→ 订单一致
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
      tQualityEvidence: frozen.tQualityEvidence,
    },
  );
  assert.deepEqual(recomputed.orders, frozen.orders);
});

test("核验器：摘要不可直接声明——改写、缺证据、删除都被拒绝", () => {
  const evidence = buildTQualityEvidence(
    [completedRecord(1, dateAt(1), -800), completedRecord(2, dateAt(2), -600)],
    [dateAt(0), dateAt(1), dateAt(2)],
  );
  const summary = summarizeTQuality(
    [completedRecord(1, dateAt(1), -800), completedRecord(2, dateAt(2), -600)],
    { signalDate: dateAt(2), tradingDates: [dateAt(0), dateAt(1), dateAt(2)] },
  );
  assert.equal(summary.blocked, true, "证据表明应停手");
  const snap = gatedSnapshot(dateAt(2));
  const book = tBook();

  // 合法冻结：摘要与证据一致 → 核验通过
  const frozen = createPlan(
    snap,
    book,
    BASE_STRATEGY,
    "v",
    `${dateAt(2)}T07:10:00.000Z`,
    {
      tQuality: summary,
      tQualityEvidence: evidence,
    },
  );
  assert.doesNotThrow(() => assertProgramSnapshot(frozen, snap, book));

  // 攻击 1：把停手摘要改成允许交易并重算订单——证据重算结果与声明不符
  const tampered = createPlan(
    snap,
    structuredClone(book),
    BASE_STRATEGY,
    "v",
    `${dateAt(2)}T07:10:00.000Z`,
    {
      tQuality: tSummary({ capTraction: 0.2, winRate: 0.8 }),
      tQualityEvidence: evidence,
    },
  );
  assert.throws(
    () => assertProgramSnapshot(tampered, snap, structuredClone(book)),
    /做T质量摘要与冻结证据重算不一致/,
  );

  // 攻击 2：直接改计划 JSON——只删摘要留证据（或反之）。冻结入口拒绝
  // 孤儿字段，核验器对已冻结计划同样要求两者成对。
  const noSummary = JSON.parse(JSON.stringify(frozen));
  delete noSummary.tQuality;
  assert.throws(
    () => assertProgramSnapshot(noSummary, snap, structuredClone(book)),
    /做T质量摘要与冻结证据必须同时随计划冻结/,
  );
  const noEvidence = JSON.parse(JSON.stringify(frozen));
  delete noEvidence.tQualityEvidence;
  assert.throws(
    () => assertProgramSnapshot(noEvidence, snap, structuredClone(book)),
    /做T质量摘要与冻结证据必须同时随计划冻结/,
  );
  // 冻结入口即拒绝孤儿字段
  assert.throws(
    () =>
      createPlan(
        snap,
        structuredClone(book),
        BASE_STRATEGY,
        "v",
        `${dateAt(2)}T07:10:00.000Z`,
        { tQualityEvidence: evidence },
      ),
    /做T质量证据缺少摘要/,
  );
  assert.throws(
    () =>
      createPlan(
        snap,
        structuredClone(book),
        BASE_STRATEGY,
        "v",
        `${dateAt(2)}T07:10:00.000Z`,
        { tQuality: summary },
      ),
    /做T质量摘要缺少冻结证据/,
  );
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
    completed_sequence: 0,
    created_at: "2026-01-02T00:00:00.000Z",
  };
  const dayFills = [
    fill({
      date: dateAt(4),
      sequence: 0,
      code: "600001",
      action: "T_REVERSE",
      side: "SELL",
      priceCents: 1020,
      cashDeltaCents: 101800,
    }),
    fill({
      date: dateAt(4),
      sequence: 1,
      code: "600001",
      action: "T_REVERSE",
      side: "BUY",
      priceCents: 1000,
      cashDeltaCents: -100010,
    }),
    fill({
      date: dateAt(4),
      sequence: 2,
      code: "600099",
      action: "REDUCE",
      side: "SELL",
      priceCents: 1010,
      quantity: 200,
      cashDeltaCents: 201900,
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
  assert.equal(recovered.total_pnl_cents, 201900);
  assert.equal(recovered.completed_sequence, 2);
  assert.equal(
    recovered.created_at,
    openRecord.created_at,
    "更新保留首次落库时间",
  );
});
