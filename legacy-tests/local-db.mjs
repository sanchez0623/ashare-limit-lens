import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { ResearchRepository } from "../backend/storage/research.js";

test("事务内批次复用连接，失败批次只回滚到保存点，外层事务仍能提交", async () => {
  const DB = localDatabase();
  DB.exec("CREATE TABLE queue_probe(id INTEGER PRIMARY KEY)");
  try {
    await DB.transaction(async () => {
      await DB.prepare("INSERT INTO queue_probe VALUES(1)").run();
      await assert.rejects(
        () =>
          DB.batch([
            DB.prepare("INSERT INTO queue_probe VALUES(2)"),
            DB.prepare("INSERT INTO queue_probe VALUES(1)"),
          ]),
        /UNIQUE constraint/,
      );
      assert.deepEqual(
        (await DB.prepare("SELECT id FROM queue_probe").all()).results.map(
          (row) => row.id,
        ),
        [1],
      );
      await DB.batch([DB.prepare("INSERT INTO queue_probe VALUES(3)")]);
    });
    assert.deepEqual(
      (
        await DB.prepare("SELECT id FROM queue_probe ORDER BY id").all()
      ).results.map((row) => row.id),
      [1, 3],
    );
  } finally {
    DB.close();
  }
});

test("外部政策保存和读取等待事务回滚，成功政策不会随另一事务丢失", async () => {
  const DB = localDatabase();
  const research = new ResearchRepository({ DB });
  let entered, release;
  const inside = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const transaction = DB.transaction(async () => {
    await research.savePolicy({ forwardDays: 20 }, "rolled-back");
    assert.equal((await research.getPolicy()).id, "rolled-back");
    entered();
    await gate;
    throw new Error("TEST_ROLLBACK");
  });
  const failed = assert.rejects(transaction, /TEST_ROLLBACK/);
  await inside;
  let saved = false,
    read = false;
  const save = research.savePolicy({ forwardDays: 30 }, "survives-rollback");
  save.then(() => (saved = true));
  const externalRead = DB.prepare(
    "SELECT id FROM research_policy_versions",
  ).all();
  externalRead.then(() => (read = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, false);
  assert.equal(read, false, "外部读取不能观察未提交政策");
  release();
  await failed;
  assert.equal((await save).id, "survives-rollback");
  await externalRead;
  assert.equal((await research.getPolicy()).id, "survives-rollback");
  assert.equal(
    await DB.prepare(
      "SELECT id FROM research_policy_versions WHERE id='rolled-back'",
    ).first(),
    null,
  );
  DB.close();
});

test("事务结束后的异步后续不继承连接所有权，绑定参数在排队时冻结", async () => {
  const DB = localDatabase();
  DB.exec("CREATE TABLE queue_probe(id INTEGER PRIMARY KEY)");
  let releaseLater, late;
  const later = new Promise((resolve) => (releaseLater = resolve));
  await DB.transaction(async () => {
    await DB.prepare("INSERT INTO queue_probe VALUES(1)").run();
    late = later.then(() =>
      DB.prepare("INSERT INTO queue_probe VALUES(3)").run(),
    );
  });
  let entered, release;
  const inside = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const failed = assert.rejects(
    DB.transaction(async () => {
      await DB.prepare("INSERT INTO queue_probe VALUES(2)").run();
      entered();
      await gate;
      throw new Error("TEST_ROLLBACK");
    }),
    /TEST_ROLLBACK/,
  );
  await inside;
  releaseLater();
  const statement = DB.prepare("INSERT INTO queue_probe VALUES(?)").bind(4);
  const queued = statement.run();
  statement.bind(5);
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => DB.exec("INSERT INTO queue_probe VALUES(6)"), /排队操作/);
  assert.throws(
    () => DB.prepare("INSERT INTO queue_probe VALUES(7)")._run(),
    /所属事务/,
  );
  release();
  await failed;
  await Promise.all([late, queued]);
  assert.deepEqual(
    (
      await DB.prepare("SELECT id FROM queue_probe ORDER BY id").all()
    ).results.map((row) => row.id),
    [1, 3, 4],
  );
  DB.close();
});
