import { database } from "./database.js";
import {
  BASE_STRATEGY,
  newBook,
  createPlan,
  defensivePlan,
} from "../domain/trading.js";
import { normalizeFees, feesForBook } from "../../shared/fees.js";

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
        "paper_configuration_history",
        "paper_plan_revisions",
      ].includes(table)
    )
      throw new Error("无效存储类别");
    const column =
      table === "paper_plans"
        ? "signal_date"
        : ["paper_configuration_history", "paper_plan_revisions"].includes(
              table,
            )
          ? "created_at"
          : "trade_date";
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
    if (result.session)
      statements.push(
        this.db
          .prepare(
            `INSERT INTO paper_live_sessions (trade_date,payload,digest) SELECT ?,?,? ${guard} ON CONFLICT(trade_date) DO UPDATE SET payload=excluded.payload,digest=excluded.digest`,
          )
          .bind(
            dataset.date,
            JSON.stringify(result.session),
            await digest(result.session),
            "primary",
            nextRevision,
            runId,
          ),
      );
    await this.db.batch(statements);
    const row = await this.db
      .prepare("SELECT last_run_id FROM paper_accounts WHERE id=?")
      .bind("primary")
      .first();
    return row.last_run_id === runId;
  }
  async canEditCapital(book) {
    const live = await this.db
      .prepare("SELECT COUNT(*) AS count FROM paper_live_sessions")
      .first();
    if (live.count) return false;
    if (
      book.settlementCount > 1 ||
      book.positions.length ||
      book.feesCents ||
      book.realizedPnlCents
    )
      return false;
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM paper_ledger")
      .first();
    return row.count === 0;
  }
  async configure(settings, now = new Date()) {
    const account = await this.initialize();
    const book = structuredClone(account.book);
    const feeConfig =
      settings.fees === undefined
        ? feesForBook(book)
        : normalizeFees(settings.fees);
    const feesChanged =
      settings.fees !== undefined &&
      (book.feeModel !== "itemized-v2" ||
        JSON.stringify(normalizeFees(feesForBook(book))) !==
          JSON.stringify(feeConfig));
    const initial =
      settings.initialCapital === undefined
        ? book.initialCashCents
        : newBook(settings.initialCapital, feeConfig).initialCashCents;
    const capitalChanged = initial !== book.initialCashCents;
    if (capitalChanged) {
      if (!(await this.canEditCapital(book)))
        throw new Error("交易计划开始执行后初始资金被冻结，不能改写收益基准");
      book.initialCashCents = initial;
      book.cashCents = initial;
      book.equityCents = initial;
      book.peakEquityCents = initial;
    }
    if (feesChanged) {
      book.feeConfig = feeConfig;
      book.feeModel = "itemized-v2";
      book.feeConfigVersion = (book.feeConfigVersion || 0) + 1;
    }
    if (settings.improvementMode !== undefined) {
      if (!["auto", "manual"].includes(settings.improvementMode))
        throw new Error("改进模式无效");
      book.improvementMode = settings.improvementMode;
    }
    const stamp = now.toISOString(),
      nonce = crypto.randomUUID();
    const statements = [
      this.db
        .prepare(
          "UPDATE paper_accounts SET state=?, revision=revision+1, last_run_id=?, updated_at=? WHERE id=? AND revision=?",
        )
        .bind(JSON.stringify(book), nonce, stamp, "primary", account.revision),
    ];
    const guard =
      "EXISTS (SELECT 1 FROM paper_accounts WHERE id=? AND revision=? AND last_run_id=?)";
    const guardArgs = ["primary", account.revision + 1, nonce];
    const baselines = capitalChanged
      ? await this.history("paper_equity", 10)
      : [];
    for (const row of baselines) {
      const previous = JSON.parse(row.payload);
      if (
        previous.feesCents ||
        previous.marketValueCents ||
        previous.equityCents !== account.book.initialCashCents
      )
        throw new Error("已有账户收益记录，不能修改初始资金");
      const equity = { ...previous, cashCents: initial, equityCents: initial };
      statements.push(
        this.db
          .prepare(
            `UPDATE paper_equity SET payload=? WHERE trade_date=? AND ${guard}`,
          )
          .bind(JSON.stringify(equity), row.trade_date, ...guardArgs),
      );
    }
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
    let replacement = null;
    // Only revise a plan on its signal day after close; never alter an executable intraday plan.
    if (
      (capitalChanged || feesChanged) &&
      book.lastDate === day &&
      time >= "15:05"
    ) {
      const previousPlan = await this.db
        .prepare("SELECT payload,digest FROM paper_plans WHERE signal_date=?")
        .bind(day)
        .first();
      const snapshot = await this.snapshot(day),
        strategy = await this.strategy(book);
      replacement = snapshot
        ? createPlan(snapshot, book, strategy, book.activeStrategy, stamp)
        : defensivePlan(day, book, strategy, book.activeStrategy, stamp);
      if (previousPlan)
        statements.push(
          this.db
            .prepare(
              `INSERT INTO paper_plan_revisions (id,signal_date,created_at,payload,digest) SELECT ?,?,?,?,? WHERE ${guard}`,
            )
            .bind(
              nonce,
              day,
              stamp,
              previousPlan.payload,
              previousPlan.digest,
              ...guardArgs,
            ),
        );
      statements.push(
        this.db
          .prepare(`DELETE FROM paper_plans WHERE signal_date=? AND ${guard}`)
          .bind(day, ...guardArgs),
      );
      statements.push(
        this.db
          .prepare(
            `INSERT INTO paper_plans (signal_date,created_at,payload,digest) SELECT ?,?,?,? WHERE ${guard}`,
          )
          .bind(
            day,
            stamp,
            JSON.stringify(replacement),
            await digest(replacement),
            ...guardArgs,
          ),
      );
    }
    const change = {
      id: nonce,
      createdAt: stamp,
      capitalChanged,
      feesChanged,
      before: {
        initialCashCents: account.book.initialCashCents,
        fees: feesForBook(account.book),
        feeConfigVersion: account.book.feeConfigVersion || 0,
        improvementMode: account.book.improvementMode,
      },
      after: {
        initialCashCents: book.initialCashCents,
        fees: feesForBook(book),
        feeConfigVersion: book.feeConfigVersion || 0,
        improvementMode: book.improvementMode,
      },
      previousBaselines: baselines.map((row) => JSON.parse(row.payload)),
      revisedPlanDate: replacement?.signalDate || null,
      effective: replacement
        ? "当日尚未执行的计划已重新冻结；原计划留档"
        : "新费用适用于后续新计划，已有计划保持原配置",
    };
    statements.push(
      this.db
        .prepare(
          `INSERT INTO paper_configuration_history (id,created_at,payload,digest) SELECT ?,?,?,? WHERE ${guard}`,
        )
        .bind(
          nonce,
          stamp,
          JSON.stringify(change),
          await digest(change),
          ...guardArgs,
        ),
    );
    const results = await this.db.batch(statements);
    if ((results[0].meta?.changes ?? results[0].changes) !== 1)
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
      .prepare("SELECT status,evidence FROM strategy_versions WHERE id=?")
      .bind(id)
      .first();
    if (!row || row.status !== "VALIDATED")
      throw new Error("只允许启用通过样本外验证的新策略");
    const { book, revision } = await this.account();
    const evidence = JSON.parse(row.evidence);
    if (
      (evidence.feeConfigVersion !== undefined &&
        evidence.feeConfigVersion !== (book.feeConfigVersion || 0)) ||
      (evidence.initialCashCents !== undefined &&
        evidence.initialCashCents !== book.initialCashCents)
    )
      throw new Error("验证所用费用或资金已变更，请等待新配置下的独立验证");
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
