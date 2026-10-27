import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository, digest } from "../backend/storage/paper.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import {
  ShadowAccountRepository,
  SHADOW_ACCOUNT_KINDS,
} from "../backend/storage/shadow.js";
import {
  tradingArchive,
  tradingArchives,
  archivedLedgerCsv,
} from "../backend/storage/trading-archives.js";
import {
  prepareTradingCutover,
  applyTradingCutover,
} from "../backend/services/trading-cutover.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import { assertStoredProgramPlan } from "../backend/services/strategy-program-evidence.js";
import {
  newBook,
  createPlan,
  BASE_STRATEGY,
} from "../backend/domain/trading.js";
import { openSession, advanceSession } from "../backend/domain/realtime.js";
import { selectionSnapshotDigest } from "../backend/domain/signal-selection.js";
import {
  T_QUALITY_RULES_VERSION,
  summarizeTQuality,
  buildTQualityEvidence,
} from "../backend/domain/t-quality.js";
import { snapshot } from "./fixtures/trading.mjs";
import { api as handleApi } from "../backend/routes/api.js";
import {
  registerDragonConfig,
  dragonBookFields,
} from "../backend/storage/dragon-risk.js";
import { defaultDragonConfig } from "../shared/dragon-risk-config.js";
import { latestPolicyBundle } from "../backend/storage/execution-cost.js";

const signalDate = "2026-10-23",
  tradeDate = "2026-10-26";
const now = new Date("2026-10-25T03:00:00Z");
const options = () => ({ tradeDate, now });
const observerId = "intraday-entry-observation-v1";

async function fixture(t) {
  const DB = localDatabase(),
    env = { DB };
  t.after(() => DB.close());
  const papers = new PaperRepository(env);
  await papers.initialize();
  const source = snapshot(signalDate);
  source.tQualityRulesVersion = T_QUALITY_RULES_VERSION;
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
          previousVolumeShares: null,
        },
      ]),
    ),
  };
  const old = {
    ...newBook(),
    lastDate: signalDate,
    entryExecutionMode: "intraday-conditional",
    cashCents: 98990000,
    equityCents: 99990000,
    realizedPnlCents: -10000,
    feesCents: 10000,
    positions: [
      {
        code: "600002",
        name: "旧持仓",
        sector: "测试行业",
        lots: [{ quantity: 1000, costCents: 1000000, buyDate: "2026-10-22" }],
        markCents: 1000,
        heldDays: 2,
      },
    ],
    pendingExits: [{ code: "600002" }],
    pendingRecovery: [],
    benchmarkBaseCents: 12345,
    benchmarkBaseDate: "2026-10-09",
    settlementCount: 10,
    dragonTransition: { state: "DRAINING", configId: "old-config" },
  };
  await DB.prepare(
    "UPDATE paper_accounts SET state=?,revision=revision+1 WHERE id='primary'",
  )
    .bind(JSON.stringify(old))
    .run();
  await DB.prepare(
    "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
  )
    .bind(signalDate, source.createdAt, JSON.stringify(source))
    .run();
  const plan = createPlan(
    source,
    old,
    BASE_STRATEGY,
    "baseline-v1",
    `${signalDate}T09:00:00Z`,
    {
      snapshotDigest: await selectionSnapshotDigest(source),
      tQuality: summarizeTQuality([], { signalDate }),
      tQualityEvidence: buildTQualityEvidence([], []),
    },
  );
  await papers.savePlan(plan);
  const fill = {
    id: "old-fill",
    date: signalDate,
    code: "600002",
    name: "旧持仓",
    action: "OPEN",
    side: "BUY",
    quantity: 1000,
    priceCents: 1000,
    feesCents: 10000,
    cashDeltaCents: -1010000,
    sequence: 1,
  };
  await DB.prepare(
    "INSERT INTO paper_ledger(id,trade_date,payload) VALUES(?,?,?)",
  )
    .bind(fill.id, signalDate, JSON.stringify(fill))
    .run();
  await DB.prepare("INSERT INTO paper_equity(trade_date,payload) VALUES(?,?)")
    .bind(
      signalDate,
      JSON.stringify({ date: signalDate, equityCents: old.equityCents }),
    )
    .run();
  const shadows = new ShadowAccountRepository(env);
  await shadows.ensureAccount(observerId, {
    kind: SHADOW_ACCOUNT_KINDS.INTRADAY_OBSERVATION,
    book: old,
  });
  await shadows.savePlan(observerId, plan, source);
  await shadows.ensureAccount("old-dragon", {
    kind: SHADOW_ACCOUNT_KINDS.DRAGON_OBSERVATION,
    book: old,
  });
  await DB.prepare(
    "INSERT INTO shadow_ledger(account_id,id,trade_date,payload) VALUES(?,?,?,?)",
  )
    .bind(observerId, fill.id, signalDate, JSON.stringify(fill))
    .run();
  for (const [key, value] of [
    ["intraday-entry-observation-request", {}],
    ["intraday-entry-readiness", { passed: true, date: signalDate }],
    ["intraday-entry-observation-preparation", { status: "WAITING_HISTORY" }],
    ["private-test-config", "must-not-export"],
  ])
    await DB.prepare("INSERT INTO settings(key,value) VALUES(?,?)")
      .bind(key, JSON.stringify(value))
      .run();
  return { env, DB, papers, shadows, old, source, plan, fill };
}

test("归档保存原始交易和持仓，当前账户与影子账户只保留周一 V5 观察名单", async (t) => {
  const f = await fixture(t);
  const before = await f.DB.prepare("SELECT * FROM paper_accounts").first();
  const prepared = await prepareTradingCutover(f.env, options());
  assert.deepEqual(
    await f.DB.prepare("SELECT * FROM paper_accounts").first(),
    before,
  );
  const summary = await applyTradingCutover(f.env, prepared, { now });
  const archive = await tradingArchive(f.env, summary.id);
  assert.deepEqual(JSON.parse(archive.tables.paper_accounts[0].state), f.old);
  assert.deepEqual(JSON.parse(archive.tables.paper_ledger[0].payload), f.fill);
  assert.equal(archive.tables.shadow_accounts.length, 2);
  assert.equal(archive.tables.shadow_ledger.length, 1);
  assert.equal(JSON.stringify(archive).includes("must-not-export"), false);
  assert.match(archivedLedgerCsv(archive), /旧持仓/);
  const { book } = await f.papers.account();
  assert.deepEqual(book.positions, []);
  assert.equal(book.cashCents, 100000000);
  assert.equal(book.realizedPnlCents, 0);
  assert.equal(book.feesCents, 0);
  assert.equal(book.settlementCount, 0);
  assert.equal(book.lastDate, signalDate);
  assert.equal(book.dragonTransition, undefined);
  assert.equal(book.benchmarkBaseCents, undefined);
  assert.equal(book.benchmarkBaseDate, undefined);
  assert.deepEqual(book.pendingExits, []);
  const plan = await f.papers.plan(signalDate);
  assert.deepEqual(plan.orders, []);
  assert.deepEqual(
    plan.entryExecutionPolicy.candidates,
    f.plan.entryExecutionPolicy.candidates,
  );
  assert.deepEqual(Object.keys(plan.entryExecutionPolicy.history), ["600001"]);
  assert.equal(plan.selectionPolicy.version, "signal-ranking-v5");
  assert.deepEqual(plan.tQualityEvidence.records, []);
  await assertStoredProgramPlan(f.env, plan, book);
  assert.equal((await f.shadows.accounts()).length, 1);
  assert.deepEqual((await f.shadows.account(observerId)).book, book);
  assert.deepEqual((await f.shadows.plan(observerId, signalDate)).orders, []);
  for (const table of [
    "paper_ledger",
    "paper_equity",
    "paper_market_days",
    "paper_runs",
    "paper_live_ticks",
    "paper_live_sessions",
    "shadow_ledger",
    "shadow_sessions",
    "shadow_equity",
    "reviews",
  ])
    assert.equal(
      (await f.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n,
      0,
      table,
    );
  assert.deepEqual(await f.papers.snapshot(signalDate), f.source);
  assert.equal(
    (
      await f.DB.prepare(
        "SELECT value FROM settings WHERE key='private-test-config'",
      ).first()
    ).value,
    '"must-not-export"',
  );
  assert.equal(
    await f.DB.prepare(
      "SELECT value FROM settings WHERE key='intraday-entry-readiness'",
    ).first(),
    null,
  );
  assert.equal((await verifyExport(await exportPaper(f.env))).passed, true);
});

test("持仓中的龙头周期完整归档，保留政策与观察名单并从空仓重新记账", async (t) => {
  const f = await fixture(t);
  const record = await registerDragonConfig(f.DB, defaultDragonConfig(), null, {
    origin: "MANUAL",
    validationMode: "MANUAL_UNVERIFIED",
  });
  const oldBook = {
    ...f.old,
    ...dragonBookFields(record),
    dragonTransition: {
      state: "ACTIVE",
      configId: record.id,
      candidate: false,
    },
  };
  oldBook.positions[0].dragon = {
    id: `${signalDate}:600002`,
    startDate: signalDate,
    p0Cents: 1000,
    r0Cents: 40,
    stopCents: 960,
    initialQuantity: 1000,
    strategicQuantity: 1000,
    strategicCostCents: 1000000,
    stage: 0,
    highCents: 1000,
    holdDays: 3,
    buyPoint: "broken-board-dip",
    dayAction: signalDate,
  };
  await f.DB.prepare(
    "UPDATE paper_accounts SET state=?,revision=revision+1 WHERE id='primary'",
  )
    .bind(JSON.stringify(oldBook))
    .run();
  await f.DB.prepare("DELETE FROM paper_plans").run();
  const oldPlan = createPlan(
    f.source,
    oldBook,
    null,
    record.id,
    now.toISOString(),
    {
      snapshotDigest: await selectionSnapshotDigest(f.source),
      executionCostPolicy: await latestPolicyBundle(f.DB),
    },
  );
  await f.papers.savePlan(oldPlan);
  const continuation = {
    type: "DRAGON_INDUSTRY_RUNTIME_CONTINUED",
    createdAt: now.toISOString(),
    note: "原周期续跑证明",
  };
  await f.DB.prepare(
    "INSERT INTO paper_configuration_history(id,created_at,payload,digest) VALUES('old-continuation',?,?,?)",
  )
    .bind(
      continuation.createdAt,
      JSON.stringify(continuation),
      await digest(continuation),
    )
    .run();
  await assert.rejects(
    f.DB.prepare(
      "DELETE FROM paper_configuration_history WHERE id='old-continuation'",
    ).run(),
    /不可删除/,
  );
  await f.DB.prepare(
    "INSERT INTO observation_score_cursors(trade_date,version,sequence,payload,digest) VALUES(?,'old',1,'{}','old')",
  )
    .bind(signalDate)
    .run();
  await f.DB.prepare(
    "INSERT INTO observation_score_invalidations(trade_date,reason) VALUES(?,'旧周期')",
  )
    .bind(signalDate)
    .run();
  const originalFill = { ...f.fill, feeCents: f.fill.feesCents };
  delete originalFill.feesCents;
  await f.DB.prepare("UPDATE paper_ledger SET payload=? WHERE id=?")
    .bind(JSON.stringify(originalFill), f.fill.id)
    .run();
  const summary = await applyTradingCutover(
    f.env,
    await prepareTradingCutover(f.env, options()),
    { now },
  );
  const archive = await tradingArchive(f.env, summary.id);
  assert.deepEqual(JSON.parse(archive.tables.paper_accounts[0].state), oldBook);
  assert.deepEqual(
    JSON.parse(archive.tables.paper_ledger[0].payload),
    originalFill,
  );
  assert.deepEqual(
    JSON.parse(
      archive.tables.paper_configuration_history.find(
        (row) => row.id === "old-continuation",
      ).payload,
    ),
    continuation,
  );
  assert.equal(summary.primary.openPositions[0].quantity, 1000);
  assert.equal(summary.policy, "dragon-risk-v1");
  assert.equal(archive.tables.observation_score_cursors.length, 1);
  assert.equal(archive.tables.observation_score_invalidations.length, 1);
  assert.match(archivedLedgerCsv(archive), /"10000","-1010000"/);
  const { book } = await f.papers.account(),
    plan = await f.papers.plan(signalDate);
  assert.deepEqual(book.positions, []);
  assert.equal(book.cashCents, 100000000);
  assert.equal(book.equityCents, 100000000);
  assert.equal(book.feesCents, 0);
  assert.equal(book.realizedPnlCents, 0);
  assert.equal(book.settlementCount, 0);
  assert.deepEqual(book.dragonConfig, oldBook.dragonConfig);
  assert.equal(plan.dragonPolicy.configId, record.id);
  assert.deepEqual(
    plan.entryExecutionPolicy.candidates,
    oldPlan.entryExecutionPolicy.candidates,
  );
  assert.deepEqual(plan.orders, []);
  for (const table of [
    "paper_ledger",
    "observation_score_cursors",
    "observation_score_invalidations",
  ])
    assert.equal(
      (await f.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n,
      0,
    );
  const observers = await f.shadows.accounts();
  assert.equal(observers.length, 1);
  assert.equal(observers[0].kind, SHADOW_ACCOUNT_KINDS.DRAGON_OBSERVATION);
  assert.deepEqual(observers[0].book, book);
  await assertStoredProgramPlan(f.env, plan, book);
  assert.equal((await verifyExport(await exportPaper(f.env))).passed, true);
});

test("新周期能用周一两份报价实际建仓，导出从空仓边界独立重放", async (t) => {
  const f = await fixture(t);
  await applyTradingCutover(
    f.env,
    await prepareTradingCutover(f.env, options()),
    { now },
  );
  const repo = new RealtimeRepository(f.env);
  let { book } = await repo.account();
  const plan = await repo.plan(signalDate);
  let session = openSession(book, plan, tradeDate),
    count = 0;
  for (const [time, price, volume] of [
    ["09:31:00", 950, 100000],
    ["09:31:10", 951, 2000000],
  ]) {
    const timestamp = `${tradeDate}T${time}+08:00`;
    const observation = {
      observedAt: new Date(timestamp).toISOString(),
      pollIntervalSeconds: 10,
      quotes: {
        600001: {
          date: tradeDate,
          timestamp,
          previousCloseCents: 1000,
          openCents: 940,
          closeCents: price,
          highCents: 1000,
          lowCents: 940,
          volumeShares: volume,
          limitUpCents: 1100,
          limitDownCents: 900,
          bid1Cents: price - 1,
          ask1Cents: price + 1,
          ask1Shares: 100000,
          bid1Shares: 100000,
          orderBookQuality: "OK",
          orderBookTimestamp: timestamp,
        },
      },
      entryInputs: {
        market: {
          date: tradeDate,
          observedAt: new Date(timestamp).toISOString(),
          emotion: 75,
          cycle: { maxGrossExposure: 0.6 },
          sectors: [{ name: "测试行业", score: 85 }],
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
    count += result.ledger.length;
  }
  assert.equal(count, 1);
  assert.equal(book.positions[0].code, "600001");
  const bundle = await exportPaper(f.env);
  assert.equal(bundle.ledger.length, 1);
  assert.equal((await verifyExport(bundle)).passed, true);
  const missing = structuredClone(bundle);
  missing.configurationHistory = [];
  assert.equal((await verifyExport(missing)).passed, false);
  const modified = structuredClone(bundle);
  modified.configurationHistory[0].payload.initialBook.cashCents -= 100;
  modified.configurationHistory[0].digest = await digest(
    modified.configurationHistory[0].payload,
  );
  assert.equal((await verifyExport(modified)).passed, false);
});

test("重复执行同一周一迁移不会清空已经开始的新周期交易", async (t) => {
  const f = await fixture(t);
  await applyTradingCutover(
    f.env,
    await prepareTradingCutover(f.env, options()),
    { now },
  );
  await f.DB.prepare(
    "INSERT INTO paper_ledger(id,trade_date,payload) VALUES('new',?,'{}')",
  )
    .bind(tradeDate)
    .run();
  const prepared = await prepareTradingCutover(f.env, options());
  assert.equal(prepared.duplicate, true);
  await applyTradingCutover(f.env, prepared, {
    now: new Date(`${tradeDate}T02:00:00Z`),
  });
  assert.equal(
    (await f.DB.prepare("SELECT COUNT(*) AS n FROM paper_ledger").first()).n,
    1,
  );
  assert.equal((await tradingArchives(f.env)).length, 1);
});

test("写入或核验失败时归档和清空操作一起回滚", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTradingCutover(f.env, options());
  f.DB.exec(
    "CREATE TRIGGER fail_cutover BEFORE DELETE ON paper_ledger BEGIN SELECT RAISE(ABORT,'injected archive failure'); END;",
  );
  await assert.rejects(
    applyTradingCutover(f.env, prepared, { now }),
    /injected archive failure/,
  );
  assert.equal((await f.papers.account()).book.tradingCycleId, undefined);
  assert.equal(
    (
      await f.DB.prepare(
        "SELECT COUNT(*) AS n FROM paper_trading_archives",
      ).first()
    ).n,
    0,
  );
  assert.equal(
    (
      await f.DB.prepare(
        "SELECT COUNT(*) AS n FROM paper_trading_archive_chunks",
      ).first()
    ).n,
    0,
  );
  assert.equal(
    (await f.DB.prepare("SELECT COUNT(*) AS n FROM paper_ledger").first()).n,
    1,
  );
  assert.equal((await f.shadows.accounts()).length, 2);
});

test("准备后账户变化或影子成交变化时拒绝迁移，保留所有当前交易", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTradingCutover(f.env, options());
  await f.DB.prepare(
    "UPDATE paper_accounts SET revision=revision+1 WHERE id='primary'",
  ).run();
  await assert.rejects(
    applyTradingCutover(f.env, prepared, { now }),
    /账户已变化/,
  );
  const next = await prepareTradingCutover(f.env, options());
  await f.DB.prepare(
    "INSERT INTO shadow_ledger(account_id,id,trade_date,payload) VALUES(?,'late',?,'{}')",
  )
    .bind(observerId, signalDate)
    .run();
  await assert.rejects(
    applyTradingCutover(f.env, next, { now }),
    /归档输入已变化/,
  );
  assert.equal(
    (
      await f.DB.prepare(
        "SELECT COUNT(*) AS n FROM paper_trading_archives",
      ).first()
    ).n,
    0,
  );
});

test("拒绝盘中清空、缺失冻结输入、周末执行日及过期信号", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareTradingCutover(f.env, {
      tradeDate,
      now: new Date(`${tradeDate}T09:30:00+08:00`),
    }),
    /开盘/,
  );
  await assert.rejects(
    prepareTradingCutover(f.env, { tradeDate: "2026-10-25", now }),
    /有效/,
  );
  await assert.rejects(
    prepareTradingCutover(f.env, { tradeDate: "2026-10-27", now }),
    /不连续/,
  );
  const prepared = await prepareTradingCutover(f.env, options());
  await assert.rejects(
    applyTradingCutover(f.env, prepared, {
      now: new Date(`${tradeDate}T09:30:00+08:00`),
    }),
    /开盘/,
  );
  await f.DB.prepare("DELETE FROM paper_plans").run();
  await assert.rejects(prepareTradingCutover(f.env, options()), /观察名单/);
});

test("归档不可改写，缺失分块无法以完整归档下载", async (t) => {
  const f = await fixture(t);
  const summary = await applyTradingCutover(
    f.env,
    await prepareTradingCutover(f.env, options()),
    { now },
  );
  await assert.rejects(
    f.DB.prepare("UPDATE paper_trading_archives SET summary='{}'").run(),
    /不可修改/,
  );
  await assert.rejects(
    f.DB.prepare("DELETE FROM paper_trading_archive_chunks").run(),
    /不可删除/,
  );
  f.DB.exec("DROP TRIGGER paper_archive_chunk_immutable_delete");
  await f.DB.prepare(
    "DELETE FROM paper_trading_archive_chunks WHERE table_name='paper_ledger'",
  ).run();
  await assert.rejects(tradingArchive(f.env, summary.id), /不完整/);
});

test("历史接口只读，能列出归档并下载主账户及影子成交", async (t) => {
  const f = await fixture(t);
  const summary = await applyTradingCutover(
    f.env,
    await prepareTradingCutover(f.env, options()),
    { now },
  );
  const request = (path, method = "GET") =>
    handleApi(
      new Request(`http://localhost/api/paper/archives${path}`, { method }),
      f.env,
    );
  assert.equal((await (await request("")).json()).archives[0].id, summary.id);
  const csv = await request(`?id=${summary.id}&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("Content-Disposition"), /attachment/);
  assert.match(await csv.text(), /intraday-entry-observation-v1/);
  assert.equal(
    (await (await request(`?id=${summary.id}`)).json()).tables.paper_ledger
      .length,
    1,
  );
  assert.equal((await request("?id=missing")).status, 404);
  assert.equal((await request("", "POST")).status, 405);
});
