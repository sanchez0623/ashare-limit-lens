import { PaperRepository, digest } from "./paper.js";
import { environmentStatements } from "./market-environment.js";

export class RealtimeRepository extends PaperRepository {
  async session(date) {
    const row = await this.db
      .prepare("SELECT payload FROM paper_live_sessions WHERE trade_date=?")
      .bind(date)
      .first();
    return row ? JSON.parse(row.payload) : null;
  }
  async sessions() {
    const rows = await this.db
      .prepare(
        "SELECT payload,digest FROM paper_live_sessions ORDER BY trade_date",
      )
      .all();
    return rows.results.map((row) => ({
      payload: JSON.parse(row.payload),
      digest: row.digest,
    }));
  }
  // 晚于某结算日的最新实时会话：存在即说明账本正被该交易时段盯市，
  // 但该日尚未盘后结算（结算与会话同日，正常至多一个）。
  async latestSessionAfter(date) {
    const row = await this.db
      .prepare(
        "SELECT payload FROM paper_live_sessions WHERE trade_date>? ORDER BY trade_date DESC LIMIT 1",
      )
      .bind(date)
      .first();
    return row ? JSON.parse(row.payload) : null;
  }
  async observations(date) {
    const rows = await this.db
      .prepare(
        "SELECT payload,digest FROM paper_live_ticks WHERE trade_date=? ORDER BY sequence",
      )
      .bind(date)
      .all();
    return rows.results.map((row) => ({
      payload: JSON.parse(row.payload),
      digest: row.digest,
    }));
  }
  async health() {
    const row = await this.db
      .prepare("SELECT payload FROM paper_executor_health WHERE id='primary'")
      .first();
    return row ? JSON.parse(row.payload) : null;
  }
  async heartbeat(payload) {
    await this.db
      .prepare(
        "INSERT INTO paper_executor_health (id,payload) VALUES ('primary',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .bind(JSON.stringify(payload))
      .run();
  }
  // 运维事件（operationEvents）与账户状态在同一 batch（原子事务）里提交：
  // 账户提交成功而事件写入失败、或进程在两步之间突然终止（SIGKILL/断电），
  // 都会把回撤、保护退出阻塞这类一次性风险事实永久丢掉。同事务写入保证
  // "已提交的账户风险"必然有对应事件，事件写入失败时账户提交一并回滚，
  // 下一轮按帧重新观察并再次产出事实。
  async commitObservation(
    expectedRevision,
    result,
    observation,
    operationEvents = [],
  ) {
    const runId = crypto.randomUUID(),
      stamp = observation.observedAt;
    const guard =
      "WHERE EXISTS (SELECT 1 FROM paper_accounts WHERE id='primary' AND revision=? AND last_run_id=?)";
    const guarded = (sql, args) =>
      this.db
        .prepare(`${sql} ${guard}`)
        .bind(...args, expectedRevision + 1, runId);
    const statements = [
      this.db
        .prepare(
          "UPDATE paper_accounts SET state=?, revision=revision+1, last_run_id=?, updated_at=? WHERE id='primary' AND revision=?",
        )
        .bind(JSON.stringify(result.book), runId, stamp, expectedRevision),
      this.db
        .prepare(
          `INSERT INTO paper_live_sessions (trade_date,payload,digest) SELECT ?,?,? ${guard} ON CONFLICT(trade_date) DO UPDATE SET payload=excluded.payload,digest=excluded.digest`,
        )
        .bind(
          result.session.date,
          JSON.stringify(result.session),
          await digest(result.session),
          expectedRevision + 1,
          runId,
        ),
    ];
    statements.push(
      guarded(
        "INSERT INTO paper_live_ticks (trade_date,sequence,payload,digest) SELECT ?,?,?,?",
        [
          result.session.date,
          result.session.sequence,
          JSON.stringify(observation),
          await digest(observation),
        ],
      ),
    );
    for (const row of result.ledger)
      statements.push(
        guarded(
          "INSERT INTO paper_ledger (id,trade_date,payload) SELECT ?,?,?",
          [row.id, row.date, JSON.stringify(row)],
        ),
      );
    // 事件 INSERT 必须同样走账户 CAS 守卫：两个重叠的执行器会读到同一
    // revision 并各自产出事件，输家的 UPDATE 已输（changes=0），它携带的
    // 是"从未成为权威状态"的事实（observedAt 各不相同 → 事件 ID 不同，
    // INSERT OR IGNORE 挡不住）。无守卫时输家事件照常落库，制造幻影
    // 风险事实与重复通知。守卫失败只插入 0 行——事件与账户提交同生共死。
    for (const event of operationEvents)
      statements.push(
        guarded(
          "INSERT OR IGNORE INTO operation_events (id, instance_id, account_id, trade_date, source_sequence, type, rule_type, reason_code, occurred_at, entity_ref, payload, ingest_seq) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(ingest_seq), 0) + 1 FROM operation_events)",
          [
            event.id,
            event.instanceId,
            event.accountId,
            event.tradeDate ?? null,
            event.sourceSequence ?? null,
            event.type,
            event.ruleType ?? null,
            event.reasonCode ?? null,
            event.occurredAt,
            event.entityRef ?? null,
            JSON.stringify(event.payload ?? {}),
          ],
        ),
      );
    statements.push(
      ...(await environmentStatements(
        this.db,
        result,
        observation,
        "primary",
        guarded,
      )),
    );
    const results = await this.db.batch(statements);
    return results[0].meta.changes === 1;
  }
  async close(expectedRevision, result, dataset) {
    // The account CAS guards the already-recorded fills; settlement writes no duplicate fills.
    return this.settle(expectedRevision, result, dataset);
  }
}
