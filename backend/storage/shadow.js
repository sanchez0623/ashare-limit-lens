import { database } from "./database.js";
import { digest } from "./paper.js";
import { frozenSelectionPolicy } from "../domain/signal-selection.js";

// 影子账户体系（§6/§7）：多账户隔离的 CAS 提交、计划、成交、净值与消费游标。
// 物理存储键采用 (account_id, localId)/(account_id, trade_date) 组合键；
// 保留引擎产生的局部成交 ID，不同账户允许同日同局部成交 ID。
// 每个账户按序消费行情帧：CAS 同时推进 revision 与 (cursor_date, cursor_sequence)，
// 重复或回退的帧在 SQL 层幂等跳过；一账户的失败不阻塞其他账户。

export const SHADOW_ACCOUNT_KINDS = Object.freeze({
  CANDIDATE: "CANDIDATE",
  PARENT_MATCH: "PARENT_MATCH",
  BASELINE_MATCH: "BASELINE_MATCH",
  BASELINE_CONTINUOUS: "BASELINE_CONTINUOUS",
});

export class ShadowAccountRepository {
  constructor(env) {
    this.db = database(env);
  }
  async ensureAccount(
    accountId,
    { kind, cohortId = null, memberId = null, book },
  ) {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO shadow_accounts (account_id, kind, cohort_id, member_id, status, revision, state, cursor_date, cursor_sequence, last_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', 0, ?, NULL, 0, NULL, ?, ?) ON CONFLICT (account_id) DO NOTHING",
      )
      .bind(accountId, kind, cohortId, memberId, JSON.stringify(book), now, now)
      .run();
    return this.account(accountId);
  }
  async account(accountId) {
    const row = await this.db
      .prepare("SELECT * FROM shadow_accounts WHERE account_id = ?")
      .bind(accountId)
      .first();
    if (!row) return null;
    return {
      accountId: row.account_id,
      kind: row.kind,
      cohortId: row.cohort_id,
      memberId: row.member_id,
      status: row.status,
      revision: row.revision,
      book: JSON.parse(row.state),
      cursorDate: row.cursor_date,
      cursorSequence: row.cursor_sequence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  async accounts({ cohortId = null, kinds = null } = {}) {
    const rows = (
      await this.db
        .prepare("SELECT account_id FROM shadow_accounts ORDER BY account_id")
        .all()
    ).results;
    const accounts = [];
    for (const row of rows) {
      const account = await this.account(row.account_id);
      if (cohortId && account.cohortId !== cohortId) continue;
      if (kinds && !kinds.includes(account.kind)) continue;
      accounts.push(account);
    }
    return accounts;
  }
  async setStatus(accountId, status) {
    await this.db
      .prepare(
        "UPDATE shadow_accounts SET status = ?, updated_at = ? WHERE account_id = ?",
      )
      .bind(status, new Date().toISOString(), accountId)
      .run();
  }
  async plan(accountId, signalDate) {
    const row = await this.db
      .prepare(
        "SELECT payload, digest FROM shadow_plans WHERE account_id = ? AND signal_date = ?",
      )
      .bind(accountId, signalDate)
      .first();
    return row ? { ...JSON.parse(row.payload), digest: row.digest } : null;
  }
  async latestPlan(accountId) {
    const row = await this.db
      .prepare(
        "SELECT payload, digest FROM shadow_plans WHERE account_id = ? ORDER BY signal_date DESC LIMIT 1",
      )
      .bind(accountId)
      .first();
    return row ? { ...JSON.parse(row.payload), digest: row.digest } : null;
  }
  async savePlan(accountId, plan) {
    frozenSelectionPolicy(plan);
    const digestValue = await digest(plan);
    const existing = await this.plan(accountId, plan.signalDate);
    if (existing) {
      if (existing.digest !== digestValue)
        throw new Error("影子账户计划已冻结，不允许覆盖");
      return existing;
    }
    await this.db
      .prepare(
        "INSERT INTO shadow_plans (account_id, signal_date, payload, digest, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        accountId,
        plan.signalDate,
        JSON.stringify(plan),
        digestValue,
        new Date().toISOString(),
      )
      .run();
    return { ...plan, digest: digestValue };
  }
  async session(accountId, tradeDate) {
    const row = await this.db
      .prepare(
        "SELECT payload, digest FROM shadow_sessions WHERE account_id = ? AND trade_date = ?",
      )
      .bind(accountId, tradeDate)
      .first();
    return row ? JSON.parse(row.payload) : null;
  }
  async ledger(accountId, limit = 100000) {
    const rows = (
      await this.db
        .prepare(
          "SELECT payload FROM shadow_ledger WHERE account_id = ? ORDER BY trade_date, id LIMIT ?",
        )
        .bind(accountId, limit)
        .all()
    ).results;
    return rows.map((row) => JSON.parse(row.payload));
  }
  async equities(accountId) {
    const rows = (
      await this.db
        .prepare(
          "SELECT trade_date, payload, digest FROM shadow_equity WHERE account_id = ? ORDER BY trade_date",
        )
        .bind(accountId)
        .all()
    ).results;
    return rows.map((row) => ({
      ...JSON.parse(row.payload),
      tradeDate: row.trade_date,
      digest: row.digest,
    }));
  }
  hasConsumed(account, tradeDate, sequence) {
    if (!account.cursorDate) return false;
    if (account.cursorDate > tradeDate) return true;
    return (
      account.cursorDate === tradeDate && account.cursorSequence >= sequence
    );
  }
  // CAS 消费一帧：账本状态、会话、成交与消费游标通过一次原子提交完成。
  // 预期游标必须严格前进，重复消费在 SQL 层返回 applied:false。
  async commitFrame({
    accountId,
    expectedRevision,
    runId,
    tradeDate,
    sequence,
    book,
    session,
    observation,
    ledger,
  }) {
    const now = new Date().toISOString();
    const guardArgs = [accountId, expectedRevision + 1, runId];
    const guarded = (sql, args) =>
      this.db
        .prepare(
          `${sql} WHERE EXISTS (SELECT 1 FROM shadow_accounts WHERE account_id = ? AND revision = ? AND last_run_id = ?)`,
        )
        .bind(...args, ...guardArgs);
    const statements = [
      this.db
        .prepare(
          "UPDATE shadow_accounts SET state = ?, revision = revision + 1, cursor_date = ?, cursor_sequence = ?, last_run_id = ?, updated_at = ? WHERE account_id = ? AND revision = ? AND (cursor_date IS NULL OR cursor_date < ? OR (cursor_date = ? AND cursor_sequence < ?))",
        )
        .bind(
          JSON.stringify(book),
          tradeDate,
          sequence,
          runId,
          now,
          accountId,
          expectedRevision,
          tradeDate,
          tradeDate,
          sequence,
        ),
      guarded(
        "INSERT OR REPLACE INTO shadow_sessions (account_id, trade_date, payload, digest) SELECT ?, ?, ?, ?",
        [accountId, tradeDate, JSON.stringify(session), await digest(session)],
      ),
      ...ledger.map((fill) =>
        guarded(
          "INSERT INTO shadow_ledger (account_id, id, trade_date, payload) SELECT ?, ?, ?, ?",
          [accountId, fill.id, tradeDate, JSON.stringify(fill)],
        ),
      ),
    ];
    const results = await this.db.batch(statements);
    return { applied: results[0].meta.changes === 1 };
  }
  // 盘后结算：账户 CAS + 净值行 + 已收盘会话；成交已在消费帧时落账，不重复写。
  async commitSettlement({
    accountId,
    expectedRevision,
    runId,
    tradeDate,
    book,
    equity,
    session,
  }) {
    const now = new Date().toISOString();
    const guardArgs = [accountId, expectedRevision + 1, runId];
    const guarded = (sql, args) =>
      this.db
        .prepare(
          `${sql} WHERE EXISTS (SELECT 1 FROM shadow_accounts WHERE account_id = ? AND revision = ? AND last_run_id = ?)`,
        )
        .bind(...args, ...guardArgs);
    const statements = [
      this.db
        .prepare(
          "UPDATE shadow_accounts SET state = ?, revision = revision + 1, last_run_id = ?, updated_at = ? WHERE account_id = ? AND revision = ?",
        )
        .bind(JSON.stringify(book), runId, now, accountId, expectedRevision),
      guarded(
        "INSERT INTO shadow_equity (account_id, trade_date, payload, digest) SELECT ?, ?, ?, ?",
        [accountId, tradeDate, JSON.stringify(equity), await digest(equity)],
      ),
      guarded(
        "INSERT OR REPLACE INTO shadow_sessions (account_id, trade_date, payload, digest) SELECT ?, ?, ?, ?",
        [accountId, tradeDate, JSON.stringify(session), await digest(session)],
      ),
    ];
    const results = await this.db.batch(statements);
    return { applied: results[0].meta.changes === 1 };
  }
}
