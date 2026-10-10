import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { ResearchRepository } from "../backend/storage/research.js";
import { openHistoryStore } from "../backend/storage/history.js";
import {
  proposeBootstrapImprovement,
  researchStatus,
} from "../backend/services/research.js";
import { FACTORS, PRESETS } from "../shared/scoring.js";

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
    assert.equal(status.activeExperiment, null);
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
