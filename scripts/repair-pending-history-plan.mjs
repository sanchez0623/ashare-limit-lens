import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { localDatabase } from "./local-db.mjs";
import { repairPendingPlanHistory } from "../backend/services/pending-plan-history.js";

try {
  process.loadEnvFile();
} catch {}
const args = process.argv.slice(2),
  apply = args.includes("--apply");
const at = args.indexOf("--database");
const dbPath = resolve(
  at >= 0
    ? args[at + 1]
    : process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite",
);
let directory;
if (apply) {
  directory = resolve(
    ".sites-runtime/trading-archives",
    `history-plan-repair-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
  );
  await mkdir(directory, { recursive: true });
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await backup(source, join(directory, "before.sqlite"));
  } finally {
    source.close();
  }
}
const DB = localDatabase(dbPath);
try {
  const result = await repairPendingPlanHistory({ DB }, { dryRun: !apply });
  if (directory)
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
  console.log(
    JSON.stringify({ ...result, backupDirectory: directory }, null, 2),
  );
} finally {
  DB.close();
}
