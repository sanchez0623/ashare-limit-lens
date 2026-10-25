import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { localDatabase } from "./local-db.mjs";
import { restoreDragonObservationUniverse } from "../backend/services/trading-cutover.js";
import { exportPaper } from "../backend/services/paper.js";

try { process.loadEnvFile(); } catch {}
const path = resolve(process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite");
const directory = resolve(".sites-runtime/trading-archives", `restore-observations-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
await mkdir(directory, { recursive: true });
const source = new DatabaseSync(path, { readOnly: true });
try { await backup(source, join(directory, "before.sqlite")); } finally { source.close(); }
const DB = localDatabase(path);
try {
  const result = await restoreDragonObservationUniverse({ DB });
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
  await writeFile(join(directory, "current-paper.json"), JSON.stringify(await exportPaper({ DB })));
  console.log(JSON.stringify({ directory, ...result }, null, 2));
} finally { DB.close(); }
