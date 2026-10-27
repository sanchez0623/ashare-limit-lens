import { spawn } from "node:child_process";
export function startDataUpdateWorker(dbPath, { enabled = true } = {}) {
  let child = null,
    stopped = !enabled,
    restart = null;
  const launch = () => {
    if (stopped) return;
    child = spawn(process.execPath, ["scripts/data-worker.mjs"], {
      env: { ...process.env, LOCAL_DATABASE_PATH: dbPath },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
      detached: false,
    });
    child.on("error", (error) =>
      console.error("[data-worker] 启动失败：", error.message),
    );
    child.on("exit", (code, signal) => {
      child = null;
      if (!stopped) {
        console.warn(
          `[data-worker] 进程退出（code=${code}, signal=${signal ?? "none"}），2 秒后重启`,
        );
        restart = setTimeout(launch, 2000);
      }
    });
  };
  launch();
  return {
    async stop() {
      stopped = true;
      clearTimeout(restart);
      const current = child;
      if (!current) return;
      await new Promise((resolve) => {
        const kill = setTimeout(() => {
          current.kill();
          resolve();
        }, 5000);
        current.once("exit", () => {
          clearTimeout(kill);
          resolve();
        });
        if (current.connected) current.disconnect();
        else current.kill("SIGTERM");
      });
    },
  };
}
