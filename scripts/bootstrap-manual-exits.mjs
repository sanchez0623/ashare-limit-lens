import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PaperRepository } from "../backend/storage/paper.js";
import { pendingManualExitRequests } from "../backend/storage/manual-exits.js";
import { prepareManualExitPlan } from "../backend/services/manual-exits.js";

export async function bootstrapManualExits(env, dbPath) {
  const account = await new PaperRepository(env).account();
  if (
    !account ||
    !(await pendingManualExitRequests(env.DB, account.book)).length
  )
    return { changed: false };
  const directory = resolve(
    ".sites-runtime/trading-archives",
    `manual-exit-startup-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
  );
  await mkdir(directory, { recursive: true });
  const source = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    await backup(source, join(directory, "before.sqlite"));
  } finally {
    source.close();
  }
  const result = await prepareManualExitPlan(env);
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return { ...result, directory };
}
