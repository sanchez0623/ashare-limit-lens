import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import { QuoteFrameRepository } from "../backend/storage/quotes.js";
import {
  registerDragonConfig,
  dragonBookFields,
} from "../backend/storage/dragon-risk.js";
import { latestPolicyBundle } from "../backend/storage/execution-cost.js";
import { tradingArchive } from "../backend/storage/trading-archives.js";
import { defaultDragonConfig } from "../shared/dragon-risk-config.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import { newBook, createPlan } from "../backend/domain/trading.js";
import { openSession, advanceSession } from "../backend/domain/realtime.js";
import { selectionSnapshotDigest } from "../backend/domain/signal-selection.js";
import { snapshot } from "./fixtures/trading.mjs";
import {
  repairIndustryInputs,
  inspectIndustryRepair,
} from "../backend/services/industry-repair.js";
import { enrichMarketIndustries } from "../backend/services/industry.js";
import { collectEntryMarket } from "../backend/services/intraday-inputs.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import { assertStoredProgramPlan } from "../backend/services/strategy-program-evidence.js";
import {
  industryContinuation,
  INDUSTRY_CONTINUATION,
  verifyEntryOrderObservation,
} from "../backend/storage/industry-continuation.js";
import { ENTRY_ORDER_POLICY } from "../shared/entry-order-policy.js";
import {
  ADAPTIVE_RISK_POLICY,
  ADAPTIVE_RISK_POLICY_V1,
} from "../shared/adaptive-risk.js";
import { pollTrading } from "../backend/services/realtime.js";
import { runScoringTick } from "../backend/services/observation-scoring.js";
import { runTournamentPoll } from "../backend/services/strategy-tournament.js";

const signalDate = "2026-10-23",
  date = "2026-10-26";
const now = new Date(`${date}T10:15:00+08:00`);
async function fixture(
  t,
  {
    oldEngine = false,
    metadataAt = "2026-10-24T10:00:00Z",
    canonicalHistory = false,
    legacyRevision = false,
    legacyTemplate = false,
    riskPolicy,
  } = {},
) {
  const DB = localDatabase(),
    env = { DB },
    papers = new PaperRepository(env);
  t.after(() => DB.close());
  await papers.initialize();
  const record = await registerDragonConfig(DB, defaultDragonConfig(), null, {
    origin: "MANUAL",
    validationMode: "MANUAL_UNVERIFIED",
  });
  if (oldEngine) {
    record.id = "old-engine-fixture";
    record.engineBuild = "a".repeat(64);
    record.provenanceDigest = await digestOf({
      id: record.id,
      configDigest: record.digest,
      engineBuild: record.engineBuild,
      baseId: record.baseId,
      origin: record.origin,
      validationMode: record.validationMode,
      replacesId: record.replacesId,
    });
    await DB.prepare(
      "INSERT INTO dragon_config_versions(id,payload,digest,engine_build,base_id,created_at,origin,validation_mode,replaces_id,provenance_digest) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        record.id,
        JSON.stringify(record.config),
        record.digest,
        record.engineBuild,
        record.baseId,
        "2026-10-24T01:00:00Z",
        record.origin,
        record.validationMode,
        record.replacesId,
        record.provenanceDigest,
      )
      .run();
  }
  const book = {
    ...newBook(),
    ...dragonBookFields(record),
    lastDate: signalDate,
    tradingCycleId: "industry-test-cycle",
    dragonTransition: {
      state: "ACTIVE",
      configId: record.id,
      candidate: false,
    },
  };
  await DB.prepare(
    "UPDATE paper_accounts SET state=?,revision=revision+1 WHERE id='primary'",
  )
    .bind(JSON.stringify(book))
    .run();
  const start = {
    type: "TRADING_CYCLE_STARTED",
    id: book.tradingCycleId,
    signalDate,
    createdAt: "2026-10-25T01:00:00Z",
    initialBook: book,
  };
  await DB.prepare(
    "INSERT INTO paper_configuration_history(id,created_at,payload,digest) VALUES(?,?,?,?)",
  )
    .bind(
      book.tradingCycleId,
      start.createdAt,
      JSON.stringify(start),
      await digestOf(start),
    )
    .run();
  const source = snapshot(signalDate);
  const records = [
    { code: "600001", name: "合成样本1", emIndustry: "专用设备" },
    { code: "600002", name: "合成样本2", emIndustry: "汽车零部件" },
  ];
  source.intradayEntryContext = {
    version: "intraday-entry-v1",
    asOf: signalDate,
    history: Object.fromEntries(
      source.stocks.map((s) => [
        s.code,
        {
          name: s.name,
          sector: canonicalHistory
            ? s.code === "600001"
              ? "专用设备"
              : "汽车零部件"
            : "旧行业",
          stockClass: "strong-reversal",
          recentLimitUp: true,
          amount: 500000000,
          previousCloseCents: 1000,
          previousOpenCents: 950,
          previousChange: 10,
          previousHeight: 1,
          lastFourCloseSumCents: 3600,
        },
      ]),
    ),
  };
  if (legacyRevision)
    source.industryRevision = {
      version: "eastmoney-code-industry-amendment-v1",
      correctedAt: `${date}T01:30:00Z`,
      originalSignalFrozenAt: "2026-10-25T02:00:00Z",
      metadataSnapshotId: "em-fixture",
      metadataDigest: await digestOf(records),
      metadataFetchedAt: metadataAt,
    };
  await DB.prepare(
    "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
  )
    .bind(signalDate, source.createdAt, JSON.stringify(source))
    .run();
  const plan = createPlan(
    source,
    book,
    null,
    record.id,
    "2026-10-25T02:00:00Z",
    {
      executionCostPolicy: await latestPolicyBundle(DB),
      engineBuild: record.engineBuild,
      snapshotDigest: await selectionSnapshotDigest(source),
      observationUniverse: ["600001", "600002"],
      ...(legacyTemplate
        ? { dragonTemplateVersion: "dragon-template-v1" }
        : {}),
      ...(riskPolicy ? { adaptiveRiskPolicy: riskPolicy } : {}),
    },
  );
  await papers.savePlan(plan);
  await DB.prepare(
    "INSERT INTO metadata_snapshots(id,kind,source,state,fetched_at,digest,stats) VALUES('em-fixture','stock_em','eastmoney-fixture','PUBLISHED',?,?,'{}')",
  )
    .bind(metadataAt, await digestOf(records))
    .run();
  for (const r of records)
    await DB.prepare(
      "INSERT INTO metadata_records(snapshot_id,code,payload) VALUES('em-fixture',?,?)",
    )
      .bind(r.code, JSON.stringify(r))
      .run();
  await DB.prepare(
    "INSERT INTO metadata_current(kind,snapshot_id) VALUES('stock_em','em-fixture')",
  ).run();
  const observation = {
    observedAt: `${date}T01:31:00Z`,
    pollIntervalSeconds: 10,
    quotes: Object.fromEntries(
      records.map((r) => [
        r.code,
        {
          date,
          timestamp: `${date}T09:31:00+08:00`,
          closeCents: 1000,
          previousCloseCents: 1000,
          openCents: 1000,
          highCents: 1000,
          lowCents: 1000,
          volumeShares: 1000000,
          limitUpCents: 1100,
          limitDownCents: 900,
        },
      ]),
    ),
    entryInputs: {
      market: {
        date,
        observedAt: `${date}T01:31:00Z`,
        sectorsComplete: true,
        cycle: { phase: "rising" },
        sectors: [
          { name: "专用设备", score: 80, count: 3 },
          { name: "汽车零部件", score: 80, count: 3 },
        ],
        discoveries: [],
        ...(legacyRevision
          ? { industryContext: { stockEmSnapshotId: "em-fixture" } }
          : {}),
      },
    },
  };
  const step = advanceSession(book, openSession(book, plan, date), observation);
  assert.equal(step.ledger.length, 0);
  await new RealtimeRepository(env).commitObservation(
    (await papers.account()).revision,
    step,
    observation,
  );
  await new QuoteFrameRepository(env).appendFrame({
    tradeDate: date,
    observedAt: observation.observedAt,
    quotes: observation.quotes,
    entryInputs: observation.entryInputs,
    pollIntervalSeconds: 10,
    pool: { codes: records.map((r) => r.code) },
  });
  return { DB, env, papers, source, plan, records };
}

function continuationObservation(stamp, price, volume, askShares = 300) {
  return {
    observedAt: stamp,
    pollIntervalSeconds: 10,
    quotes: {
      600001: {
        date,
        timestamp: stamp,
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
        ask1Shares: askShares,
        bid1Shares: 100000,
        orderBookQuality: "OK",
        orderBookTimestamp: stamp,
      },
    },
    entryInputs: {
      market: {
        date,
        observedAt: stamp,
        cycle: { phase: "rising" },
        sectorsComplete: true,
        sectors: [{ name: "专用设备", score: 85, count: 6, broken: 0 }],
        discoveries: [],
        industryContext: { stockEmSnapshotId: "em-fixture" },
        metrics: {
          limitUp: 80,
          broken: 0,
          height: 5,
          premium: 3,
          premiumCoverage: 1,
        },
      },
      auction: {
        600001: { date, final: true, openCents: 940, previousCloseCents: 1000 },
      },
    },
  };
}

async function partialContinuationFixture(t) {
  const f = await fixture(t, {
    oldEngine: true,
    canonicalHistory: true,
    legacyRevision: true,
    legacyTemplate: true,
  });
  const repo = new RealtimeRepository(f.env);
  for (const [seconds, price, volume] of [
    [10, 950, 2000000],
    [20, 951, 3000000],
  ]) {
    const observation = continuationObservation(
      `${date}T01:31:${seconds}Z`,
      price,
      volume,
    );
    const account = await repo.account();
    const step = advanceSession(
      account.book,
      await repo.session(date),
      observation,
    );
    await repo.commitObservation(account.revision, step, observation);
  }
  const session = await repo.session(date);
  assert.equal(session.fillCount, 1);
  assert.equal(session.orders[0].status, "PARTIAL");
  assert.equal(session.orders[0].filledQuantity, 300);
  return { ...f, repo, session };
}

test("按代码统一已发布东财行业与缩写；历史查询不借用之后发布的分类", async (t) => {
  const f = await fixture(t);
  const market = {
    date,
    rows: [
      { c: "600001", hybk: "错误旧行业" },
      { c: "600002", hybk: "汽车零部" },
    ],
    brokenRows: [],
  };
  const result = await enrichMarketIndustries(f.env, market);
  assert.deepEqual(
    result.rows.map((r) => r.hybk),
    ["专用设备", "汽车零部件"],
  );
  assert.equal(result.rows[1]._industryNative, "汽车零部");
  assert.equal(
    result.industryContext.mappingPolicy,
    "CODE_SNAPSHOT_PRIMARY_V2",
  );
  assert.equal(
    (await enrichMarketIndustries(f.env, { ...market, date: signalDate }))
      .rows[0].hybk,
    "错误旧行业",
  );
  assert.equal(market.rows[0].hybk, "错误旧行业");
  const historicalMissing = await enrichMarketIndustries(f.env, {
    ...market,
    date: signalDate,
    rows: [{ c: "600001", hybk: null }],
  });
  assert.equal(historicalMissing.rows[0].hybk, null);
  assert.equal(historicalMissing.industryContext.stockEmSnapshotId, null);
});

test("完整行情下已知行业无涨停是零活跃，源缺失时不得造零", async () => {
  const base = {
    date,
    fetchedAt: `${date}T01:31:00Z`,
    rows: [{ c: "600001", n: "样本", hybk: "专用设备", lbc: 1 }],
    broken: 0,
    brokenRows: [],
    previous: [],
    industryContext: {
      mappingPolicy: "CODE_SNAPSHOT_PRIMARY_V2",
      industryNames: ["专用设备", "汽车零部件"],
    },
  };
  const complete = await collectEntryMarket(date, {
    provider: async () => base,
  });
  assert.deepEqual(
    complete.sectors.find((s) => s.name === "汽车零部件"),
    {
      name: "汽车零部件",
      score: 0,
      count: 0,
      height: 0,
      coverage: 100,
      broken: 0,
    },
  );
  const missing = await collectEntryMarket(date, {
    provider: async () => ({ ...base, brokenRows: null }),
  });
  assert.equal(missing.sectorsComplete, false);
  assert.equal(
    missing.sectors.some((s) => s.name === "汽车零部件"),
    false,
  );
});

test("冻结计划绑定行业快照；后续发布新版不污染旧计划，也不取晚于原冻结时刻的数据修复", async (t) => {
  const f = await fixture(t);
  const later = f.records.map((r) => ({ ...r, emIndustry: "新版分类" }));
  await f.DB.prepare(
    "INSERT INTO metadata_snapshots(id,kind,source,state,fetched_at,digest,stats) VALUES('em-later','stock_em','eastmoney-fixture','PUBLISHED','2026-10-26T02:10:00Z',?,'{}')",
  )
    .bind(await digestOf(later))
    .run();
  for (const r of later)
    await f.DB.prepare(
      "INSERT INTO metadata_records(snapshot_id,code,payload) VALUES('em-later',?,?)",
    )
      .bind(r.code, JSON.stringify(r))
      .run();
  await f.DB.prepare(
    "UPDATE metadata_current SET snapshot_id='em-later' WHERE kind='stock_em'",
  ).run();
  assert.equal(
    (await inspectIndustryRepair(f.env, now)).metadata.id,
    "em-fixture",
  );
  await repairIndustryInputs(f.env, { now });
  const plan = await f.papers.plan(signalDate);
  assert.equal(plan.entryExecutionPolicy.industrySnapshotId, "em-fixture");
  const market = {
    date,
    fetchedAt: now.toISOString(),
    rows: [{ c: "600001", n: "合成样本1", hybk: "源缩写", lbc: 1 }],
    brokenRows: [],
    broken: 0,
    previous: [],
  };
  const latest = await enrichMarketIndustries(f.env, market);
  assert.equal(latest.rows[0].hybk, "新版分类");
  let requested;
  const input = await collectEntryMarket(date, {
    industrySnapshotId: plan.entryExecutionPolicy.industrySnapshotId,
    env: f.env,
    provider: async (_, __, options) => {
      requested = options.industrySnapshotId;
      return enrichMarketIndustries(f.env, market, options);
    },
  });
  assert.equal(requested, "em-fixture");
  assert.equal(input.industryContext.stockEmSnapshotId, "em-fixture");
  assert.ok(input.sectors.some((s) => s.name === "专用设备"));
  await assert.rejects(
    collectEntryMarket(date, {
      industrySnapshotId: "em-fixture",
      provider: async () => latest,
    }),
    /行业来源.*不一致/,
  );
  await assert.rejects(
    enrichMarketIndustries(f.env, market, { industrySnapshotId: "missing" }),
    /缺失或摘要/,
  );
});

for (const oldEngine of [false, true])
  test(`行业修订保留原价格冻结时刻和名单，旧观测完整归档，不补成交；旧执行构建=${oldEngine}`, async (t) => {
    const f = await fixture(t, { oldEngine });
    const before = await f.papers.account();
    const result = await repairIndustryInputs(f.env, { now });
    assert.equal(result.changed, true);
    assert.equal(result.retiredObservations, 1);
    assert.equal(result.verification.passed, true);
    const current = await f.papers.plan(signalDate);
    assert.equal(current.createdAt, f.plan.createdAt);
    assert.deepEqual(
      current.entryExecutionPolicy.candidates,
      f.plan.entryExecutionPolicy.candidates,
    );
    assert.equal(
      current.entryExecutionPolicy.history["600001"].sector,
      "专用设备",
    );
    assert.equal(
      current.entryExecutionPolicy.history["600001"].previousCloseCents,
      1000,
    );
    const after = await f.papers.account();
    for (const key of [
      "cashCents",
      "equityCents",
      "feesCents",
      "settlementCount",
      "positions",
      "lastDate",
      "dragonConfig",
    ])
      assert.deepEqual(after.book[key], before.book[key], key);
    const archive = await tradingArchive(f.env, result.archiveId);
    assert.equal(archive.tables.paper_live_ticks.length, 1);
    assert.equal(archive.tables.quote_frames.length, 1);
    assert.equal(
      (await verifyExport(archive.tables.repair_export[0])).passed,
      true,
    );
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT COUNT(*) n FROM quote_frames WHERE trade_date=?",
        )
          .bind(date)
          .first()
      ).n,
      0,
    );
    assert.equal(
      JSON.parse(
        (
          await f.DB.prepare(
            "SELECT payload FROM paper_live_sessions WHERE trade_date=?",
          )
            .bind(date)
            .first()
        ).payload,
      ).sequence,
      0,
    );
    assert.equal(
      (await f.DB.prepare("SELECT COUNT(*) n FROM paper_ledger").first()).n,
      0,
    );
    assert.equal((await repairIndustryInputs(f.env, { now })).changed, false);
    assert.equal((await verifyExport(await exportPaper(f.env))).passed, true);
  });

test("已修正行业但尚未绑定快照的零成交会话，可在重启时补齐版本并升级执行构建", async (t) => {
  const f = await fixture(t, { canonicalHistory: true, oldEngine: true });
  const prepared = await inspectIndustryRepair(f.env, now);
  assert.equal(prepared.corrections.length, 0);
  const result = await repairIndustryInputs(f.env, { now });
  assert.equal(result.changed, true);
  assert.equal(result.corrections.length, 0);
  assert.equal(result.verification.passed, true);
  assert.equal(
    (await f.papers.plan(signalDate)).entryExecutionPolicy.industrySnapshotId,
    "em-fixture",
  );
  assert.notEqual(
    (await f.papers.account()).book.dragonEngineBuild,
    "a".repeat(64),
  );
  assert.equal((await repairIndustryInputs(f.env, { now })).changed, false);
});

test("已有订单、未来行业快照、失败写入和摘要损坏均不改写原账本", async (t) => {
  const f = await fixture(t);
  const before = await f.papers.account(),
    plan = await f.papers.plan(signalDate);
  f.DB.exec(
    "CREATE TRIGGER fail_industry_archive BEFORE INSERT ON industry_repair_archive_chunks BEGIN SELECT RAISE(ABORT,'archive write failed'); END",
  );
  await assert.rejects(
    repairIndustryInputs(f.env, { now }),
    /archive write failed/,
  );
  assert.deepEqual(await f.papers.account(), before);
  assert.deepEqual(await f.papers.plan(signalDate), plan);
  assert.equal(
    (
      await f.DB.prepare(
        "SELECT COUNT(*) n FROM industry_repair_archives",
      ).first()
    ).n,
    0,
  );
  f.DB.exec("DROP TRIGGER fail_industry_archive");
  const row = await f.DB.prepare(
    "SELECT payload FROM paper_live_sessions WHERE trade_date=?",
  )
    .bind(date)
    .first();
  const session = JSON.parse(row.payload);
  session.orders.push({ id: "existing-order" });
  await f.DB.prepare(
    "UPDATE paper_live_sessions SET payload=? WHERE trade_date=?",
  )
    .bind(JSON.stringify(session), date)
    .run();
  await assert.rejects(repairIndustryInputs(f.env, { now }), /已下单/);
  assert.deepEqual(await f.papers.account(), before);
  await f.DB.prepare(
    "UPDATE metadata_snapshots SET fetched_at='2026-10-26T02:00:00Z' WHERE id='em-fixture'",
  ).run();
  assert.equal(await inspectIndustryRepair(f.env, now), null);
  await f.DB.prepare(
    "UPDATE metadata_snapshots SET fetched_at='2026-10-24T10:00:00Z',digest='bad' WHERE id='em-fixture'",
  ).run();
  await assert.rejects(inspectIndustryRepair(f.env, now), /摘要不一致/);
});

test("旧构建已有300股部分成交：追加续跑证明，原计划/持仓/成交/观测完整保留，新报价继续成交", async (t) => {
  const f = await partialContinuationFixture(t);
  const resumeAt = new Date(`${date}T01:32:00Z`);
  const before = await exportPaper(f.env);
  assert.equal(
    await verifyEntryOrderObservation(before, f.session.plan, date, 1, {
      ...before.realtimeObservations[0].observations[0].payload,
      entryOrderPolicy: ENTRY_ORDER_POLICY,
    }),
    false,
    "旧观测不能自行声明启用新的恢复规则",
  );
  await assert.rejects(
    assertStoredProgramPlan(f.env, f.session.plan, f.session.initialBook),
    /执行指纹/,
  );
  assert.equal((await inspectIndustryRepair(f.env, now)).mode, "CONTINUE");
  const result = await repairIndustryInputs(f.env, { now: resumeAt });
  assert.equal(result.mode, "CONTINUE");
  assert.equal(result.preservedFills, 1);
  assert.equal(result.retiredObservations, 0);
  const after = await exportPaper(f.env);
  for (const key of [
    "book",
    "ledger",
    "plans",
    "realtimeSessions",
    "realtimeObservations",
    "signalSnapshots",
  ])
    assert.deepEqual(after[key], before[key], key);
  await assertStoredProgramPlan(f.env, f.session.plan, f.session.initialBook);
  assert.equal(
    (await repairIndustryInputs(f.env, { now: resumeAt })).changed,
    false,
  );
  assert.equal((await verifyExport(after)).passed, true);
  const proof = await industryContinuation(f.DB, f.session.plan);
  assert.equal(proof.industrySnapshotId, "em-fixture");
  await assert.rejects(
    f.DB.prepare(
      "UPDATE paper_configuration_history SET created_at=? WHERE id=?",
    )
      .bind(now.toISOString(), proof.id)
      .run(),
    /不可改写/,
  );
  await assert.rejects(
    f.DB.prepare("DELETE FROM paper_configuration_history WHERE id=?")
      .bind(proof.id)
      .run(),
    /不可删除/,
  );
  for (const [seconds, price, volume] of [
    [0, 951, 12000000],
    [10, 952, 13000000],
  ]) {
    const observation = continuationObservation(
      `${date}T01:32:${seconds === 0 ? "00" : seconds}Z`,
      price,
      volume,
    );
    const response = await pollTrading(
      f.env,
      new Date(observation.observedAt),
      {
        observedAt: observation.observedAt,
        quotes: async () => observation.quotes,
        entryInputs: observation.entryInputs,
      },
    );
    assert.ok(
      ["RUNNING", "STALE_QUOTES"].includes(response.status),
      JSON.stringify(response),
    );
    if (seconds === 0)
      assert.equal(response.fills, 0, "停机间隔只建立新基线，不能补造增量成交");
    else assert.ok(response.fills > 0, "后续有效报价可继续原部分成交订单");
  }
  const continued = await exportPaper(f.env);
  assert.deepEqual(continued.ledger[0], before.ledger[0]);
  assert.equal((await verifyExport(continued)).passed, true);
  assert.equal(
    (await repairIndustryInputs(f.env, { now: new Date(`${date}T01:33:00Z`) }))
      .changed,
    false,
  );
});

test("续跑不消费登记前的漏处理帧，旧帧继续留档；只消费新帧且校验行业版本", async (t) => {
  const f = await partialContinuationFixture(t);
  const frames = new QuoteFrameRepository(f.env);
  const old = continuationObservation(`${date}T02:14:50Z`, 951, 12000000);
  await frames.appendFrame({
    tradeDate: date,
    observedAt: old.observedAt,
    quotes: old.quotes,
    entryInputs: old.entryInputs,
    pollIntervalSeconds: 10,
    pool: { codes: ["600001"] },
  });
  await repairIndustryInputs(f.env, { now });
  const next = continuationObservation(`${date}T02:15:10Z`, 952, 13000000);
  const result = await runTournamentPoll(f.env, new Date(next.observedAt), {
    providers: {
      quotes: async () => next.quotes,
      entryInputs: next.entryInputs,
    },
  });
  assert.ok(
    ["RUNNING", "STALE_QUOTES"].includes(result.primary.status),
    JSON.stringify(result.primary),
  );
  const ticks = await f.repo.observations(date);
  assert.equal(ticks.length, f.session.sequence + 1);
  assert.equal(
    Date.parse(ticks.at(-1).payload.observedAt),
    Date.parse(next.observedAt),
  );
  assert.ok(
    (await frames.framesForDate(date)).some(
      (row) => row.observedAt === old.observedAt,
    ),
  );
  const wrong = continuationObservation(`${date}T02:15:20Z`, 953, 14000000);
  wrong.entryInputs.market.industryContext.stockEmSnapshotId =
    "different-industry";
  const blocked = await pollTrading(f.env, new Date(wrong.observedAt), {
    observedAt: wrong.observedAt,
    quotes: async () => wrong.quotes,
    entryInputs: wrong.entryInputs,
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.match(blocked.reason, /行业来源/);
  const stale = await pollTrading(f.env, now, {
    observedAt: old.observedAt,
    quotes: async () => old.quotes,
    entryInputs: old.entryInputs,
  });
  assert.equal(stale.status, "BLOCKED");
  assert.equal((await f.repo.observations(date)).length, ticks.length);
});

test("续跑必须精确重放会话状态，写入失败回滚；不能借用其他计划/作用域的证明", async (t) => {
  const f = await partialContinuationFixture(t);
  const before = await exportPaper(f.env);
  const changed = structuredClone(f.session);
  changed.entryState.paths["600001"].stableQuotes += 1;
  await f.DB.prepare(
    "UPDATE paper_live_sessions SET payload=?,digest=? WHERE trade_date=?",
  )
    .bind(JSON.stringify(changed), await digestOf(changed), date)
    .run();
  await assert.rejects(repairIndustryInputs(f.env, { now }), /逐帧复现/);
  await f.DB.prepare(
    "UPDATE paper_live_sessions SET payload=?,digest=? WHERE trade_date=?",
  )
    .bind(JSON.stringify(f.session), await digestOf(f.session), date)
    .run();
  f.DB.exec(
    `CREATE TRIGGER fail_continuation BEFORE INSERT ON paper_configuration_history WHEN json_extract(NEW.payload,'$.type')='${INDUSTRY_CONTINUATION}' BEGIN SELECT RAISE(ABORT,'continuation write failed'); END`,
  );
  await assert.rejects(
    repairIndustryInputs(f.env, { now }),
    /continuation write failed/,
  );
  assert.deepEqual((await exportPaper(f.env)).book, before.book);
  assert.equal(await industryContinuation(f.DB, f.session.plan), null);
  f.DB.exec("DROP TRIGGER fail_continuation");
  await repairIndustryInputs(f.env, { now });
  assert.equal(
    await industryContinuation(f.DB, f.session.plan, "shadow:other"),
    null,
  );
  const other = structuredClone(f.session.plan);
  other.entryExecutionPolicy.candidates.pop();
  assert.equal(await industryContinuation(f.DB, other), null);
  await assert.rejects(
    assertStoredProgramPlan(f.env, other, f.session.initialBook),
    /冻结依据/,
  );
  const exported = await exportPaper(f.env);
  const forged = structuredClone(exported);
  const event = forged.configurationHistory.find(
    (row) => row.payload.type === INDUSTRY_CONTINUATION,
  );
  event.payload.verifiedPrefix.sessionDigest = "0".repeat(64);
  event.digest = await digestOf(event.payload);
  assert.equal((await verifyExport(forged)).passed, false);
  assert.equal((await verifyExport(exported)).passed, true);
});

test("旧v1动态会话保留原成交，在续跑边界启用3分钟分层恢复；新观测与完整账本可重放", async (t) => {
  const f = await fixture(t, {
    oldEngine: true,
    canonicalHistory: true,
    legacyRevision: true,
    riskPolicy: ADAPTIVE_RISK_POLICY_V1,
  });
  const repo = new RealtimeRepository(f.env);
  for (let seconds = 10; seconds <= 190; seconds += 10) {
    const stamp = new Date(
      Date.parse(`${date}T01:31:00Z`) + seconds * 1000,
    ).toISOString();
    const observation = continuationObservation(
      stamp,
      951,
      seconds === 190 ? 1300000 : 1000000,
    );
    const account = await repo.account();
    const step = advanceSession(
      account.book,
      await repo.session(date),
      observation,
    );
    await repo.commitObservation(account.revision, step, observation);
  }
  const original = await exportPaper(f.env);
  const beforeSession = await repo.session(date);
  assert.equal(
    beforeSession.adaptiveRisk.version,
    ADAPTIVE_RISK_POLICY_V1.version,
  );
  assert.equal(beforeSession.orders[0].filledQuantity, 300);
  assert.equal(beforeSession.orders[0].status, "PARTIAL");
  await repairIndustryInputs(f.env, { now: new Date(`${date}T01:34:30Z`) });
  for (const [stamp, volume] of [
    [`${date}T01:35:10Z`, 2000000],
    [`${date}T01:35:20Z`, 2100000],
  ]) {
    const observation = continuationObservation(stamp, 952, volume);
    const result = await pollTrading(f.env, new Date(stamp), {
      observedAt: stamp,
      quotes: async () => observation.quotes,
      entryInputs: observation.entryInputs,
    });
    assert.ok(
      ["RUNNING", "STALE_QUOTES"].includes(result.status),
      JSON.stringify(result),
    );
    if (volume === 2000000)
      assert.equal(result.fills, 0, "断流区间成交量不补成成交额度");
    else assert.ok(result.fills > 0);
  }
  const afterSession = await repo.session(date);
  assert.equal(afterSession.adaptiveRisk.version, ADAPTIVE_RISK_POLICY.version);
  assert.equal(afterSession.adaptiveRisk.market.ready, true);
  assert.equal(afterSession.adaptiveRisk.stocks["600001"].ready, true);
  const after = await exportPaper(f.env);
  assert.deepEqual(after.plans, original.plans);
  assert.deepEqual(after.ledger[0], original.ledger[0]);
  assert.equal((await verifyExport(after)).passed, true);
  const scoreResult = await runScoringTick(f.env, { maxFrames: 100 });
  assert.ok(scoreResult.processed > 0, "已验证的旧计划续跑可独立生成新版评分");
  assert.equal(scoreResult.issues.length, 0);
  assert.equal((await runScoringTick(f.env, { maxFrames: 100 })).processed, 0);
  const scored = await exportPaper(f.env);
  assert.deepEqual(scored.book, after.book);
  assert.deepEqual(scored.ledger, after.ledger);
});
