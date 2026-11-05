import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { digestOf } from "../backend/domain/research-lineage.js";
import { assertSessionlessSettlementPlan } from "../backend/services/paper.js";

const SIGNAL_DATE = "2026-10-26";
const TRADE_DATE = "2026-10-27";
const CONFIG_ID = "dragon-engine-old";

function plan(overrides = {}) {
  return {
    tradingPolicyVersion: "dragon-risk-v1",
    signalDate: SIGNAL_DATE,
    createdAt: "2026-10-27T01:26:46.644Z",
    engineBuild: "old-build-digest",
    dragonPolicy: { configId: CONFIG_ID, configDigest: "config-digest" },
    ...overrides,
  };
}

async function setup({ liveSession = false, configDigest = "config-digest" } = {}) {
  const DB = localDatabase();
  const env = { DB };
  const frozen = plan();
  await DB.prepare(
    "INSERT INTO paper_plans(signal_date,created_at,payload,digest) VALUES(?,?,?,?)",
  )
    .bind(SIGNAL_DATE, frozen.createdAt, JSON.stringify(frozen), await digestOf(frozen))
    .run();
  await DB.prepare(
    "INSERT INTO dragon_config_versions(id,payload,digest,engine_build,created_at) VALUES(?,?,?,?,?)",
  )
    .bind(CONFIG_ID, "{}", configDigest, frozen.engineBuild, frozen.createdAt)
    .run();
  await DB.prepare(
    "INSERT INTO dragon_plan_bindings(scope,signal_date,config_id,plan_digest) VALUES('main',?,?,?)",
  )
    .bind(SIGNAL_DATE, CONFIG_ID, await digestOf(frozen))
    .run();
  if (liveSession)
    await DB.prepare(
      "INSERT INTO paper_live_sessions(trade_date,payload,digest) VALUES(?,?,?)",
    )
      .bind(TRADE_DATE, "{}", "session-digest")
      .run();
  return { DB, env, frozen };
}

test("漏日空仓补结算：冻结依据一致且无会话时允许核验通过", async () => {
  const { DB, env, frozen } = await setup();
  try {
    await assertSessionlessSettlementPlan(env, frozen, TRADE_DATE);
  } finally {
    DB.close();
  }
});

test("漏日空仓补结算：当日已有实时会话时拒绝", async () => {
  const { DB, env, frozen } = await setup({ liveSession: true });
  try {
    await assert.rejects(
      () => assertSessionlessSettlementPlan(env, frozen, TRADE_DATE),
      /当日已有实时会话/,
    );
  } finally {
    DB.close();
  }
});

test("漏日空仓补结算：登记配置摘要不一致时拒绝", async () => {
  const { DB, env, frozen } = await setup({ configDigest: "other-digest" });
  try {
    await assert.rejects(
      () => assertSessionlessSettlementPlan(env, frozen, TRADE_DATE),
      /登记配置与冻结计划不一致/,
    );
  } finally {
    DB.close();
  }
});

test("漏日空仓补结算：计划摘要被改写时拒绝", async () => {
  const { DB, env, frozen } = await setup();
  try {
    await assert.rejects(
      () =>
        assertSessionlessSettlementPlan(
          env,
          { ...frozen, engineBuild: "tampered" },
          TRADE_DATE,
        ),
      /冻结计划摘要不一致/,
    );
  } finally {
    DB.close();
  }
});
