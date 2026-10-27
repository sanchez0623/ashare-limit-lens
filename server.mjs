import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { localDatabase } from "./scripts/local-db.mjs";
import { startTradingRunner } from "./scripts/trading-runner.mjs";
import { startDataUpdateWorker } from "./scripts/data-worker-supervisor.mjs";
import { bootstrapIndustryRepair } from "./scripts/bootstrap-industry-repair.mjs";
import { bootstrapManualExits } from "./scripts/bootstrap-manual-exits.mjs";
import { bootstrapMarketEnvironment } from "./scripts/bootstrap-market-environment.mjs";
import { RealtimeRepository } from "./backend/storage/realtime.js";
import worker from "./dist/server/index.js";
import { installRuntimeLogTimestamps } from "./scripts/runtime-log.mjs";
installRuntimeLogTimestamps();
try {
  process.loadEnvFile();
} catch {}
const host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 3000);
const authUser = process.env.AUTH_USER || "",
  authPassword = process.env.AUTH_PASSWORD || "";
if (
  (host !== "127.0.0.1" || authUser || authPassword) &&
  (!authUser || authPassword.length < 16)
)
  throw new Error("对外监听必须设置 AUTH_USER 和至少 16 位 AUTH_PASSWORD");
const dbPath = process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const DB = localDatabase(dbPath),
  env = {
    DB,
    DATA_UPDATE_RUNNER:
      process.env.DATA_WORKER_ENABLED === "false" ? "disabled" : "local",
    SW_METADATA_SOURCE: process.env.SW_METADATA_SOURCE || "lixinger",
    LIXINGER_CONFIGURED: !!process.env.LIXINGER_TOKEN?.trim(),
    AI_API_KEY: process.env.AI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_MODEL: process.env.AI_MODEL,
    LOCAL_RESEARCH_DB_PATH: process.env.LOCAL_RESEARCH_DB_PATH,
    QUAN_DATA_DIR: process.env.QUAN_DATA_DIR,
    TRADING_POLL_SECONDS: process.env.TRADING_POLL_SECONDS || "10",
    TRADING_RUNNER:
      process.env.TRADING_ENABLED === "false" ? "disabled" : "server",
    ALERTS_ENABLED: process.env.ALERTS_ENABLED,
    TRADE_NOTIFICATIONS_ENABLED: process.env.TRADE_NOTIFICATIONS_ENABLED,
    FEISHU_WEBHOOK_URL: process.env.FEISHU_WEBHOOK_URL,
    FEISHU_SECRET: process.env.FEISHU_SECRET,
    WATCHDOG_PROGRESS_URL: process.env.WATCHDOG_PROGRESS_URL,
    WATCHDOG_PIPELINE_URL: process.env.WATCHDOG_PIPELINE_URL,
    ALERT_INSTANCE_ALIAS: process.env.ALERT_INSTANCE_ALIAS,
  };
const hash = (value) => createHash("sha256").update(value).digest();
const authorized = (req) => {
  if (!authUser && !authPassword && host === "127.0.0.1") return true;
  const expected = `Basic ${Buffer.from(`${authUser}:${authPassword}`).toString("base64")}`;
  return timingSafeEqual(hash(req.headers.authorization || ""), hash(expected));
};
const server = createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Limit Lens", charset="UTF-8"',
      "Cache-Control": "no-store",
    });
    res.end("Authentication required");
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 12000) {
        res.writeHead(413);
        res.end("Request too large");
        return;
      }
      chunks.push(chunk);
    }
    const origin =
      process.env.PUBLIC_ORIGIN ||
      `http://${req.headers.host || `localhost:${port}`}`;
    const request = new Request(new URL(req.url, origin), {
      method: req.method,
      headers: req.headers,
      ...(["GET", "HEAD"].includes(req.method)
        ? {}
        : { body: Buffer.concat(chunks) }),
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end("Service error");
  }
});
let runner;
let dataWorker;
let scoringWorker, scoringRestart;
server.listen(port, host, async () => {
  console.log(`Trading server listening on port ${port}`);
  if (process.env.TRADING_ENABLED !== "false") {
    try {
      const repaired = await bootstrapIndustryRepair(env, dbPath);
      if (repaired.mode === "CONTINUE")
        console.log(
          `[industry-repair] 已验证续跑：保留 ${repaired.preservedObservations} 次观测、${repaired.preservedFills} 笔成交及原持仓；备份 ${repaired.directory}`,
        );
      else if (repaired.changed)
        console.log(
          `[industry-repair] 已修正 ${repaired.corrections.length} 只行业；保留 ${repaired.candidates} 只观察，原 ${repaired.retiredObservations} 次观测已归档；备份 ${repaired.directory}`,
        );
    } catch (error) {
      console.error(`[industry-repair] 未修改原账本：${error.message}`);
      await new RealtimeRepository(env).heartbeat({
        status: "BLOCKED",
        reason: `行业输入修复未通过：${error.message}`,
        checkedAt: new Date().toISOString(),
        automatic: false,
        runner: "disabled",
        pollIntervalSeconds: Number(env.TRADING_POLL_SECONDS),
      });
      // Do not run an execution build against a plan whose repair was refused.
      // Keep the server available to inspect/export its unchanged evidence.
      return;
    }
  }
  if (process.env.TRADING_ENABLED !== "false") {
    try {
      const manual = await bootstrapManualExits(env, dbPath);
      if (manual.changed)
        console.log(
          `[manual-exit] 已冻结 ${manual.requests.map((row) => `${row.tradeDate} ${row.code} 清仓${row.quantity}股`).join("；")}，当天禁止买回该股`,
        );
      if (manual.status === "WAITING_PREPARATION")
        throw new Error("清仓预约尚未在开盘前完成冻结，请先核对执行状态");
    } catch (error) {
      console.error(`[manual-exit] 准备失败：${error.message}`);
      await new RealtimeRepository(env).heartbeat({
        status: "BLOCKED",
        reason: `用户清仓计划未通过：${error.message}`,
        checkedAt: new Date().toISOString(),
        automatic: false,
        runner: "disabled",
        pollIntervalSeconds: Number(env.TRADING_POLL_SECONDS),
      });
      return;
    }
  }
  if (process.env.TRADING_ENABLED !== "false") {
    try {
      const environment = await bootstrapMarketEnvironment(env, dbPath);
      console.log(`[market-environment] ${environment.status}`);
    } catch (error) {
      console.error(`[market-environment] ${error.message}`);
      await new RealtimeRepository(env).heartbeat({
        status: "BLOCKED",
        reason: `市场环境准备失败：${error.message}`,
        checkedAt: new Date().toISOString(),
        automatic: false,
        runner: "disabled",
      });
      return;
    }
  }
  dataWorker = startDataUpdateWorker(dbPath, {
    enabled: env.DATA_UPDATE_RUNNER === "local",
  });
  if (process.env.SCORING_WORKER_ENABLED !== "false") {
    const startScoring = () => {
      scoringWorker = spawn(process.execPath, ["scripts/scoring-worker.mjs"], {
        env: process.env,
        stdio: "inherit",
        detached: false,
      });
      scoringWorker.on("exit", () => {
        if (!stopped) scoringRestart = setTimeout(startScoring, 30000);
      });
    };
    startScoring();
  }
  if (process.env.TRADING_ENABLED !== "false")
    runner = startTradingRunner(env, async () =>
      (
        await worker.fetch(
          new Request("http://localhost/api/run-daily", { method: "POST" }),
          env,
        )
      ).json(),
    );
  // 独立告警子进程（§6）：规则推进与通知发送不阻塞交易循环；进程崩溃时
  // 停止管道健康信号，由外部监测兜底。未配置通知通道时静默空转。
  if (process.env.ALERTS_ENABLED !== "false") {
    const child = spawn(process.execPath, ["scripts/alert-runner.mjs"], {
      env: process.env,
      stdio: "ignore",
      detached: false,
    });
    child.on("exit", (code) => {
      if (!stopped)
        console.log(`Alert runner exited (${code}); restarting in 30s`);
      if (!stopped)
        setTimeout(
          () =>
            spawn(process.execPath, ["scripts/alert-runner.mjs"], {
              env: process.env,
              stdio: "ignore",
              detached: false,
            }).on("exit", () => {}),
          30000,
        );
    });
  }
  // 独立统计 worker（statistical-evidence.md §8.3）：补齐缺失证据窗口，
  // 与盘后主流程幂等共存；EVIDENCE_WORKER_ENABLED=false 时禁用。
  if (process.env.EVIDENCE_WORKER_ENABLED !== "false") {
    const spawnEvidenceWorker = () =>
      spawn(process.execPath, ["scripts/evidence-worker.mjs"], {
        env: process.env,
        stdio: "inherit",
        detached: false,
      });
    let evidenceWorker = spawnEvidenceWorker();
    evidenceWorker.on("exit", (code) => {
      if (!stopped) {
        console.log(`Evidence worker exited (${code}); restarting in 60s`);
        setTimeout(() => {
          evidenceWorker = spawnEvidenceWorker();
        }, 60000);
      }
    });
  }
});
let stopped = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (stopped) return;
    stopped = true;
    runner?.stop();
    clearTimeout(scoringRestart);
    scoringWorker?.kill();
    await dataWorker?.stop();
    server.close(() => {
      DB.close();
      process.exit(0);
    });
  });
