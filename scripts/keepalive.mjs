// 本机看门狗（Layer A）：独立于交易服务进程，由计划任务每 2 分钟与开机
// 时调用。端口无响应即拉起 server.mjs（detached，日志追加到运行目录）；
// 任何 HTTP 响应（含 401 认证响应）都视为服务存活，不重启、不干预。
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
try {
  process.loadEnvFile(join(root, ".env"));
} catch {}
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
async function alive() {
  try {
    const response = await fetch(`http://${host}:${port}/api/paper/live`, {
      signal: AbortSignal.timeout(3000),
    });
    return true; // 任何 HTTP 响应（含 401）都证明服务进程存活
  } catch {
    return false;
  }
}
if (await alive()) process.exit(0);
const logDirectory = resolve(root, ".sites-runtime/logs");
mkdirSync(logDirectory, { recursive: true });
const logPath = join(
  logDirectory,
  `server-${new Date().toISOString().slice(0, 10)}.log`,
);
const child = spawn(process.execPath, [join(root, "server.mjs")], {
  cwd: root,
  env: process.env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
const stamp = () => `[${new Date().toISOString()}] `;
appendFileSync(
  logPath,
  `${stamp()}keepalive 拉起 server.mjs (pid ${child.pid})\n`,
);
child.stdout.on("data", (chunk) => appendFileSync(logPath, chunk));
child.stderr.on("data", (chunk) => appendFileSync(logPath, chunk));
child.on("exit", (code) =>
  appendFileSync(logPath, `${stamp()}server.mjs 退出 (${code})\n`),
);
child.unref();
console.log(`server.mjs 已由 keepalive 拉起 (pid ${child.pid})`);
