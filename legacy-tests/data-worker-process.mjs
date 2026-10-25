import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { localDatabase } from "../scripts/local-db.mjs";
import { StockMetadataRepository } from "../backend/storage/stock-metadata.js";
import { startDataUpdateWorker } from "../scripts/data-worker-supervisor.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
for (const entry of ["server.mjs", "dev.mjs"])
  test(`${entry}: metadata worker stays independent of trading and recovers interrupted jobs on restart`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "limit-lens-data-worker-")),
      path = join(dir, "local.sqlite"),
      port = await freePort();
    let output = "";
    const options = {
      cwd: root,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        AUTH_USER: "",
        AUTH_PASSWORD: "",
        PUBLIC_ORIGIN: "",
        LOCAL_DATABASE_PATH: path,
        TRADING_ENABLED: "false",
        ALERTS_ENABLED: "false",
        EVIDENCE_WORKER_ENABLED: "false",
        DATA_WORKER_ENABLED: "true",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const children = [];
    const launch = () => {
      const child = spawn(process.execPath, [entry], options);
      children.push(child);
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          output = (output + chunk).slice(-4000);
        });
      return child;
    };
    const terminate = async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    };
    let child = launch();
    let DB;
    t.after(async () => {
      for (const process of children) await terminate(process);
      DB?.close();
      // This directory was created exclusively for this test. Verify the resolved
      // target before a recursive cleanup on Windows.
      assert.equal(dirname(realpathSync(dir)), realpathSync(tmpdir()));
      rmSync(dir, { recursive: true, force: true });
    });
    let status;
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/data/status`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) status = await res.json();
        if (status?.workerHealthy) break;
      } catch {}
      if (child.exitCode !== null) break;
      await delay(100);
    }
    assert.equal(status?.available, true, output);
    assert.equal(status?.workerHealthy, true, output);
    assert.equal(status.activeJob, null);
    assert.equal(status.stockList, null);
    assert.equal(status.stockEm, null);
    assert.equal(status.industrySw, null);
    DB = localDatabase(path);
    assert.equal(
      (await DB.prepare("SELECT COUNT(*) AS c FROM data_update_jobs").first())
        .c,
      0,
      "startup must not fetch external metadata",
    );
    assert.equal(
      (await DB.prepare("SELECT COUNT(*) AS c FROM paper_accounts").first()).c,
      0,
      "trading must stay disabled",
    );
    const repo = new StockMetadataRepository({ DB });
    const previousOwner = (await repo.worker()).owner;
    const { job } = await repo.createJob("industry_sw");
    // Reserve the queued job without making any external request. A hard stop
    // can kill the entire Windows process tree before finally blocks execute.
    await repo.claimJob(previousOwner);
    await terminate(child);
    child = launch();
    let recovered;
    for (let i = 0; i < 210; i++) {
      recovered = await repo.job(job.id);
      if (recovered.status === "FAILED") break;
      if (child.exitCode !== null) break;
      await delay(200);
    }
    assert.equal(recovered.status, "FAILED", output);
    assert.match(recovered.error, /中断/);
    assert.notEqual((await repo.worker()).owner, previousOwner);
    assert.equal(await repo.activeJob(), null);
    assert.equal(await repo.snapshot("stock_em"), null);
    assert.equal(await repo.snapshot("industry_sw"), null);
  });

test("graceful supervisor shutdown releases the worker lease", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "limit-lens-data-worker-")),
    path = join(dir, "local.sqlite"),
    DB = localDatabase(path),
    repo = new StockMetadataRepository({ DB });
  const supervisor = startDataUpdateWorker(path);
  t.after(async () => {
    await supervisor.stop();
    DB.close();
    assert.equal(dirname(realpathSync(dir)), realpathSync(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !(await repo.worker()).owner; i++)
    await delay(100);
  assert.ok((await repo.worker()).owner);
  await supervisor.stop();
  assert.equal((await repo.worker()).owner, null);
});
