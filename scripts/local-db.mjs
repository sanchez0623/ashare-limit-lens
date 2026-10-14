import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
export function localDatabase(path = ":memory:") {
  const sqlite = new DatabaseSync(path);
  sqlite.exec(
    "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)",
  );
  for (const name of readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (
      sqlite.prepare("SELECT name FROM local_migrations WHERE name=?").get(name)
    )
      continue;
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(readFileSync(`drizzle/${name}`, "utf8"));
      sqlite
        .prepare("INSERT INTO local_migrations (name) VALUES (?)")
        .run(name);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  const context = new AsyncLocalStorage();
  let activeTransaction = null;
  let pending = 0;
  let savepointSequence = 0;
  const ownsTransaction = () =>
    activeTransaction !== null && context.getStore() === activeTransaction;
  function enqueue(operation) {
    pending++;
    const run = db.transactionQueue.then(operation).finally(() => pending--);
    db.transactionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  function statement(operation) {
    // 事务内语句必须直接执行；外部调用（包括读取）不能加入其未提交连接。
    return ownsTransaction() ? operation() : enqueue(operation);
  }
  function prepare(sql) {
    return {
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      async first() {
        const args = [...this.args];
        return statement(() => sqlite.prepare(sql).get(...args) || null);
      },
      async all() {
        const args = [...this.args];
        return statement(() => ({ results: sqlite.prepare(sql).all(...args) }));
      },
      async run() {
        const args = [...this.args];
        return statement(() => {
          const result = sqlite.prepare(sql).run(...args);
          return { meta: { changes: Number(result.changes) } };
        });
      },
      _run() {
        if (!ownsTransaction())
          throw new Error(
            "同步写入只允许在所属事务内执行；外部写入请使用 run()",
          );
        const result = sqlite.prepare(sql).run(...this.args);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }
  const db = {
    prepare,
    exec(sql) {
      if (pending && !ownsTransaction())
        throw new Error("连接有排队操作；外部 SQL 请使用异步 prepare()");
      return sqlite.exec(sql);
    },
    async batch(statements) {
      if (ownsTransaction()) {
        const savepoint = `batch_${++savepointSequence}`;
        sqlite.exec(`SAVEPOINT ${savepoint}`);
        try {
          const results = statements.map((item) => item._run());
          sqlite.exec(`RELEASE ${savepoint}`);
          return results;
        } catch (error) {
          sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          throw error;
        }
      }
      return db.transaction(() => statements.map((item) => item._run()));
    },
    transactionQueue: Promise.resolve(),
    async transaction(fn) {
      if (ownsTransaction())
        throw new Error("不支持嵌套事务；请复用当前事务内的语句");
      return enqueue(() =>
        context.run({}, async () => {
          sqlite.exec("BEGIN IMMEDIATE");
          activeTransaction = context.getStore();
          try {
            let result = fn();
            if (result?.then) result = await result;
            sqlite.exec("COMMIT");
            return result;
          } catch (error) {
            sqlite.exec("ROLLBACK");
            throw error;
          } finally {
            activeTransaction = null;
          }
        }),
      );
    },
    close() {
      if (pending) throw new Error("连接仍有排队操作，不能关闭");
      sqlite.close();
    },
  };
  return db;
}
