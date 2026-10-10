import test from "node:test";
import assert from "node:assert/strict";
import { BASE_STRATEGY } from "../backend/domain/trading.js";
import {
  validateCandidatePatch,
  DEFAULT_RESEARCH_POLICY,
} from "../backend/domain/research-policy.js";
import {
  ResearchRepository,
  RESEARCH_NAMESPACE,
} from "../backend/storage/research.js";
import {
  proposeImprovement,
  promoteCandidate,
  researchStatus,
} from "../backend/services/research.js";
import { beijingMonth } from "../backend/domain/research-windows.js";
import {
  eventDigest,
  digestOf,
  EXECUTION_VERSION,
  SCORING_VERSION,
} from "../backend/domain/research-lineage.js";
import { PaperRepository } from "../backend/storage/paper.js";
import { api } from "../backend/routes/api.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { pairs, dateAt } from "./fixtures/trading.mjs";

async function seedRepository(count = 80) {
  const DB = localDatabase();
  const env = {
    DB,
    AI_API_KEY: "test-only-secret",
    AI_BASE_URL: "https://api.deepseek.com/v1",
  };
  const repository = new PaperRepository(env);
  await repository.initialize();
  for (const pair of pairs(count)) {
    pair.snapshot.stocks[1].score = 81;
    pair.snapshot.stocks[1].factors = pair.snapshot.stocks[1].factors.map(
      (factor) => ({ value: 81 }),
    );
    await DB.prepare(
      "INSERT OR IGNORE INTO snapshots (trade_date,created_at,payload) VALUES (?,?,?)",
    )
      .bind(
        pair.snapshot.date,
        pair.snapshot.createdAt,
        JSON.stringify(pair.snapshot),
      )
      .run();
    await DB.prepare(
      "INSERT INTO paper_market_days (trade_date,payload,digest) VALUES (?,?,?)",
    )
      .bind(pair.dataset.date, JSON.stringify(pair.dataset), "fixture")
      .run();
  }
  await new ResearchRepository(env).ensureRegistry();
  return { DB, env, repository };
}
function stubProposal(patch = { minScore: 82 }) {
  let calls = 0;
  let received = null;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls++;
    received = JSON.parse(options.body);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              rationale: "基于训练数据微调",
              patch,
            }),
          },
        },
      ],
    });
  };
  return {
    calls: () => calls,
    received: () => received,
    restore: () => {
      globalThis.fetch = fetchBefore;
    },
  };
}
async function setCutoff(DB, cutoff) {
  await DB.prepare(
    "UPDATE research_registry SET legacy_cutoff = ? WHERE namespace = ?",
  )
    .bind(cutoff, RESEARCH_NAMESPACE)
    .run();
}
function windowDates() {
  const trainingDates = [];
  const testDates = [];
  for (let index = 1; index <= 60; index++) trainingDates.push(dateAt(index));
  for (let index = 61; index <= 80; index++) testDates.push(dateAt(index));
  return { trainingDates, testDates };
}
function minimalSamples({ trainingDates, testDates }) {
  return [
    ...trainingDates.map((date) => ({
      date,
      role: "TRAIN",
      payload: { tradeDate: date, role: "TRAIN" },
      digest: `train-${date}`,
    })),
    ...testDates.map((date) => ({
      date,
      role: "HISTORICAL_TEST",
      payload: { tradeDate: date, role: "HISTORICAL_TEST" },
      digest: `test-${date}`,
    })),
  ];
}
function makeRealtime(pair) {
  const day = pair.dataset;
  const baseQuotes = JSON.parse(JSON.stringify(day.quotes));
  const seconds = [];
  for (let mark = 9 * 3600 + 30 * 60; mark <= 11 * 3600 + 30 * 60; mark += 10)
    seconds.push(mark);
  for (let mark = 13 * 3600; mark <= 14 * 3600 + 56 * 60; mark += 10)
    seconds.push(mark);
  const observations = seconds.map((mark, tickIndex) => {
    const time = `${String(Math.floor(mark / 3600)).padStart(2, "0")}:${String(Math.floor((mark % 3600) / 60)).padStart(2, "0")}:${String(mark % 60).padStart(2, "0")}`;
    const timestamp = `${day.date}T${time}+08:00`;
    const quotes = {};
    for (const [code, quote] of Object.entries(baseQuotes))
      quotes[code] = {
        ...quote,
        timestamp,
        volumeShares: 100000 + tickIndex * 5000000,
      };
    return { observedAt: new Date(timestamp).toISOString(), quotes };
  });
  day.executionMode = "realtime";
  const lastVolume = 100000 + (seconds.length - 1) * 5000000;
  const closingQuotes = {};
  for (const [code, quote] of Object.entries(baseQuotes))
    closingQuotes[code] = {
      ...quote,
      timestamp: `${day.date}T15:00:03+08:00`,
      volumeShares: lastVolume,
    };
  day.quotes = closingQuotes;
  return observations;
}
test("候选 patch 的参数组数量、步长与无变化候选由代码强制校验", () => {
  const parent = { ...BASE_STRATEGY };
  assert.throws(
    () =>
      validateCandidatePatch({
        proposal: { rationale: "r", patch: { minScore: 84 } },
        parentParams: parent,
        frozenPolicy: DEFAULT_RESEARCH_POLICY,
      }),
    /步长/,
  );
  assert.throws(
    () =>
      validateCandidatePatch({
        proposal: { rationale: "r", patch: {} },
        parentParams: parent,
        frozenPolicy: DEFAULT_RESEARCH_POLICY,
      }),
    /无实际差异|有效参数变化/,
  );
  assert.throws(
    () =>
      validateCandidatePatch({
        proposal: { rationale: "r", patch: { minScore: 80 } },
        parentParams: parent,
        frozenPolicy: DEFAULT_RESEARCH_POLICY,
      }),
    /无实际差异/,
  );
  assert.throws(
    () =>
      validateCandidatePatch({
        proposal: {
          rationale: "r",
          patch: { minScore: 82, stopLoss: 0.065, maxPositions: 3 },
        },
        parentParams: parent,
        frozenPolicy: DEFAULT_RESEARCH_POLICY,
      }),
    /参数组/,
  );
  assert.throws(
    () =>
      validateCandidatePatch({
        proposal: { rationale: "r", patch: { maxGrossExposure: 0.9 } },
        parentParams: parent,
        frozenPolicy: DEFAULT_RESEARCH_POLICY,
      }),
    /父策略不存在/,
  );
  assert.throws(
    () =>
      validateCandidatePatch({
        proposal: JSON.parse('{"rationale":"r","patch":{"__proto__":1}}'),
        parentParams: parent,
        frozenPolicy: DEFAULT_RESEARCH_POLICY,
      }),
    /未授权字段/,
  );
  assert.throws(
    () =>
      validateCandidatePatch({
        proposal: {
          rationale: "r",
          patch: {
            weights: [32, 22, 15, 15, 15, 3],
            stopLoss: 0.065,
            takeProfit: 0.13,
          },
        },
        parentParams: parent,
        frozenPolicy: DEFAULT_RESEARCH_POLICY,
      }),
    /分量|参数组/,
  );
  assert.throws(
    () =>
      validateCandidatePatch({
        proposal: {
          rationale: "r",
          patch: { weights: [32, 20, 15, 15, 15, 7] },
        },
        parentParams: parent,
        frozenPolicy: DEFAULT_RESEARCH_POLICY,
      }),
    /总和/,
  );
  const twoGroups = validateCandidatePatch({
    proposal: {
      rationale: "r",
      patch: {
        weights: [32, 20, 15, 15, 15, 3],
        stopLoss: 0.065,
      },
    },
    parentParams: parent,
    frozenPolicy: DEFAULT_RESEARCH_POLICY,
  });
  assert.deepEqual(twoGroups.patch.weights, [32, 20, 15, 15, 15, 3]);
  assert.equal(twoGroups.params.stopLoss, 0.065);
  const boundary = validateCandidatePatch({
    proposal: { rationale: "r", patch: { stopLoss: 0.065 } },
    parentParams: parent,
    frozenPolicy: DEFAULT_RESEARCH_POLICY,
  });
  assert.equal(boundary.params.stopLoss, 0.065);
});
test("测试日期全历史一次性占用；截止线、训练占用与超出展示分页的旧记录都阻断复用", async () => {
  const { DB, env, repository } = await seedRepository(80);
  const research = new ResearchRepository(env);
  await setCutoff(DB, dateAt(20));
  const stub = stubProposal();
  try {
    const result = await proposeImprovement(repository, env);
    assert.equal(result.status, "AWAITING_SHADOW");
    assert.equal(
      (await repository.account()).book.activeStrategy,
      "baseline-v1",
    );
    const sent = JSON.parse(stub.received().messages[1].content);
    assert.equal(sent.dailySignals.length, 60);
    assert.equal(sent.dailySignals.at(-1).date, dateAt(59));
    assert.ok(!JSON.stringify(sent).includes(dateAt(80)));
    await assert.rejects(
      () => research.assertFreshOutcomeDates([dateAt(61)]),
      /占用|一次性登记/,
    );
    await assert.rejects(
      () => research.assertFreshOutcomeDates([dateAt(30)]),
      /占用/,
    );
    await assert.rejects(
      () => research.assertFreshOutcomeDates([dateAt(15)]),
      /截止线/,
    );
    for (let index = 0; index < 50; index++) {
      await DB.prepare(
        "INSERT OR IGNORE INTO research_test_claims (namespace, outcome_date, experiment_id, role, reserved_at) VALUES (?,?,?,?,?)",
      )
        .bind(
          RESEARCH_NAMESPACE,
          dateAt(100 + index),
          `legacy-${index}`,
          "HISTORICAL_TEST",
          new Date().toISOString(),
        )
        .run();
    }
    await assert.rejects(
      () => research.assertFreshOutcomeDates([dateAt(100)]),
      /占用|一次性登记/,
    );
    const policy = await research.getPolicy();
    const { trainingDates, testDates } = windowDates();
    await assert.rejects(
      () =>
        research.reserveAttempt({
          policy,
          month: "2099-01",
          parentVersion: "baseline-v1",
          windowPayload: {},
          testDates: [dateAt(61)],
          samples: minimalSamples({
            trainingDates: [dateAt(1)],
            testDates: [dateAt(61)],
          }),
        }),
      /UNIQUE|PRIMARY|占用/,
    );
    const status = await researchStatus(env);
    assert.equal(status.registry.attemptSequence, 1);
    assert.equal(status.activeExperiment.experimentId, result.experimentId);
  } finally {
    stub.restore();
    DB.close();
  }
});
test("模型错误同样占用预算与尝试序号；同月第二次提案被拒绝", async () => {
  const { DB, env, repository } = await seedRepository(80);
  await setCutoff(DB, dateAt(20));
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("模型服务不可用");
  };
  try {
    const first = await proposeImprovement(repository, env);
    assert.equal(first.status, "ERROR");
    const status = await researchStatus(env);
    assert.equal(status.registry.attemptSequence, 1);
    const second = await proposeImprovement(repository, env);
    assert.equal(second.status, "BUDGET_EXHAUSTED");
    const research = new ResearchRepository(env);
    await assert.rejects(
      () => research.assertFreshOutcomeDates([dateAt(61)]),
      /占用|一次性登记/,
    );
  } finally {
    globalThis.fetch = fetchBefore;
    DB.close();
  }
});
test("并发提案只有一次预留和一次模型调用", async () => {
  const { DB, env, repository } = await seedRepository(80);
  await setCutoff(DB, dateAt(20));
  const stub = stubProposal();
  try {
    const [first, second] = await Promise.all([
      proposeImprovement(repository, env),
      proposeImprovement(repository, env),
    ]);
    assert.equal(stub.calls(), 1);
    const statuses = [first.status, second.status].sort();
    assert.ok(statuses.includes("AWAITING_SHADOW"));
    assert.ok(
      statuses.includes("BUSY") ||
        statuses.includes("BUDGET_EXHAUSTED") ||
        statuses.includes("COLLECTING"),
    );
  } finally {
    stub.restore();
    DB.close();
  }
});
test("启用闸门：历史通过不启用；新旧启用入口统一被前瞻规则拦截；血缘绑定实际输入", async () => {
  const { DB, env, repository } = await seedRepository(80);
  await setCutoff(DB, dateAt(20));
  const stub = stubProposal();
  const make = (body) =>
    new Request("https://example.test/api/paper/activate", {
      method: "POST",
      body: JSON.stringify(body),
    });
  try {
    const result = await proposeImprovement(repository, env);
    assert.equal(result.status, "AWAITING_SHADOW");
    const status = await researchStatus(env);
    assert.equal(status.activeExperiment.stage, "AWAITING_SHADOW");
    await assert.rejects(
      () => promoteCandidate(repository, env, "ai-2026-01-30"),
      /不再具有启用资格/,
    );
    await assert.rejects(
      () => promoteCandidate(repository, env, result.experimentId),
      /前瞻影子验证/,
    );
    const badId = await api(make({ id: "invalid-id" }), env);
    assert.equal(badId.status, 400);
    const legacy = await api(make({ id: "ai-2026-01-30" }), env);
    assert.equal(legacy.status, 503);
    const candidate = await api(make({ id: result.experimentId }), env);
    assert.equal(candidate.status, 503);
    const research = new ResearchRepository(env);
    const experiment = await research.getExperiment(result.experimentId);
    assert.equal(
      experiment.proposalManifest.executionVersion,
      EXECUTION_VERSION,
    );
    assert.equal(experiment.proposalManifest.scoringVersion, SCORING_VERSION);
    assert.equal(
      experiment.proposalManifest.parentParamsDigest,
      await digestOf(BASE_STRATEGY),
    );
    assert.ok(experiment.proposalManifest.feeConfigDigest);
    const samples = await research.experimentSamples(result.experimentId);
    assert.equal(samples.length, 80);
    for (const sample of samples) {
      assert.notEqual(sample.digest, `train-${sample.outcomeDate}`);
      assert.equal(sample.digest, await digestOf(sample.payload));
      assert.ok(sample.payload.snapshotDigest);
      assert.ok(sample.payload.marketDigest);
      assert.ok(sample.payload.quoteManifestDigest);
    }
    const events = await research.experimentEvents(result.experimentId);
    for (const [index, event] of events.entries()) {
      const expected = await eventDigest({
        sequence: event.sequence,
        eventType: event.eventType,
        createdAt: event.createdAt,
        payload: event.payload,
        previousDigest: event.previousDigest,
      });
      assert.equal(event.digest, expected);
      assert.equal(
        event.previousDigest,
        index === 0 ? null : events[index - 1].digest,
      );
    }
  } finally {
    stub.restore();
    DB.close();
  }
});
async function seedRealtimeRepository(withTicks) {
  const DB = localDatabase();
  const env = {
    DB,
    AI_API_KEY: "test-only-secret",
    AI_BASE_URL: "https://api.deepseek.com/v1",
  };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const all = pairs(80);
  for (const [index, pair] of all.entries()) {
    pair.snapshot.stocks[1].score = 81;
    pair.snapshot.stocks[1].factors = pair.snapshot.stocks[1].factors.map(
      (factor) => ({ value: 81 }),
    );
    let observations = null;
    if (index >= 61) {
      observations = makeRealtime(pair);
      if (!withTicks) observations = null;
    }
    await DB.prepare(
      "INSERT OR IGNORE INTO snapshots (trade_date,created_at,payload) VALUES (?,?,?)",
    )
      .bind(
        pair.snapshot.date,
        pair.snapshot.createdAt,
        JSON.stringify(pair.snapshot),
      )
      .run();
    await DB.prepare(
      "INSERT INTO paper_market_days (trade_date,payload,digest) VALUES (?,?,?)",
    )
      .bind(pair.dataset.date, JSON.stringify(pair.dataset), "fixture")
      .run();
    if (observations) {
      let sequence = 0;
      for (const observation of observations) {
        sequence++;
        await DB.prepare(
          "INSERT INTO paper_live_ticks (trade_date,sequence,payload,digest) VALUES (?,?,?,?)",
        )
          .bind(
            pair.dataset.date,
            sequence,
            JSON.stringify(observation),
            "fixture",
          )
          .run();
      }
    }
  }
  await new ResearchRepository(env).ensureRegistry();
  await setCutoff(DB, dateAt(20));
  return { DB, env, repository };
}
test("实时报价参与历史筛查：缺失则拒绝，恢复加载后通过", async () => {
  const missing = await seedRealtimeRepository(false);
  const stubMissing = stubProposal();
  try {
    const rejected = await proposeImprovement(missing.repository, missing.env);
    assert.equal(rejected.status, "REJECTED");
    assert.equal(rejected.checks.coverage, false);
  } finally {
    stubMissing.restore();
    missing.DB.close();
  }
  const present = await seedRealtimeRepository(true);
  const stubPresent = stubProposal();
  try {
    const passed = await proposeImprovement(present.repository, present.env);
    assert.equal(passed.status, "AWAITING_SHADOW");
    assert.equal(passed.checks.coverage, true);
  } finally {
    stubPresent.restore();
    present.DB.close();
  }
});
test("提案中断恢复：请求发出后停机记为 ERROR 且预算保留；冻结后停机幂等续验且不再调用模型", async () => {
  const { DB, env, repository } = await seedRepository(100);
  await setCutoff(DB, dateAt(20));
  const research = new ResearchRepository(env);
  const policy = await research.getPolicy();
  const { trainingDates, testDates } = windowDates();
  const samples = minimalSamples({ trainingDates, testDates });
  const stuck = await research.reserveAttempt({
    policy,
    month: beijingMonth(),
    parentVersion: "baseline-v1",
    windowPayload: {},
    testDates,
    samples,
  });
  await research.appendEvent(stuck.experimentId, "REQUEST_ISSUED", {});
  const stub = stubProposal();
  try {
    const afterCrash = await proposeImprovement(repository, env);
    assert.equal(afterCrash.status, "BUDGET_EXHAUSTED");
    assert.equal(stub.calls(), 0);
    const stuckExperiment = await research.getExperiment(stuck.experimentId);
    assert.equal(stuckExperiment.stage, "ERROR");
    const status = await researchStatus(env);
    assert.equal(status.activeExperiment, null);
    assert.equal(status.registry.attemptSequence, 1);
    const resumedTraining = [];
    for (let index = 1; index <= 80; index++)
      resumedTraining.push(dateAt(index));
    const resumedTest = [];
    for (let index = 81; index <= 90; index++) resumedTest.push(dateAt(index));
    const refrozen = await research.reserveAttempt({
      policy,
      month: "2099-02",
      parentVersion: "baseline-v1",
      windowPayload: {},
      testDates: resumedTest,
      samples: [
        ...resumedTraining.map((date) => ({
          date,
          role: "TRAIN",
          payload: { tradeDate: date },
          digest: `train-${date}`,
        })),
        ...resumedTest.map((date) => ({
          date,
          role: "HISTORICAL_TEST",
          payload: { tradeDate: date },
          digest: `test-${date}`,
        })),
      ],
    });
    await research.freezeCandidate(refrozen.experimentId, {
      versionId: refrozen.experimentId,
      params: { ...BASE_STRATEGY, minScore: 82 },
      patch: { minScore: 82 },
      rationale: "冻结后中断",
      policyId: policy.id,
      modelAlias: "test",
      modelVersionReported: null,
      promptDigest: "prompt",
      output: {},
      trainingDates: resumedTraining,
      parentVersion: "baseline-v1",
      parentParamsDigest: "parent",
      feeConfigDigest: "fees",
      executionVersion: EXECUTION_VERSION,
      scoringVersion: SCORING_VERSION,
    });
    const resumed = await proposeImprovement(repository, env);
    assert.equal(resumed.status, "AWAITING_SHADOW");
    assert.equal(resumed.experimentId, refrozen.experimentId);
    assert.equal(stub.calls(), 0);
    assert.equal(
      (await research.getExperiment(refrozen.experimentId)).stage,
      "AWAITING_SHADOW",
    );
  } finally {
    stub.restore();
    DB.close();
  }
});
test("迁移回填旧验证日期并固定截止线；新安装截止线为空不误判新数据", async () => {
  const { DB, env } = await seedRepository(40);
  const fresh = await researchStatus(env);
  assert.equal(fresh.registry.legacyCutoff, null);
  await DB.prepare(
    "INSERT INTO strategy_versions (id, created_at, status, params, evidence) VALUES (?,?,?,?,?)",
  )
    .bind(
      "ai-2026-01-30",
      `${dateAt(30)}T08:00:00.000Z`,
      "LEGACY_VALIDATED",
      JSON.stringify(BASE_STRATEGY),
      JSON.stringify({
        validationStart: dateAt(35),
        validationEnd: dateAt(45),
        baseVersion: "baseline-v1",
      }),
    )
    .run();
  const research = new ResearchRepository(env);
  const status = await researchStatus(env);
  assert.equal(status.registry.legacyBackfillDone, true);
  assert.equal(status.registry.legacyCutoff, dateAt(45));
  await assert.rejects(
    () => research.assertFreshOutcomeDates([dateAt(12)]),
    /截止线/,
  );
  await DB.prepare(
    "DELETE FROM paper_market_days WHERE trade_date >= ? AND trade_date <= ?",
  )
    .bind(dateAt(35), dateAt(40))
    .run();
  await assert.rejects(
    () => research.assertFreshOutcomeDates([dateAt(37)]),
    /截止线/,
  );
  await assert.rejects(
    async () =>
      research.reserveAttempt({
        policy: await research.getPolicy(),
        month: "2099-03",
        parentVersion: "baseline-v1",
        windowPayload: {},
        testDates: [dateAt(12)],
        samples: [
          {
            date: dateAt(12),
            role: "HISTORICAL_TEST",
            payload: { tradeDate: dateAt(12) },
            digest: "test-12",
          },
        ],
      }),
    /截止线/,
  );
  DB.close();
});
test("存储层在预留事务内拒绝把已用训练日期改成测试日期", async () => {
  const { DB, env } = await seedRepository(80);
  const research = new ResearchRepository(env);
  const policy = await research.getPolicy();
  const { trainingDates, testDates } = windowDates();
  await research.reserveAttempt({
    policy,
    month: "2099-04",
    parentVersion: "baseline-v1",
    windowPayload: {},
    testDates,
    samples: minimalSamples({ trainingDates, testDates }),
  });
  const registryBefore = await research.ensureRegistry();
  await assert.rejects(
    () =>
      research.reserveAttempt({
        policy,
        month: "2099-05",
        parentVersion: "baseline-v1",
        windowPayload: {},
        testDates: [dateAt(30)],
        samples: [
          ...trainingDates
            .filter((date) => date !== dateAt(30))
            .map((date) => ({
              date,
              role: "TRAIN",
              payload: { tradeDate: date },
              digest: `train-${date}`,
            })),
          {
            date: dateAt(30),
            role: "HISTORICAL_TEST",
            payload: { tradeDate: dateAt(30) },
            digest: "test-30",
          },
        ],
      }),
    /占用/,
  );
  const registryAfter = await research.ensureRegistry();
  assert.equal(registryAfter.revision, registryBefore.revision);
  DB.close();
});
