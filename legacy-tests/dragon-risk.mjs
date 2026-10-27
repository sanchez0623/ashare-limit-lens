import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultDragonConfig,
  normalizeDragonConfig,
  DRAGON_RISK_FIELDS,
  DRAGON_ADVANCED_FIELDS,
  DRAGON_OPERATION_FIELDS,
  DRAGON_BUY_POINT_FIELDS,
  dragonPreview,
  dragonEffectiveFields,
} from "../shared/dragon-risk-config.js";
import {
  createPlan,
  newBook,
  BASE_STRATEGY,
  assertProgramSnapshot,
  executePlan,
} from "../backend/domain/trading.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../backend/domain/realtime.js";
import { executionEngineBuildDigest } from "../backend/domain/execution-build.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import { defaultExecutionCostPolicy } from "../shared/execution-cost.js";
import { INTRADAY_ENTRY_VERSION } from "../backend/domain/intraday-entry.js";
import { snapshot, dateAt, dataset } from "./fixtures/trading.mjs";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import {
  saveDragonSettings,
  requestDragonActivation,
  applyDragonLifecycle,
  dragonStatus,
  maintainDragonObservation,
  verifyDragonObservation,
} from "../backend/services/dragon-risk.js";
import { QuoteFrameRepository } from "../backend/storage/quotes.js";
import { ShadowAccountRepository } from "../backend/storage/shadow.js";
import {
  consumePortfolioFrame,
  settlePortfolioDay,
} from "../backend/services/portfolio-runner.js";
import { pollTrading } from "../backend/services/realtime.js";
import { runTournamentPoll } from "../backend/services/strategy-tournament.js";
import { startTradingRunner } from "../scripts/trading-runner.mjs";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import {
  validateDragonPatch,
  verifyDragonMatchedDays,
  ensureDragonTemplateResearch,
} from "../backend/services/dragon-research.js";
import {
  selectionPolicyDigest,
  selectionPolicy,
} from "../backend/domain/signal-selection.js";
import { dragonBudget } from "../backend/domain/dragon-risk.js";
import { assertStoredProgramPlan } from "../backend/services/strategy-program-evidence.js";
import {
  registerDragonConfig,
  dragonBookFields,
} from "../backend/storage/dragon-risk.js";

const signalDate = dateAt(0),
  date = dateAt(1);
async function fixture({ held = false, config = defaultDragonConfig() } = {}) {
  const source = snapshot(signalDate, [1000]);
  source.stocks = source.stocks.slice(0, 1);
  source.intradayEntryContext = {
    version: INTRADAY_ENTRY_VERSION,
    asOf: signalDate,
    firstNegMinPrevHeight: 3,
    history: {
      600001: {
        name: "合成龙头",
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
  };
  const book = {
    ...newBook(),
    lastDate: signalDate,
    tradingPolicyVersion: "dragon-risk-v1",
    dragonConfig: config,
    dragonConfigId: "synthetic-config",
    dragonConfigDigest: await digestOf(config),
    dragonEngineBuild: await executionEngineBuildDigest(),
  };
  if (held) {
    book.cashCents -= 1000000;
    book.positions = [
      {
        code: "600001",
        name: "合成龙头",
        sector: "测试行业",
        heldDays: 1,
        markCents: 1000,
        lots: [
          {
            quantity: 1000,
            costCents: 1000000,
            acquiredDate: signalDate,
            priceCents: 1000,
          },
        ],
        dragon: {
          id: `${signalDate}:600001`,
          startDate: signalDate,
          p0Cents: 1000,
          r0Cents: 40,
          stopCents: 960,
          highCents: 1000,
          initialQuantity: 1000,
          strategicQuantity: 1000,
          strategicCostCents: 1000000,
          stage: 0,
          holdDays: 4,
          buyPoint: "auction-dip",
          dayAction: signalDate,
        },
      },
    ];
  }
  const options = {
    dragonTemplateVersion: "dragon-template-v1",
    executionCostPolicy: defaultExecutionCostPolicy(),
    snapshotDigest: await digestOf(source),
  };
  const plan = createPlan(
    source,
    book,
    BASE_STRATEGY,
    "ignored-old-version",
    `${signalDate}T08:00:00Z`,
    options,
  );
  return {
    book,
    source,
    plan,
    options,
    session: openSession(book, plan, date),
  };
}
function frame(
  time,
  price,
  volume,
  { phase = "rising", open = 940, date: day = date, marketStamp, ...rest } = {},
) {
  const stamp = `${day}T${time}+08:00`;
  return {
    observedAt: stamp,
    quotes: {
      600001: {
        date: day,
        timestamp: stamp,
        closeCents: price,
        previousCloseCents: 1000,
        openCents: open,
        highCents: Math.max(1000, price),
        volumeShares: volume,
        limitUpCents: 1100,
        limitDownCents: 900,
        bid1Cents: price - 1,
        ask1Cents: price + 1,
        ask1Shares: 100000,
        bid1Shares: 100000,
        orderBookQuality: "OK",
        orderBookTimestamp: stamp,
        ...rest,
      },
    },
    entryInputs: {
      market: {
        date: day,
        observedAt: marketStamp ?? stamp,
        cycle: { phase },
        metrics: {
          limitUp: 80,
          broken: 0,
          height: 5,
          premium: 3,
          premiumCoverage: 1,
        },
        sectorsComplete: true,
        sectors: [{ name: "测试行业", score: 85, count: 6, broken: 0 }],
        discoveries: [],
      },
      auction: {
        600001: {
          date: day,
          final: true,
          openCents: open,
          previousCloseCents: 1000,
        },
      },
    },
  };
}
function step(f, observation) {
  const result = advanceSession(f.book, f.session, observation);
  f.book = result.book;
  f.session = result.session;
  return result;
}
function closing(day = date, price = 1000) {
  return {
    date: day,
    source: "synthetic",
    quotes: {
      600001: {
        date: day,
        timestamp: `${day}T15:00:00+08:00`,
        previousCloseCents: 1000,
        closeCents: price,
      },
    },
  };
}
test("配置严格限制为11个数值和10个开关，字段与权限不可注入", () => {
  assert.equal(DRAGON_RISK_FIELDS.length + DRAGON_ADVANCED_FIELDS.length, 11);
  assert.equal(
    DRAGON_OPERATION_FIELDS.length + DRAGON_BUY_POINT_FIELDS.length,
    10,
  );
  const c = defaultDragonConfig();
  assert.deepEqual(normalizeDragonConfig(c), c);
  for (const mutation of [
    (x) => delete x.risk.entryRisk,
    (x) => (x.risk.minScore = 1),
    (x) => (x.operations.lossAdd = 1),
    (x) => (x.advanced.stopLoss = NaN),
    (x) => (x.risk.stockWeight = 0.8),
    (x) => (x.version = "signal-ranking-v5"),
  ]) {
    const bad = structuredClone(c);
    mutation(bad);
    assert.throws(() => normalizeDragonConfig(bad));
  }
  assert.equal(dragonPreview(c, "climax").effective.lossAdd, false);
  assert.equal(dragonPreview(c, "unknown").effective.open, false);
  const fields = dragonEffectiveFields(c, "climax");
  assert.equal(fields.length, 21);
  assert.ok(
    Math.abs(fields.find((f) => f.key === "entryRisk").effective - 0.0035) <
      1e-12,
  );
  assert.equal(fields.find((f) => f.key === "lossAdd").effective, false);
  assert.ok(
    dragonEffectiveFields(c, "rising", true)
      .filter((f) => f.unit === "boolean")
      .every((f) => !f.effective),
  );
});
test("新计划完全隔离旧策略、情绪、风控与分类退出参数", async () => {
  const f = await fixture(),
    changed = structuredClone(f.book);
  changed.riskLimits = {
    maxPositionWeight: 0.01,
    maxGrossExposure: 0.01,
    maxDrawdown: 0.005,
    slippageBps: 200,
    maxParticipation: 0.0001,
  };
  const plan = createPlan(
    f.source,
    changed,
    {
      minScore: 999,
      weights: [0, 0, 0, 0, 0, 50],
      stopLoss: 0.99,
      exposureTiers: { midEmotion: 100 },
      pyramidReduce: [0.5, 0.5, 0.5],
    },
    "bad",
    f.plan.createdAt,
    f.options,
  );
  assert.deepEqual(plan, f.plan);
  assert.equal(plan.strategy, undefined);
  assert.equal(plan.riskLimits, undefined);
  assert.doesNotThrow(() => assertProgramSnapshot(plan, f.source, f.book));
  const stripped = structuredClone(plan);
  delete stripped.tradingPolicyVersion;
  assert.throws(() => openSession(f.book, stripped, date), /标记|回退/);
  const missing = structuredClone(plan);
  delete missing.dragonPolicy.config.risk.entryRisk;
  assert.throws(() => openSession(f.book, missing, date), /字段/);
});
test("上升需两份独立市场快照，实际买点与成本后建仓，重复帧不重复扣款", async () => {
  const f = await fixture();
  step(f, frame("09:31:00", 950, 1000000));
  const first = step(f, frame("09:31:10", 951, 11000000));
  assert.ok(first.ledger.length);
  assert.equal(f.book.positions.length, 1);
  assert.ok(f.book.positions[0].dragon.r0Cents > 0);
  assert.ok(first.ledger[0].executionCost);
  const before = structuredClone(f.book);
  assert.equal(step(f, frame("09:31:10", 951, 11000000)).ledger.length, 0);
  assert.deepEqual(f.book, before);
  const old = structuredClone(f.book);
  old.riskLimits.maxDrawdown = 0.00001;
  const a = advanceSession(f.book, f.session, frame("09:31:20", 952, 21000000));
  const b = advanceSession(old, f.session, frame("09:31:20", 952, 21000000));
  assert.deepEqual(a.ledger, b.ledger);
});
for (const [name, price, flag, ratio] of [
  ["盈利", 1022, "profitAdded", 0.5],
  ["亏损", 974, "lossAdded", 0.25],
])
  test(`${name}加仓一次、部分成交续单不重置原R和持仓时钟`, async () => {
    const f = await fixture({ held: true });
    const original = structuredClone(f.book.positions[0].dragon);
    step(f, frame("09:31:00", price - 1, 1000000));
    const result = step(f, frame("09:31:10", price, 11000000));
    assert.ok(
      result.ledger.some(
        (l) => l.intent === (name === "盈利" ? "ADD_PROFIT" : "ADD_LOSS"),
      ),
    );
    const c = f.book.positions[0].dragon;
    assert.equal(c[flag], true);
    assert.equal(c.r0Cents, original.r0Cents);
    assert.equal(c.startDate, original.startDate);
    assert.equal(c.stopCents, original.stopCents);
    assert.ok(
      f.book.positions[0].lots.reduce((n, l) => n + l.quantity, 0) <=
        1000 + 1000 * ratio,
    );
    const again = step(f, frame("09:31:20", price, 21000000));
    assert.equal(again.ledger.length, 0);
  });
test("高潮禁止亏损补仓；同一市场快照反复引用不会提前放宽", async () => {
  const f = await fixture({ held: true }),
    stamp = `${date}T09:31:00+08:00`;
  step(
    f,
    frame("09:31:00", 973, 1000000, { phase: "climax", marketStamp: stamp }),
  );
  assert.equal(
    step(
      f,
      frame("09:31:10", 974, 11000000, { phase: "climax", marketStamp: stamp }),
    ).ledger.length,
    0,
  );
  assert.equal(f.session.regime.phase, "unknown");
  assert.equal(
    step(f, frame("09:31:20", 974, 21000000, { phase: "climax" })).ledger
      .length,
    0,
  );
  assert.equal(f.session.regime.phase, "climax");
});
for (const [name, prices] of [
  ["正向", [978, 979, 1008]],
  ["反向", [1023, 1022, 990]],
])
  test(`${name}T两腿实际配对、T+1、费用、主仓基准不变`, async () => {
    const config = defaultDragonConfig();
    config.operations.profitAdd = false;
    config.operations.lossAdd = false;
    const f = await fixture({ held: true, config }),
      original = structuredClone(f.book.positions[0].dragon);
    step(f, frame("10:01:00", prices[0], 1000000, { open: 1000 }));
    const first = step(
      f,
      frame("10:01:10", prices[1], 11000000, { open: 1000 }),
    );
    assert.equal(first.ledger.length, 1);
    assert.ok(f.book.positions[0].dragon.t);
    assert.equal(
      step(f, frame("10:01:10", prices[1], 11000000, { open: 1000 })).ledger
        .length,
      0,
    );
    const secondQuote = frame("10:01:20", prices[2], 21000000, { open: 1000 });
    secondQuote.quotes[600001].timestamp = new Date(
      secondQuote.observedAt,
    ).toISOString();
    const second = step(f, secondQuote);
    assert.equal(second.ledger.length, 1);
    const p = f.book.positions[0];
    assert.equal(p.dragon.t, null);
    assert.equal(p.dragon.r0Cents, original.r0Cents);
    assert.equal(p.dragon.strategicQuantity, 1000);
    assert.equal(
      p.lots.reduce((n, l) => n + l.quantity, 0),
      1000,
    );
    assert.equal(f.book.dragonTRecords.at(-1).status, "COMPLETED");
    assert.equal(
      f.book.dragonTRecords.at(-1).netPnlCents,
      first.ledger[0].cashDeltaCents + second.ledger[0].cashDeltaCents,
    );
    const closed = closeSession(f.book, f.session, closing());
    assert.equal(closed.session.status, "CLOSED");
  });
test("T未完成跨日保留；冻结行情重放与重启状态完全一致", async () => {
  const config = defaultDragonConfig();
  config.operations.profitAdd = false;
  config.operations.lossAdd = false;
  const f = await fixture({ held: true, config }),
    initial = structuredClone(f.book),
    observations = [
      frame("10:01:00", 978, 1000000, { open: 1000 }),
      frame("10:01:10", 979, 11000000, { open: 1000 }),
    ];
  const all = [];
  for (const o of observations) all.push(...step(f, o).ledger);
  const closed = closeSession(f.book, f.session, closing(date, 979));
  assert.equal(closed.book.pendingRecovery.length, 1);
  let book = initial,
    session = openSession(book, f.plan, date),
    fills = [];
  for (const o of observations) {
    const r = advanceSession(book, JSON.parse(JSON.stringify(session)), o);
    book = r.book;
    session = r.session;
    fills.push(...r.ledger);
  }
  assert.deepEqual(fills, all);
  assert.deepEqual(closeSession(book, session, closing(date, 979)), closed);
});
test("新买份额触发止损不能当日卖出；风险退出持续到下一日", async () => {
  const f = await fixture();
  step(f, frame("09:31:00", 950, 1000000));
  step(f, frame("09:31:10", 951, 11000000));
  const r = step(f, frame("09:31:20", 910, 21000000));
  assert.equal(r.ledger.length, 0);
  assert.equal(f.book.positions[0].dragon.exit, true);
  const closed = closeSession(f.book, f.session, closing(date, 910));
  assert.equal(closed.book.pendingExits.length, 1);
});
test("追加迁移、配置冻结、旧写入拒绝与独立计划绑定", async () => {
  const db = localDatabase(),
    env = { DB: db };
  try {
    const papers = new PaperRepository(env);
    await papers.initialize();
    const saved = await saveDragonSettings(env, defaultDragonConfig());
    assert.equal(saved.dragon.state, "READY");
    assert.equal(saved.dragon.report, null);
    assert.equal(saved.dragon.synthetic.passed, true);
    assert.equal(saved.book.tradingPolicyVersion, undefined);
    const record = await registerDragonConfig(db, defaultDragonConfig());
    const f = await fixture();
    const book = { ...f.book, ...dragonBookFields(record) };
    await db
      .prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
      .bind(JSON.stringify(book))
      .run();
    await assert.rejects(
      () => papers.configure({ riskLimits: f.book.riskLimits }),
      /隔离旧配置/,
    );
    const plan = createPlan(
      f.source,
      book,
      BASE_STRATEGY,
      "old",
      f.plan.createdAt,
      { ...f.options, snapshotDigest: undefined },
    );
    // The real immutable snapshot digest is assigned by the storage boundary.
    f.source.createdAt = `${signalDate}T07:00:00Z`;
    await db
      .prepare(
        "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
      )
      .bind(signalDate, f.source.createdAt, JSON.stringify(f.source))
      .run();
    await papers.savePlan(plan);
    const frozen = await papers.plan(signalDate);
    await assertStoredProgramPlan(env, frozen, book);
    const corrupt = structuredClone(frozen);
    delete corrupt.tradingPolicyVersion;
    await assert.rejects(
      () => assertStoredProgramPlan(env, corrupt, book),
      /标记|回退/,
    );
    assert.equal((await dragonStatus(env, book)).state, "ACTIVE");
  } finally {
    db.close();
  }
});
test("首次手动启用免整日报告；缺覆盖可申请，账本异常、结清及时点继续拦截", async (t) => {
  for (const reportKind of ["MISSING", "INCOMPLETE", "ACCOUNTING_FAILURE"]) {
    await t.test(reportKind, async () => {
      const DB = localDatabase(),
        env = { DB },
        repo = new PaperRepository(env);
      try {
        const opening = await repo.initialize(),
          initial = dataset(signalDate),
          f = await fixture();
        await repo.settle(
          opening.revision,
          executePlan(opening.book, null, initial),
          initial,
        );
        await DB.prepare(
          "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
        )
          .bind(signalDate, f.source.createdAt, JSON.stringify(f.source))
          .run();
        const before = await repo.account();
        await repo.savePlan(
          createPlan(
            f.source,
            before.book,
            BASE_STRATEGY,
            "baseline-v1",
            `${signalDate}T08:00:00Z`,
          ),
        );
        const saved = await saveDragonSettings(env, defaultDragonConfig());
        if (reportKind !== "MISSING") {
          const report = {
            configId: saved.dragon.configId,
            configDigest: await digestOf(saved.dragon.config),
            engineBuild: await executionEngineBuildDigest(),
            date: signalDate,
            passed: false,
            coverage: false,
            replay: true,
            accounting: reportKind !== "ACCOUNTING_FAILURE",
            fills: 0,
          };
          await DB.prepare(
            "INSERT INTO dragon_observation_reports(config_id,trade_date,payload,digest) VALUES(?,?,?,?)",
          )
            .bind(
              saved.dragon.configId,
              signalDate,
              JSON.stringify(report),
              await digestOf(report),
            )
            .run();
        }
        const status = await dragonStatus(env);
        if (reportKind === "ACCOUNTING_FAILURE") {
          assert.equal(status.ready, false);
          await assert.rejects(
            () => requestDragonActivation(env),
            /账本核对失败/,
          );
          assert.equal(
            (await repo.account()).book.tradingPolicyVersion,
            undefined,
          );
          return;
        }
        assert.equal(status.ready, true);
        assert.equal(status.observationVerified, false);
        assert.equal(status.requiresResearch, false);
        assert.equal((await requestDragonActivation(env)).state, "DRAINING");
        let account = await repo.account();
        assert.equal(account.book.tradingPolicyVersion, undefined);
        assert.equal(
          await applyDragonLifecycle(
            env,
            signalDate,
            new Date(`${date}T09:30:00+08:00`),
          ),
          false,
        );
        const beforeOpen = new Date(`${date}T09:29:59+08:00`),
          blocked = {
            ...account.book,
            pendingExits: [{ code: "600001", quantity: 100 }],
          };
        await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
          .bind(JSON.stringify(blocked))
          .run();
        assert.equal(
          await applyDragonLifecycle(env, signalDate, beforeOpen),
          false,
        );
        await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
          .bind(JSON.stringify(account.book))
          .run();
        assert.equal(
          await applyDragonLifecycle(env, signalDate, beforeOpen),
          true,
        );
        account = await repo.account();
        assert.equal(account.book.tradingPolicyVersion, "dragon-risk-v1");
        assert.equal(account.book.cashCents, before.book.cashCents);
        assert.equal(account.book.equityCents, before.book.equityCents);
        assert.equal(account.book.peakEquityCents, before.book.peakEquityCents);
        assert.equal(await repo.plan(signalDate), null);
        assert.equal(
          (
            await DB.prepare(
              "SELECT COUNT(*) AS n FROM paper_plan_revisions WHERE signal_date=?",
            )
              .bind(signalDate)
              .first()
          ).n,
          1,
        );
        assert.equal(
          (await DB.prepare("SELECT COUNT(*) AS n FROM quote_frames").first())
            .n,
          0,
        );
        assert.equal(
          (
            await DB.prepare(
              "SELECT COUNT(*) AS n FROM dragon_observation_reports",
            ).first()
          ).n,
          reportKind === "MISSING" ? 0 : 1,
        );
      } finally {
        DB.close();
      }
    });
  }
});

test("影子准备允许09:26及09:29:59，09:30拒绝；只有新政策影子也持续消费行情", async (t) => {
  for (const time of ["09:26:00", "09:29:59", "09:30:00"]) {
    const DB = localDatabase(),
      env = { DB },
      repo = new PaperRepository(env),
      shadows = new ShadowAccountRepository(env);
    t.after(() => DB.close());
    const account = await repo.initialize(),
      initial = dataset(signalDate),
      f = await fixture();
    await repo.settle(
      account.revision,
      executePlan(account.book, null, initial),
      initial,
    );
    await DB.prepare(
      "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
    )
      .bind(signalDate, f.source.createdAt, JSON.stringify(f.source))
      .run();
    const saved = await saveDragonSettings(env, defaultDragonConfig());
    assert.equal(saved.dragon.observation.status, "WAITING_PREPARATION");
    if (time === "09:26:00") {
      const runner = startTradingRunner(env, async () => null, {
        now: () => new Date(`${date}T${time}+08:00`),
        providers: { quotes: async () => ({}) },
      });
      try {
        await runner.ready;
        assert.ok(await shadows.plan(saved.dragon.observerId, signalDate));
      } finally {
        runner.stop();
      }
    }
    const result = await maintainDragonObservation(
      env,
      signalDate,
      new Date(`${date}T${time}+08:00`),
    );
    if (time === "09:30:00") {
      assert.equal(result, null);
      assert.equal(await shadows.account(saved.dragon.observerId), null);
      continue;
    }
    const observer = await shadows.account(saved.dragon.observerId),
      plan = await shadows.plan(saved.dragon.observerId, signalDate);
    assert.equal(result.status, "OBSERVING");
    assert.equal(
      plan.createdAt,
      new Date(`${date}T${time}+08:00`).toISOString(),
    );
    assert.equal(openSession(observer.book, plan, date).status, "OPEN");
    const latePlan = { ...plan, createdAt: `${date}T09:30:00+08:00` };
    assert.throws(
      () => openSession(observer.book, latePlan, date),
      /执行日前冻结/,
    );
    const obs = frame("09:30:00", 950, 1000000);
    const polled = await runTournamentPoll(env, new Date(obs.observedAt), {
      providers: {
        calendar: async () => ({ dates: [signalDate, date] }),
        quotes: async () => obs.quotes,
        entryInputs: obs.entryInputs,
      },
    });
    assert.ok(polled);
    assert.ok(
      polled.shadows.some(
        (r) => r.accountId === saved.dragon.observerId && r.applied,
      ),
    );
    assert.equal(
      (await shadows.account(saved.dragon.observerId)).cursorSequence,
      1,
    );
    const running = await dragonStatus(
      env,
      null,
      new Date(`${date}T09:30:10+08:00`),
    );
    assert.equal(running.observation.status, "RUNNING");
    assert.equal(running.observation.preparationEnd, "09:30:00");
    assert.equal(running.observation.verificationStart, "17:00:00");
  }
});

test("17:00前不生成核验报告或修改影子状态，17:00开放核验入口", async (t) => {
  const DB = localDatabase(),
    env = { DB },
    repo = new PaperRepository(env);
  t.after(() => DB.close());
  await repo.initialize();
  const saved = await saveDragonSettings(env, defaultDragonConfig());
  const before = await repo.account();
  for (const time of ["15:05:00", "16:59:59"]) {
    const now = new Date(`${date}T${time}+08:00`);
    assert.equal(
      (
        await verifyDragonObservation(
          env,
          saved.dragon.observerId,
          date,
          closing(),
          now,
        )
      ).status,
      "WAITING_VERIFICATION",
    );
    assert.equal(await maintainDragonObservation(env, date, now), null);
    assert.equal(await applyDragonLifecycle(env, date, now), false);
  }
  assert.deepEqual(await repo.account(), before);
  assert.equal(
    (
      await DB.prepare(
        "SELECT COUNT(*) AS n FROM dragon_observation_reports",
      ).first()
    ).n,
    0,
  );
  assert.equal(
    await verifyDragonObservation(
      env,
      saved.dragon.observerId,
      date,
      closing(),
      new Date(`${date}T17:00:00+08:00`),
    ),
    null,
  );
});

test("AI仅可调整两个高级参数组；账户风险和执行纪律拒绝注入", () => {
  const c = defaultDragonConfig();
  assert.equal(
    validateDragonPatch(c, {
      rationale: "合成候选",
      patch: { stopLoss: 0.045, tSpread: 0.025 },
    }).risk.entryRisk,
    0.005,
  );
  for (const patch of [
    { entryRisk: 0.01 },
    { stopLoss: 0.06 },
    { tFraction: 0.12, tSpread: 0.025, stopLoss: 0.045 },
    { stopLoss: 0.04 },
    JSON.parse('{"__proto__":{}}'),
  ])
    assert.throws(() =>
      validateDragonPatch(c, { rationale: "合成候选", patch }),
    );
});
test("待成交买单占用资金与风险，不能把同一预算分给第二只股票", async () => {
  const f = await fixture();
  f.session.regime.phase = "rising";
  f.session.plan.dragonPolicy.config.risk.maxPositions = 1;
  f.session.orders.push({
    id: "reserved",
    code: "600002",
    intent: "OPEN",
    status: "PENDING",
    quantity: 1000,
    filledQuantity: 0,
    maxPriceCents: 1000,
    stopCents: 960,
  });
  const result = dragonBudget(f.book, f.session, "600001", 1000, 960, "OPEN");
  assert.equal(result.quantity, 0);
  assert.match(result.reason, /名额/);
});
test("跳空跨越盈利档位合并减仓；其余仓位跟踪保护，不重复减仓", async () => {
  const f = await fixture({ held: true });
  step(f, frame("10:01:00", 1085, 1000000));
  const result = step(f, frame("10:01:10", 1085, 11000000));
  assert.equal(
    result.ledger.reduce((s, l) => s + l.quantity, 0),
    600,
  );
  assert.equal(f.book.positions[0].dragon.stage, 2);
  assert.equal(f.book.positions[0].dragon.baseQuantity, 1000);
  assert.equal(step(f, frame("10:01:20", 1085, 21000000)).ledger.length, 0);
  assert.ok(
    step(f, frame("10:01:30", 1040, 31000000)).ledger.some(
      (l) => l.intent === "EXIT",
    ),
  );
});
test("低成交容量下加仓分批续单不扩大数量，不重复计次数", async () => {
  const f = await fixture({ held: true });
  step(f, frame("09:31:00", 1021, 1000000));
  const a = step(f, frame("09:31:10", 1022, 1040000));
  assert.equal(a.ledger[0].quantity, 200);
  const b = step(f, frame("09:31:20", 1022, 1080000));
  assert.ok(b.ledger.length);
  assert.ok(f.book.positions[0].dragon.profitAdded);
  const c = step(f, frame("09:31:30", 1022, 1120000));
  assert.equal(
    a.ledger[0].quantity +
      b.ledger[0].quantity +
      c.ledger.reduce((s, l) => s + l.quantity, 0),
    500,
  );
  assert.equal(step(f, frame("09:31:40", 1022, 1160000)).ledger.length, 0);
});
test("日内亏损暂停保持到收盘；回撤熔断后不因价格反弹自动恢复", async () => {
  const f = await fixture({ held: true });
  const p = f.book.positions[0];
  p.lots[0].quantity = 100000;
  p.lots[0].costCents = 100000000;
  f.book.cashCents = 0;
  p.dragon.initialQuantity = 100000;
  p.dragon.strategicQuantity = 100000;
  p.dragon.strategicCostCents = 100000000;
  f.session = openSession(f.book, f.plan, date);
  step(f, frame("10:01:00", 970, 1000000));
  assert.equal(f.session.dailyPaused, true);
  step(f, frame("10:01:10", 990, 11000000));
  assert.equal(f.session.dailyPaused, true);
  step(f, frame("10:01:20", 910, 21000000));
  assert.equal(f.book.dragonHalted, true);
  step(f, frame("10:01:30", 1000, 31000000));
  assert.equal(f.book.dragonHalted, true);
});
test("新排序元数据独立冻结，降级伪装和摘要修改均拒绝", async () => {
  const f = await fixture();
  assert.equal(f.plan.selectionPolicy.version, "dragon-risk-v1");
  assert.equal(
    await digestOf(selectionPolicy("dragon-risk-v1")),
    selectionPolicyDigest(f.plan.selectionPolicy),
  );
  const changed = structuredClone(f.plan);
  changed.selectionPolicy = selectionPolicy("signal-ranking-v5");
  changed.selectionPolicyDigest = selectionPolicyDigest(
    changed.selectionPolicy,
  );
  assert.throws(() => openSession(f.book, changed, date), /排序/);
});
for (const [direction, prices] of [
  ["FORWARD", [978, 979, 1005]],
  ["REVERSE", [1023, 1022, 990]],
]) {
  test(`${direction}未完成T跨日恢复保持周期，恢复买入仍受暂停限制`, async () => {
    const config = defaultDragonConfig();
    config.operations.profitAdd = config.operations.lossAdd = false;
    const f = await fixture({ held: true, config });
    step(f, frame("10:01:00", prices[0], 1000000, { open: 1000 }));
    step(f, frame("10:01:10", prices[1], 11000000, { open: 1000 }));
    const closed = closeSession(f.book, f.session, closing(date, prices[1])),
      next = dateAt(4),
      original = structuredClone(closed.book.positions[0].dragon);
    f.book = closed.book;
    const source = structuredClone(f.source);
    source.date = date;
    source.intradayEntryContext.asOf = date;
    f.plan = createPlan(
      source,
      f.book,
      null,
      null,
      `${date}T08:00:00Z`,
      f.options,
    );
    f.session = openSession(f.book, f.plan, next);
    step(
      f,
      frame("10:01:00", prices[2], 1000000, {
        date: next,
        previousCloseCents: prices[1],
      }),
    );
    if (direction === "REVERSE") {
      const paused = structuredClone(f);
      paused.session.dailyPaused = true;
      assert.equal(
        step(
          paused,
          frame("10:01:10", prices[2], 11000000, {
            date: next,
            previousCloseCents: prices[1],
          }),
        ).ledger.length,
        0,
      );
      assert.ok(paused.book.positions[0].dragon.t);
    }
    const result = step(
      f,
      frame("10:01:10", prices[2], 11000000, {
        date: next,
        previousCloseCents: prices[1],
      }),
    );
    assert.equal(result.ledger[0].intent, "T_RECOVERY");
    assert.equal(f.book.positions[0].dragon.t, null);
    assert.equal(f.book.positions[0].dragon.r0Cents, original.r0Cents);
    assert.equal(f.book.positions[0].dragon.startDate, original.startDate);
    assert.equal(
      f.book.positions[0].lots.reduce((n, l) => n + l.quantity, 0),
      1000,
    );
  });
}
test("反向T预留不能挪给新仓，市场恶化时保护退出优先且中断不算成功", async () => {
  const config = defaultDragonConfig();
  config.operations.profitAdd = config.operations.lossAdd = false;
  config.risk.sectorWeight = config.risk.grossWeight = 0.15;
  const f = await fixture({ held: true, config });
  step(f, frame("10:01:00", 1023, 1000000, { open: 1000 }));
  step(f, frame("10:01:10", 1022, 11000000, { open: 1000 }));
  const reserved = dragonBudget(f.book, f.session, "600002", 1000, 960, "OPEN");
  const free = structuredClone(f.book);
  delete free.positions[0].dragon.t;
  const unreserved = dragonBudget(free, f.session, "600002", 1000, 960, "OPEN");
  assert.ok(reserved.capCents < unreserved.capCents);
  const exit = step(
    f,
    frame("10:01:20", 910, 21000000, { phase: "freezing", open: 1000 }),
  );
  assert.equal(
    exit.ledger
      .filter((l) => l.side === "SELL")
      .reduce((n, l) => n + l.quantity, 0),
    900,
  );
  assert.equal(f.book.dragonTRecords.at(-1).status, "ABORTED_BY_RISK");
  assert.equal(f.book.dragonTNetPnlCents ?? 0, 0);
});
test("分档减仓完成后可启动T，临时买入不重复触发旧减仓档位", async () => {
  const config = defaultDragonConfig();
  config.operations.profitAdd = config.operations.lossAdd = false;
  const f = await fixture({ held: true, config }),
    p = f.book.positions[0];
  p.markCents = 1100;
  p.lots[0].quantity = 1400;
  p.lots[0].costCents = 1400000;
  f.book.cashCents = f.book.initialCashCents - 1400000;
  f.book.equityCents = f.book.cashCents + 1400 * 1100;
  Object.assign(p.dragon, {
    r0Cents: 100,
    highCents: 1100,
    initialQuantity: 2000,
    strategicQuantity: 2000,
    strategicCostCents: 2000000,
    baseQuantity: 2000,
    stage: 1,
    targetQuantity: 1400,
    stopCents: 1000,
  });
  f.session = openSession(f.book, f.plan, date);
  step(f, frame("10:01:00", 1076, 1000000, { previousCloseCents: 1100 }));
  assert.equal(
    step(f, frame("10:01:10", 1077, 11000000, { previousCloseCents: 1100 }))
      .ledger[0].intent,
    "T_FORWARD",
  );
  assert.equal(
    step(f, frame("10:01:20", 1078, 21000000, { previousCloseCents: 1100 }))
      .ledger.length,
    0,
  );
  assert.ok(f.book.positions[0].dragon.t);
  const reduced = step(
    f,
    frame("10:01:30", 1201, 31000000, {
      previousCloseCents: 1100,
      limitUpCents: 1300,
    }),
  );
  assert.equal(reduced.ledger[0].quantity, 700);
  assert.equal(
    f.book.positions[0].lots.reduce((n, l) => n + l.quantity, 0),
    800,
  );
  assert.equal(f.book.dragonTRecords.at(-1).status, "ABORTED_BY_RISK");
});
test("执行版本自动衔接；人工配置免整日报告，AI高级模板仍需研究", async () => {
  const db = localDatabase(),
    env = { DB: db };
  try {
    const papers = new PaperRepository(env),
      account = await papers.initialize(),
      config = defaultDragonConfig(),
      id = "old-engine";
    await db
      .prepare(
        "INSERT INTO dragon_config_versions(id,payload,digest,engine_build,base_id,created_at) VALUES(?,?,?,?,NULL,?)",
      )
      .bind(
        id,
        JSON.stringify(config),
        await digestOf(config),
        "previous-engine",
        new Date().toISOString(),
      )
      .run();
    const stale = {
      id,
      config,
      digest: await digestOf(config),
      engineBuild: "previous-engine",
    };
    const book = {
      ...account.book,
      ...dragonBookFields(stale),
      dragonTransition: { state: "ACTIVE", configId: id },
    };
    await db
      .prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
      .bind(JSON.stringify(book))
      .run();
    assert.equal((await dragonStatus(env)).staleEngine, true);
    assert.equal((await requestDragonActivation(env)).staleEngine, false);
    const saved = await saveDragonSettings(env, config);
    assert.notEqual(saved.book.pendingDragonConfigId, id);
    assert.equal(saved.book.dragonTransition.candidate, false);
    assert.equal(saved.dragon.ready, true);
    assert.equal(saved.dragon.report, null);
    const record = await registerDragonConfig(
      db,
      { ...config, advanced: { ...config.advanced, tSpread: 0.025 } },
      saved.book.dragonTransition.configId,
    );
    await ensureDragonTemplateResearch(
      env,
      record,
      { book: saved.book },
      snapshot(signalDate),
      new Date(),
    );
    const run = await db
      .prepare("SELECT status FROM dragon_research_runs WHERE config_id=?")
      .bind(record.id)
      .first();
    assert.equal(run.status, "COLLECTING");
    await db
      .prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
      .bind(
        JSON.stringify({
          ...saved.book,
          pendingDragonConfigId: undefined,
          dragonTransition: {
            ...saved.book.dragonTransition,
            configId: record.id,
            candidate: true,
            observerId: `dragon-observer:${record.id}`,
          },
        }),
      )
      .run();
    const researchStatus = await dragonStatus(env);
    assert.equal(researchStatus.requiresResearch, true);
    assert.equal(researchStatus.ready, false);
    await assert.rejects(() => requestDragonActivation(env), /高级模板.*研究/);
    await db
      .prepare(
        "UPDATE dragon_research_runs SET status='PASSED' WHERE config_id=?",
      )
      .bind(record.id)
      .run();
    assert.equal((await dragonStatus(env)).ready, false);
    await assert.rejects(() => requestDragonActivation(env), /完整真实交易日/);
    assert.equal(
      await db
        .prepare(
          "SELECT owner_id FROM research_window_owners WHERE namespace='main'",
        )
        .first(),
      null,
    );
  } finally {
    db.close();
  }
});
test("合成完整闭环：影子核验、研究锁、空仓整体切换与新账本导出重放", async () => {
  const db = localDatabase(),
    env = { DB: db },
    repo = new RealtimeRepository(env),
    shadows = new ShadowAccountRepository(env);
  try {
    let account = await repo.initialize();
    const initial = dataset(signalDate);
    await repo.settle(
      account.revision,
      executePlan(account.book, null, initial),
      initial,
    );
    account = await repo.account();
    const f = await fixture();
    f.source.createdAt = `${signalDate}T07:00:00Z`;
    await db
      .prepare(
        "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
      )
      .bind(signalDate, f.source.createdAt, JSON.stringify(f.source))
      .run();
    await repo.savePlan(
      createPlan(
        f.source,
        account.book,
        BASE_STRATEGY,
        "baseline-v1",
        `${signalDate}T08:00:00Z`,
      ),
    );
    const saved = await saveDragonSettings(env, defaultDragonConfig());
    await maintainDragonObservation(
      env,
      signalDate,
      new Date(`${signalDate}T09:00:00Z`),
    );
    const accountId = saved.dragon.observerId;
    assert.ok(await shadows.account(accountId));
    const frames = new QuoteFrameRepository(env);
    let index = 0;
    for (const [start, end] of [
      ["09:30:00", "11:30:00"],
      ["13:00:00", "14:55:00"],
    ]) {
      for (
        let ms = Date.parse(`${date}T${start}+08:00`);
        ms <= Date.parse(`${date}T${end}+08:00`);
        ms += 10000
      ) {
        const time = new Date(ms + 8 * 3600000).toISOString().slice(11, 19),
          obs = frame(time, 950, 1000000 + ++index * 1000000);
        const ref = await frames.appendFrame({
          tradeDate: date,
          observedAt: obs.observedAt,
          quotes: obs.quotes,
          pollIntervalSeconds: 10,
          pool: {
            codes: ["600001"],
            sources: { researchPoolDate: signalDate },
          },
          entryInputs: obs.entryInputs,
        });
        const loaded = await frames.loadFrame(date, ref.sequence);
        assert.equal(
          (await consumePortfolioFrame(env, accountId, loaded)).applied,
          true,
        );
      }
    }
    await settlePortfolioDay(env, accountId, date, closing());
    assert.equal(
      (
        await verifyDragonObservation(
          env,
          accountId,
          date,
          closing(),
          new Date(`${date}T16:59:59+08:00`),
        )
      ).status,
      "WAITING_VERIFICATION",
    );
    assert.equal(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM dragon_observation_reports")
          .first()
      ).n,
      0,
    );
    const report = await verifyDragonObservation(
      env,
      accountId,
      date,
      closing(),
      new Date(`${date}T17:00:00+08:00`),
    );
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.ok(report.fills > 0);
    const matchedDays = [
      { date, frames: await frames.framesForDate(date), dataset: closing() },
    ];
    assert.ok(
      (await verifyDragonMatchedDays(env, accountId, matchedDays)).fills > 0,
    );
    const fillRow = await db
      .prepare(
        "SELECT id,payload FROM shadow_ledger WHERE account_id=? LIMIT 1",
      )
      .bind(accountId)
      .first();
    const badFill = JSON.parse(fillRow.payload);
    badFill.quantity += 100;
    await db
      .prepare("UPDATE shadow_ledger SET payload=? WHERE account_id=? AND id=?")
      .bind(JSON.stringify(badFill), accountId, fillRow.id)
      .run();
    await assert.rejects(
      () => verifyDragonMatchedDays(env, accountId, matchedDays),
      /重放不一致/,
    );
    await db
      .prepare("UPDATE shadow_ledger SET payload=? WHERE account_id=? AND id=?")
      .bind(fillRow.payload, accountId, fillRow.id)
      .run();
    // The primary stayed on the original policy throughout this observation.
    account = await repo.account();
    assert.equal(account.book.tradingPolicyVersion, undefined);
    const old = await repo.plan(signalDate),
      day = dataset(date, "600001", { minutes: [] });
    await repo.settle(
      account.revision,
      executePlan(account.book, old, day),
      day,
    );
    const nextSource = structuredClone(f.source);
    nextSource.date = date;
    nextSource.createdAt = `${date}T07:00:00Z`;
    nextSource.intradayEntryContext.asOf = date;
    await db
      .prepare(
        "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
      )
      .bind(date, nextSource.createdAt, JSON.stringify(nextSource))
      .run();
    account = await repo.account();
    await repo.savePlan(
      createPlan(
        nextSource,
        account.book,
        BASE_STRATEGY,
        "baseline-v1",
        `${date}T08:00:00Z`,
      ),
    );
    await db
      .prepare(
        "INSERT INTO research_window_owners(namespace,owner_type,owner_id,window_payload,created_at) VALUES('main','TEST','busy','{}',?)",
      )
      .bind(new Date().toISOString())
      .run();
    await assert.rejects(() => requestDragonActivation(env), /状态|窗口/);
    await db
      .prepare("DELETE FROM research_window_owners WHERE namespace='main'")
      .run();
    const beforeActivation = (await repo.account()).revision;
    const activations = await Promise.allSettled([
      requestDragonActivation(env),
      requestDragonActivation(env),
    ]);
    assert.ok(activations.some((result) => result.status === "fulfilled"));
    assert.equal((await repo.account()).revision, beforeActivation + 1);
    assert.equal(
      (await repo.account()).book.dragonTransition.state,
      "DRAINING",
    );
    assert.equal(
      await applyDragonLifecycle(env, date, new Date(`${date}T09:00:00Z`)),
      true,
    );
    account = await repo.account();
    assert.equal(account.book.tradingPolicyVersion, "dragon-risk-v1");
    assert.equal(account.book.cashCents, account.book.initialCashCents);
    assert.equal(account.book.peakEquityCents, account.book.initialCashCents);
    const cost = defaultExecutionCostPolicy();
    await repo.savePlan(
      createPlan(nextSource, account.book, null, null, `${date}T08:00:00Z`, {
        executionCostPolicy: cost,
      }),
    );
    const liveDate = dateAt(4);
    for (const obs of [
      frame("09:31:00", 950, 1000000, { date: liveDate }),
      frame("09:31:10", 951, 11000000, { date: liveDate }),
    ]) {
      const result = await pollTrading(env, new Date(obs.observedAt), {
        calendar: async () => ({ dates: [date, liveDate] }),
        quotes: async () => obs.quotes,
        entryInputs: obs.entryInputs,
        observedAt: obs.observedAt,
      });
      assert.equal(result.status, "RUNNING", JSON.stringify(result));
    }
    const bundle = await exportPaper(env),
      checked = await verifyExport(bundle);
    assert.equal(checked.passed, true, JSON.stringify(checked));
    const forgedOrigin = structuredClone(bundle);
    forgedOrigin.dragonConfigs.find(
      (r) => r.id === bundle.book.dragonConfigId,
    ).origin = "AI";
    assert.equal((await verifyExport(forgedOrigin)).passed, false);
    account = await repo.account();
    const closedDay = {
      ...closing(liveDate, 951),
      executionMode: "realtime",
      previousTradingDate: date,
    };
    await repo.settle(
      account.revision,
      closeSession(account.book, await repo.session(liveDate), closedDay),
      closedDay,
    );
    const settled = await verifyExport(await exportPaper(env));
    assert.equal(settled.passed, true, JSON.stringify(settled));
    const changed = structuredClone(bundle);
    changed.plans.find(
      (r) => r.payload.tradingPolicyVersion,
    ).payload.dragonPolicy.config.risk.entryRisk = 0.01;
    assert.equal((await verifyExport(changed)).passed, false);
  } finally {
    db.close();
  }
});
