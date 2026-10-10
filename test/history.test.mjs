import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { localDatabase } from "../scripts/local-db.mjs";
import {
  createHistoryImport,
  historyImportDetail,
  runHistoryImport,
} from "../backend/services/history.js";
import {
  HistoryDatasetStore,
  HistoryJobRepository,
  openHistoryStore,
} from "../backend/storage/history.js";
import {
  assessFieldCoverage,
  classifyExecutionModel,
  normalizeDailyBarRow,
  normalizeLimitFeatureRow,
  sanitizeMinuteSeries,
} from "../backend/domain/historical-input.js";
import { runBacktest } from "../backend/services/backtest.js";
import { PaperRepository } from "../backend/storage/paper.js";

function weekdays(start, end) {
  const result = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}
function emPoolRow(code, overrides = {}) {
  return {
    c: code,
    n: `样本${code.slice(-2)}`,
    hybk: "测试行业",
    p: 10500,
    zdp: 10.02,
    amount: 5.2e8,
    ltsz: 4.2e9,
    fund: 1.8e8,
    hs: 8.5,
    fbt: 93500,
    lbt: 93500,
    zbc: 0,
    lbc: 1,
    ...overrides,
  };
}
function installFetchStub({
  tradingDays,
  poolDates,
  poolFailureDates = [],
  poolOverrides = {},
  dailyCloseYuan = "10.50",
}) {
  const calls = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input instanceof URL ? input : (input?.url ?? input));
    calls.push(url);
    if (url.includes("push2ex.eastmoney.com")) {
      const date = new URL(url).searchParams.get("date");
      const formatted = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      if (poolFailureDates.includes(formatted))
        return Response.json({ rc: 1, data: null });
      if (!poolDates.includes(formatted))
        return Response.json({
          rc: 0,
          data: { pool: [emPoolRow("600099")], qdate: "20260101", tc: 1 },
        });
      const codes = ["600001", "600002", "600003"];
      return Response.json({
        rc: 0,
        data: {
          pool: codes.map((code, index) =>
            emPoolRow(code, {
              p: 10000 + index * 500,
              lbc: index === 0 ? 2 : 1,
              zbc: index === 2 ? 1 : 0,
              ...poolOverrides,
            }),
          ),
          qdate: date,
          tc: codes.length,
        },
      });
    }
    if (url.includes("fqkline/get")) {
      const param = new URL(url).searchParams.get("param");
      const [symbolCode, , windowStart, windowEnd, countParam] =
        param.split(",");
      const maxRows = Number(countParam) || 80;
      const rows = tradingDays
        .filter((date) => date >= windowStart && date <= windowEnd)
        .slice(-maxRows)
        .map((date) => [
          date,
          "10.00",
          dailyCloseYuan,
          "10.80",
          "9.90",
          "120000",
        ]);
      return Response.json({
        data: { [symbolCode]: { day: rows } },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    calls: () => calls.length,
    restore: () => {
      globalThis.fetch = fetchBefore;
    },
  };
}
test("历史输入规范化：缺失与零区分、单位转换与异常隔离", () => {
  const normalized = normalizeLimitFeatureRow({
    code: "600001",
    name: "样本一",
    sector: "测试行业",
    price: 10.5,
    change: 10.02,
    amount: 5.2e8,
    floatCap: 4.2e9,
    seal: 1.8e8,
    turnover: 8.5,
    first: 93500,
    last: 93500,
    breaks: 0,
    height: 1,
  });
  assert.equal(normalized.row.price, 10.5);
  assert.equal(normalized.row.breaks, 0);
  assert.equal(normalized.provenance.fieldCoverage.complete, true);
  assert.throws(
    () => normalizeLimitFeatureRow({ code: "600001", breaks: -1 }),
    /不能为负数/,
  );
  assert.throws(
    () => normalizeLimitFeatureRow({ code: "ABC", price: 10 }),
    /合法证券代码/,
  );
  const coverage = assessFieldCoverage([
    {
      code: "600001",
      name: "x",
      sector: "s",
      price: 10,
      amount: null,
      seal: null,
      turnover: 8,
      first: 93500,
      last: 93500,
      breaks: 0,
      height: 1,
    },
  ]);
  assert.equal(coverage.complete, false);
  assert.ok(coverage.missing.some((field) => field.startsWith("amount")));
  assert.equal(classifyExecutionModel(100, true), "SIX_FACTOR_V1");
  assert.equal(classifyExecutionModel(40, false), "DAILY_OBSERVATION_V1");
  const bar = normalizeDailyBarRow({
    code: "600001",
    tradeDate: "2026-03-03",
    openYuan: 10.0,
    closeYuan: 10.5,
    highYuan: 10.8,
    lowYuan: 9.9,
    volumeShares: 120000,
  });
  assert.equal(bar.closeCents, 1050);
  assert.throws(
    () =>
      normalizeDailyBarRow({
        code: "600001",
        tradeDate: "2026-03-03",
        openYuan: 10,
        closeYuan: 10.5,
        highYuan: 9,
        lowYuan: 9.9,
      }),
    /最高价低于最低价/,
  );
  const sanitized = sanitizeMinuteSeries([
    { time: "09:30", priceCents: 1000, volumeShares: 100 },
    { time: "15:06", priceCents: 1000, volumeShares: 100 },
    { time: "09:25", priceCents: 1000, volumeShares: 100 },
    { time: "12:00", priceCents: 1000, volumeShares: 100 },
    { time: "10:00", priceCents: 1000, volumeShares: 50 },
  ]);
  assert.equal(sanitized.inSession.length, 1);
  assert.ok(sanitized.anomalies.some((row) => row.reason.includes("时段外")));
  assert.ok(sanitized.anomalies.some((row) => row.reason.includes("午休")));
  assert.ok(sanitized.anomalies.some((row) => row.reason.includes("回落")));
});
test("能力探测：区分涨停池不可用日期与日线分段覆盖", async () => {
  const { createTencentHistoricalProvider } = await import(
    "../backend/services/historical-providers.js"
  );
  const tradingDays = weekdays("2025-11-01", "2026-03-31");
  const stub = installFetchStub({
    tradingDays,
    poolDates: tradingDays.filter((date) => date >= "2026-03-01"),
  });
  try {
    const provider = createTencentHistoricalProvider();
    const capabilities = await provider.capabilities({
      start: "2025-11-01",
      end: "2026-03-31",
    });
    assert.equal(capabilities.limitFeatures.available, true);
    assert.equal(capabilities.limitFeatures.availableFrom, "2026-03-31");
    assert.ok(
      capabilities.limitFeatures.rejections.some((row) =>
        row.reason.includes("不一致"),
      ),
    );
    assert.equal(capabilities.dailyPrices.available, true);
    assert.equal(capabilities.dailyPrices.observedFrom, "2025-11-03");
    assert.equal(capabilities.dailyPrices.observedTo, "2026-03-31");
    assert.ok(capabilities.dailyPrices.segmentCount >= 2);
    const calendar = await provider.tradingCalendar({
      start: "2025-11-01",
      end: "2026-03-31",
    });
    assert.equal(calendar.dates.length, tradingDays.length);
    assert.equal(new Set(calendar.dates).size, calendar.dates.length);
    assert.ok(calendar.segments.length >= 2);
    assert.ok(calendar.segments.every((segment) => segment.rows > 0));
  } finally {
    stub.restore();
  }
});
test("历史导入生命周期：READY、断点幂等、评分与观察反馈、主库隔离", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-history-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const tradingDays = weekdays("2026-01-01", "2026-03-31");
  const stub = installFetchStub({
    tradingDays,
    poolDates: tradingDays,
  });
  try {
    const job = await createHistoryImport(env, {
      kind: "LIMIT_FEATURES",
      start: "2026-03-02",
      end: "2026-03-06",
      name: "生命周期测试",
    });
    const done = await runHistoryImport(env, job.id, {
      withObservationReturns: true,
    });
    assert.equal(done.stage, "READY");
    const info = await historyImportDetail(env, job.id);
    assert.equal(info.dates.length, 5);
    assert.equal(info.scoreCount, 5);
    assert.equal(info.reviewCount, 4);
    const review = info.reviews.at(0).payload;
    assert.ok(review.continuationRate !== null);
    assert.ok(review.observationCoverage > 0);
    assert.ok(review.note.includes("不含可成交性保证"));
    assert.equal(info.dataset.executionModel, "SIX_FACTOR_V1");
    const fetchCallsAfterFirstRun = stub.calls().length;
    const rerun = await runHistoryImport(env, job.id);
    assert.equal(rerun.stage, "READY");
    assert.equal(stub.calls().length, fetchCallsAfterFirstRun);
    const mainDbChecks = {
      snapshots: await DB.prepare(
        "SELECT COUNT(*) AS n FROM snapshots",
      ).first(),
      reviews: await DB.prepare("SELECT COUNT(*) AS n FROM reviews").first(),
      paperMarketDays: await DB.prepare(
        "SELECT COUNT(*) AS n FROM paper_market_days",
      ).first(),
      paperLedger: await DB.prepare(
        "SELECT COUNT(*) AS n FROM paper_ledger",
      ).first(),
    };
    for (const table of Object.values(mainDbChecks)) assert.equal(table.n, 0);
    const jobRow = await new HistoryJobRepository(env).getJob(job.id);
    assert.equal(jobRow.datasetId, info.dataset.id);
  } finally {
    stub.restore();
    DB.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("部分日期失败标记 PARTIAL 并保留成功日期；DAILY 无股票池阻塞", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-history-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const tradingDays = weekdays("2026-01-01", "2026-03-31");
  const stub = installFetchStub({
    tradingDays,
    poolDates: tradingDays,
    poolFailureDates: ["2026-03-03"],
  });
  try {
    const job = await createHistoryImport(env, {
      kind: "LIMIT_FEATURES",
      start: "2026-03-02",
      end: "2026-03-04",
    });
    const done = await runHistoryImport(env, job.id, {
      withObservationReturns: false,
    });
    assert.equal(done.stage, "PARTIAL");
    assert.ok(
      done.statusPayload.coverage.failedDates.some(
        (row) => row.date === "2026-03-03",
      ),
    );
    const info = await historyImportDetail(env, job.id);
    assert.equal(info.dates.length, 2);
    assert.equal(info.scoreCount, 2);
    await assert.rejects(
      () =>
        createHistoryImport(env, {
          kind: "DAILY",
          start: "2026-03-02",
          end: "2026-03-04",
        }),
      /股票池/,
    );
    const codes = ["600001"];
    const dailyJob = await createHistoryImport(env, {
      kind: "DAILY",
      start: "2026-03-02",
      end: "2026-03-04",
      codes,
    });
    const dailyDone = await runHistoryImport(env, dailyJob.id);
    assert.equal(dailyDone.stage, "READY");
    assert.equal(
      dailyDone.statusPayload.executionModel,
      "DAILY_OBSERVATION_V1",
    );
    const dailyInfo = await historyImportDetail(env, dailyJob.id);
    assert.equal(dailyInfo.scoreCount, 0);
  } finally {
    stub.restore();
    DB.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("缺失交易日不生成跨越反馈；PARTIAL 重跑补抓失败日期", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-history-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const tradingDays = weekdays("2026-01-01", "2026-03-31");
  let stub = installFetchStub({
    tradingDays,
    poolDates: tradingDays,
    poolFailureDates: ["2026-03-03"],
  });
  try {
    const job = await createHistoryImport(env, {
      kind: "LIMIT_FEATURES",
      start: "2026-03-02",
      end: "2026-03-04",
    });
    const first = await runHistoryImport(env, job.id, {
      withObservationReturns: true,
    });
    assert.equal(first.stage, "PARTIAL");
    assert.ok(
      first.statusPayload.coverage.notes.some((note) =>
        note.includes("不跨越缺失日"),
      ),
    );
    const partialInfo = await historyImportDetail(env, job.id);
    assert.equal(partialInfo.reviewCount, 0);
    stub.restore();
    stub = installFetchStub({ tradingDays, poolDates: tradingDays });
    const second = await runHistoryImport(env, job.id);
    assert.equal(second.stage, "READY");
    const info = await historyImportDetail(env, job.id);
    assert.equal(info.dates.length, 3);
    assert.equal(info.scoreCount, 3);
    assert.equal(info.reviewCount, 2);
    const review0203 = info.reviews.find(
      (row) => row.signalDate === "2026-03-02",
    );
    assert.equal(review0203.labelEndDate, "2026-03-03");
  } finally {
    stub.restore();
    DB.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("涨停特征缺失保持 null 不填零；空日线数据发布 FAILED", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-history-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const tradingDays = weekdays("2026-01-01", "2026-03-31");
  const stub = installFetchStub({
    tradingDays,
    poolDates: tradingDays,
    poolOverrides: { fund: null, zbc: "" },
  });
  try {
    const job = await createHistoryImport(env, {
      kind: "LIMIT_FEATURES",
      start: "2026-03-02",
      end: "2026-03-03",
    });
    const done = await runHistoryImport(env, job.id, {
      withObservationReturns: false,
    });
    assert.equal(done.stage, "READY");
    const coverage = done.statusPayload.coverage;
    assert.ok(coverage.coverage.ratio < 100);
    assert.ok(
      coverage.coverage.missing.some((field) => field.startsWith("seal")),
    );
    assert.ok(
      coverage.coverage.missing.some((field) => field.startsWith("breaks")),
    );
    const stored = await openHistoryStore(env).getDailyInput(
      done.statusPayload.datasetId,
      "2026-03-02",
    );
    const missingRow = stored.normalized.find((row) => row.code === "600001");
    assert.equal(missingRow.seal, null);
    assert.equal(missingRow.breaks, null);
    const emptyDaily = await createHistoryImport(env, {
      kind: "DAILY",
      start: "2026-05-01",
      end: "2026-05-03",
      codes: ["600001"],
    });
    const emptyResult = await runHistoryImport(env, emptyDaily.id);
    assert.equal(emptyResult.stage, "FAILED");
    assert.ok(emptyResult.statusPayload.error.includes("没有任何成功日期"));
  } finally {
    stub.restore();
    DB.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("数据集摘要绑定真实输入与原始下载块引用", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-history-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const tradingDays = weekdays("2026-01-01", "2026-03-31");
  let stub = installFetchStub({ tradingDays, poolDates: tradingDays });
  try {
    const jobA = await createHistoryImport(env, {
      kind: "LIMIT_FEATURES",
      start: "2026-03-02",
      end: "2026-03-03",
    });
    const doneA = await runHistoryImport(env, jobA.id, {
      withObservationReturns: false,
    });
    const digestA = doneA.statusPayload.manifestDigest;
    stub.restore();
    stub = installFetchStub({
      tradingDays,
      poolDates: tradingDays,
      dailyCloseYuan: "11.20",
      poolOverrides: { p: 12000 },
    });
    const jobB = await createHistoryImport(env, {
      kind: "LIMIT_FEATURES",
      start: "2026-03-02",
      end: "2026-03-03",
    });
    const doneB = await runHistoryImport(env, jobB.id, {
      withObservationReturns: false,
    });
    const digestB = doneB.statusPayload.manifestDigest;
    assert.notEqual(digestA, digestB);
    const store = openHistoryStore(env);
    const probeId = `hds-probe-${crypto.randomUUID()}`;
    await store.createDatasetVersion({
      id: probeId,
      provider: "tencent-free",
      kind: "LIMIT_FEATURES",
      executionModel: "SIX_FACTOR_V1",
      requestedStart: "2026-03-02",
      requestedEnd: "2026-03-02",
      coverage: {},
    });
    await store.saveDailyInputs(probeId, "2026-03-02", {
      normalized: [],
      provenance: {},
    });
    const withChunks = await store.updateDatasetCoverage(probeId, {}, [
      { jobId: "j1", chunkKey: "limit:2026-03-02" },
    ]);
    assert.equal(withChunks.manifest.inputs.length, 1);
    assert.equal(withChunks.manifest.chunkRefs.length, 1);
    const withoutChunks = await store.updateDatasetCoverage(probeId, {}, []);
    assert.notEqual(withChunks.manifestDigest, withoutChunks.manifestDigest);
  } finally {
    stub.restore();
    DB.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("并发认领数据集：只有第一次声明生效", async () => {
  const DB = localDatabase();
  const env = { DB };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const jobs = new HistoryJobRepository(env);
  try {
    const job = await jobs.createJob({
      id: "hjob-claim-test",
      provider: "tencent-free",
      kind: "DAILY",
      start: "2026-03-02",
      end: "2026-03-04",
      name: null,
    });
    assert.equal(await jobs.claimDataset(job.id, "hds-a"), true);
    assert.equal(await jobs.claimDataset(job.id, "hds-b"), false);
    assert.equal((await jobs.getJob(job.id)).datasetId, "hds-a");
  } finally {
    DB.close();
  }
});
test("未配置本机研究存储时云端入口明确降级", async () => {
  const DB = localDatabase();
  const env = { DB };
  const repository = new PaperRepository(env);
  await repository.initialize();
  try {
    assert.equal(openHistoryStore(env), null);
    const job = await createHistoryImport(env, {
      kind: "LIMIT_FEATURES",
      start: "2026-03-02",
      end: "2026-03-04",
    });
    const result = await runHistoryImport(env, job.id);
    assert.equal(result.stage, "BLOCKED");
    assert.ok(result.statusPayload.reason.includes("仅本机可用"));
    await assert.rejects(
      () => runBacktest(env, { datasetId: "hds-none" }),
      /仅本机可用/,
    );
  } finally {
    DB.close();
  }
});
test("从 main 已发布迁移升级：不重命名已应用迁移", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, readdirSync } = await import("node:fs");
  const researchPath = `.sites-runtime/test-migration-${crypto.randomUUID()}.sqlite`;
  {
    const sqlite = new DatabaseSync(researchPath);
    sqlite.exec("CREATE TABLE local_migrations (name TEXT PRIMARY KEY)");
    const files = readdirSync("drizzle")
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of files) {
      if (name > "0005_research_upgrade.sql") break;
      sqlite.exec(readFileSync(`drizzle/${name}`, "utf8"));
      sqlite
        .prepare("INSERT INTO local_migrations (name) VALUES (?)")
        .run(name);
    }
    sqlite.close();
  }
  const DB = localDatabase(researchPath);
  try {
    const registry = await DB.prepare(
      "SELECT bootstrap_done FROM research_registry WHERE namespace = 'main'",
    ).first();
    assert.equal(registry.bootstrap_done, 0);
    const jobs = await DB.prepare(
      "SELECT COUNT(*) AS n FROM history_import_jobs",
    ).first();
    assert.ok(jobs.n >= 0);
  } finally {
    DB.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
