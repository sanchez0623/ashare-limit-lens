import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../../scripts/local-db.mjs";
import { PaperRepository } from "../../backend/storage/paper.js";
import { RealtimeRepository } from "../../backend/storage/realtime.js";
import {
  ShadowAccountRepository,
  SHADOW_ACCOUNT_KINDS,
} from "../../backend/storage/shadow.js";
import {
  prepareTradingCutover,
  applyTradingCutover,
  switchTradingCycleToDragon,
  restoreDragonObservationUniverse,
} from "../../backend/services/trading-cutover.js";
import { buildJointQuotePool } from "../../backend/services/quote-stream.js";
import { saveDragonSettings } from "../../backend/services/dragon-risk.js";
import { exportPaper, verifyExport } from "../../backend/services/paper.js";
import { assertStoredProgramPlan } from "../../backend/services/strategy-program-evidence.js";
import { defaultDragonConfig } from "../../shared/dragon-risk-config.js";
import {
  newBook,
  createPlan,
  BASE_STRATEGY,
} from "../../backend/domain/trading.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../../backend/domain/realtime.js";
import { selectionSnapshotDigest } from "../../backend/domain/signal-selection.js";
import { frozenProgramSignal } from "../../backend/storage/strategy-signals.js";
import { dragonBudget } from "../../backend/domain/dragon-risk.js";
import { advanceAdaptiveRisk } from "../../shared/adaptive-risk.js";
import { snapshot, dataset } from "../fixtures/trading.mjs";
import {
  renderEntryPlanRules,
  entryPlanRows,
} from "../../frontend/entry-plan.js";

const signalDate = "2026-10-23",
  tradeDate = "2026-10-26",
  now = new Date("2026-10-25T04:00:00Z");
async function fixture(
  t,
  { configure = () => {}, customizeSource = () => {} } = {},
) {
  const DB = localDatabase(),
    env = { DB },
    papers = new PaperRepository(env);
  t.after(() => DB.close());
  await papers.initialize();
  const source = snapshot(signalDate);
  source.intradayEntryContext = {
    version: "intraday-entry-v1",
    asOf: signalDate,
    history: Object.fromEntries(
      source.stocks.map((s) => [
        s.code,
        {
          name: s.name,
          sector: s.sector,
          stockClass: "relay-leader",
          amount: 500000000,
          recentLimitUp: true,
          previousCloseCents: 1000,
          previousOpenCents: 950,
          previousChange: 10,
          previousHeight: 3,
          previousTouchedLimit: true,
          lastFourCloseSumCents: 3600,
        },
      ]),
    ),
  };
  customizeSource(source);
  const book = {
    ...newBook(),
    lastDate: signalDate,
    entryExecutionMode: "intraday-conditional",
  };
  await DB.prepare(
    "UPDATE paper_accounts SET state=?,revision=revision+1 WHERE id='primary'",
  )
    .bind(JSON.stringify(book))
    .run();
  await DB.prepare(
    "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
  )
    .bind(signalDate, source.createdAt, JSON.stringify(source))
    .run();
  const plan = createPlan(
    source,
    book,
    BASE_STRATEGY,
    "baseline-v1",
    `${signalDate}T09:00:00Z`,
    { snapshotDigest: await selectionSnapshotDigest(source) },
  );
  await papers.savePlan(plan);
  const config = defaultDragonConfig();
  config.risk.sectorWeight = 0.4;
  configure(config);
  const saved = await saveDragonSettings(env, config);
  const shadows = new ShadowAccountRepository(env);
  await shadows.ensureAccount("intraday-entry-observation-v1", {
    kind: SHADOW_ACCOUNT_KINDS.INTRADAY_OBSERVATION,
    book,
  });
  await shadows.savePlan("intraday-entry-observation-v1", plan, source);
  await DB.prepare(
    "INSERT INTO settings(key,value) VALUES('intraday-entry-observation-request','{}')",
  ).run();
  const prepared = await prepareTradingCutover(env, { tradeDate, now });
  await applyTradingCutover(env, prepared, { now });
  return {
    DB,
    env,
    papers,
    shadows,
    config,
    source,
    sourceConfigId: saved.dragon.configId,
  };
}

test("未执行的新周期可在周日实际时间整体切换龙头政策，旧 V5 计划保留修订", async (t) => {
  const f = await fixture(t),
    before = await f.papers.account();
  const switched = await switchTradingCycleToDragon(f.env, {
    sourceConfigId: f.sourceConfigId,
    now,
  });
  assert.equal(switched.changed, true);
  assert.equal(switched.dragon.state, "ACTIVE");
  assert.equal(switched.dragon.ready, true);
  assert.equal(switched.dragon.observationVerified, false);
  assert.deepEqual(switched.dragon.config, f.config);
  const { book } = await f.papers.account(),
    plan = await f.papers.plan(signalDate);
  assert.equal(book.tradingPolicyVersion, "dragon-risk-v1");
  assert.equal(book.cashCents, before.book.cashCents);
  assert.deepEqual(book.positions, []);
  assert.equal(book.tradingCycleId, before.book.tradingCycleId);
  assert.equal(plan.selectionPolicy.tieBreak, "buy-point-turnover-code-asc");
  assert.equal(plan.tradingPolicyVersion, "dragon-risk-v1");
  assert.equal(plan.strategy, undefined);
  assert.equal(plan.riskLimits, undefined);
  assert.deepEqual(plan.orders, []);
  const html = renderEntryPlanRules(
    plan,
    entryPlanRows(plan.entryExecutionPolicy),
  );
  assert.match(html, /买点优先级、信号日成交额、代码排序/);
  assert.match(html, /风险预算与 R 管理/);
  assert.match(html, /单笔计划风险 0.5%/);
  assert.match(html, /组合计划风险 2%/);
  assert.match(html, /板块 40%/);
  assert.doesNotMatch(
    html,
    /快照分数降序|情绪 ≥ 40|计划上限 未知|仓位上限 未知/,
  );
  assert.equal(plan.createdAt, now.toISOString());
  assert.equal(
    JSON.parse(
      (await f.DB.prepare("SELECT payload FROM paper_plan_revisions").first())
        .payload,
    ).selectionPolicy.version,
    "signal-ranking-v5",
  );
  await assertStoredProgramPlan(f.env, plan, book);
  assert.doesNotThrow(() => openSession(book, plan, tradeDate));
  const observers = await f.shadows.accounts();
  assert.equal(observers.length, 1);
  assert.equal(observers[0].kind, SHADOW_ACCOUNT_KINDS.DRAGON_OBSERVATION);
  assert.deepEqual(observers[0].book, book);
  assert.equal(
    (await f.shadows.latestPlan(observers[0].accountId)).tradingPolicyVersion,
    "dragon-risk-v1",
  );
  assert.equal((await verifyExport(await exportPaper(f.env))).passed, true);
  const revision = (await f.papers.account()).revision;
  assert.equal(
    (await switchTradingCycleToDragon(f.env, { now })).changed,
    false,
  );
  assert.equal((await f.papers.account()).revision, revision);
});

test("低于成交额门槛的原观察股在切换、恢复及计划重建中保留，观察数量与准入数量分开", async (t) => {
  const f = await fixture(t, {
    customizeSource: (source) => {
      source.intradayEntryContext.history["600002"].amount = 200000000;
    },
  });
  const originalCandidates = (await f.papers.plan(signalDate))
    .entryExecutionPolicy.candidates;
  assert.equal(originalCandidates.length, 2);
  await switchTradingCycleToDragon(f.env, { now });
  const { book } = await f.papers.account();
  const plan = await f.papers.plan(signalDate);
  assert.deepEqual(plan.observationUniverse, ["600001", "600002"]);
  assert.deepEqual(
    plan.entryExecutionPolicy.candidates,
    plan.observationUniverse,
  );
  const rows = entryPlanRows(plan.entryExecutionPolicy);
  assert.equal(rows.filter((row) => row.state === "ready").length, 1);
  assert.equal(rows.filter((row) => row.state === "turnover").length, 1);
  await assertStoredProgramPlan(f.env, plan, book);
  assert.equal((await verifyExport(await exportPaper(f.env))).passed, true);

  // Reproduce an older plan whose watchlist was narrowed during the switch.
  const narrowed = createPlan(
    await frozenProgramSignal(f.DB, plan),
    book,
    null,
    book.dragonConfigId,
    now.toISOString(),
    {
      executionCostPolicy: plan.executionCostPolicy,
      snapshotDigest: plan.selectionAudit.snapshotDigest,
      engineBuild: plan.engineBuild,
      observationUniverse: ["600001"],
    },
  );
  await f.DB.prepare("DELETE FROM paper_plans WHERE signal_date=?")
    .bind(signalDate)
    .run();
  await f.DB.prepare(
    "DELETE FROM dragon_plan_bindings WHERE scope='main' AND signal_date=?",
  )
    .bind(signalDate)
    .run();
  await f.papers.savePlan(narrowed);
  await assertStoredProgramPlan(f.env, narrowed, book);
  const before = await f.papers.account();
  const restored = await restoreDragonObservationUniverse(f.env, { now });
  assert.equal(restored.changed, true);
  assert.equal(restored.candidates, 2);
  assert.equal(restored.pendingTurnover, 1);
  assert.equal(restored.verification.passed, true);
  assert.deepEqual((await f.papers.account()).book, before.book);
  const replacement = await f.papers.plan(signalDate);
  assert.deepEqual(replacement.observationUniverse, ["600001", "600002"]);
  assert.deepEqual(
    replacement.entryExecutionPolicy.candidates,
    replacement.observationUniverse,
  );
  await assertStoredProgramPlan(f.env, replacement, book);
  const pool = await buildJointQuotePool(f.env, { now });
  assert.deepEqual(pool.sources.primary, ["600001", "600002"]);
  for (const codes of Object.values(pool.sources.shadow)) {
    assert.deepEqual(codes, ["600001", "600002"]);
  }
  assert.equal(
    (await restoreDragonObservationUniverse(f.env, { now })).changed,
    false,
  );
  await assert.rejects(
    restoreDragonObservationUniverse(f.env, {
      now: new Date(`${tradeDate}T09:30:00+08:00`),
    }),
    /开盘/,
  );
});

test("周一龙头风险预算实际成交后首日结算，整段导出仍按期初和切换事件重放", async (t) => {
  const f = await fixture(t);
  await switchTradingCycleToDragon(f.env, { now });
  const repo = new RealtimeRepository(f.env);
  let { book } = await repo.account();
  const plan = await repo.plan(signalDate);
  let session = openSession(book, plan, tradeDate),
    fills = 0;
  for (let index = 0; index < 8; index++) {
    const price = index === 7 ? 951 : 950,
      volume = index === 7 ? 11000000 : 1000000;
    const timestamp = new Date(
      Date.parse(`${tradeDate}T09:31:00+08:00`) + index * 10000,
    ).toISOString();
    const observation = {
      observedAt: new Date(timestamp).toISOString(),
      pollIntervalSeconds: 10,
      quotes: {
        600001: {
          date: tradeDate,
          timestamp,
          closeCents: price,
          previousCloseCents: 1000,
          openCents: 940,
          highCents: 1000,
          lowCents: 940,
          volumeShares: volume,
          limitUpCents: 1100,
          limitDownCents: 900,
          bid1Cents: price - 1,
          ask1Cents: price + 1,
          ask1Shares: 1000000,
          bid1Shares: 1000000,
          orderBookQuality: "OK",
          orderBookTimestamp: timestamp,
        },
      },
      entryInputs: {
        market: {
          date: tradeDate,
          observedAt: new Date(timestamp).toISOString(),
          cycle: { phase: "rising" },
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
            date: tradeDate,
            final: true,
            openCents: 940,
            previousCloseCents: 1000,
          },
        },
      },
    };
    const result = advanceSession(book, session, observation);
    await repo.commitObservation(
      (await repo.account()).revision,
      result,
      observation,
    );
    book = result.book;
    session = result.session;
    fills += result.ledger.length;
  }
  assert.equal(fills, 1);
  assert.ok(book.positions[0].dragon.r0Cents > 0);
  assert.equal(session.tradingPolicyVersion, "dragon-risk-v1");
  assert.equal((await verifyExport(await exportPaper(f.env))).passed, true);
  const closing = {
    ...dataset(tradeDate, "600001", { previousDate: signalDate, close: 960 }),
    executionMode: "realtime",
  };
  closing.quotes["600001"].timestamp = `${tradeDate}T15:00:00+08:00`;
  const settled = closeSession(book, session, closing);
  await repo.close((await repo.account()).revision, settled, closing);
  const bundle = await exportPaper(f.env),
    verification = await verifyExport(bundle);
  assert.equal(bundle.datasets.length, 1);
  assert.equal(bundle.book.settlementCount, 1);
  assert.equal(bundle.book.lastDate, tradeDate);
  assert.equal(verification.passed, true, JSON.stringify(verification));
});

test("开盘、已开始的会话或新计划冻结失败时拒绝切换，完整保留原 V5 周期", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    switchTradingCycleToDragon(f.env, {
      now: new Date(`${tradeDate}T09:30:00+08:00`),
    }),
    /开盘/,
  );
  const before = await f.papers.account();
  const count = (
    await f.DB.prepare(
      "SELECT COUNT(*) AS n FROM dragon_config_versions",
    ).first()
  ).n;
  f.DB.exec(
    "CREATE TRIGGER fail_dragon_freeze BEFORE INSERT ON paper_plans WHEN json_extract(NEW.payload,'$.tradingPolicyVersion')='dragon-risk-v1' BEGIN SELECT RAISE(ABORT,'injected freeze failure'); END;",
  );
  await assert.rejects(
    switchTradingCycleToDragon(f.env, { now }),
    /injected freeze failure/,
  );
  assert.deepEqual(await f.papers.account(), before);
  assert.equal(
    (await f.papers.plan(signalDate)).selectionPolicy.version,
    "signal-ranking-v5",
  );
  assert.equal(
    (
      await f.DB.prepare(
        "SELECT COUNT(*) AS n FROM dragon_config_versions",
      ).first()
    ).n,
    count,
  );
  assert.equal(
    (await f.shadows.accounts())[0].kind,
    SHADOW_ACCOUNT_KINDS.INTRADAY_OBSERVATION,
  );
  assert.equal(
    (
      await f.DB.prepare(
        "SELECT COUNT(*) AS n FROM paper_plan_revisions",
      ).first()
    ).n,
    0,
  );
  await f.DB.prepare(
    "INSERT INTO paper_live_sessions(trade_date,payload,digest) VALUES(?,'{}','test')",
  )
    .bind(tradeDate)
    .run();
  await assert.rejects(switchTradingCycleToDragon(f.env, { now }), /已经开始/);
});

for (const priority of [true, false])
  test(
    priority
      ? "同时触发时低评分低成交额的高优先级买点先占用唯一名额"
      : "相同买点按信号日成交额排序，不按旧综合评分抢占名额",
    async (t) => {
      const f = await fixture(t, {
        configure: (config) => {
          config.risk.maxPositions = 1;
        },
        customizeSource: (source) => {
          source.stocks[0].score = priority ? 99 : 1;
          source.stocks[1].score = priority ? 1 : 99;
          source.intradayEntryContext.history["600001"].amount = 900000000;
          if (priority)
            Object.assign(source.intradayEntryContext.history["600002"], {
              previousOpenCents: 1050,
              previousChange: 1,
            });
        },
      });
      await switchTradingCycleToDragon(f.env, { now });
      let { book } = await f.papers.account();
      const plan = await f.papers.plan(signalDate);
      let session = openSession(book, plan, tradeDate),
        fills = [];
      for (let index = 0; index < 8; index++) {
        const timestamp = new Date(
          Date.parse(`${tradeDate}T09:31:00+08:00`) + index * 10000,
        ).toISOString();
        const quotes = Object.fromEntries(
          ["600001", "600002"].map((code) => {
            const dip = priority && code === "600002",
              price = (dip ? 920 : 950) + (index === 7 ? 1 : 0);
            return [
              code,
              {
                date: tradeDate,
                timestamp,
                closeCents: price,
                previousCloseCents: 1000,
                openCents: dip ? 910 : 940,
                highCents: 1000,
                lowCents: dip ? 910 : 940,
                volumeShares: index === 7 ? 11000000 : 1000000,
                limitUpCents: 1100,
                limitDownCents: 900,
                bid1Cents: price - 1,
                ask1Cents: price + 1,
                ask1Shares: 1000000,
                bid1Shares: 1000000,
                orderBookQuality: "OK",
                orderBookTimestamp: timestamp,
              },
            ];
          }),
        );
        const observation = {
          observedAt: new Date(timestamp).toISOString(),
          pollIntervalSeconds: 10,
          quotes,
          entryInputs: {
            market: {
              date: tradeDate,
              observedAt: new Date(timestamp).toISOString(),
              cycle: { phase: "rising" },
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
            auction: Object.fromEntries(
              Object.entries(quotes).map(([code, quote]) => [
                code,
                {
                  date: tradeDate,
                  final: true,
                  openCents: quote.openCents,
                  previousCloseCents: 1000,
                },
              ]),
            ),
          },
        };
        const result = advanceSession(book, session, observation);
        book = result.book;
        session = result.session;
        fills.push(...result.ledger);
      }
      assert.equal(fills.length, 1);
      assert.equal(fills[0].code, priority ? "600002" : "600001");
      assert.equal(book.positions.length, 1);
      assert.equal(
        book.positions[0].dragon.buyPoint,
        priority ? "fake-neg-limit-dip" : "auction-dip",
      );
    },
  );

test("同一可亏损预算下止损距离扩大时仓位缩小，并遵守整手和集中度上限", async (t) => {
  const f = await fixture(t);
  await switchTradingCycleToDragon(f.env, { now });
  const { book } = await f.papers.account(),
    plan = await f.papers.plan(signalDate);
  const session = openSession(book, plan, tradeDate);
  for (let seconds = 0; seconds <= 180; seconds += 10) {
    const observedAt = new Date(
      Date.parse(`${tradeDate}T09:30:00+08:00`) + seconds * 1000,
    ).toISOString();
    advanceAdaptiveRisk(session.adaptiveRisk, {
      observedAt,
      sectors: { 600001: "测试行业" },
      market: {
        date: tradeDate,
        observedAt,
        sectorsComplete: true,
        metrics: {
          limitUp: 80,
          broken: 0,
          height: 5,
          premium: 3,
          premiumCoverage: 1,
        },
        sectors: [{ name: "测试行业", score: 85, count: 6, broken: 0 }],
      },
      quotes: {
        600001: {
          date: tradeDate,
          timestamp: observedAt,
          closeCents: 1000,
          volumeShares: 1000000,
        },
      },
    });
    session.lastObservedAt = observedAt;
  }
  const near = dragonBudget(book, session, "600001", 1000, 950, "OPEN");
  const far = dragonBudget(book, session, "600001", 1000, 900, "OPEN");
  assert.ok(near.quantity > far.quantity);
  assert.ok(far.quantity > 0);
  assert.equal(near.riskBudgetCents, far.riskBudgetCents);
  for (const [budget, distance] of [
    [near, 50],
    [far, 100],
  ]) {
    assert.equal(budget.quantity % 100, 0);
    assert.ok(budget.quantity * (distance + 3) <= budget.riskBudgetCents);
    assert.ok(
      budget.quantity * 1000 <= book.equityCents * f.config.risk.stockWeight,
    );
  }
});
