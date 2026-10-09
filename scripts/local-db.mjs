import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
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
  function prepare(sql) {
    return {
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      async first() {
        return sqlite.prepare(sql).get(...this.args) || null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...this.args) };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...this.args);
        return { meta: { changes: Number(result.changes) } };
      },
      _run() {
        const result = sqlite.prepare(sql).run(...this.args);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    prepare,
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement._run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      sqlite.close();
    },
  };
}
