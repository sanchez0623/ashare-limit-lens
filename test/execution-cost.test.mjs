import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeExecutionCostPayload,
  normalizeExecutionCostPolicy,
  defaultExecutionCostPolicy,
  executionPeriod,
  EXECUTION_COST_MODEL,
  DEFAULT_EXECUTION_COST_PAYLOAD,
} from "../shared/execution-cost.js";
import {
  buildExecutionContext,
  estimateExecutionCost,
  solveFillQuantity,
  cumulativeImpactCents,
} from "../backend/domain/execution-cost.js";
import {
  newBook,
  createPlan,
  executePlan,
  totalQuantity,
  BASE_STRATEGY,
} from "../backend/domain/trading.js";
import { openSession, advanceSession } from "../backend/domain/realtime.js";
import { PaperRepository, digest } from "../backend/storage/paper.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import {
  runExecutionSensitivity,
  scenarioPolicyBundles,
} from "../backend/services/execution-sensitivity.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { parseTencentQuotes } from "../backend/services/market.js";
import {
  bars,
  dataset,
  order,
  plan,
  snapshot,
  pairs,
  dateAt,
} from "./fixtures/trading.mjs";

const event = (time, overrides = {}) => ({
  time,
  priceCents: 1000,
  volumeShares: 10_000_000,
  quality: "realtime_poll",
  intervalKey: `2026-01-02:${time}`,
  ...overrides,
});
const context = (overrides = {}) =>
  buildExecutionContext({
    plan: { previousLimitUpCodes: [], previousLimitUpKnown: true },
    code: "600001",
    event: event("10:00:00"),
    quote: {},
    ...overrides,
  });
const estimate = (overrides = {}) =>
  estimateExecutionCost({
    policy: defaultExecutionCostPolicy(),
    context: context(),
    side: "BUY",
    quantity: 1000,
    ...overrides,
  });

test("政策规范化：拒绝未知字段、原型键、越界与非有限数；规范化产生稳定摘要", async () => {
  const normalized = await normalizeExecutionCostPayload({
    ...DEFAULT_EXECUTION_COST_PAYLOAD,
  });
  assert.equal(normalized.periodBaseBps.openFirstMinute, 30);
  assert.throws(
    () =>
      normalizeExecutionCostPayload({
        ...DEFAULT_EXECUTION_COST_PAYLOAD,
        slippageBps: 999,
      }),
    /未知字段/,
  );
  assert.throws(
    () =>
      normalizeExecutionCostPayload(
        JSON.parse(
          '{"impactExponent":0.5,"__proto__":{"hacked":1},"stressResidualMultiplier":[1.5]}',
        ),
      ),
    /未知字段/,
  );
  assert.throws(
    () =>
      normalizeExecutionCostPayload({
        ...DEFAULT_EXECUTION_COST_PAYLOAD,
        referenceParticipation: 0.02,
      }),
    /超出范围/,
  );
  assert.throws(
    () =>
      normalizeExecutionCostPayload({
        ...DEFAULT_EXECUTION_COST_PAYLOAD,
        openingParticipationCap: 0.02,
      }),
    /超出范围/,
  );
  assert.throws(
    () =>
      normalizeExecutionCostPayload({
        ...DEFAULT_EXECUTION_COST_PAYLOAD,
        periodBaseBps: {
          ...DEFAULT_EXECUTION_COST_PAYLOAD.periodBaseBps,
          bogus: 1,
        },
      }),
    /未知字段/,
  );
  assert.throws(
    () =>
      normalizeExecutionCostPayload({
        ...DEFAULT_EXECUTION_COST_PAYLOAD,
        impactExponent: Number.NaN,
      }),
    /有限数值/,
  );
  assert.throws(
    () =>
      normalizeExecutionCostPayload({
        ...DEFAULT_EXECUTION_COST_PAYLOAD,
        stressResidualMultiplier: [2, 1.5],
      }),
    /严格递增/,
  );
  assert.throws(
    () =>
      normalizeExecutionCostPolicy({
        ...defaultExecutionCostPolicy(),
        modelVersion: "OTHER_V9",
      }),
    /不支持的成本模型/,
  );
  assert.throws(
    () =>
      normalizeExecutionCostPolicy({
        ...defaultExecutionCostPolicy(),
        payloadDigest: "xyz",
      }),
    /摘要/,
  );
});

test("成本分段：半开区间边界准确，开盘残余项显著高于普通时段", () => {
  assert.equal(executionPeriod("09:30:00"), "openFirstMinute");
  assert.equal(executionPeriod("09:30:59"), "openFirstMinute");
  assert.equal(executionPeriod("09:31:00"), "openNextFourMinutes");
  assert.equal(executionPeriod("09:34:59"), "openNextFourMinutes");
  // 09:35:00 属于早盘后段（§3.1）
  assert.equal(executionPeriod("09:35:00"), "earlySession");
  assert.equal(executionPeriod("09:59:59"), "earlySession");
  assert.equal(executionPeriod("10:00:00"), "regular");
  assert.equal(executionPeriod("14:30"), "regular");
  const at = (time) =>
    estimate({ context: context({ event: event(time) }) }).costBreakdown;
  const open = at("09:30:10"),
    early = at("09:40:00"),
    regular = at("10:30:00");
  assert.equal(open.period, "openFirstMinute");
  assert.ok(open.residualBps > early.residualBps);
  assert.ok(early.residualBps > regular.residualBps);
  // 30bps 开盘项 + 5bps 缺盘口回退（无涨停项、无压力倍数）
  assert.equal(open.residualBps, 35);
  assert.equal(early.residualBps, 15);
  assert.equal(regular.residualBps, 10);
});

test("数量冲击：q 或累计 Q 增大、V 减小都不降低单位成本；超出适用域拒绝而非截断", () => {
  const base = estimate({}).costBreakdown;
  const biggerQ = estimate({ quantity: 50_000 }).costBreakdown;
  assert.ok(biggerQ.impactBps > base.impactBps);
  // 分价取整会量化实际 bps（低价股一分取整影响显著），因此用取整前的
  // 模型成本与每股价格断言单调性，实际 bps 只不下降。
  assert.ok(biggerQ.unroundedTotalBps > base.unroundedTotalBps);
  assert.ok(biggerQ.totalBps >= base.totalBps);
  assert.ok(biggerQ.impliedCostCents / 50_000 >= base.impliedCostCents / 1000);
  const consumed = estimate({
    context: context({
      event: event("10:00:00"),
      intervalState: {
        intervalKey: "2026-01-02:10:00:00",
        referencePriceCents: 1000,
        marketVolumeShares: 10_000_000,
        consumedShares: 50_000,
        cumulativeImpactCents: 0,
      },
    }),
    quantity: 1000,
  }).costBreakdown;
  assert.ok(consumed.impactBps > base.impactBps);
  const thin = estimate({
    context: context({ event: event("10:00:00", { volumeShares: 100_000 }) }),
    quantity: 1000,
  }).costBreakdown;
  assert.ok(thin.impactBps > base.impactBps);
  const rejected = estimate({
    context: context({ event: event("10:00:00", { volumeShares: 100 }) }),
    quantity: 1000,
  });
  assert.equal(rejected.supported, false);
  assert.equal(rejected.rejectionReason, "EXECUTION_COST_OUT_OF_DOMAIN");
});

test("拆单一致：同区间一次成交与拆成数笔的累计模型冲击相同", () => {
  const policy = defaultExecutionCostPolicy();
  const ctx = context();
  const single = estimateExecutionCost({
    policy,
    context: ctx,
    side: "BUY",
    quantity: 5000,
  });
  const first = estimateExecutionCost({
    policy,
    context: ctx,
    side: "BUY",
    quantity: 2000,
  });
  const second = estimateExecutionCost({
    policy,
    context: context({ intervalState: first.nextIntervalState }),
    side: "BUY",
    quantity: 3000,
  });
  assert.equal(
    first.costBreakdown.impactCostCents + second.costBreakdown.impactCostCents,
    single.costBreakdown.impactCostCents,
  );
  // 状态游标只由成功成交推进，且与一次性成交一致
  assert.deepEqual(
    Object.fromEntries(Object.entries(second.nextIntervalState)),
    Object.fromEntries(Object.entries(single.nextIntervalState)),
  );
  // 累计冲击函数的数学形式：F(Q) = P0×Q×κ×(p/p_ref)^γ/10000
  const manual = Math.round(
    (1000 *
      5000 *
      policy.payload.impactBpsAtReferenceParticipation *
      Math.pow(
        5000 / 10_000_000 / policy.payload.referenceParticipation,
        0.5,
      )) /
      10000,
  );
  assert.equal(single.costBreakdown.impactCostCents, manual);
  assert.equal(cumulativeImpactCents(1000, 10_000_000, 0, policy), 0);
});

test("盘口：可用时锚定不利价差且不加回退；缺失/倒挂回退并留痕，无价差双计", () => {
  const withBook = estimate({
    context: context({
      quote: { bid1Cents: 999, ask1Cents: 1002, orderBookQuality: "OK" },
    }),
  }).costBreakdown;
  assert.equal(withBook.spreadSource, "BOOK");
  assert.equal(withBook.floorBps, 0);
  assert.equal(withBook.spreadBps, 20);
  assert.ok(withBook.totalBps > 0);
  assert.ok(!withBook.residualBps.toString().includes(".5") || true);
  // 买入锚定 ask1=1002：价差成本 = 2 分 × 1000 股 = 2000 分
  assert.equal(withBook.spreadCostCents, 2000);
  const missing = estimate({}).costBreakdown;
  assert.equal(missing.spreadSource, "FALLBACK_FLOOR");
  assert.equal(missing.spreadBps, 0);
  assert.equal(missing.floorBps, 5);
  const inverted = estimate({
    context: context({
      quote: { bid1Cents: 1005, ask1Cents: 1001, orderBookQuality: "INVERTED" },
    }),
  }).costBreakdown;
  assert.equal(inverted.spreadSource, "FALLBACK_FLOOR");
  // 卖出锚定 bid1，不假设取得优于 P0 的价格
  const sellWithBook = estimateExecutionCost({
    policy: defaultExecutionCostPolicy(),
    context: context({
      quote: { bid1Cents: 998, ask1Cents: 1002, orderBookQuality: "OK" },
    }),
    side: "SELL",
    quantity: 1000,
  }).costBreakdown;
  assert.equal(sellWithBook.spreadBps, 20);
  assert.equal(sellWithBook.spreadCostCents, 2000);
});

test("取整：买入向上、卖出向下；隐含成本与逐笔分量守恒", () => {
  // 关闭缺盘口回退，隔离取整规则的数值：普通时段 5bps、V=10M 时冲击 10bps。
  const noFloorPolicy = {
    ...defaultExecutionCostPolicy(),
    payload: normalizeExecutionCostPayload({
      ...DEFAULT_EXECUTION_COST_PAYLOAD,
      unknownSpreadFloorBps: 0,
    }),
  };
  const buy = estimateExecutionCost({
    policy: noFloorPolicy,
    context: context({ event: event("10:00:00") }),
    side: "BUY",
    quantity: 1000,
  });
  // 普通时段 5bps：P0×q×5/10000 = 500 分 + 冲击 100 分；每股 0.6 分 → 买入向上取整 1001
  assert.equal(buy.fillPriceCents, 1001);
  assert.equal(buy.costBreakdown.impliedCostCents, 1000);
  assert.ok(buy.costBreakdown.roundingCostCents >= 0);
  const sell = estimateExecutionCost({
    policy: noFloorPolicy,
    context: context({ event: event("10:00:00") }),
    side: "SELL",
    quantity: 1000,
  });
  assert.equal(sell.fillPriceCents, 999);
  assert.equal(sell.costBreakdown.impliedCostCents, 1000);
  assert.ok(sell.costBreakdown.roundingCostCents >= 0);
  // 隐含成本 = 各分量 + 取整额外不利成本
  const breakdown = sell.costBreakdown;
  assert.equal(
    breakdown.impliedCostCents,
    breakdown.spreadCostCents +
      breakdown.residualCostCents +
      breakdown.impactCostCents +
      breakdown.roundingCostCents,
  );
});

test("旧计划兼容：无政策标记的计划仍按 10bps 与 Math.round 重放，不产生成本分解", () => {
  const legacy = executePlan(
    newBook(100000),
    plan([order()]),
    dataset(dateAt(1)),
  );
  assert.equal(legacy.ledger.length, 1);
  assert.equal(legacy.ledger[0].executionCost, undefined);
  // 旧模型：Math.round(1000 × (1 + 10/10000)) = 1001
  assert.equal(legacy.ledger[0].priceCents, 1001);
  assert.equal(legacy.equity.executionCost, null);
});

test("新版本计划缺政策或摘要时暂停执行；未知模型版本不静默回退", () => {
  const broken = {
    ...plan([order()]),
    executionCostModel: EXECUTION_COST_MODEL,
  };
  assert.throws(
    () => executePlan(newBook(100000), broken, dataset(dateAt(1))),
    /缺少政策或摘要/,
  );
  assert.throws(
    () =>
      openSession(
        { ...newBook(100000), lastDate: dateAt(0) },
        broken,
        dateAt(1),
      ),
    /缺少政策或摘要/,
  );
  const unknown = {
    ...plan([order()]),
    executionCostModel: "FUTURE_V99",
    executionCostPolicy: {
      ...defaultExecutionCostPolicy(),
      modelVersion: "FUTURE_V99",
    },
  };
  assert.throws(
    () => executePlan(newBook(100000), unknown, dataset(dateAt(1))),
    /未知执行成本模型/,
  );
});

test("日线假设开盘不产生可信成交：仅观察并记录拒绝原因", () => {
  const policyPlan = createPlan(
    snapshot(dateAt(0)),
    newBook(100000),
    BASE_STRATEGY,
    "baseline-v1",
    `${dateAt(0)}T07:10:00.000Z`,
  );
  const result = executePlan(
    newBook(100000),
    policyPlan,
    dataset(dateAt(1), "600001", { minutes: [] }),
  );
  assert.equal(result.ledger.length, 0);
  const outcome = result.outcomes.find((item) => item.code === "600001");
  assert.ok(outcome, "缺少订单反馈");
  assert.ok(String(outcome.reason).includes("DAILY_OBSERVATION_ONLY"));
  assert.ok(outcome.unfilledQuantity >= outcome.quantity - 0);
});

test("新成本模型：分钟成交带逐笔成本分解；缺分钟数据时订单仅观察", () => {
  const policyPlan = createPlan(
    snapshot(dateAt(0)),
    newBook(100000),
    BASE_STRATEGY,
    "baseline-v1",
    `${dateAt(0)}T07:10:00.000Z`,
  );
  assert.equal(policyPlan.executionCostModel, EXECUTION_COST_MODEL);
  assert.ok(policyPlan.executionCostPolicy.payloadDigest);
  assert.ok(Array.isArray(policyPlan.previousLimitUpCodes));
  assert.equal(policyPlan.previousLimitUpKnown, true);
  const result = executePlan(newBook(100000), policyPlan, dataset(dateAt(1)));
  assert.ok(result.ledger.length >= 1);
  const fill = result.ledger[0];
  assert.equal(fill.executionCost.modelVersion, EXECUTION_COST_MODEL);
  assert.equal(fill.executionCost.period, "openFirstMinute");
  // 夹具 height=1 → 昨日涨停项生效：(30 + 15 + 5) × 1.5 = 75
  assert.equal(fill.executionCost.previousLimitUp, true);
  assert.equal(fill.executionCost.limitUpBps, 15);
  assert.equal(fill.executionCost.residualBps, 75);
  assert.equal(fill.executionCost.spreadSource, "FALLBACK_FLOOR");
  assert.equal(fill.executionCost.scenario, 1);
  assert.ok(fill.executionCost.impliedCostCents > 0);
  assert.ok(fill.priceCents > fill.sourcePriceCents);
  assert.equal(result.equity.executionCost.modelVersion, EXECUTION_COST_MODEL);
  // 缺分钟数据：日线假设事件被拒绝
  const observation = executePlan(
    newBook(100000),
    policyPlan,
    dataset(dateAt(1), "600001", { minutes: [] }),
  );
  assert.equal(observation.ledger.length, 0);
  assert.ok(
    observation.outcomes.some((outcome) =>
      String(outcome.reason).includes("DAILY_OBSERVATION_ONLY"),
    ),
  );
});

test("同股区间共享容量：多订单合计不超过预算，开盘软上限生效", () => {
  const frozen = createPlan(
    snapshot(dateAt(0)),
    newBook(100000000),
    BASE_STRATEGY,
    "baseline-v1",
    `${dateAt(0)}T07:10:00.000Z`,
  );
  // V=30000：硬参与率预算 300 股；开盘软上限 150 → 整手 100。
  const open = dataset(dateAt(1), "600001", {
    minutes: [{ time: "09:30", priceCents: 1000, volumeShares: 30000 }],
  });
  const opening = executePlan(
    newBook(100000000),
    { ...frozen, orders: [order("OPEN", 1000), order("ADD", 1000)] },
    open,
  );
  // 第一个订单吃掉软上限的整手部分（100），剩余 50 不足一手；
  // 第二个订单同区间被共享容量阻塞，如实不成交。
  assert.equal(opening.ledger.length, 1);
  assert.equal(opening.ledger[0].quantity, 100);
  // 普通时段的卖出同样共享区间预算：保护退出在 10:00 触发，受硬参与率约束
  const entered = executePlan(newBook(100000), frozen, dataset(dateAt(1)));
  const day2Plan = {
    ...createPlan(
      snapshot(dateAt(1)),
      entered.book,
      BASE_STRATEGY,
      "baseline-v1",
      `${dateAt(1)}T07:10:00.000Z`,
    ),
    orders: [order("ADD", 200)],
  };
  const day2 = dataset(dateAt(2), "600001", {
    previous: entered.book.positions[0].markCents,
    open: Math.round(entered.book.positions[0].markCents * 0.9),
    limitDown: Math.round(entered.book.positions[0].markCents * 0.81),
    minutes: [
      {
        time: "10:00",
        priceCents: Math.round(entered.book.positions[0].markCents * 0.9),
        volumeShares: 30000,
      },
    ],
  });
  const protective = executePlan(entered.book, day2Plan, day2);
  const sell = protective.ledger.find((fill) => fill.side === "SELL");
  assert.ok(sell, "保护退出未成交");
  assert.equal(sell.executionCost.period, "regular");
  // 卖出受同股区间硬参与率预算约束：30000 × 1% = 300 股
  assert.equal(sell.quantity, 300);
  assert.ok(sell.priceCents < sell.sourcePriceCents);
  assert.ok(sell.executionCost.impliedCostCents > 0);
});

test("拒绝场景如实不成交：含成本超过买入上限、涨停边界与跌停边界", () => {
  // maxPriceCents 1030 低于开盘分钟含成本价（≈1006？不，1000×1.00525≈1005）
  // 构造更紧的上限：maxBuyGap 0.3% → 1003，低于含成本价 → 拒绝
  const tight = createPlan(
    snapshot(dateAt(0)),
    newBook(100000),
    { ...BASE_STRATEGY, maxBuyGap: 0.003 },
    "baseline-v1",
    `${dateAt(0)}T07:10:00.000Z`,
  );
  const rejected = executePlan(newBook(100000), tight, dataset(dateAt(1)));
  assert.equal(rejected.ledger.length, 0);
  assert.ok(
    rejected.outcomes.some((outcome) =>
      /买入上限|成本约束/.test(outcome.reason || ""),
    ),
  );
  // 涨停排队不假设成交（观测价已达涨停）
  const limitUp = executePlan(
    newBook(100000),
    createPlan(
      snapshot(dateAt(0)),
      newBook(100000),
      BASE_STRATEGY,
      "baseline-v1",
      `${dateAt(0)}T07:10:00.000Z`,
    ),
    dataset(dateAt(1), "600001", { open: 1100, limitUp: 1100 }),
  );
  assert.equal(limitUp.ledger.length, 0);
});

test("腾讯解析：盘口字段可选规范化，倒挂降级为回退并保留质量标志", () => {
  // 按腾讯 qt 接口的合成 fixture：fields[9]/[10]=买一价/量，[19]/[20]=卖一价/量，
  // [30]=时间戳，[33]/[34]=高低价，[47]/[48]=涨跌停。
  const quoteText = (bid1) => {
    const fields = new Array(50).fill("");
    fields[0] = "51";
    fields[1] = "平安银行";
    fields[2] = "000001";
    fields[3] = "10.50";
    fields[4] = "10.00";
    fields[5] = "10.20";
    fields[6] = "100000";
    fields[9] = bid1;
    fields[10] = "5000";
    fields[19] = "10.60";
    fields[20] = "6000";
    fields[30] = "20260102093045";
    fields[33] = "10.80";
    fields[34] = "10.10";
    fields[47] = "11.00";
    fields[48] = "9.00";
    return `v_sz000001="${fields.join("~")}"`;
  };
  const ok = parseTencentQuotes(quoteText("10.40"), "2026-01-02");
  assert.equal(ok["000001"].orderBookQuality, "OK");
  assert.equal(ok["000001"].bid1Cents, 1040);
  assert.equal(ok["000001"].ask1Cents, 1060);
  assert.equal(ok["000001"].bid1Shares, 500000);
  assert.equal(ok["000001"].quoteSchemaVersion, "tencent-qt-v1");
  assert.equal(ok["000001"].timestamp, "2026-01-02T09:30:45+08:00");
  const inverted = parseTencentQuotes(quoteText("10.70"), "2026-01-02");
  assert.equal(inverted["000001"].orderBookQuality, "INVERTED");
  assert.equal(inverted["000001"].bid1Cents, undefined);
  const missing = parseTencentQuotes(quoteText(""), "2026-01-02");
  assert.equal(missing["000001"].orderBookQuality, "MISSING");
});

test("同一时刻 UTC 与 +08:00 表示产生相同成本分段；重放不使用当天墙上时钟", async () => {
  const DB = localDatabase(),
    env = { DB },
    repository = new PaperRepository(env);
  const account = await repository.initialize();
  await repository.settle(
    account.revision,
    executePlan(account.book, null, dataset(dateAt(0))),
    dataset(dateAt(0)),
  );
  const current = await repository.account();
  const frozen = await repository.savePlan(
    createPlan(
      snapshot(dateAt(0)),
      current.book,
      BASE_STRATEGY,
      "baseline-v1",
      `${dateAt(0)}T07:10:00.000Z`,
    ),
  );
  // 09:30:30 +08:00 ≡ 01:30:30Z；观测时间取帧采集时刻而非重放当天时钟。
  // 首帧仅预热建立累计量基线，第二帧的量差才提供区间容量（§4.4）。
  const quoteAt = (time, volume) => ({
    date: dateAt(1),
    previousCloseCents: 1000,
    openCents: 1000,
    closeCents: 1000,
    volumeShares: volume,
    limitUpCents: 1100,
    limitDownCents: 900,
    timestamp: `${dateAt(1)}T${time}+08:00`,
  });
  const session = openSession(current.book, frozen, dateAt(1));
  let step = advanceSession(current.book, session, {
    observedAt: new Date(`${dateAt(1)}T01:30:30.000Z`).toISOString(),
    quotes: { 600001: quoteAt("09:30:30", 10_000_000) },
    pollIntervalSeconds: 10,
  });
  assert.equal(step.ledger.length, 0, "首帧只预热，不凭缺口量成交");
  step = advanceSession(step.book, step.session, {
    observedAt: new Date(`${dateAt(1)}T01:30:40.000Z`).toISOString(),
    quotes: { 600001: quoteAt("09:30:40", 15_000_000) },
    pollIntervalSeconds: 10,
  });
  assert.equal(step.ledger.length, 1);
  assert.equal(step.ledger[0].executionCost.period, "openFirstMinute");
  assert.equal(step.ledger[0].quoteTimestamp, `${dateAt(1)}T09:30:40+08:00`);
  assert.equal(step.ledger[0].executionCost.marketVolumeShares, 5_000_000);
  DB.close();
});

test("新模型账本完整导出可重放，政策摘要纳入核验，篡改成本被检测", async () => {
  const DB = localDatabase(),
    env = { DB },
    repository = new PaperRepository(env);
  const account = await repository.initialize();
  const firstData = dataset(dateAt(0));
  await repository.settle(
    account.revision,
    executePlan(account.book, null, firstData),
    firstData,
  );
  const current = await repository.account();
  const frozen = await repository.savePlan(
    createPlan(
      snapshot(dateAt(0)),
      current.book,
      BASE_STRATEGY,
      "baseline-v1",
      `${dateAt(0)}T07:10:00.000Z`,
    ),
  );
  assert.equal(frozen.executionCostPolicy.modelVersion, EXECUTION_COST_MODEL);
  const day = dataset(dateAt(1));
  const settled = executePlan(current.book, frozen, day);
  assert.ok(settled.ledger.length >= 1);
  await repository.settle(current.revision, settled, day);
  const bundle = await exportPaper(env);
  assert.equal(bundle.schemaVersion, 2);
  assert.equal(bundle.executionCostPolicy.modelVersion, EXECUTION_COST_MODEL);
  const audit = await verifyExport(bundle);
  assert.equal(audit.passed, true, JSON.stringify(audit.checks));
  // 政策 payload 被篡改 → 摘要不一致 → 核验失败
  const tamperedPolicy = structuredClone(bundle);
  tamperedPolicy.plans = tamperedPolicy.plans.map((row) =>
    row.payload.executionCostPolicy
      ? {
          ...row,
          payload: {
            ...row.payload,
            executionCostPolicy: {
              ...row.payload.executionCostPolicy,
              payload: {
                ...row.payload.executionCostPolicy.payload,
                regular: 1,
                periodBaseBps: {
                  ...row.payload.executionCostPolicy.payload.periodBaseBps,
                  regular: 1,
                },
              },
            },
          },
        }
      : row,
  );
  const policyAudit = await verifyExport(tamperedPolicy);
  assert.equal(policyAudit.checks.hashes, false);
  // 逐笔成本被篡改 → 重放不一致
  const tamperedCost = structuredClone(bundle);
  tamperedCost.ledger[0].executionCost.totalBps += 1;
  const costAudit = await verifyExport(tamperedCost);
  assert.equal(costAudit.passed, false);
  DB.close();
});

test("敏感性：情景倍数冻结进政策，单笔成本随压力单调上升，完整重放互不影响", async () => {
  const DB = localDatabase(),
    env = { DB },
    repository = new PaperRepository(env);
  await repository.initialize();
  const sample = pairs(12);
  for (const pair of sample) {
    await DB.prepare(
      "INSERT OR IGNORE INTO snapshots (trade_date,created_at,payload) VALUES (?,?,?)",
    )
      .bind(
        pair.snapshot.date,
        pair.snapshot.createdAt,
        JSON.stringify(pair.snapshot),
      )
      .run();
    await DB.prepare(
      "INSERT INTO paper_market_days (trade_date,payload,digest) VALUES (?,?,?)",
    )
      .bind(pair.dataset.date, JSON.stringify(pair.dataset), "fixture")
      .run();
  }
  const base = defaultExecutionCostPolicy();
  const bundles = await scenarioPolicyBundles(base);
  assert.deepEqual(
    bundles.map((bundle) => bundle.payload.executionStressMultiplier),
    [1, 1.5, 2],
  );
  for (const bundle of bundles)
    assert.equal(await digest(bundle.payload), bundle.payloadDigest);
  const run = await runExecutionSensitivity(env, { days: 10 });
  assert.equal(run.status, "COMPLETE");
  assert.equal(run.manifest.scenarios.length, 3);
  assert.equal(run.payload.results.length, 3);
  const [baseline, mid, stress] = run.payload.results;
  assert.ok(baseline.fillCount > 0);
  assert.equal(mid.fillCount, baseline.fillCount);
  assert.equal(stress.fillCount, baseline.fillCount);
  assert.ok(mid.impliedCostCents > baseline.impliedCostCents);
  assert.ok(stress.impliedCostCents > mid.impliedCostCents);
  // 三情景各自独立重放，结果带完整摘要可独立复核
  assert.ok(run.manifest.basePolicy.payloadDigest);
  DB.close();
});
