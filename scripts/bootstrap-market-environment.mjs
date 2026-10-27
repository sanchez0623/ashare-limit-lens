import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PaperRepository } from "../backend/storage/paper.js";
import { applyDragonLifecycle } from "../backend/services/dragon-risk.js";
import { prepareEnvironmentTrial } from "../backend/services/market-environment.js";
import { executionEngineBuildDigest } from "../backend/domain/execution-build.js";
export async function bootstrapMarketEnvironment(
  env,
  dbPath,
  now = new Date(),
) {
  const account = await new PaperRepository(env).account();
  if (account?.book.tradingPolicyVersion !== "dragon-risk-v1")
    return { status: "NOT_CONFIGURED" };
  const active = await env.DB.prepare(
    "SELECT id FROM market_environment_trials WHERE cycle_id=? AND status='ACTIVE'",
  )
    .bind(account.book.tradingCycleId ?? "primary")
    .first();
  const plan = await new PaperRepository(env).plan(account.book.lastDate);
  if (active && plan?.engineBuild === (await executionEngineBuildDigest()))
    return prepareEnvironmentTrial(env, now);
  const directory = resolve(
    ".sites-runtime/trading-archives",
    `environment-startup-${now.toISOString().replaceAll(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { recursive: true });
  const source = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    await backup(source, join(directory, "before.sqlite"));
  } finally {
    source.close();
  }
  await applyDragonLifecycle(env, account.book.lastDate, now);
  let result = await prepareEnvironmentTrial(env, now);
  if (result.status === "INVALIDATED")
    result = await prepareEnvironmentTrial(env, now);
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  return { ...result, directory };
}
