import { PaperRepository, digest } from "./paper.js";

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
  async commitObservation(expectedRevision, result, observation) {
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
    const results = await this.db.batch(statements);
    return results[0].meta.changes === 1;
  }
  async close(expectedRevision, result, dataset) {
    // The account CAS guards the already-recorded fills; settlement writes no duplicate fills.
    return this.settle(expectedRevision, result, dataset);
  }
}
