import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { localDatabase } from "../scripts/local-db.mjs";
import { openHistoryStore } from "../backend/storage/history.js";
import { PaperRepository } from "../backend/storage/paper.js";
import {
  createHistoryImport,
  runHistoryImport,
} from "../backend/services/history.js";
import { runBacktest, backtestDetail } from "../backend/services/backtest.js";
import {
  auditArchivedDay,
  evaluateArchivedInterval,
  researchSnapshotView,
} from "../backend/services/archived-backtest.js";
import {
  fetchCompleteHistoricalPool,
  reconstructV5Snapshot,
  V5_SCORING_VERSION,
  V5_RECONSTRUCTION_VERSION,
  freezeResearchConfiguration,
  fetchResearchDailyRecord,
  withResearchDailyRecords,
} from "../backend/services/v5-reconstruction.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import {
  createPlan,
  newBook,
  BASE_STRATEGY,
} from "../backend/domain/trading.js";
import { openSession, advanceSession } from "../backend/domain/realtime.js";
import { defaultExecutionCostPolicy } from "../shared/execution-cost.js";
import { DEFAULT_FEES } from "../shared/fees.js";
import { DEFAULT_RISK_LIMITS } from "../shared/risk-limits.js";
import { snapshot as baseSnapshot } from "./fixtures/trading.mjs";
import { INTRADAY_ENTRY_VERSION } from "../backend/domain/intraday-entry.js";
import {
  summarizeTQuality,
  buildTQualityEvidence,
} from "../backend/domain/t-quality.js";
import { analyze } from "../shared/scoring.js";
import {
  computeEodRowsWithPrev,
  computeMa5ByCode,
  computeStockFeaturesByCode,
} from "../backend/services/daily-closes.js";

const signalDate = "2026-03-02",
  date = "2026-03-03";
const configuration = {
  strategy: BASE_STRATEGY,
  fees: DEFAULT_FEES,
  riskLimits: DEFAULT_RISK_LIMITS,
  initialCapital: 1000000,
  activeStrategy: "baseline-v1",
  executionCostPolicy: defaultExecutionCostPolicy(),
  buyPointParams: { firstNegMinPrevHeight: 3 },
};
function source(overrides = {}) {
  return {
    ...baseSnapshot(signalDate, [1000]),
    stocks: baseSnapshot(signalDate, [1000]).stocks.slice(0, 1),
    brokenStocks: [],
    extraStocks: [],
    modelVersion: V5_SCORING_VERSION,
    reconstructionVersion: V5_RECONSTRUCTION_VERSION,
    createdAt: "2026-10-22T10:00:00.000Z",
    decisionAt: `${signalDate}T07:10:00.000Z`,
    candidateCoverage: { status: "COMPLETE", issues: [] },
    researchExitInputs: {},
    intradayEntryContext: {
      version: INTRADAY_ENTRY_VERSION,
      asOf: signalDate,
      firstNegMinPrevHeight: 3,
      history: {
        600001: {
          name: "合成样本",
          sector: "测试行业",
          stockClass: "relay-leader",
          recentLimitUp: true,
          amount: 500000000,
          previousCloseCents: 1000,
          previousOpenCents: 950,
          previousChange: 10,
          previousHeight: 3,
          previousTouchedLimit: true,
          lastFourCloseSumCents: 3600,
          previousVolumeShares: null,
          ...overrides,
        },
      },
    },
  };
}
function planFor(s) {
  return createPlan(
    researchSnapshotView(s),
    {
      ...newBook(),
      lastDate: signalDate,
      entryExecutionMode: "intraday-conditional",
    },
    BASE_STRATEGY,
    "baseline-v1",
    `${signalDate}T07:15:00.000Z`,
    s.tQualityRulesVersion
      ? {
          tQuality: summarizeTQuality([], { signalDate, tradingDates: [] }),
          tQualityEvidence: buildTQualityEvidence([], []),
        }
      : {},
  );
}
async function framesFor(kind = "none") {
  const frames = [];
  const open =
    kind === "auction-dip" ? 940 : kind === "fake-neg-limit-dip" ? 910 : 1000;
  let high = 1000,
    volume = 100000;
  for (const [from, to] of [
    ["09:30:00", "11:30:00"],
    ["13:00:00", "14:56:50"],
    ["15:00:00", "15:00:00"],
  ]) {
    for (
      let t = Date.parse(`${date}T${from}+08:00`);
      t <= Date.parse(`${date}T${to}+08:00`);
      t += 10000
    ) {
      const time = new Date(t + 8 * 3600000).toISOString().slice(11, 19);
      let price = 1000;
      if (kind === "auction-dip") price = 950;
      if (kind === "fake-neg-limit-dip") price = 921;
      if (kind === "broken-board-dip" && time >= "10:45:00") {
        price = 1040;
        high = 1100;
      }
      if (kind === "first-neg-dip" && time >= "14:31:00") price = 970;
      if (kind === "late-dip" && time >= "14:31:00") price = 960;
      if (kind === "limit-up-momentum" && time >= "09:45:00") {
        price = time === "09:45:00" ? 1100 : 1090;
        high = 1100;
      }
      const observedAt = new Date(t).toISOString(),
        pool = {
          codes: ["600001"],
          sources: { 600001: ["TEST_FIXTURE"] },
          declaredAt: observedAt,
        };
      const poolDigest = await digestOf(pool);
      const payload = {
        observedAt,
        pollIntervalSeconds: 10,
        pool,
        poolDigest,
        capture: { missingCodes: [] },
        quotes: {
          600001: {
            date,
            timestamp: observedAt,
            closeCents: price,
            previousCloseCents: 1000,
            openCents: open,
            highCents: high,
            lowCents: Math.min(open, price),
            volumeShares: volume,
            limitUpCents: 1100,
            limitDownCents: 900,
            bid1Cents: price - 1,
            ask1Cents: price + 1,
            bid1Shares: 100000,
            ask1Shares: 100000,
            orderBookQuality: "OK",
            orderBookTimestamp: observedAt,
          },
        },
        entryInputs: {
          market: {
            date,
            observedAt,
            emotion: 75,
            cycle: { maxGrossExposure: 0.6 },
            sectors: [{ name: "测试行业", score: 85 }],
            discoveries: [],
          },
          auction: {
            600001: {
              date,
              final: true,
              openCents: open,
              previousCloseCents: 1000,
            },
          },
        },
      };
      frames.push({
        tradeDate: date,
        sequence: frames.length + 1,
        observedAt,
        poolDigest,
        payload,
        digest: await digestOf(payload),
        origin: "REAL_QUOTE_ARCHIVE",
        createdAt: observedAt,
        importedAt: "2026-10-22T10:00:00.000Z",
      });
      volume += 100000;
    }
  }
  return frames;
}
function fakeStore(s, frames) {
  return {
    listScores: async () => [{ tradeDate: signalDate, payload: s }],
    listArchivedFrames: async () => frames,
  };
}
function dataset() {
  const warmupDates = candidateDataset().dates.slice(-22, -1);
  return {
    id: "synthetic-test-only",
    coverage: {
      executionDates: [date],
      signalDates: [signalDate],
      warmupDates,
      tradingDates: [...warmupDates, signalDate, date],
    },
  };
}

test("历史池逐页验收：缺列表、重复、分页不完整不能当作空名单", async () => {
  const calls = [];
  const ok = await fetchCompleteHistoricalPool(async (_, o) => {
    calls.push(o.page);
    return {
      pagination: { page: o.page, pages: 2, total: 2 },
      item: [{ ticker: `60000${o.page}` }],
    };
  }, date);
  assert.equal(ok.rows.length, 2);
  assert.deepEqual(calls, [1, 2]);
  const empty = await fetchCompleteHistoricalPool(
    async () => ({ pagination: { page: 1, pages: 0, total: 0 }, item: [] }),
    date,
  );
  assert.equal(empty.complete, true);
  for (const response of [
    { unavailable: true, item: [] },
    { item: [] },
    {
      pagination: { page: 1, pages: 1, total: 2 },
      item: [{ ticker: "600001" }],
    },
    { date: signalDate, pagination: { page: 1, pages: 1, total: 0 }, item: [] },
  ])
    await assert.rejects(
      fetchCompleteHistoricalPool(async () => response, date),
    );
  await assert.rejects(
    fetchCompleteHistoricalPool(
      async (_, o) => ({
        pagination: { page: o.page, pages: 2, total: 2 },
        item: [{ ticker: "600001" }],
      }),
      date,
    ),
    /重复/,
  );
});

function candidateDataset() {
  const dates = [];
  for (let n = 60; n >= 0; n--) {
    const d = new Date(Date.parse(`${signalDate}T00:00:00Z`) - n * 86400000);
    if (![0, 6].includes(d.getUTCDay()))
      dates.push(d.toISOString().slice(0, 10));
  }
  const count = dates.length,
    codes = new Map();
  for (const code of ["600001", "600002", "600003", "600004"]) {
    const c = Array(count).fill(10),
      o = Array(count).fill(10),
      h = Array(count).fill(10.5),
      l = Array(count).fill(9.8);
    c[count - 7] = 11;
    h[count - 7] = 11;
    if (code === "600001") {
      c[count - 1] = 11;
      h[count - 1] = 11;
    }
    if (code === "600002") {
      c[count - 1] = 10.4;
      h[count - 1] = 11;
    }
    if (code === "600003") {
      c.fill(9);
      l.fill(8.8);
      c[count - 3] = 10 / 1.1;
      c[count - 2] = 10;
      c[count - 1] = 9.8;
      o[count - 1] = 10;
      h[count - 1] = 10;
    }
    if (code === "600004") {
      o[count - 2] = 10.9;
      h[count - 2] = 11;
      c[count - 1] = 9.4;
      o[count - 1] = 9;
      h[count - 1] = 9.5;
      l[count - 1] = 9;
    }
    codes.set(code, {
      dates: Uint32Array.from(dates, (_, i) => i),
      closes: Float64Array.from(c),
      opens: Float64Array.from(o),
      highs: Float64Array.from(h),
      lows: Float64Array.from(l),
      volumes: new Float64Array(count).fill(50000000),
      amounts: new Float64Array(count).fill(500000000),
      adjs: new Float64Array(count).fill(1),
      hasFactor: true,
    });
  }
  return { dates, dateIdx: new Map(dates.map((d, i) => [d, i])), codes };
}
test("历史与线上构造对齐：涨停、炸板、首阴、假阴进入 V5，昨日池现价不能污染昨日 K 线", async () => {
  const dataset = candidateDataset(),
    previousDate = dataset.dates.at(-2);
  const metadata = new Map(
    [...dataset.codes.keys()].map((code) => [
      code,
      {
        name: `合成${code}`,
        industryName: "测试行业",
        pointInTimeVerified: true,
      },
    ]),
  );
  const pools = {
    main: {
      date: signalDate,
      rows: [
        {
          ticker: "600001",
          name: "合成600001",
          last_price: 11,
          continue_day_cnt: 3,
          seal_money: 500000000,
        },
      ],
    },
    broken: {
      date: signalDate,
      rows: [
        {
          ticker: "600002",
          name: "合成600002",
          last_price: 10.4,
          open_times: 1,
          turnover: 500000000,
        },
      ],
    },
  };
  const previousPools = {
    main: {
      date: previousDate,
      rows: [
        {
          ticker: "600003",
          name: "合成600003",
          last_price: 999,
          continue_day_cnt: 3,
        },
      ],
    },
  };
  const result = reconstructV5Snapshot({
    date: signalDate,
    previousDate,
    dataset,
    pools,
    previousPools,
    metadata,
    configuration,
    createdAt: "2026-10-22T10:00:00.000Z",
  });
  const s = result.snapshot;
  assert.deepEqual(
    s.stocks.map((r) => r.code),
    ["600001"],
  );
  assert.deepEqual(
    s.brokenStocks.map((r) => r.code),
    ["600002"],
  );
  assert.deepEqual(s.extraStocks.map((r) => r.code).sort(), [
    "600003",
    "600004",
  ]);
  assert.ok(
    s.extraStocks
      .find((r) => r.code === "600003")
      .buyPoint.labels.includes("first-neg-dip"),
  );
  assert.ok(
    s.extraStocks
      .find((r) => r.code === "600004")
      .buyPoint.labels.includes("fake-neg-limit-dip"),
  );
  assert.equal(s.market.previous[0].close, 10);
  assert.equal(s.market.previous[0].open, 10);
  const online = analyze(
    s.market.rows,
    s.market.broken,
    s.market.previous,
    configuration.strategy.weights,
    {
      ma5ByCode: computeMa5ByCode(dataset, signalDate).ma5ByCode,
      historyByCode: computeStockFeaturesByCode(dataset, signalDate)
        .featuresByCode,
      lateSession: true,
      firstNegMinPrevHeight: 3,
      brokenRows: s.market.brokenRows,
      extraCandidates: s.extraStocks,
      prevEodByCode: computeEodRowsWithPrev(dataset, signalDate).rowsByCode,
      previousPricesVerified: true,
    },
  );
  assert.deepEqual(online.stocks, s.stocks);
  assert.deepEqual(online.brokenStocks, s.brokenStocks);
  const plan = planFor(s);
  for (const code of ["600001", "600002", "600003", "600004"])
    assert.ok(plan.entryExecutionPolicy.candidates.includes(code), code);
  // A future bar cannot change the past candidate set or frozen history.
  const future = candidateDataset();
  future.dateIdx.set("2026-03-03", future.dates.length);
  future.dates.push("2026-03-03");
  for (const [code, s] of future.codes)
    future.codes.set(code, {
      ...s,
      dates: Uint32Array.from([...s.dates, future.dates.length - 1]),
      closes: Float64Array.from([...s.closes, 999]),
      opens: Float64Array.from([...s.opens, 999]),
      highs: Float64Array.from([...s.highs, 999]),
      lows: Float64Array.from([...s.lows, 999]),
      volumes: Float64Array.from([...s.volumes, 1]),
      amounts: Float64Array.from([...s.amounts, 1]),
      adjs: Float64Array.from([...s.adjs, 1]),
    });
  const later = reconstructV5Snapshot({
    date: signalDate,
    previousDate,
    dataset: future,
    pools,
    previousPools,
    metadata,
    configuration,
    createdAt: s.createdAt,
  }).snapshot;
  assert.equal(await digestOf(s), await digestOf(later));
});

for (const kind of [
  "auction-dip",
  "fake-neg-limit-dip",
  "broken-board-dip",
  "first-neg-dip",
  "late-dip",
  "limit-up-momentum",
])
  test(`完整合成帧：${kind} 经过相同内核成交，真实导入时间与虚拟时钟分离`, async () => {
    const s = source(
      kind === "fake-neg-limit-dip"
        ? { previousOpenCents: 1050, previousChange: 0 }
        : kind === "late-dip"
          ? { previousHeight: 1 }
          : {},
    );
    const frames = await framesFor(kind),
      result = await evaluateArchivedInterval(
        fakeStore(s, frames),
        dataset(),
        configuration,
        "test-run",
      );
    assert.equal(
      result.blocked,
      false,
      JSON.stringify(result.days.map((d) => d.gaps)),
    );
    assert.ok(
      result.ledger.some((r) => r.buyPoint === kind),
      JSON.stringify(result.ledger),
    );
    assert.equal(result.days[0].buyPoints[kind], "TRIGGERED");
    assert.ok(result.book.cashCents >= 0);
    assert.equal(s.createdAt, "2026-10-22T10:00:00.000Z");
    assert.equal(researchSnapshotView(s).createdAt, s.decisionAt);
    assert.equal(researchSnapshotView(s).importedAt, s.createdAt);
  });

test("数据完整无触发可验证为零交易；任一天缺证据阻断整段且不输出部分收益", async () => {
  const s = source(),
    frames = await framesFor(),
    store = fakeStore(s, frames);
  const complete = await evaluateArchivedInterval(
    store,
    dataset(),
    configuration,
    "zero",
  );
  assert.equal(complete.blocked, false);
  assert.equal(complete.ledger.length, 0);
  assert.equal(complete.equity.length, 1);
  assert.ok(
    Object.values(complete.days[0].buyPoints).every(
      (v) => v === "VERIFIED_NO_TRIGGER",
    ),
  );
  const ds = dataset();
  ds.coverage.executionDates.push("2026-03-04");
  ds.coverage.signalDates.push(date);
  ds.coverage.tradingDates.push("2026-03-04");
  const blocked = await evaluateArchivedInterval(
    {
      ...store,
      listArchivedFrames: async (_, d) => (d === date ? frames : []),
    },
    ds,
    configuration,
    "blocked",
  );
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.ledger.length, 0);
  assert.equal(blocked.equity.length, 0);
  assert.equal(blocked.book, null);
});

test("断流、缺盘口/竞价/市场输入、重复帧、分钟替代与摘要篡改均阻断", async () => {
  const s = source(),
    base = await framesFor();
  for (const mutate of [
    (f) => f.splice(200, 4),
    (f) => delete f[1].payload.quotes["600001"].ask1Cents,
    (f) => delete f[1].payload.entryInputs.auction["600001"],
    (f) => delete f[1].payload.entryInputs.market,
    (f) => f.splice(2, 0, structuredClone(f[1])),
    (f) => {
      f[1].payload.observationQuality = "minute";
      f[1].payload.pollIntervalSeconds = 300;
    },
    (f) => {
      f[1].payload.quotes["600001"].closeCents = 999;
    },
  ]) {
    const f = structuredClone(base);
    mutate(f);
    const report = await auditArchivedDay({
      date,
      snapshot: s,
      frames: f,
      plan: planFor(s),
    });
    assert.equal(report.status, "UNVERIFIABLE");
    assert.ok(report.gaps.length);
  }
});

test("同一帧重复与 JSON 重启不产生重复成交；T+1 和资金约束来自现有内核", async () => {
  const s = source(),
    plan = planFor(s),
    frames = await framesFor("auction-dip");
  let book = {
    ...newBook(10000),
    lastDate: signalDate,
    entryExecutionMode: "intraday-conditional",
  };
  const smallPlan = createPlan(
    researchSnapshotView(s),
    book,
    BASE_STRATEGY,
    "baseline-v1",
    plan.createdAt,
  );
  let session = openSession(book, smallPlan, date),
    fills = [];
  for (const f of frames.slice(0, 3)) {
    const r = advanceSession(book, session, f.payload);
    book = r.book;
    session = r.session;
    fills.push(...r.ledger);
  }
  const resumed = JSON.parse(JSON.stringify({ book, session }));
  const duplicate = advanceSession(
    resumed.book,
    resumed.session,
    frames[2].payload,
  );
  assert.equal(duplicate.ledger.length, 0);
  assert.ok(duplicate.book.cashCents >= 0);
  assert.equal(fills.filter((f) => f.side === "SELL").length, 0);
});

test("研究库隔离导入与阻断报告：原始帧不覆盖、manifest 检验、防篡改", async () => {
  const researchPath = `.sites-runtime/test-v5-${crypto.randomUUID()}.sqlite`,
    DB = localDatabase();
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const store = openHistoryStore(env);
  await new PaperRepository(env).initialize();
  const frozen = await freezeResearchConfiguration(env),
    s = source();
  const coverage = {
    ...dataset().coverage,
    reconstructionVersion: V5_RECONSTRUCTION_VERSION,
    configuration: frozen,
    executionModel: "V5_RECONSTRUCTION_V1",
  };
  try {
    await store.createDatasetVersion({
      id: "hds-test",
      provider: "local-fuyao-v5",
      kind: "V5_RECONSTRUCTION",
      executionModel: coverage.executionModel,
      requestedStart: date,
      requestedEnd: date,
      coverage,
    });
    await store.saveScore(
      "hds-test",
      signalDate,
      V5_SCORING_VERSION,
      "test",
      s,
    );
    await store.updateDatasetCoverage("hds-test", coverage);
    const before = await new PaperRepository(env).account();
    const job = await createHistoryImport(env, {
      kind: "OBSERVATIONS",
      start: date,
      end: date,
      datasetId: "hds-test",
    });
    const imported = await runHistoryImport(env, job.id);
    assert.equal(imported.stage, "BLOCKED");
    assert.notEqual(imported.datasetId, "hds-test");
    assert.equal((await store.datasetIntegrity("hds-test")).verified, true);
    const run = await runBacktest(env, {
      datasetId: imported.datasetId,
      executionModel: "ARCHIVED_OBSERVATIONS_V1",
    });
    assert.equal(run.stage, "BLOCKED");
    assert.equal(run.coverage.totalReturn, null);
    const detail = await backtestDetail(env, run.id);
    assert.equal(
      detail.verification.verified,
      true,
      JSON.stringify(detail.verification),
    );
    assert.equal(detail.ledger.length, 0);
    assert.equal(detail.equity.length, 0);
    assert.deepEqual(await new PaperRepository(env).account(), before);
    const completeFrames = await framesFor("auction-dip");
    for (const f of completeFrames)
      await store.saveArchivedFrame("hds-test", f);
    await store.updateDatasetCoverage("hds-test", coverage);
    const ready = await runBacktest(env, {
      datasetId: "hds-test",
      executionModel: "ARCHIVED_OBSERVATIONS_V1",
    });
    assert.equal(
      ready.stage,
      "READY",
      JSON.stringify(ready.coverage.days[0]?.gaps),
    );
    assert.ok(ready.coverage.fillCount > 0);
    const verified = await backtestDetail(env, ready.id);
    assert.equal(
      verified.verification.verified,
      true,
      JSON.stringify(verified.verification),
    );
    assert.deepEqual(await new PaperRepository(env).account(), before);
    await store.db
      .prepare("UPDATE backtest_equity SET payload = '{}' WHERE run_id = ?")
      .bind(ready.id)
      .run();
    assert.equal(
      (await backtestDetail(env, ready.id)).verification.verified,
      false,
    );
    const frame = (await framesFor())[0];
    await store.saveArchivedFrame("frame-test", frame);
    await assert.rejects(
      store.saveArchivedFrame("frame-test", { ...frame, origin: "changed" }),
      /冲突/,
    );
    await assert.rejects(
      runBacktest(env, {
        datasetId: imported.datasetId,
        executionModel: "ARCHIVED_OBSERVATIONS_V1",
        initialCapital: 50000,
      }),
      /100 万/,
    );
  } finally {
    store.db?.close();
    unlinkSync(researchPath);
  }
});

test("历史候选导入中断续传：BigInt 日历、预热、原始块、独立评分版本与发布后不覆盖", async () => {
  const researchPath = `.sites-runtime/test-v5-import-${crypto.randomUUID()}.sqlite`,
    env = {
      DB: localDatabase(),
      LOCAL_RESEARCH_DB_PATH: researchPath,
      QUAN_DATA_DIR: "synthetic-only",
    };
  await new PaperRepository(env).initialize();
  const frozen = await freezeResearchConfiguration(env),
    local = candidateDataset();
  const refs = [
    local.dates.concat(date).map((date) => ({ date, is_open: 1n })),
    [...local.codes.keys()].map((code) => ({
      code,
      name: `合成${code}`,
      list_date: "2000-01-01",
      pointInTimeVerified: true,
    })),
    [...local.codes.keys()].map((code) => ({
      code,
      sw_l1: "测试行业",
      snapshot_date: "2020-01-01",
    })),
  ];
  const calls = [];
  const poolProviders = Object.fromEntries(
    ["main", "broken"].map((kind) => [
      kind,
      async (d, o) => {
        calls.push(`${kind}:${d}:${o.page}`);
        return {
          pagination: { total: 1, pages: 1, page: 1 },
          item: [
            {
              ticker: kind === "main" ? "600001" : "600002",
              name: kind === "main" ? "合成600001" : "合成600002",
              last_price: d === signalDate ? (kind === "main" ? 11 : 10.4) : 10,
              continue_day_cnt: 3,
              open_times: 1,
              turnover: 500000000,
            },
          ],
        };
      },
    ]),
  );
  const options = {
    localDataset: local,
    referenceRows: refs,
    sourceFiles: { synthetic: "stable" },
    configuration: frozen,
    poolProviders,
    onProgress: () => {
      throw new Error("synthetic restart");
    },
  };
  try {
    const job = await createHistoryImport(env, {
      kind: "V5_RECONSTRUCTION",
      start: date,
      end: date,
    });
    const failed = await runHistoryImport(env, job.id, options);
    assert.equal(failed.stage, "FAILED");
    assert.equal(calls.length, 2);
    const resumed = await runHistoryImport(env, job.id, {
      ...options,
      onProgress: undefined,
    });
    assert.equal(resumed.stage, "PARTIAL", JSON.stringify(resumed));
    assert.equal(calls.length, 4);
    const store = openHistoryStore(env),
      ds = await store.getDataset(resumed.datasetId);
    assert.ok(ds.coverage.warmupDates.length >= 21);
    assert.deepEqual(ds.coverage.signalDates, [signalDate]);
    assert.equal((await store.datasetIntegrity(ds.id)).verified, true);
    const scores = await store.listScores(ds.id);
    assert.equal(scores[0].scoringVersion, V5_SCORING_VERSION);
    assert.equal(scores[0].payload.createdAt, job.createdAt);
    assert.notEqual(scores[0].payload.createdAt, scores[0].payload.decisionAt);
    const published = ds.manifestDigest;
    await runHistoryImport(env, job.id, options);
    assert.equal((await store.getDataset(ds.id)).manifestDigest, published);
    assert.equal(calls.length, 4);
    store.db.close();
  } finally {
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});

test("历史日线回补固定区间与成对复权，拒绝未来数据及同日价格冲突", async () => {
  const dates = candidateDataset().dates.slice(-22),
    calls = [];
  const provider = async (code, o) => {
    calls.push({ code, ...o });
    return {
      thscode: code,
      interval: "1d",
      adjust: o.adjust,
      item: dates.map((date, i) => ({
        date_ms: Date.parse(`${date}T00:00:00+08:00`),
        open_price: 10,
        high_price: 11,
        low_price: 9,
        close_price: 10,
        volume: 10000000,
        turnover: 100000000,
      })),
    };
  };
  const result = await fetchResearchDailyRecord(
    "600001",
    dates[0],
    signalDate,
    provider,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.adjust),
    ["none", "forward"],
  );
  assert.equal(result.record.raw.at(-1).date, signalDate);
  assert.throws(
    () => withResearchDailyRecords(candidateDataset(), [result.record]),
    /不一致/,
  );
  const empty = {
    dates,
    dateIdx: new Map(dates.map((d, i) => [d, i])),
    codes: new Map(),
  };
  const merged = withResearchDailyRecords(empty, [result.record]);
  assert.equal(merged.codes.size, 1);
  await assert.rejects(
    fetchResearchDailyRecord("600001", dates[0], "2026-02-27", provider),
    /日期/,
  );
});
