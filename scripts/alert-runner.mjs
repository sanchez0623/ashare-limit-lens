// 独立告警子进程（§6）：规则推进与通知发送不阻塞交易循环。
// 主进程崩溃时本进程仍可发送已入队事件；数据库不可写时停止管道健康信号，
// 由外部监测兜底。不保存密钥：凭据经环境变量传入。
import { localDatabase } from "./local-db.mjs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  processAlerts,
  processAlertOutbox,
  alertsStatus,
} from "../backend/services/alerts.js";
import { reportPipelineHealth } from "../backend/services/watchdog.js";
import { AlertRepository } from "../backend/storage/alerts.js";

try {
  process.loadEnvFile();
} catch {}
const dbPath = process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const env = {
  DB: localDatabase(dbPath),
  ALERTS_ENABLED: process.env.ALERTS_ENABLED,
  FEISHU_WEBHOOK_URL: process.env.FEISHU_WEBHOOK_URL,
  FEISHU_SECRET: process.env.FEISHU_SECRET,
  WATCHDOG_PIPELINE_URL: process.env.WATCHDOG_PIPELINE_URL,
  ALERT_INSTANCE_ALIAS: process.env.ALERT_INSTANCE_ALIAS,
};
const interval =
  Math.max(5, Math.min(60, Number(process.env.ALERT_RUNNER_SECONDS || 10))) *
  1000;
let stopped = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopped = true;
    setTimeout(() => {
      env.DB.close();
      process.exit(0);
    }, 100);
  });
const log = (message) => {
  // 只输出事件 ID、通道代号与安全错误码；不含密钥、URL 或堆栈。
  if (process.env.ALERT_RUNNER_VERBOSE === "true") console.log(message);
};
const loop = async () => {
  try {
    const advanced = await processAlerts(env);
    const delivered = await processAlertOutbox(env, {
      leaseOwner: "alert-runner",
    });
    const store = new AlertRepository(env);
    const state = await store.processorState();
    const outbox = await store.outboxHealth();
    await reportPipelineHealth(env, {
      cursor: state?.lastEventCursor ?? null,
      outbox,
      // 分发器自己的推进时刻：队列为空但分发器已死时必须判为不健康。
      state,
    });
    log(
      `alerts tick: events=${advanced.processed} incidents=${advanced.incidents ?? 0} outbox=${delivered.length}`,
    );
  } catch (error) {
    // 数据库错误无法持久化：不继续发送管道健康信号，外部监测兜底。
    log(`alerts tick failed: ${error?.code ?? error?.name ?? "ERROR"}`);
  }
  if (!stopped) setTimeout(() => void loop(), interval);
};
void alertsStatus(env).then((status) =>
  log(
    `alert runner started: enabled=${status.enabled} channels=${status.channels
      .map((c) => `${c.ref}:${c.configured ? "ok" : "off"}`)
      .join(",")}`,
  ),
);
void loop();
