import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { localDatabase } from "./local-db.mjs";
import {
  prepareTradingCutover,
  applyTradingCutover,
} from "../backend/services/trading-cutover.js";
import {
  tradingArchive,
  archivedLedgerCsv,
} from "../backend/storage/trading-archives.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";

try {
  process.loadEnvFile();
} catch {}
const args = process.argv.slice(2);
if (args.some((arg) => !/^--(date=\d{4}-\d{2}-\d{2}|apply)$/.test(arg)))
  throw new Error(
    "用法：node scripts/trading-cutover.mjs --date=YYYY-MM-DD [--apply]",
  );
const tradeDate = args.find((arg) => arg.startsWith("--date="))?.slice(7);
if (!tradeDate) throw new Error("请指定新周期执行日 --date=YYYY-MM-DD");
const path = resolve(
  process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite",
);
let backupPath = null,
  directory = null;
if (args.includes("--apply")) {
  directory = resolve(
    ".sites-runtime/trading-archives",
    `cutover-${tradeDate}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
  );
  await mkdir(directory, { recursive: true });
  backupPath = join(directory, "before.sqlite");
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    await backup(source, backupPath);
  } finally {
    source.close();
  }
}
const DB = localDatabase(path);
try {
  const env = { DB };
  const prepared = await prepareTradingCutover(env, { tradeDate });
  const summary = prepared.summary;
  console.log(
    JSON.stringify(
      {
        mode: prepared.duplicate
          ? "ALREADY_APPLIED"
          : args.includes("--apply")
            ? "APPLY"
            : "PREVIEW",
        tradeDate,
        signalDate: summary.signalDate,
        primaryFills: summary.primary.fills,
        shadowFills: summary.shadow.fills,
        oldPositions: summary.primary.positions,
        candidates: summary.candidates.length,
        initialCapital: summary.initialBook.initialCashCents / 100,
        backupPath,
      },
      null,
      2,
    ),
  );
  if (args.includes("--apply")) {
    await applyTradingCutover(env, prepared);
    const archive = await tradingArchive(env, summary.id);
    const verification = await verifyExport(await exportPaper(env));
    await writeFile(join(directory, "archive.json"), JSON.stringify(archive));
    await writeFile(join(directory, "ledger.csv"), archivedLedgerCsv(archive));
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify(
        { summary, archiveDigest: archive.digest, backupPath, verification },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify(
        { archiveId: summary.id, directory, verification },
        null,
        2,
      ),
    );
    if (!verification.passed) process.exitCode = 1;
  }
} finally {
  DB.close();
}
