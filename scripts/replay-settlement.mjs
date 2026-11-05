// 漏日结算重放工具（运维兜底）：收盘后手动/计划任务触发，按漏日自动补
// 结算（backend/services/paper.js 的收盘后递归重放）补齐缺失交易日。
// 任何守卫失败都会如实阻断，不放宽校验；盘中调用会被拒绝。
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { localDatabase } from "./local-db.mjs";
import { runPaperDay } from "../backend/services/paper.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import { afterClose } from "../backend/services/review.js";

const root = fileURLToPath(new URL("..", import.meta.url));
try {
  // 计划任务的工作目录是 System32：必须按项目根显式加载 .env。
  process.loadEnvFile(join(root, ".env"));
} catch {}
const args = process.argv.slice(2);
const at = args.indexOf("--date");
const date = at >= 0 ? args[at + 1] : undefined;
const dbPath = resolve(
  root,
  process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite",
);
mkdirSync(dirname(dbPath), { recursive: true });
const DB = localDatabase(dbPath);
const env = {
  DB,
  DATA_UPDATE_RUNNER: "disabled",
  SW_METADATA_SOURCE: process.env.SW_METADATA_SOURCE || "lixinger",
  LIXINGER_CONFIGURED: !!process.env.LIXINGER_TOKEN?.trim(),
  AI_API_KEY: process.env.AI_API_KEY,
  AI_BASE_URL: process.env.AI_BASE_URL,
  AI_MODEL: process.env.AI_MODEL,
  LOCAL_RESEARCH_DB_PATH: process.env.LOCAL_RESEARCH_DB_PATH,
  QUAN_DATA_DIR: process.env.QUAN_DATA_DIR,
  TRADING_POLL_SECONDS: process.env.TRADING_POLL_SECONDS || "10",
  TRADING_RUNNER: "api",
  ALERTS_ENABLED: "false",
};
try {
  const account = await new RealtimeRepository(env).account();
  const target =
    date ??
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  console.log(
    `重放前 lastDate=${account?.book?.lastDate ?? "（新账户）"} 目标=${target}`,
  );
  if (!afterClose()) {
    console.error("拒绝执行：当前北京时间未到收盘后 15:05 结算窗口。");
    process.exitCode = 1;
  } else {
    const result = await runPaperDay(env, target);
    const after = await new RealtimeRepository(env).account();
    console.log(
      JSON.stringify(
        {
          ...result,
          notices: result.notices?.slice(0, 10),
          lastDateAfter: after?.book?.lastDate ?? null,
        },
        null,
        2,
      ).slice(0, 4000),
    );
    if (result.status !== "SETTLED" && result.status !== "NON_TRADING_DAY")
      process.exitCode = 1;
  }
} finally {
  DB.close();
}
