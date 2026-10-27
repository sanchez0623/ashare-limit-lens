import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultDragonConfig,
  normalizeDragonConfig,
  dragonCapitalPreset,
  dragonTCapitalLimits,
  DRAGON_T_CAPITAL_POLICY,
} from "../../shared/dragon-risk-config.js";
import { ADAPTIVE_RISK_POLICY } from "../../shared/adaptive-risk.js";
import {
  createDragonPlan,
  openDragonSession,
  advanceDragonSession,
  dragonBudget,
  assertDragonPlan,
} from "../../backend/domain/dragon-risk.js";
import {
  newBook,
  assertProgramSnapshot,
  totalQuantity,
} from "../../backend/domain/trading.js";
import { defaultExecutionCostPolicy } from "../../shared/execution-cost.js";
import { localDatabase } from "../../scripts/local-db.mjs";
import { saveDragonSettings } from "../../backend/services/dragon-risk.js";
import { loadDragonConfig } from "../../backend/storage/dragon-risk.js";

const date = "2026-10-26",
  previous = "2026-10-23";
const codes = ["600001", "600002", "600003", "600004", "600005"];
const stamp = (s) =>
  new Date(Date.parse(`${date}T09:30:00+08:00`) + s * 1000).toISOString();
function config() {
  const c = defaultDragonConfig();
  c.risk = {
    entryRisk: 0.03,
    portfolioRisk: 0.05,
    stockWeight: 0.2,
    sectorWeight: 0.4,
    grossWeight: 0.7,
    maxPositions: 4,
    dailyLoss: 0.03,
    drawdown: 0.12,
  };
  c.advanced.tFraction = 0.5;
  c.operations.profitAdd = c.operations.lossAdd = false;
  return normalizeDragonConfig(c);
}
function position(code, quantity, sector) {
  return {
    code,
    name: code,
    sector,
    markCents: 1000,
    heldDays: 1,
    lots: [
      {
        acquiredDate: previous,
        quantity,
        costCents: quantity * 1000,
        priceCents: 1000,
      },
    ],
    dragon: {
      id: `cycle:${code}`,
      startDate: previous,
      p0Cents: 1000,
      r0Cents: 40,
      stopCents: 960,
      highCents: 1000,
      initialQuantity: quantity,
      strategicQuantity: quantity,
      strategicCostCents: quantity * 1000,
      stage: 0,
      holdDays: 4,
      buyPoint: "limit-up-momentum",
      dayAction: previous,
    },
  };
}
function fixture({
  weights = [20, 20, 20, 10],
  legacy = false,
  factor = 1,
} = {}) {
  const c = config();
  const history = Object.fromEntries(
    codes.map((code, i) => [
      code,
      {
        name: code,
        sector: i < 2 ? "甲" : "乙",
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
    ]),
  );
  const source = {
    date: previous,
    stocks: [],
    cycle: { phase: "rising" },
    intradayEntryContext: {
      version: "intraday-entry-v1",
      asOf: previous,
      history,
    },
  };
  const book = {
    ...newBook(100000),
    lastDate: previous,
    tradingPolicyVersion: "dragon-risk-v1",
    dragonConfig: c,
    dragonConfigId: "t-capital-fixture",
    dragonConfigDigest: "fixture",
    dragonEngineBuild: "fixture",
  };
  book.positions = weights.map((weight, i) =>
    position(codes[i], weight * 100, history[codes[i]].sector),
  );
  book.cashCents -= book.positions.reduce(
    (n, p) => n + totalQuantity(p) * p.markCents,
    0,
  );
  const plan = createDragonPlan(source, book, `${previous}T07:00:00Z`, {
    executionCostPolicy: defaultExecutionCostPolicy(),
    ...(legacy ? { tCapitalPolicy: null } : {}),
  });
  const session = openDragonSession(book, plan, date);
  const at = stamp(300);
  const layer = () => ({
    ready: true,
    valid: true,
    applied: factor,
    observedAt: at,
    protectionKnown: true,
    protectionApplied: factor,
  });
  const sensed = {
    version: ADAPTIVE_RISK_POLICY.version,
    date,
    segment: "AM",
    observedAt: at,
    market: layer(),
    sectors: { 甲: layer(), 乙: layer() },
    stocks: Object.fromEntries(codes.map((code) => [code, layer()])),
  };
  return { c, source, book, plan, session, sensed };
}
function ready(f) {
  f.session.adaptiveRisk = structuredClone(f.sensed);
  f.session.lastObservedAt = stamp(300);
  return f;
}
const budget = (f, code = codes[0], intent = "T_FIRST", max = Infinity) =>
  dragonBudget(f.book, f.session, code, 1000, 960, intent, max);
function overlay(f, index, quantity, direction = "FORWARD") {
  const p = f.book.positions[index];
  p.dragon.t = {
    direction,
    firstQuantity: quantity,
    secondQuantity: 0,
    reservePriceCents: 1030,
  };
  if (direction === "FORWARD") {
    p.lots.push({
      quantity,
      acquiredDate: date,
      costCents: quantity * 1000,
      priceCents: 1000,
      dragonIntent: "T_FORWARD",
    });
    f.book.cashCents -= quantity * 1000;
  } else {
    p.lots[0].quantity -= quantity;
    p.lots[0].costCents -= quantity * 1000;
    f.book.cashCents += quantity * 1000;
  }
}

test("优化方案收紧组合风险至5%、保留底仓70%、T可卖旧仓比例50%，不改其余配置", () => {
  const before = defaultDragonConfig();
  before.buyPoints["auction-dip"] = false;
  before.advanced.tSpread = 0.03;
  const after = dragonCapitalPreset(before);
  assert.equal(after.risk.portfolioRisk, 0.05);
  assert.equal(after.risk.grossWeight, 0.7);
  assert.equal(after.advanced.tFraction, 0.5);
  assert.equal(after.risk.stockWeight, before.risk.stockWeight);
  assert.deepEqual(after.buyPoints, before.buyPoints);
  assert.equal(after.advanced.tSpread, 0.03);
  assert.equal(before.advanced.tFraction, 0.1);
  assert.throws(() =>
    normalizeDragonConfig({
      ...after,
      advanced: { ...after.advanced, tFraction: 0.5001 },
    }),
  );
});

test("满70%底仓可使用T临时额度；旧冻结计划保持原共享上限", () => {
  const current = ready(fixture()),
    old = ready(fixture({ legacy: true }));
  const result = budget(current);
  assert.ok(result.quantity > 0);
  assert.equal(result.capital.coreGrossWeight, 0.7);
  assert.equal(result.capital.peakGrossWeight, 1);
  assert.ok(Math.abs(result.capital.peakStockWeight - 0.3) < 1e-9);
  assert.ok(Math.abs(result.capital.peakSectorWeight - 0.6) < 1e-9);
  assert.equal(budget(old).quantity, 0);
  assert.equal(budget(old).capital, undefined);
});

test("T数量最多50%可卖旧仓；当日新买股份不能扩大可卖基数", () => {
  const f = ready(fixture({ weights: [10] }));
  assert.equal(budget(f).quantity, 500);
  f.book.positions[0].lots[0].acquiredDate = date;
  assert.equal(budget(f).quantity, 0);
});

test("T共用100%峰值上限，不能每只股票额外领取一份30%额度", () => {
  const f = ready(fixture());
  overlay(f, 0, 1000);
  overlay(f, 1, 1000);
  overlay(f, 2, 500);
  const result = budget(f, codes[3]);
  assert.equal(result.capital.totalExposureCents, 9500000);
  assert.equal(result.capCents, 500000);
  assert.ok(result.quantity * 1000 <= 500000);
  overlay(f, 2, 500);
  assert.equal(budget(f, codes[3]).quantity, 0);
});

test("普通加仓使用底仓余额；已开始的T不会占掉未用底仓额度", () => {
  const f = ready(fixture({ weights: [15, 15, 15, 15] }));
  for (let i = 0; i < 3; i++) overlay(f, i, 500);
  const result = budget(f, codes[3], "ADD_PROFIT");
  assert.equal(result.capital.strategicExposureCents, 6000000);
  assert.equal(result.capital.totalExposureCents, 7500000);
  assert.equal(result.quantity, 400);
  const full = ready(fixture());
  overlay(full, 0, 1000);
  assert.equal(budget(full, codes[3], "ADD_LOSS").quantity, 0);
});

test("反向T恢复资金和底仓名额持续预留，不能借给普通加仓", () => {
  const f = ready(fixture());
  overlay(f, 0, 1000, "REVERSE");
  assert.equal(budget(f, codes[3], "ADD_PROFIT").quantity, 0);
  const recovery = budget(f, codes[0], "T_RECOVERY", 1000);
  assert.equal(recovery.quantity, 1000);
  delete f.book.positions[0].dragon.t;
  assert.ok(budget(f, codes[3], "ADD_PROFIT").quantity > 0);
});

test("T峰值随市场缩放；单股板块仍按局部系数收紧", () => {
  const f = ready(fixture({ weights: [10, 10, 10, 5], factor: 0.5 }));
  const result = budget(f);
  assert.equal(result.capital.coreGrossWeight, 0.35);
  assert.equal(result.capital.peakGrossWeight, 0.5);
  assert.ok(result.quantity > 0);
  const local = dragonTCapitalLimits(f.c, {
    grossWeight: 0.56,
    stockWeight: 0.06,
    sectorWeight: 0.12,
  });
  assert.ok(Math.abs(local.grossWeight - 0.8) < 1e-9);
  assert.equal(local.stockWeight, 0.09);
  assert.equal(local.sectorWeight, 0.18);
});

test("组合风险、日亏暂停和回撤熔断继续约束T，不因临时额度绕过", () => {
  for (const reason of ["risk", "daily", "drawdown"]) {
    const f = ready(fixture());
    if (reason === "risk")
      for (const p of f.book.positions) p.dragon.stopCents = 600;
    if (reason === "daily") f.session.dailyPaused = true;
    if (reason === "drawdown") f.book.dragonHalted = true;
    assert.equal(budget(f).quantity, 0, reason);
  }
});

test("新旧计划冻结与原输入重建一致；T资金政策篡改不能通过校验", () => {
  for (const legacy of [true, false]) {
    const f = fixture({ legacy });
    assert.doesNotThrow(() => assertProgramSnapshot(f.plan, f.source, f.book));
    assert.deepEqual(
      f.plan.dragonPolicy.tCapitalPolicy,
      legacy ? undefined : DRAGON_T_CAPITAL_POLICY,
    );
  }
  const f = fixture();
  f.plan.dragonPolicy.tCapitalPolicy.maxGrossWeight = 1.1;
  assert.throws(() => assertDragonPlan(f.plan));
});

test("模拟账户配置接口接受5%组合风险和50%T，登记完整参数供后续计划使用", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const saved = await saveDragonSettings({ DB }, config());
  const record = await loadDragonConfig(DB, saved.dragon.configId);
  assert.equal(record.config.risk.portfolioRisk, 0.05);
  assert.equal(record.config.risk.grossWeight, 0.7);
  assert.equal(record.config.advanced.tFraction, 0.5);
  assert.equal(record.validationMode, "MANUAL_UNVERIFIED");
});

function step(f, seconds, { price = 976, shock = false } = {}) {
  const at = stamp(seconds);
  const quotes = Object.fromEntries(
    f.book.positions.map((p) => [
      p.code,
      {
        date,
        timestamp: at,
        closeCents: price,
        previousCloseCents: 1000,
        openCents: 1000,
        highCents: Math.max(1000, price),
        lowCents: Math.min(976, price),
        volumeShares: 1000000 + seconds * 100000,
        limitUpCents: 1100,
        limitDownCents: 900,
        ask1Cents: price + 1,
        bid1Cents: price - 1,
        ask1Shares: 1000000,
        bid1Shares: 1000000,
        orderBookQuality: "OK",
        orderBookTimestamp: at,
      },
    ]),
  );
  const result = advanceDragonSession(f.book, f.session, {
    observedAt: at,
    quotes,
    pollIntervalSeconds: 10,
    entryInputs: {
      market: {
        date,
        observedAt: at,
        metrics: {
          limitUp: shock ? 0 : 80,
          broken: shock ? 80 : 0,
          height: shock ? 1 : 5,
          heightAvg5: 2,
          premium: shock ? -5 : 5,
          premiumCoverage: 1,
        },
        sectorsComplete: true,
        sectors: ["甲", "乙"].map((name) => ({
          name,
          score: shock ? 0 : 85,
          count: shock ? 0 : 6,
          broken: shock ? 10 : 0,
        })),
        discoveries: [],
      },
      auction: {},
    },
  });
  f.book = result.book;
  f.session = result.session;
  return result;
}

test("真实执行路径：约69%旧仓启动四轮T接近满仓，下一报价不会误判底仓超限，尾盘第二腿遵守T+1", () => {
  const f = fixture({ weights: [19, 19, 19, 12] });
  const originalShares = f.book.positions.map(totalQuantity);
  let first = [];
  for (let s = 0; s <= 300; s += 10) first.push(...step(f, s).ledger);
  first = first.filter((row) => row.intent === "T_FORWARD");
  assert.equal(first.length, 4);
  const exposure =
    f.book.positions.reduce((n, p) => n + totalQuantity(p) * p.markCents, 0) /
    f.book.equityCents;
  assert.ok(exposure > 0.97 && exposure <= 1, exposure);
  const next = step(f, 310);
  assert.equal(next.ledger.length, 0);
  assert.ok(f.book.positions.every((p) => p.dragon.t?.direction === "FORWARD"));
  step(f, 19200);
  const complete = step(f, 19210);
  assert.equal(
    complete.ledger.filter((row) => row.intent === "T_RECOVERY").length,
    4,
  );
  assert.ok(f.book.positions.every((p) => !p.dragon.t));
  assert.deepEqual(f.book.positions.map(totalQuantity), originalShares);
  assert.ok(f.book.cashCents >= 0);
  assert.ok(f.book.dragonTRecords.every((r) => r.status === "COMPLETED"));
});

test("真实执行路径：留有动态仓位余量时，50%旧仓T在达到配对价差后完成", () => {
  const f = fixture({ weights: [10, 10, 10, 10] });
  for (let s = 0; s <= 300; s += 10) step(f, s);
  assert.ok(f.book.positions.every((p) => p.dragon.t?.firstQuantity === 500));
  const complete = step(f, 310, { price: 1001 });
  assert.equal(
    complete.ledger.filter((row) => row.intent === "T_RECOVERY").length,
    4,
  );
  assert.ok(
    f.book.positions.every((p) => totalQuantity(p) === 1000 && !p.dragon.t),
  );
  assert.ok(
    f.book.dragonTRecords.every(
      (r) => r.status === "COMPLETED" && r.netPnlCents > 0,
    ),
  );
});

test("真实执行路径：市场恶化优先中断T并减仓，新买T股份当日不能被卖出", () => {
  const f = fixture({ weights: [19, 19, 19, 12] });
  for (let s = 0; s <= 300; s += 10) step(f, s);
  const newShares = f.book.positions.reduce(
    (n, p) =>
      n +
      p.lots
        .filter((l) => l.acquiredDate === date)
        .reduce((s, l) => s + l.quantity, 0),
    0,
  );
  assert.ok(newShares > 0);
  const result = step(f, 310, { shock: true });
  assert.ok(result.ledger.some((row) => row.side === "SELL"));
  assert.ok(f.book.dragonTRecords.some((r) => r.status === "ABORTED_BY_RISK"));
  assert.equal(
    f.book.positions.reduce(
      (n, p) =>
        n +
        p.lots
          .filter((l) => l.acquiredDate === date)
          .reduce((s, l) => s + l.quantity, 0),
      0,
    ),
    newShares,
  );
  assert.ok(f.book.cashCents >= 0);
});
