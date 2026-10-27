import test from "node:test";
import assert from "node:assert/strict";
import {
  initialAdaptiveRisk,
  advanceAdaptiveRisk,
  adaptiveEffective,
  adaptiveRiskView,
  ADAPTIVE_RISK_POLICY,
  ADAPTIVE_RISK_POLICY_V1,
} from "../../shared/adaptive-risk.js";
import {
  defaultDragonConfig,
  dragonEffectiveFields,
} from "../../shared/dragon-risk-config.js";
import {
  createDragonPlan,
  openDragonSession,
  advanceDragonSession,
  assertDragonPlan,
} from "../../backend/domain/dragon-risk.js";
import {
  newBook,
  assertProgramSnapshot,
} from "../../backend/domain/trading.js";
import { defaultExecutionCostPolicy } from "../../shared/execution-cost.js";
import { INTRADAY_ENTRY_VERSION } from "../../backend/domain/intraday-entry.js";
import { localDatabase } from "../../scripts/local-db.mjs";
import { RealtimeRepository } from "../../backend/storage/realtime.js";
import { previewLiveDragonConfig } from "../../backend/services/dragon-risk.js";
import { realtimeStatus } from "../../backend/services/realtime.js";
import { collectEntryMarket } from "../../backend/services/intraday-inputs.js";
import { api } from "../../backend/routes/api.js";
import { ENTRY_ORDER_POLICY } from "../../shared/entry-order-policy.js";

const date = "2026-10-26",
  signalDate = "2026-10-23";
const stamp = (seconds) =>
  new Date(Date.parse(`${date}T09:30:00+08:00`) + seconds * 1000).toISOString();
const config = defaultDragonConfig();
function market(seconds, extra = {}) {
  return {
    date,
    observedAt: stamp(Math.floor(seconds / 30) * 30),
    cycle: { phase: "rising" },
    sectorsComplete: true,
    metrics: {
      limitUp: 80,
      broken: 0,
      height: 5,
      premium: 3,
      premiumCoverage: 1,
      ...extra.metrics,
    },
    sectors: [{ name: "测试行业", score: 85, count: 6, broken: 0 }],
    discoveries: [],
    ...Object.fromEntries(
      Object.entries(extra).filter(([k]) => k !== "metrics"),
    ),
  };
}
function quote(seconds, { price = 1000, volume = 1000000, ...extra } = {}) {
  return {
    date,
    timestamp: stamp(seconds),
    closeCents: price,
    previousCloseCents: 1000,
    openCents: 940,
    highCents: 1000,
    lowCents: 940,
    volumeShares: volume,
    limitUpCents: 1100,
    limitDownCents: 900,
    ask1Cents: price + 1,
    bid1Cents: price - 1,
    ask1Shares: 1000000,
    bid1Shares: 1000000,
    orderBookQuality: "OK",
    orderBookTimestamp: stamp(seconds),
    ...extra,
  };
}
function sense(state, seconds, extra = {}) {
  return advanceAdaptiveRisk(state, {
    observedAt: stamp(seconds),
    market: market(seconds),
    quotes: { 600001: quote(seconds) },
    sectors: { 600001: "测试行业" },
    ...extra,
  });
}
function warmed(extra = {}) {
  const state = initialAdaptiveRisk(date);
  for (let i = 0; i <= 330; i += 10)
    sense(state, i, typeof extra === "function" ? extra(i) : extra);
  return state;
}
const effective = (state) =>
  adaptiveEffective(config, state, { code: "600001", sector: "测试行业" });

test("同一上升标签仍有不同连续预算；同样当前强度下恶化速度会继续收紧", () => {
  const strong = warmed((i) => ({
    market: market(i, {
      metrics: { limitUp: 70, broken: 10, height: 4, premium: 2 },
    }),
  }));
  const weak = warmed((i) => ({
    market: market(i, {
      metrics: { limitUp: 55, broken: 10, height: 4, premium: 2 },
    }),
  }));
  assert.equal(strong.market.phase, weak.market.phase);
  assert.equal(strong.market.phase, "rising");
  assert.ok(effective(strong).entryRisk > effective(weak).entryRisk);
  const before = strong.market.applied;
  sense(strong, 340, {
    market: market(340, {
      metrics: { limitUp: 70, broken: 10, height: 4, premium: 2 },
    }),
  });
  sense(strong, 350, {
    market: market(350, {
      metrics: { limitUp: 70, broken: 10, height: 4, premium: 2 },
    }),
  });
  sense(strong, 360, {
    market: market(360, {
      metrics: { limitUp: 55, broken: 10, height: 4, premium: 2 },
    }),
  });
  assert.ok(strong.market.applied < before);
  assert.ok(strong.market.applied < weak.market.applied);
});

test("缓存快照不增加确认；至少三份独立快照与60秒后逐步恢复", () => {
  const state = initialAdaptiveRisk(date);
  for (let i = 0; i <= 50; i += 10) sense(state, i);
  assert.equal(state.market.warming.count, 2);
  assert.equal(effective(state).open, false);
  sense(state, 60);
  assert.equal(state.market.warming.count, 3);
  assert.equal(state.market.applied, ADAPTIVE_RISK_POLICY.recoveryStep);
  assert.equal(effective(state).open, true);
  sense(state, 70);
  assert.equal(state.market.applied, 0.2);
  sense(state, 90);
  assert.equal(state.market.applied, 0.4);
  const e = effective(state);
  assert.ok(
    e.protection.grossWeight > e.grossWeight,
    "预热恢复只限制新增，不制造存量清仓理由",
  );
});

test("市场、板块、个股分别收紧；持仓与单笔上限取三层最严格约束", () => {
  const state = warmed();
  sense(state, 340);
  sense(state, 350);
  sense(state, 360, {
    market: market(360, {
      sectors: [{ name: "测试行业", score: 60, count: 2, broken: 5 }],
    }),
  });
  const sectorWeak = effective(state);
  assert.ok(sectorWeak.sectorFactor < sectorWeak.marketFactor);
  assert.equal(sectorWeak.factor, sectorWeak.sectorFactor);
  sense(state, 370, {
    market: market(360, {
      sectors: [{ name: "测试行业", score: 60, count: 2, broken: 5 }],
    }),
    quotes: { 600001: quote(370, { price: 975, volume: 5000000 }) },
  });
  const stockWeak = effective(state);
  assert.ok(stockWeak.stockFactor < 1);
  assert.equal(
    stockWeak.factor,
    Math.min(
      stockWeak.marketFactor,
      stockWeak.sectorFactor,
      stockWeak.stockFactor,
    ),
  );
  assert.ok(
    stockWeak.stockWeight <= config.risk.stockWeight * sectorWeak.sectorFactor,
  );
  assert.equal(stockWeak.lossAdd, false);
});

test("缺失、未来、过期数据暂停新增；真实零值是有效观测", () => {
  for (const bad of [
    null,
    market(360, { metrics: { broken: null } }),
    market(360, { observedAt: stamp(390) }),
    market(0),
  ]) {
    const state = warmed();
    sense(state, 360, { market: bad });
    assert.equal(effective(state).open, false);
    assert.equal(effective(state).protection.grossWeight, null);
  }
  const state = warmed();
  sense(state, 340);
  sense(state, 350);
  sense(state, 360, {
    market: market(360, {
      metrics: { limitUp: 0, broken: 0, height: 0, premium: 0 },
    }),
  });
  assert.equal(state.market.valid, true);
  assert.equal(effective(state).marketFactor, 0);
  assert.equal(effective(state).protection.grossWeight, 0);
});

test("3分钟内短断保留确认，超时及午休重建；报价倒序和JSON恢复不产生额外证据", () => {
  const state = warmed(),
    restored = structuredClone(state);
  for (const i of [340, 350, 360]) {
    sense(state, i);
    sense(restored, i);
  }
  assert.deepEqual(restored, state);
  const frozen = JSON.stringify(state);
  sense(state, 360);
  assert.equal(JSON.stringify(state), frozen);
  sense(state, 400);
  assert.equal(effective(state).open, true);
  sense(state, 610);
  assert.equal(effective(state).open, false);
  assert.equal(state.market.warming.count, 1);
  const afternoon = 3.5 * 3600;
  sense(restored, afternoon);
  assert.equal(restored.segment, "PM");
  assert.equal(effective(restored).open, false);
  assert.equal(effective(restored).protection.grossWeight, null);
});

test("三分钟边界按每层自己的采样时刻判断，个股超时不清空仍有效的市场和板块", () => {
  for (const seconds of [509, 510]) {
    const state = warmed();
    sense(state, seconds);
    assert.equal(state.market.ready, true);
    assert.equal(state.sectors["测试行业"].ready, true);
    assert.equal(state.stocks["600001"].ready, true);
    assert.equal(effective(state).open, true);
  }
  const state = warmed();
  sense(state, 510.001);
  assert.equal(state.market.ready, true);
  assert.equal(state.sectors["测试行业"].ready, true);
  assert.equal(state.stocks["600001"].ready, false);
  assert.equal(effective(state).open, false);
});

test("个股暂缺时保留确认与样本、停用过期数据；恢复新报价不重新等待整轮预热", () => {
  const state = warmed();
  for (let seconds = 340; seconds <= 500; seconds += 10)
    sense(state, seconds, { quotes: {} });
  assert.equal(state.stocks["600001"].valid, false);
  assert.equal(state.stocks["600001"].ready, true);
  assert.equal(state.market.ready, true);
  assert.equal(state.sectors["测试行业"].ready, true);
  assert.equal(effective(state).open, false);
  sense(state, 510);
  assert.equal(effective(state).open, true);
  assert.equal(
    state.stocks["600001"].trend.oneMinute,
    null,
    "缺口不冒充1分钟趋势",
  );
});

test("市场指标和板块数据分别恢复，单层缺失不抹掉其他层新鲜观测", () => {
  const state = warmed();
  const sectorCount = state.sectors["测试行业"].warming.count;
  sense(state, 360, { market: market(360, { metrics: { broken: null } }) });
  assert.equal(state.market.valid, false);
  assert.equal(state.market.ready, true);
  assert.equal(state.sectors["测试行业"].valid, true);
  assert.ok(state.sectors["测试行业"].warming.count > sectorCount);
  sense(state, 390, {
    market: market(390, {
      sectors: [{ name: "测试行业", score: null, count: 1, broken: 0 }],
    }),
  });
  assert.equal(state.market.valid, true);
  assert.equal(state.market.ready, true);
  assert.equal(state.sectors["测试行业"].valid, false);
  assert.equal(effective(state).open, false);
});

test("新鲜缓存恢复可沿用已确认状态，缓存和重复报价不增加确认次数", () => {
  const state = warmed();
  const count = state.market.warming.count;
  sense(state, 340, { market: null });
  assert.equal(state.market.valid, false);
  sense(state, 350, { market: market(330) });
  assert.equal(state.market.valid, true);
  assert.equal(state.sectors["测试行业"].valid, true);
  assert.equal(state.market.warming.count, count);
  assert.equal(effective(state).open, true);
});

test("原v1政策的20秒断流重放保持不变，不能用新规则改写既有观测", () => {
  const state = initialAdaptiveRisk(date, ADAPTIVE_RISK_POLICY_V1);
  for (let seconds = 0; seconds <= 360; seconds += 10) sense(state, seconds);
  assert.equal(effective(state).open, true);
  sense(state, 400);
  assert.equal(effective(state).open, false);
  assert.equal(state.version, ADAPTIVE_RISK_POLICY_V1.version);
});

test("个股陈旧或重复报价不能完成确认，累计量倒退重新等待有效观测", () => {
  const state = initialAdaptiveRisk(date);
  for (let i = 0; i <= 60; i += 10)
    sense(state, i, { quotes: { 600001: quote(0) } });
  assert.equal(state.market.ready, true);
  assert.equal(effective(state).open, false);
  for (let i = 70; i <= 130; i += 10) sense(state, i);
  assert.equal(effective(state).open, true);
  sense(state, 140, { quotes: { 600001: quote(140, { volume: 500000 }) } });
  assert.equal(state.stocks["600001"].valid, false);
  assert.equal(effective(state).open, false);
});

function fixture({
  held = false,
  sameDay = false,
  legacy = false,
  legacyCancellation = false,
  riskPolicy = ADAPTIVE_RISK_POLICY,
} = {}) {
  const source = {
    date: signalDate,
    stocks: [],
    cycle: { phase: "rising" },
    intradayEntryContext: {
      version: INTRADAY_ENTRY_VERSION,
      asOf: signalDate,
      history: {
        600001: {
          name: "测试股",
          sector: "测试行业",
          stockClass: "relay-leader",
          amount: 500000000,
          recentLimitUp: true,
          previousCloseCents: 1000,
          previousOpenCents: 950,
          previousChange: 10,
          previousHeight: 3,
          previousTouchedLimit: true,
          lastFourCloseSumCents: 3600,
          previousVolumeShares: null,
        },
      },
    },
  };
  const book = {
    ...newBook(),
    lastDate: signalDate,
    tradingPolicyVersion: "dragon-risk-v1",
    dragonConfig: structuredClone(config),
    dragonConfigId: "synthetic-adaptive",
    dragonConfigDigest: "synthetic",
    dragonEngineBuild: "synthetic",
  };
  if (held) {
    book.cashCents -= 10000000;
    book.positions = [
      {
        code: "600001",
        name: "测试股",
        sector: "测试行业",
        heldDays: 1,
        markCents: 1000,
        lots: [
          {
            acquiredDate: sameDay ? date : signalDate,
            quantity: 10000,
            costCents: 10000000,
            priceCents: 1000,
          },
        ],
        dragon: {
          id: "cycle",
          startDate: signalDate,
          p0Cents: 1000,
          r0Cents: 40,
          stopCents: 960,
          highCents: 1000,
          initialQuantity: 10000,
          strategicQuantity: 10000,
          strategicCostCents: 10000000,
          stage: 0,
          holdDays: 4,
          dayAction: signalDate,
        },
      },
    ];
  }
  const plan = createDragonPlan(source, book, `${signalDate}T07:00:00Z`, {
    executionCostPolicy: defaultExecutionCostPolicy(),
    ...(legacy ? { dragonTemplateVersion: "dragon-template-v1" } : {}),
    ...(legacyCancellation ? { entryOrderPolicy: null } : {}),
    adaptiveRiskPolicy: riskPolicy,
  });
  return { source, book, plan, session: openDragonSession(book, plan, date) };
}
function step(f, seconds, extra = {}) {
  const q = quote(seconds, extra.quote);
  const observation = {
    observedAt: stamp(seconds),
    quotes: { 600001: q },
    pollIntervalSeconds: 10,
    entryInputs: {
      market: market(seconds, extra.market),
      auction: {
        600001: { date, final: true, openCents: 940, previousCloseCents: 1000 },
      },
    },
  };
  if (extra.missingMarket) observation.entryInputs.market = null;
  if (extra.entryOrderPolicy)
    observation.entryOrderPolicy = extra.entryOrderPolicy;
  if (extra.adaptiveRiskPolicy)
    observation.adaptiveRiskPolicy = extra.adaptiveRiskPolicy;
  const result = advanceDragonSession(f.book, f.session, observation);
  f.book = result.book;
  f.session = result.session;
  return { ...result, observation };
}
function warmExecution(f, price = 1000) {
  for (let i = 0; i <= 180; i += 10)
    assert.equal(step(f, i, { quote: { price } }).ledger.length, 0);
}

test("新计划冻结感知政策，旧模板按原逻辑回放，删改动态政策被拒绝", () => {
  const f = fixture(),
    old = fixture({ legacy: true });
  assert.deepEqual(
    f.plan.dragonPolicy.adaptiveRiskPolicy,
    ADAPTIVE_RISK_POLICY,
  );
  assert.doesNotThrow(() =>
    assertProgramSnapshot(old.plan, old.source, old.book),
  );
  step(old, 0, { quote: { price: 950 } });
  assert.ok(
    step(old, 10, {
      market: { observedAt: stamp(10) },
      quote: { price: 951, volume: 11000000 },
    }).ledger.some((r) => r.intent === "OPEN"),
  );
  for (const mutate of [
    (p) => delete p.dragonPolicy.adaptiveRiskPolicy,
    (p) => (p.dragonPolicy.adaptiveRiskPolicy.recoveryStep = 1),
  ]) {
    const bad = structuredClone(f.plan);
    mutate(bad);
    assert.throws(() => assertDragonPlan(bad));
  }
});

test("动态确认后真实买入并记录依据；重放、重复帧及重启保持一致", () => {
  const f = fixture();
  warmExecution(f, 950);
  const replay = structuredClone(f);
  const result = step(f, 190, { quote: { price: 951, volume: 11000000 } });
  assert.ok(result.ledger.some((r) => r.intent === "OPEN"));
  assert.equal(
    result.ledger[0].entryEvidence.adaptiveRisk.version,
    ADAPTIVE_RISK_POLICY.version,
  );
  assert.deepEqual(
    step(replay, 190, { quote: { price: 951, volume: 11000000 } }).ledger,
    result.ledger,
  );
  assert.deepEqual(f.session, replay.session);
  assert.equal(
    step(f, 190, { quote: { price: 951, volume: 11000000 } }).ledger.length,
    0,
  );
});

test("可信板块恶化触发减仓并取消买单；缺数据只暂停余单且不强卖", () => {
  for (const missing of [true, false]) {
    const f = fixture({ held: true });
    warmExecution(f);
    step(f, 190);
    step(f, 200);
    f.session.orders.push({
      id: "pending",
      code: "600001",
      intent: "ADD_PROFIT",
      side: "BUY",
      status: "PARTIAL",
      quantity: 2000,
      filledQuantity: 100,
      maxPriceCents: 1030,
      stopCents: 960,
    });
    const result = step(f, 210, {
      quote: { volume: 11000000 },
      missingMarket: missing,
      market: {
        sectors: [{ name: "测试行业", score: 50, count: 1, broken: 5 }],
      },
    });
    assert.equal(
      f.session.orders.find((o) => o.id === "pending").status,
      missing ? "PARTIAL" : "CANCELLED",
    );
    assert.equal(
      result.ledger.some((r) => r.side === "SELL"),
      !missing,
    );
    assert.equal(f.book.positions[0].dragon.stopCents, 960);
  }
});

test("动态减仓继续遵守T+1与真实成交容量，未完成T记录风险中断", () => {
  const f = fixture({ held: true, sameDay: true });
  warmExecution(f);
  step(f, 190);
  step(f, 200);
  const result = step(f, 210, {
    quote: { volume: 11000000 },
    market: { sectors: [{ name: "测试行业", score: 40, count: 0, broken: 5 }] },
  });
  assert.equal(result.ledger.length, 0);
  assert.equal(f.book.positions[0].lots[0].quantity, 10000);
  const old = fixture({ held: true });
  warmExecution(old);
  step(old, 190);
  step(old, 200);
  old.book.positions[0].dragon.t = {
    id: "T-test",
    direction: "REVERSE",
    date,
    firstQuantity: 100,
    secondQuantity: 0,
    cashDeltaCents: 100000,
    firstPriceCents: 1000,
    reservePriceCents: 1030,
    spread: 0.02,
    lastQuote: stamp(180),
  };
  step(old, 210, {
    quote: { volume: 11000000, ask1Shares: 0, bid1Shares: 0 },
    market: { sectors: [{ name: "测试行业", score: 40, count: 0, broken: 5 }] },
  });
  assert.equal(old.book.dragonTRecords.at(-1).status, "ABORTED_BY_RISK");
  assert.equal(old.book.positions[0].lots[0].quantity, 10000);
});

test("动态减仓按当帧买盘部分成交；旧版缺数据撤单保持原重放语义", () => {
  const held = fixture({ held: true });
  warmExecution(held);
  step(held, 190);
  step(held, 200);
  const cut = step(held, 210, {
    quote: { volume: 11000000, bid1Shares: 100 },
    market: { sectors: [{ name: "测试行业", score: 50, count: 1, broken: 5 }] },
  });
  assert.equal(cut.ledger[0].quantity, 100);
  assert.equal(held.book.positions[0].lots[0].quantity, 9900);
  const f = fixture({ legacyCancellation: true });
  warmExecution(f, 950);
  step(f, 190, { quote: { price: 951, volume: 11000000, ask1Shares: 0 } });
  const original = f.session.orders.find((o) => o.intent === "OPEN");
  assert.equal(original.filledQuantity, 0);
  step(f, 200, {
    missingMarket: true,
    quote: { price: 951, volume: 11000000 },
  });
  assert.equal(
    f.session.orders.find((o) => o.id === original.id).status,
    "CANCELLED",
  );
  for (let i = 210; i <= 280; i += 10)
    step(f, i, { quote: { price: 951, volume: 11000000 } });
  const resumed = step(f, 290, { quote: { price: 952, volume: 21000000 } });
  assert.ok(resumed.ledger.some((r) => r.intent === "OPEN"));
  assert.notEqual(resumed.ledger[0].orderId, original.id);
});

test("300股部分成交后断流：预热保留原余单与数量，确认恢复后续买，重复帧及JSON重启可重放", () => {
  const f = fixture();
  warmExecution(f, 950);
  step(f, 190, { quote: { price: 951, volume: 11000000, ask1Shares: 300 } });
  const original = structuredClone(
    f.session.orders.find((o) => o.intent === "OPEN"),
  );
  assert.equal(original.filledQuantity, 300);
  const replay = structuredClone(f);
  const observe = (target, seconds) =>
    step(target, seconds, {
      quote: {
        price: 952,
        volume: 20000000 + (seconds - 600) * 10000,
        ask1Shares: 300,
      },
    });
  assert.equal(observe(f, 600).ledger.length, 0);
  const pending = f.session.orders.find((o) => o.id === original.id);
  assert.equal(pending.status, "PARTIAL");
  assert.equal(pending.quantity, original.quantity);
  assert.equal(pending.filledQuantity, 300);
  assert.equal(pending.entryPaused, true);
  assert.ok(
    Object.values(f.session.practice.decisions).some(
      (d) => d.reasonCode === "ADAPTIVE_WAIT",
    ),
  );
  assert.deepEqual(observe(replay, 600).ledger, []);
  assert.equal(observe(f, 600).ledger.length, 0);
  assert.equal(observe(replay, 600).ledger.length, 0);
  let newFills = 0;
  for (let seconds = 610; seconds <= 690; seconds += 10) {
    const result = observe(f, seconds);
    assert.deepEqual(result.ledger, observe(replay, seconds).ledger);
    newFills += result.ledger.length;
  }
  assert.ok(newFills > 0);
  assert.deepEqual(f.session, replay.session);
  assert.equal(
    f.session.orders.find((o) => o.id === original.id).adaptiveCancelled,
    undefined,
  );
});

test("旧冻结计划仅在显式续跑边界后启用预热等待；真实熔断和到期仍取消余单", () => {
  const old = fixture({ legacyCancellation: true });
  warmExecution(old, 950);
  step(old, 190, { quote: { price: 951, volume: 11000000, ask1Shares: 300 } });
  const continued = structuredClone(old);
  step(old, 600, { quote: { price: 952, volume: 20000000 } });
  assert.equal(old.session.orders[0].status, "CANCELLED");
  step(continued, 600, {
    quote: { price: 952, volume: 20000000 },
    entryOrderPolicy: ENTRY_ORDER_POLICY,
  });
  assert.equal(continued.session.orders[0].status, "PARTIAL");
  assert.equal(continued.session.orders[0].entryPaused, true);
  const halted = structuredClone(continued),
    expired = structuredClone(continued);
  halted.book.dragonHalted = true;
  step(halted, 610, {
    missingMarket: true,
    quote: { price: 952, volume: 21000000 },
    entryOrderPolicy: ENTRY_ORDER_POLICY,
  });
  assert.equal(halted.session.orders[0].status, "CANCELLED");
  expired.session.orders[0].expiresAt = "09:39:59";
  step(expired, 610, {
    quote: { price: 952, volume: 21000000 },
    entryOrderPolicy: ENTRY_ORDER_POLICY,
  });
  assert.equal(expired.session.orders[0].status, "EXPIRED_PARTIAL");
  assert.equal(expired.session.orders[0].filledQuantity, 300);
});

test("动态减仓不能遮蔽盈利档位与跟踪止损，即使卖出容量受限仍先提高保护位", () => {
  const f = fixture({ held: true });
  warmExecution(f);
  step(f, 190);
  step(f, 200);
  const reduced = step(f, 210, {
    quote: { price: 1085, volume: 11000000, bid1Shares: 100 },
  });
  assert.equal(reduced.ledger[0].quantity, 100);
  assert.equal(f.book.positions[0].dragon.stage, 2);
  assert.equal(f.book.positions[0].dragon.stopCents, 1045);
  step(f, 220, { quote: { price: 1030, volume: 21000000, bid1Shares: 100 } });
  assert.equal(f.book.positions[0].dragon.exit, true);
  assert.equal(f.book.positions[0].dragon.r0Cents, 40);
});

test("不可信板块名称按普通键保存，JSON重启后仍可独立重算", () => {
  const state = initialAdaptiveRisk(date);
  for (let i = 0; i <= 180; i += 10)
    sense(state, i, {
      sectors: { 600001: "__proto__" },
      market: market(i, {
        sectors: [{ name: "__proto__", score: 85, count: 6, broken: 0 }],
      }),
    });
  const restored = JSON.parse(JSON.stringify(state));
  sense(restored, 190, {
    sectors: { 600001: "__proto__" },
    market: market(190, {
      sectors: [{ name: "__proto__", score: 85, count: 6, broken: 0 }],
    }),
  });
  assert.equal(Object.hasOwn(restored.sectors, "__proto__"), true);
  assert.equal({}.applied, undefined);
});

test("预览API兼容原四态请求，拒绝混用模式和注入字段", async (t) => {
  const DB = await localDatabase(":memory:");
  t.after(() => DB.close());
  const request = (body) =>
    api(
      new Request("http://localhost/api/paper/dragon/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { DB },
    );
  const manual = await request({ config, phase: "climax" });
  assert.equal(manual.status, 200);
  assert.equal((await manual.json()).effective.lossAdd, false);
  const live = await request({ config, mode: "live" });
  assert.equal(live.status, 200);
  assert.equal((await live.json()).effective.open, false);
  for (const fields of [
    { mode: "live", phase: "rising" },
    { mode: "ai" },
    { adaptiveRisk: { factor: 1 } },
  ])
    assert.equal((await request({ config, ...fields })).status, 400);
});

test("实时状态与草稿预览共用同一冻结感知状态，预览不写库或增加确认", async (t) => {
  const DB = await localDatabase(":memory:");
  t.after(() => DB.close());
  const env = { DB },
    repo = new RealtimeRepository(env);
  await repo.initialize();
  const f = fixture();
  warmExecution(f, 950);
  const before = await repo.account();
  await repo.commitObservation(
    before.revision,
    { book: f.book, session: f.session, ledger: [] },
    { observedAt: f.session.lastObservedAt },
  );
  const now = new Date(stamp(180));
  const stored = JSON.stringify(await repo.session(date));
  const revision = (await repo.account()).revision;
  const preview = await previewLiveDragonConfig(env, config, now);
  const actual = (await realtimeStatus(env, now)).session.dragonExecution;
  assert.deepEqual(preview.effective, actual.adaptiveRisk.effective);
  assert.deepEqual(preview.fields, actual.effectiveFields);
  assert.deepEqual(
    preview.fields,
    dragonEffectiveFields(
      config,
      f.session.regime.phase,
      false,
      f.session.adaptiveRisk,
    ),
  );
  assert.equal(JSON.stringify(await repo.session(date)), stored);
  assert.equal((await repo.account()).revision, revision);
  const expired = await previewLiveDragonConfig(
    env,
    config,
    new Date(stamp(400)),
  );
  assert.equal(expired.effective.open, false);
});

test("盘中采集接入原始溢价、板块炸板数与30秒独立缓存参数，保留原采集时间", async () => {
  const fetchedAt = stamp(0);
  let options;
  const result = await collectEntryMarket(date, {
    provider: async (_, __, policy) => {
      options = policy;
      return {
        date,
        fetchedAt,
        rows: [{ c: "600001", n: "测试股", hybk: "测试行业", lbc: 3, zbc: 0 }],
        broken: 0,
        brokenRows: [],
        previous: [
          { c: "600001", n: "测试股", zdp: 2 },
          { c: "600002", n: "测试股2", zdp: 4 },
        ],
      };
    },
  });
  assert.equal(options.cacheTtlMs, 30000);
  assert.equal(options.cacheScope, "intraday");
  assert.equal(result.observedAt, fetchedAt);
  assert.equal(result.metrics.premium, 3);
  assert.equal(result.metrics.broken, 0);
  assert.equal(result.sectors[0].broken, 0);
});
