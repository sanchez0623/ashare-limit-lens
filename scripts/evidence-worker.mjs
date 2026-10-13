// 独立统计 worker（docs/design/statistical-evidence.md §8.3）：
// 长驻进程，周期性发现尚无报告的 (系列, 窗口, 来源日) 证据窗口并补齐
// 发布。发布幂等（同输入唯一），重复执行只补缺失；每轮失败的任务保留，
// 下一轮重试。--once 执行一轮后退出（供自测/手动补偿）。
// 与盘后流程互不干扰：都写 evidence_* 表，但发布按键唯一去重。
import { localDatabase } from "./local-db.mjs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runEvidenceWorkerTick } from "../backend/services/evidence.js";

try {
  process.loadEnvFile();
} catch {}

const dbPath = process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const DB = localDatabase(dbPath);
const env = { DB };
const intervalMs = Math.max(
  60_000,
  Number(process.env.EVIDENCE_WORKER_INTERVAL_MS ?? 300_000),
);
const once = process.argv.includes("--once");

let stopping = false;
let wake = null;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    wake?.();
  });

async function tick() {
  const startedAt = new Date().toISOString();
  try {
    const { discovered, results } = await runEvidenceWorkerTick(env);
    if (discovered)
      console.log(
        `[evidence-worker] ${startedAt} 发现 ${discovered} 个缺失窗口，` +
          `发布 ${results.filter((r) => r.reportId).length}，失败 ` +
          `${results.filter((r) => r.status === "FAILED").length}`,
      );
    for (const result of results.filter((r) => r.status === "FAILED"))
      console.error(
        `[evidence-worker] ${result.seriesId} h${result.horizon} @${result.asOf}：${result.error}`,
      );
  } catch (error) {
    console.error(`[evidence-worker] 本轮失败：${error.message}`);
  }
}

if (once) {
  await tick();
  DB.close();
} else {
  console.log(`[evidence-worker] 启动，间隔 ${intervalMs}ms`);
  while (!stopping) {
    await tick();
    if (stopping) break;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      const timer = setTimeout(finish, intervalMs);
      wake = finish;
    });
  }
  DB.close();
}
