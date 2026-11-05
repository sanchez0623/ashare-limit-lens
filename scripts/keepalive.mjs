// 本机看门狗（Layer A）：由计划任务每 2 分钟触发，独立于交易服务进程。
// 端口无响应即拉起 server.mjs（detached，日志追加到运行目录）；端口在
// 监听即视为服务存活，不重启、不干预。
// 退出方式：只设置 exitCode、不调用 process.exit，避免异步句柄未清理时
// 被系统记为“进程异常终止”（计划任务曾因此把成功运行记成 1067）。
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
try {
  process.loadEnvFile(join(root, ".env"));
} catch {}
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

function portListening(timeoutMs = 3000) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

if (await portListening()) process.exitCode = 0;
else {
  const logDirectory = join(root, ".sites-runtime", "logs");
  mkdirSync(logDirectory, { recursive: true });
  const logPath = join(
    logDirectory,
    `server-${new Date().toISOString().slice(0, 10)}.log`,
  );
  const child = spawn(process.execPath, [join(root, "server.mjs")], {
    cwd: root,
    env: process.env,
    detached: true,
    // 日志直接写文件描述符：父进程退出后管道会关闭，子进程写 stdout 会
    // 触发 EPIPE 并可能把常驻服务带崩。
    stdio: ["ignore", openSync(logPath, "a"), openSync(logPath, "a")],
  });
  const stamp = () => `[${new Date().toISOString()}] `;
  appendFileSync(
    logPath,
    `${stamp()}keepalive 拉起 server.mjs (pid ${child.pid})\n`,
  );
  child.on("exit", (code) =>
    appendFileSync(logPath, `${stamp()}server.mjs 退出 (${code})\n`),
  );
  child.unref();
  console.log(`server.mjs 已由 keepalive 拉起 (pid ${child.pid})`);
  process.exitCode = 0;
}
