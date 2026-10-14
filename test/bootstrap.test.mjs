import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { ResearchRepository } from "../backend/storage/research.js";
import { adoptSingleExperiment } from "../backend/storage/walk-forward.js";
import {
  openHistoryStore,
  HistoryDatasetStore,
} from "../backend/storage/history.js";
import {
  proposeBootstrapImprovement,
  researchStatus,
} from "../backend/services/research.js";
import { FACTORS, PRESETS } from "../shared/scoring.js";
import { trainingSourceEvidence } from "../backend/storage/training-sources.js";
import { historicalTrainingSource } from "../backend/domain/research-samples.js";
import { digestOf } from "../backend/domain/research-lineage.js";

function stubProposal(patch = { minScore: 82 }) {
  let calls = 0;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls++;
    JSON.parse(options.body);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              rationale: "冷启动候选：基于历史训练窗口微调",
              patch,
            }),
          },
        },
      ],
    });
  };
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = fetchBefore;
    },
  };
}
const CODES = ["600001", "600002"];
function snapshotPayload(date, dayIndex = 0) {
  return {
    date,
    createdAt: `${date}T07:05:00.000Z`,
    emotion: 70,
    stocks: CODES.map((code, index) => ({
      code,
      name: `样本${index + 1}`,
      sector: "测试行业",
      price: 10.5 + index * 0.5 + dayIndex * 0.1,
      deduction: 0,
      factors: FACTORS.map((factor, i) => ({
        key: factor.key,
        name: factor.name,
        value: 90,
        weight: PRESETS.balanced[i],
      })),
      risks: [],
    })),
    sectors: [{ name: "测试行业", score: 82, count: CODES.length }],
  };
}
function dailyInput(date, closeShift = 0) {
  const normalized = {};
  for (const [index, code] of CODES.entries()) {
    const closeCents = 1050 + index * 50 + closeShift * 10;
    normalized[code] = {
      openCents: closeCents - 10,
      closeCents,
      highCents: closeCents + 5,
      lowCents: closeCents - 15,
      volumeShares: 2000000,
    };
  }
  return { normalized, provenance: { origin: "HISTORICAL_RECONSTRUCTED" } };
}
function tradeDays(count) {
  const result = [];
  const cursor = new Date("2026-01-05T00:00:00Z");
  while (result.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}
async function seedDataset(env, store, dayCount) {
  const dates = tradeDays(dayCount);
  const datasetId = `hds-${crypto.randomUUID()}`;
  await store.createDatasetVersion({
    id: datasetId,
    provider: "tencent-free",
    kind: "LIMIT_FEATURES",
    executionModel: "SIX_FACTOR_V1",
    requestedStart: dates[0],
    requestedEnd: dates.at(-1),
    coverage: { succeededDates: dates, coverage: { ratio: 100 } },
  });
  for (const [index, date] of dates.entries()) {
    await store.saveScore(
      datasetId,
      date,
      "rules-v1-historical",
      "test-params",
      snapshotPayload(date, index),
    );
    await store.saveDailyInputs(datasetId, date, dailyInput(date, index));
    await store.saveObservationDaily(
      datasetId,
      date,
      dailyInput(date, index).normalized,
    );
  }
  await store.updateDatasetCoverage(datasetId, {
    observedStart: dates[0],
    observedEnd: dates.at(-1),
    succeededDates: dates,
    failedDates: [],
    executionModel: "SIX_FACTOR_V1",
  });
  return datasetId;
}
test("冷启动所有退出路径释放服务自开的历史连接，异常不会阻止文件清理", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-connection-"));
  const DB = localDatabase();
  const env = {
    DB,
    LOCAL_RESEARCH_DB_PATH: join(dir, "history.sqlite"),
    AI_API_KEY: "test-only",
    AI_BASE_URL: "https://api.deepseek.com/v1",
  };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const store = openHistoryStore(env);
  const live = new Set();
  const { ensure, close, listScores } = HistoryDatasetStore.prototype;
  HistoryDatasetStore.prototype.ensure = async function () {
    await ensure.call(this);
    live.add(this);
  };
  HistoryDatasetStore.prototype.close = function () {
    close.call(this);
    live.delete(this);
  };
  try {
    const short = await seedDataset(env, store, 10);
    assert.equal(
      (await proposeBootstrapImprovement(repository, env, { datasetId: short }))
        .status,
      "NEED_DATA",
    );
    assert.deepEqual([...live], [store]);
    const full = await seedDataset(env, store, 25);
    HistoryDatasetStore.prototype.listScores = async function () {
      throw new Error("TEST_SOURCE_READ_FAILED");
    };
    await assert.rejects(
      () => proposeBootstrapImprovement(repository, env, { datasetId: full }),
      /TEST_SOURCE_READ_FAILED/,
    );
    assert.deepEqual([...live], [store]);
    HistoryDatasetStore.prototype.listScores = listScores;
    const failed = await proposeBootstrapImprovement(
      repository,
      env,
      { datasetId: full },
      async () => {
        throw new Error("TEST_PROPOSAL_FAILED");
      },
    );
    assert.equal(failed.status, "ERROR");
    assert.deepEqual([...live], [store]);
    store.close();
    assert.equal(live.size, 0, "清理文件前，服务与测试各自的连接都已关闭");
    rmSync(dir, { recursive: true });
  } finally {
    HistoryDatasetStore.prototype.ensure = ensure;
    HistoryDatasetStore.prototype.close = close;
    HistoryDatasetStore.prototype.listScores = listScores;
    for (const open of live) open.close();
    DB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("旧冷启动从真实数据集补存精确 manifest，重复导出与文件删除后幂等", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-legacy-source-"));
  const DB = localDatabase();
  const env = { DB, LOCAL_RESEARCH_DB_PATH: join(dir, "history.sqlite") };
  const store = openHistoryStore(env);
  try {
    const id = await seedDataset(env, store, 25);
    const integrity = await store.datasetIntegrity(id);
    const experiment = {
      id: "exp-legacy-source",
      kind: "BOOTSTRAP",
      reservationPayload: {
        datasetId: id,
        datasetManifestDigest: integrity.manifestDigest,
      },
    };
    const expected = await historicalTrainingSource(id, integrity.manifest);
    assert.deepEqual(await trainingSourceEvidence(env, experiment), expected);
    assert.deepEqual(await trainingSourceEvidence(env, experiment), expected);
    const mismatched = {
      ...experiment,
      id: "exp-mismatched-source",
      reservationPayload: {
        ...experiment.reservationPayload,
        datasetManifestDigest: "f".repeat(64),
      },
    };
    await assert.rejects(
      () => trainingSourceEvidence(env, mismatched),
      /冻结 manifest/,
    );
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM research_training_sources",
        ).first()
      ).n,
      1,
    );
    const bad = structuredClone(expected);
    bad.payload.manifest.scoreRefs[0].tradeDate = "1900-01-01";
    bad.digest = await digestOf(bad.payload);
    await DB.prepare("INSERT INTO research_training_sources VALUES(?,?,?,?)")
      .bind(
        "exp-corrupted-source",
        JSON.stringify(bad.payload),
        bad.digest,
        "2026-01-01",
      )
      .run();
    await assert.rejects(
      () =>
        trainingSourceEvidence(env, {
          ...experiment,
          id: "exp-corrupted-source",
        }),
      /冻结 manifest/,
    );
  } finally {
    store.close();
    // 不忽略 EBUSY：服务补存成功/失败路径上的连接都必须已关闭。
    rmSync(dir, { recursive: true });
  }
  try {
    delete env.LOCAL_RESEARCH_DB_PATH;
    const row = await DB.prepare(
      "SELECT payload,digest FROM research_training_sources WHERE experiment_id='exp-legacy-source'",
    ).first();
    const expected = { payload: JSON.parse(row.payload), digest: row.digest };
    const experiment = {
      id: "exp-legacy-source",
      kind: "BOOTSTRAP",
      reservationPayload: {
        datasetId: expected.payload.datasetId,
        datasetManifestDigest: await digestOf(expected.payload.manifest),
      },
    };
    assert.deepEqual(await trainingSourceEvidence(env, experiment), expected);
    await assert.rejects(
      () =>
        trainingSourceEvidence(env, {
          ...experiment,
          id: "exp-source-unavailable",
        }),
      /LOCAL_RESEARCH_DB_PATH/,
    );
  } finally {
    DB.close();
  }
});

test("训练来源与冷启动预留一起提交，来源保存失败不消耗预算或资格", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-source-atomic-"));
  const DB = localDatabase();
  const env = {
    DB,
    LOCAL_RESEARCH_DB_PATH: join(dir, "history.sqlite"),
    AI_API_KEY: "test-only",
    AI_BASE_URL: "https://api.deepseek.com/v1",
  };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const store = openHistoryStore(env);
  try {
    const datasetId = await seedDataset(env, store, 25);
    let calls = 0;
    const proposal = async () => {
      calls++;
      return { patch: { minScore: 82 }, rationale: "原子来源回归" };
    };
    DB.exec(
      "CREATE TRIGGER fail_training_source BEFORE INSERT ON research_training_sources BEGIN SELECT RAISE(ABORT,'TEST_SOURCE_SAVE_FAILED'); END",
    );
    assert.equal(
      (
        await proposeBootstrapImprovement(
          repository,
          env,
          { datasetId },
          proposal,
        )
      ).status,
      "BUSY",
    );
    assert.equal(calls, 0);
    const research = new ResearchRepository(env);
    assert.equal((await research.ensureRegistry()).bootstrapDone, false);
    for (const table of [
      "research_generation_slots",
      "research_experiments",
      "research_sample_uses",
      "research_training_sources",
    ])
      assert.equal(
        (await DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,
        0,
      );
    DB.exec("DROP TRIGGER fail_training_source");
    assert.equal(
      (
        await proposeBootstrapImprovement(
          repository,
          env,
          { datasetId },
          proposal,
        )
      ).status,
      "AWAITING_SHADOW",
    );
    assert.equal(calls, 1);
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM research_training_sources",
        ).first()
      ).n,
      1,
    );
  } finally {
    store.close();
    DB.close();
    rmSync(dir, { recursive: true });
  }
});

test("AI 冷启动：一次性初始化进入影子队列并消耗资格", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-boot-${crypto.randomUUID()}.sqlite`;
  const env = {
    DB,
    LOCAL_RESEARCH_DB_PATH: researchPath,
    AI_API_KEY: "test-only-secret",
    AI_BASE_URL: "https://api.deepseek.com/v1",
    AI_MODEL: "test-model",
  };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const store = openHistoryStore(env);
  const datasetId = await seedDataset(env, store, 25);
  const stub = stubProposal();
  try {
    const first = await proposeBootstrapImprovement(repository, env, {
      datasetId,
    });
    assert.equal(first.status, "AWAITING_SHADOW");
    const research = new ResearchRepository(env);
    const registry = await research.ensureRegistry();
    assert.equal(registry.bootstrapDone, true);
    const experiment = await research.getExperiment(first.experimentId);
    assert.equal(experiment.stage, "AWAITING_SHADOW");
    assert.equal(experiment.kind, "BOOTSTRAP");
    const events = await research.experimentEvents(first.experimentId);
    assert.ok(events.some((event) => event.eventType === "BOOTSTRAP_RESERVED"));
    const reports = await research.experimentReports(first.experimentId);
    assert.ok(reports.some((report) => report.stage === "dev_screen"));
    const second = await proposeBootstrapImprovement(repository, env, {
      datasetId,
    });
    assert.equal(second.status, "BOOTSTRAP_DONE");
    const status = await researchStatus(env);
    assert.equal(status.bootstrapDone, true);
    assert.equal(status.activeExperiment.experimentId, first.experimentId);
    const adopted = await adoptSingleExperiment(env, first.experimentId);
    assert.ok(adopted.cohortId.startsWith("single-"));
    assert.equal(
      (await research.getExperiment(first.experimentId)).stage,
      "SCHEDULED",
    );
    assert.equal((await research.activeExperiment()).ownerType, "COHORT");
    assert.equal(
      (await research.ensureRegistry()).attemptSequence,
      registry.attemptSequence,
    );
  } finally {
    stub.restore();
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("训练对不足返回 NEED_DATA 且不消耗一次性资格", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-boot-${crypto.randomUUID()}.sqlite`;
  const env = {
    DB,
    LOCAL_RESEARCH_DB_PATH: researchPath,
    AI_API_KEY: "test-only-secret",
    AI_BASE_URL: "https://api.deepseek.com/v1",
    AI_MODEL: "test-model",
  };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const store = openHistoryStore(env);
  const stub = stubProposal();
  try {
    const datasetId = await seedDataset(env, store, 10);
    const result = await proposeBootstrapImprovement(repository, env, {
      datasetId,
    });
    assert.equal(result.status, "NEED_DATA");
    assert.equal(stub.calls(), 0);
    const research = new ResearchRepository(env);
    const registry = await research.ensureRegistry();
    assert.equal(registry.bootstrapDone, false);
  } finally {
    stub.restore();
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("训练窗口无法重放（0 天）时返回 NEED_DATA 且不消耗资格", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-boot-${crypto.randomUUID()}.sqlite`;
  const env = {
    DB,
    LOCAL_RESEARCH_DB_PATH: researchPath,
    AI_API_KEY: "test-only-secret",
    AI_BASE_URL: "https://api.deepseek.com/v1",
    AI_MODEL: "test-model",
  };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const store = openHistoryStore(env);
  const stub = stubProposal();
  try {
    const datasetId = await seedDataset(env, store, 25);
    await store.updateDatasetCoverage(datasetId, {
      executionModel: "SIX_FACTOR_V1",
      succeededDates: ["2026-01-05", "2026-01-08", "2026-01-12"],
    });
    const result = await proposeBootstrapImprovement(repository, env, {
      datasetId,
    });
    assert.equal(result.status, "NEED_DATA");
    assert.equal(stub.calls(), 0);
    const research = new ResearchRepository(env);
    const registry = await research.ensureRegistry();
    assert.equal(registry.bootstrapDone, false);
    const status = await researchStatus(env);
    assert.equal(status.bootstrapDone, false);
  } finally {
    stub.restore();
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("缺失交易日不跨日配对：严格交易日历下训练对不足返回 NEED_DATA 且不消耗资格", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-boot-${crypto.randomUUID()}.sqlite`;
  const env = {
    DB,
    LOCAL_RESEARCH_DB_PATH: researchPath,
    AI_API_KEY: "test-only-secret",
    AI_BASE_URL: "https://api.deepseek.com/v1",
    AI_MODEL: "test-model",
  };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const store = openHistoryStore(env);
  const stub = stubProposal();
  try {
    const dates = tradeDays(22);
    const datasetId = await seedDataset(env, store, 22);
    const missingDate = dates[11];
    await store.db
      .prepare(
        "DELETE FROM history_scores WHERE dataset_id = ? AND trade_date = ?",
      )
      .bind(datasetId, missingDate)
      .run();
    await store.updateDatasetCoverage(datasetId, {
      observedStart: dates[0],
      observedEnd: dates.at(-1),
      executionModel: "SIX_FACTOR_V1",
      succeededDates: dates.filter((date) => date !== missingDate),
      tradingDates: dates,
      failedDates: [{ date: missingDate, reason: "缺失交易日" }],
    });
    const integrity = await store.datasetIntegrity(datasetId);
    assert.equal(integrity.verified, true);
    const result = await proposeBootstrapImprovement(repository, env, {
      datasetId,
    });
    assert.equal(result.status, "NEED_DATA");
    assert.equal(result.days, 19);
    assert.equal(stub.calls(), 0);
    const research = new ResearchRepository(env);
    const registry = await research.ensureRegistry();
    assert.equal(registry.bootstrapDone, false);
  } finally {
    stub.restore();
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("模型失败同样消耗一次性资格", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-boot-${crypto.randomUUID()}.sqlite`;
  const env = {
    DB,
    LOCAL_RESEARCH_DB_PATH: researchPath,
    AI_API_KEY: "test-only-secret",
    AI_BASE_URL: "https://api.deepseek.com/v1",
    AI_MODEL: "test-model",
  };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const store = openHistoryStore(env);
  const datasetId = await seedDataset(env, store, 25);
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  try {
    const first = await proposeBootstrapImprovement(repository, env, {
      datasetId,
    });
    assert.equal(first.status, "ERROR");
    const second = await proposeBootstrapImprovement(repository, env, {
      datasetId,
    });
    assert.equal(second.status, "BOOTSTRAP_DONE");
    const research = new ResearchRepository(env);
    const experiment = await research.getExperiment(first.experimentId);
    assert.equal(experiment.stage, "ERROR");
    const samples = await research.experimentSamples(first.experimentId);
    assert.ok(samples.every((sample) => sample.role === "HISTORICAL_TRAIN"));
    assert.ok(samples.length >= 20);
  } finally {
    globalThis.fetch = fetchBefore;
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
