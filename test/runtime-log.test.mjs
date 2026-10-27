import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { localDatabase } from "../scripts/local-db.mjs";
import { StockMetadataRepository } from "../backend/storage/stock-metadata.js";

test(
  "更新进程异常后关闭IPC并被重新拉起；父子进程日志统一北京时间且不重复前缀",
  { timeout: 15000 },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), "limit-lens-runtime-log-"));
    const dbPath = join(folder, "worker.sqlite"),
      DB = localDatabase(dbPath);
    await new StockMetadataRepository({ DB }).createJob("industry_sw");
    // Deterministic SQLite failure at the real worker's claimJob boundary. No
    // external provider is called: the second worker uses an invalid test source.
    DB.exec(`CREATE TRIGGER simulate_claim_lock BEFORE UPDATE OF status ON data_update_jobs
    WHEN NEW.status='RUNNING' AND OLD.status='QUEUED'
    BEGIN SELECT RAISE(ABORT, 'database is locked'); END`);
    let child;
    t.after(async () => {
      if (child && child.exitCode === null) child.kill();
      DB.close();
      assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
      assert.ok(basename(folder).startsWith("limit-lens-runtime-log-"));
      await rm(folder, { recursive: true, force: true });
    });
    const script = `
    import { installRuntimeLogTimestamps } from './scripts/runtime-log.mjs';
    import { startDataUpdateWorker } from './scripts/data-worker-supervisor.mjs';
    installRuntimeLogTimestamps(); installRuntimeLogTimestamps();
    console.log('[log-test] format %s', 'preserved');
    console.error('[log-test] multiline\\ncontinued');
    const supervisor = startDataUpdateWorker(process.env.LOCAL_DATABASE_PATH);
    let stopping = false;
    process.on('message', async (message) => {
      if (message !== 'stop' || stopping) return;
      stopping = true;
      await supervisor.stop();
      if (process.connected) process.disconnect();
    });
  `;
    let stdout = "",
      stderr = "",
      released = false,
      stopped = false;
    const result = await new Promise((fulfill, reject) => {
      child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: resolve("."),
        windowsHide: true,
        env: {
          ...process.env,
          LOCAL_DATABASE_PATH: dbPath,
          SW_METADATA_SOURCE: "synthetic-invalid",
          NODE_NO_WARNINGS: "1",
          TZ: "UTC",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`worker did not recover: ${stdout}\n${stderr}`));
      }, 12000);
      const inspect = () => {
        try {
          if (!released && stderr.includes("执行器异常： database is locked")) {
            DB.exec("DROP TRIGGER simulate_claim_lock");
            released = true;
          }
          if (!stopped && (stdout.match(/执行器已就绪/g)?.length ?? 0) >= 2) {
            stopped = true;
            child.send("stop");
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      };
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        inspect();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        inspect();
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        fulfill({ code, signal });
      });
    });
    assert.equal(result.code, 0);
    assert.ok(released && stopped);
    assert.match(stderr, /执行器异常： database is locked/);
    assert.match(stderr, /进程退出（code=1, signal=none），2 秒后重启/);
    assert.match(stdout, /\[log-test\] format preserved/);
    assert.match(stderr, /\[log-test\] multiline\n\[.*?\] continued/);
    const lines = `${stdout}\n${stderr}`.trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      assert.match(
        line,
        /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \+08:00\] /,
      );
      assert.equal((line.match(/\+08:00\]/g) ?? []).length, 1);
    }
  },
);
