// Read-only production access; all migration, activation and UI checks use a copy.
import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import { localDatabase } from "./local-db.mjs";
import { bootstrapMarketEnvironment } from "./bootstrap-market-environment.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { ShadowAccountRepository } from "../backend/storage/shadow.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import { canonicalJson, digestOf } from "../backend/domain/research-lineage.js";
import { scoringPolicy } from "../backend/services/observation-scoring.js";
import {
  marketEnvironment,
  researchEnvironment,
} from "../backend/services/market-environment.js";
try {
  process.loadEnvFile();
} catch {}
const original =
  process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite";
const path = `.sites-runtime/environment-verification-${Date.now()}.sqlite`;
const source = new DatabaseSync(original, { readOnly: true });
try {
  await backup(source, path);
} finally {
  source.close();
}
const DB = localDatabase(path),
  env = { DB };
try {
  const repo = new PaperRepository(env),
    before = await repo.account();
  const oldPlan = await repo.plan(before.book.lastDate);
  const policyBefore = (
    await DB.prepare(
      "SELECT version,payload,digest FROM market_environment_policies",
    ).all()
  ).results;
  const archivesBefore = await DB.prepare(
    "SELECT * FROM paper_trading_archives ORDER BY created_at",
  ).all();
  // This explicitly simulates a preopen restart; it does not backdate production.
  const preopen = new Date(`${oldPlan.signalDate}T00:00:00Z`);
  preopen.setUTCDate(preopen.getUTCDate() + 1);
  while ([0, 6].includes(preopen.getUTCDay()))
    preopen.setUTCDate(preopen.getUTCDate() + 1);
  const result = await bootstrapMarketEnvironment(
    env,
    path,
    new Date(`${preopen.toISOString().slice(0, 10)}T09:20:00+08:00`),
  );
  assert.equal(result.status, "ACTIVE", JSON.stringify(result));
  const after = await repo.account(),
    plan = await repo.plan(after.book.lastDate);
  for (const key of [
    "cashCents",
    "equityCents",
    "initialCashCents",
    "positions",
    "feesCents",
    "realizedPnlCents",
    "settlementCount",
    "tradingCycleId",
    "feeConfig",
    "feeModel",
    "feeConfigVersion",
    "dragonConfig",
  ])
    assert.equal(
      canonicalJson(after.book[key]),
      canonicalJson(before.book[key]),
      `preserve ${key}`,
    );
  assert.deepEqual(
    plan.entryExecutionPolicy.candidates,
    oldPlan.entryExecutionPolicy.candidates,
  );
  assert.deepEqual(plan.feeConfig, oldPlan.feeConfig);
  assert.deepEqual(
    plan.dragonPolicy.config.risk,
    oldPlan.dragonPolicy.config.risk,
  );
  assert.equal(
    plan.dragonPolicy.adaptiveRiskPolicy.version,
    "dragon-adaptive-risk-v3",
  );
  assert.equal(
    plan.dragonPolicy.marketEnvironmentPolicy.version,
    "market-environment-v1",
  );
  for (const old of policyBefore)
    assert.deepEqual(
      {
        ...(await DB.prepare(
          "SELECT version,payload,digest FROM market_environment_policies WHERE version=?",
        )
          .bind(old.version)
          .first()),
      },
      { ...old },
    );
  assert.deepEqual(
    await DB.prepare(
      "SELECT * FROM paper_trading_archives ORDER BY created_at",
    ).all(),
    archivesBefore,
  );
  const shadows = await new ShadowAccountRepository(env).accounts({
    cohortId: result.id,
  });
  assert.equal(shadows.length, 3);
  for (const arm of shadows)
    assert.equal(arm.book.cashCents, before.book.cashCents);
  const verification = await verifyExport(await exportPaper(env));
  assert.equal(verification.passed, true, JSON.stringify(verification));
  const score = await scoringPolicy(env);
  const status = {
    checkedAt: new Date().toISOString(),
    database: path,
    productionWrites: false,
    productionRestarted: false,
    simulatedPreopen: true,
    bootstrap: result,
    account: {
      cash: after.book.cashCents / 100,
      equity: after.book.equityCents / 100,
      positions: after.book.positions.length,
      watchlist: plan.entryExecutionPolicy.candidates.length,
    },
    policies: {
      environment: plan.dragonPolicy.marketEnvironmentPolicy.version,
      risk: plan.dragonPolicy.adaptiveRiskPolicy.version,
      scoring: score.policy.version,
    },
    oldPolicyRowsPreserved: policyBefore.length,
    archiveDigest: await digestOf(archivesBefore),
    arms: shadows.map((a) => ({ role: a.memberId, account: a.accountId })),
    environment: await marketEnvironment(env),
    research: await researchEnvironment(env),
    verification,
  };
  await writeFile(
    ".sites-runtime/environment-verification.json",
    JSON.stringify(status, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        database: path,
        productionWrites: false,
        productionRestarted: false,
        status: result.status,
        account: status.account,
        policies: status.policies,
        arms: shadows.length,
        oldPolicyRowsPreserved: policyBefore.length,
        verification,
      },
      null,
      2,
    ),
  );
} finally {
  DB.close();
}
