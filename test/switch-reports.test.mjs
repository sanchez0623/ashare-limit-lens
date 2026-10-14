import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDatabase } from "../scripts/local-db.mjs";
import { digestOf } from "../backend/domain/research-lineage.js";
import { switchReportRows } from "../backend/storage/switch-reports.js";

test("SQLite CAS 批次等待异步事务结束，前序回滚不会丢失后续原子提交", async () => {
  const DB = localDatabase();
  DB.exec("CREATE TABLE queue_probe(id INTEGER PRIMARY KEY)");
  let entered, release;
  const inside = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const transaction = DB.transaction(async () => {
    await DB.prepare("INSERT INTO queue_probe VALUES(1)").run();
    entered();
    await gate;
    throw new Error("TEST_ROLLBACK");
  });
  const failed = assert.rejects(transaction, /TEST_ROLLBACK/);
  await inside;
  let settled = false;
  const batch = DB.batch([DB.prepare("INSERT INTO queue_probe VALUES(2)")]);
  batch.then(
    () => (settled = true),
    () => (settled = true),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false, "异步事务开放期间，后续批次不能嵌套 BEGIN");
  release();
  await failed;
  assert.equal((await batch)[0].meta.changes, 1);
  assert.deepEqual(
    (
      await DB.prepare("SELECT id FROM queue_probe ORDER BY id").all()
    ).results.map((row) => row.id),
    [2],
  );
  DB.close();
});

test("0018→0019：准确补存旧切换引用报告，不重写旧事件，重复读取幂等", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switch-migration-"));
  const path = join(dir, "legacy.sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("CREATE TABLE local_migrations(name TEXT PRIMARY KEY)");
  for (const file of readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql") && name < "0019")
    .sort()) {
    sqlite.exec(readFileSync(`drizzle/${file}`, "utf8"));
    sqlite.prepare("INSERT INTO local_migrations(name) VALUES(?)").run(file);
  }
  const source = {
    cohortId: "single-legacy",
    champion: { memberId: "m1" },
    verdicts: [{ memberId: "m1", stage: "ELIGIBLE" }],
    promotion: null,
  };
  const original = { ...source, digest: await digestOf(source) };
  const publicSource = { ...source, promotion: { promoted: true } };
  const evaluation = { ...publicSource, digest: await digestOf(publicSource) };
  const event = {
    id: "switch-legacy",
    cohortId: source.cohortId,
    experimentId: "exp-legacy",
    eventType: "PROMOTE",
    fromVersion: "baseline-v1",
    toVersion: "exp-legacy",
    accountRevision: 1,
    reportDigest: original.digest,
    createdAt: "2026-10-14T07:00:00.000Z",
  };
  const raw = JSON.stringify(event),
    hash = await digestOf(event);
  sqlite
    .prepare(
      "INSERT INTO strategy_switch_events(id,cohort_id,experiment_id,event_type,from_version,to_version,account_revision,payload,digest,created_at) VALUES(?,?,?,'PROMOTE',?,?,?,?,?,?)",
    )
    .run(
      event.id,
      event.cohortId,
      event.experimentId,
      event.fromVersion,
      event.toVersion,
      1,
      raw,
      hash,
      event.createdAt,
    );
  sqlite.close();
  const DB = localDatabase(path);
  try {
    const switches = [{ payload: event, digest: hash }];
    const first = await switchReportRows(DB, switches, evaluation);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].payload, original);
    assert.deepEqual(await switchReportRows(DB, switches, evaluation), first);
    const old = await DB.prepare(
      "SELECT payload,digest FROM strategy_switch_events WHERE id=?",
    )
      .bind(event.id)
      .first();
    assert.equal(old.payload, raw);
    assert.equal(old.digest, hash);
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM strategy_switch_reports",
        ).first()
      ).n,
      1,
    );
    await assert.rejects(
      () => DB.prepare("DELETE FROM strategy_switch_reports").run(),
      /不可删除/,
    );
    const bad = [{ payload: { ...event, reportDigest: "f".repeat(64) } }];
    await assert.rejects(
      () => switchReportRows(DB, bad, evaluation),
      /无法还原/,
    );
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM strategy_switch_reports",
        ).first()
      ).n,
      1,
    );
  } finally {
    DB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
