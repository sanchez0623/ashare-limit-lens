import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { localDatabase } from "./local-db.mjs";
import { requestManualExit } from "../backend/services/manual-exits.js";
try {
  process.loadEnvFile();
} catch {}
const args = process.argv.slice(2),
  argument = (key) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
const code = argument("--code"),
  tradeDate = argument("--trade-date"),
  reason = argument("--reason");
if (!/^\d{6}$/.test(code ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate ?? ""))
  throw new Error(
    "用法：--code 股票代码 --trade-date 下一交易日 [--reason 原因] [--database 副本路径]",
  );
const path =
  argument("--database") ??
  process.env.LOCAL_DATABASE_PATH ??
  ".sites-runtime/local.sqlite";
const directory = resolve(
  ".sites-runtime/trading-archives",
  `manual-exit-request-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
);
await mkdir(directory, { recursive: true });
const source = new DatabaseSync(resolve(path), { readOnly: true });
try {
  await backup(source, join(directory, "before.sqlite"));
} finally {
  source.close();
}
const DB = localDatabase(path);
try {
  const result = await requestManualExit({ DB }, { code, tradeDate, reason });
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...result, directory }, null, 2));
} finally {
  DB.close();
}
