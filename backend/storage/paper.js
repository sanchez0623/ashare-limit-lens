import { database } from "./database.js";
import { BASE_STRATEGY, newBook } from "../domain/trading.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export async function digest(value) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
const parse = (row) => (row ? JSON.parse(row.payload) : null);
export class PaperRepository {
  constructor(env) {
    this.db = database(env);
  }
  async initialize(weights = BASE_STRATEGY.weights) {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO paper_accounts (id, revision, state, updated_at) VALUES (?, 0, ?, ?)",
      )
      .bind(
        "primary",
        JSON.stringify({ ...newBook(), improvementMode: "auto" }),
        now,
      )
      .run();
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO strategy_versions (id, created_at, status, params, evidence) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        "baseline-v1",
        now,
        "ACTIVE",
        JSON.stringify({ ...BASE_STRATEGY, weights }),
        JSON.stringify({
          type: "baseline",
          explanation: "规则初始版本；未声称获得历史收益验证",
        }),
      )
      .run();
    return this.account();
  }
  async account() {
    const row = await this.db
      .prepare("SELECT revision, state FROM paper_accounts WHERE id = ?")
      .bind("primary")
      .first();
    return row ? { revision: row.revision, book: JSON.parse(row.state) } : null;
  }
  async snapshot(date) {
    return parse(
      await this.db
        .prepare("SELECT payload FROM snapshots WHERE trade_date = ?")
        .bind(date)
        .first(),
    );
  }
  async plan(date) {
    return parse(
      await this.db
        .prepare("SELECT payload FROM paper_plans WHERE signal_date = ?")
        .bind(date)
        .first(),
    );
  }
  async savePlan(plan) {
    const hash = await digest(plan);
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO paper_plans (signal_date, created_at, payload, digest) VALUES (?, ?, ?, ?)",
      )
      .bind(plan.signalDate, plan.createdAt, JSON.stringify(plan), hash)
      .run();
    return this.plan(plan.signalDate);
  }
  async history(table, limit = 120) {
    if (
      ![
        "paper_equity",
        "paper_ledger",
        "paper_market_days",
        "paper_plans",
        "snapshots",
        "paper_runs",
      ].includes(table)
    )
      throw new Error("无效存储类别");
    const column = table === "paper_plans" ? "signal_date" : "trade_date";
    const result = await this.db
      .prepare(`SELECT * FROM ${table} ORDER BY ${column} DESC LIMIT ?`)
      .bind(limit)
      .all();
    return result.results;
  }
  async versions() {
    const result = await this.db
      .prepare(
        "SELECT * FROM strategy_versions ORDER BY created_at DESC LIMIT 40",
      )
      .all();
    return result.results.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      status: row.status,
      params: JSON.parse(row.params),
      evidence: JSON.parse(row.evidence),
    }));
  }
  async strategy(book) {
    const row = await this.db
      .prepare("SELECT params FROM strategy_versions WHERE id = ?")
      .bind(book.activeStrategy)
      .first();
    if (!row) throw new Error("策略版本缺失");
    return JSON.parse(row.params);
  }
  async logRun(date, status, payload) {
    await this.db
      .prepare(
        "INSERT INTO paper_runs (trade_date, updated_at, status, payload) VALUES (?, ?, ?, ?) ON CONFLICT(trade_date) DO UPDATE SET updated_at=excluded.updated_at, status=excluded.status, payload=excluded.payload",
      )
      .bind(date, new Date().toISOString(), status, JSON.stringify(payload))
      .run();
  }
  async settle(expectedRevision, result, dataset) {
    const runId = crypto.randomUUID();
    const nextRevision = expectedRevision + 1;
    const guard =
      "WHERE EXISTS (SELECT 1 FROM paper_accounts WHERE id = ? AND revision = ? AND last_run_id = ?)";
    const stamp = new Date().toISOString();
    const statements = [
      this.db
        .prepare(
          "UPDATE paper_accounts SET state=?, revision=revision+1, last_run_id=?, updated_at=? WHERE id=? AND revision=?",
        )
        .bind(
          JSON.stringify(result.book),
          runId,
          stamp,
          "primary",
          expectedRevision,
        ),
    ];
    const guarded = (sql, args) =>
      this.db
        .prepare(`${sql} ${guard}`)
        .bind(...args, "primary", nextRevision, runId);
    statements.push(
      guarded("INSERT INTO paper_equity (trade_date, payload) SELECT ?, ?", [
        dataset.date,
        JSON.stringify(result.equity),
      ]),
    );
    statements.push(
      guarded(
        "INSERT INTO paper_market_days (trade_date, payload, digest) SELECT ?, ?, ?",
        [dataset.date, JSON.stringify(dataset), await digest(dataset)],
      ),
    );
    for (const fill of result.ledger)
      statements.push(
        guarded(
          "INSERT INTO paper_ledger (id, trade_date, payload) SELECT ?, ?, ?",
          [fill.id, fill.date, JSON.stringify(fill)],
        ),
      );
    await this.db.batch(statements);
    const row = await this.db
      .prepare("SELECT last_run_id FROM paper_accounts WHERE id=?")
      .bind("primary")
      .first();
    return row.last_run_id === runId;
  }
  async configure(settings) {
    const account = await this.initialize();
    const book = structuredClone(account.book);
    if (settings.initialCapital !== undefined) {
      if (book.settlementCount)
        throw new Error("结算开始后初始资金被冻结，不能改写收益基准");
      Object.assign(book, newBook(settings.initialCapital));
    }
    if (settings.improvementMode !== undefined) {
      if (!["auto", "manual"].includes(settings.improvementMode))
        throw new Error("改进模式无效");
      book.improvementMode = settings.improvementMode;
    }
    const result = await this.db
      .prepare(
        "UPDATE paper_accounts SET state=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?",
      )
      .bind(
        JSON.stringify(book),
        new Date().toISOString(),
        "primary",
        account.revision,
      )
      .run();
    if ((result.meta?.changes ?? result.changes) !== 1)
      throw new Error("账户正在结算，请刷新后重试");
    return book;
  }
  async recordVersion(version) {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO strategy_versions (id, created_at, status, params, evidence) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        version.id,
        version.createdAt,
        version.status,
        JSON.stringify(version.params),
        JSON.stringify(version.evidence),
      )
      .run();
  }
  async activate(id) {
    const row = await this.db
      .prepare("SELECT status FROM strategy_versions WHERE id=?")
      .bind(id)
      .first();
    if (!row || row.status !== "VALIDATED")
      throw new Error("只允许启用通过样本外验证的新策略");
    const { book, revision } = await this.account();
    book.activeStrategy = id;
    const nonce = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE paper_accounts SET state=?, revision=revision+1, last_run_id=?, updated_at=? WHERE id=? AND revision=?",
        )
        .bind(
          JSON.stringify(book),
          nonce,
          new Date().toISOString(),
          "primary",
          revision,
        ),
      this.db
        .prepare(
          "UPDATE strategy_versions SET status='RETIRED' WHERE status='ACTIVE' AND EXISTS (SELECT 1 FROM paper_accounts WHERE last_run_id=?)",
        )
        .bind(nonce),
      this.db
        .prepare(
          "UPDATE strategy_versions SET status='ACTIVE' WHERE id=? AND EXISTS (SELECT 1 FROM paper_accounts WHERE last_run_id=?)",
        )
        .bind(id, nonce),
    ]);
    return (await this.account()).book.activeStrategy === id;
  }
}
