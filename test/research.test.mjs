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
import { eventDigest } from "../backend/domain/research-lineage.js";
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
test("测试日期全历史一次性占用；迁移前截止线、训练占用与超出展示分页的旧记录都阻断复用", async () => {
  const { DB, env, repository } = await seedRepository(80);
  const research = new ResearchRepository(env);
  const first = await proposeImprovement(repository, env);
  assert.equal(first.status, "COLLECTING");
  assert.match(first.reason, /截止线/);
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
    await assert.rejects(
      () =>
        research.reserveAttempt({
          policy,
          month: "2099-01",
          trainingDates: [dateAt(1)],
          testDates: [dateAt(61)],
          parentVersion: "baseline-v1",
          windowPayload: {},
        }),
      /UNIQUE|PRIMARY/,
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
test("启用闸门：历史通过不启用；新旧启用入口统一被前瞻规则拦截", async () => {
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
    const events = await new ResearchRepository(env).experimentEvents(
      result.experimentId,
    );
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
