import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  inspectIndustryRepair,
  repairIndustryInputs,
} from "../backend/services/industry-repair.js";

// Run only after this process owns its listening port and before starting any
// workers. A second server must never repair a database used by the first one.
export async function bootstrapIndustryRepair(env, dbPath) {
  if (!(await inspectIndustryRepair(env))) return { changed: false };
  const directory = resolve(
    ".sites-runtime/trading-archives",
    `industry-repair-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
  );
  await mkdir(directory, { recursive: true });
  const source = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    await backup(source, join(directory, "before.sqlite"));
  } finally {
    source.close();
  }
  const result = await repairIndustryInputs(env);
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  return { ...result, directory };
}
