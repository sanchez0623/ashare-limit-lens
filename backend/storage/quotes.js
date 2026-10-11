import { database } from "./database.js";
import { digestOf } from "../domain/research-lineage.js";

// 联合行情帧存储（§7.1）：规范化行情先持久化为不可变帧，再被组合消费。
// 帧标识使用 tradeDate/sequence，引用实际采集时间、股票池 manifest 与批次采集状态。
export class QuoteFrameRepository {
  constructor(env) {
    this.db = database(env);
  }
  async appendFrame({
    tradeDate,
    observedAt,
    quotes,
    pollIntervalSeconds,
    pool,
    capture,
  }) {
    const poolManifest = {
      codes: [...pool.codes].sort(),
      sources: pool.sources ?? {},
      declaredAt: pool.declaredAt ?? null,
    };
    const poolDigest = await digestOf(poolManifest);
    const payload = {
      observedAt,
      quotes,
      pollIntervalSeconds,
      poolDigest,
      pool: poolManifest,
      capture: capture ?? null,
    };
    const digest = await digestOf(payload);
    const createdAt = new Date().toISOString();
    return this.db.transaction(async () => {
      const row = await this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS seq FROM quote_frames WHERE trade_date = ?",
        )
        .bind(tradeDate)
        .first();
      const sequence = Number(row?.seq ?? 0) + 1;
      await this.db
        .prepare(
          "INSERT INTO quote_frames (trade_date, sequence, observed_at, pool_digest, payload, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          tradeDate,
          sequence,
          observedAt,
          poolDigest,
          JSON.stringify(payload),
          digest,
          createdAt,
        )
        .run();
      return { tradeDate, sequence, digest, poolDigest, observedAt };
    });
  }
  async loadFrame(tradeDate, sequence) {
    const row = await this.db
      .prepare(
        "SELECT * FROM quote_frames WHERE trade_date = ? AND sequence = ?",
      )
      .bind(tradeDate, sequence)
      .first();
    return row ? this.mapFrame(row) : null;
  }
  async latestFrame(tradeDate) {
    const row = await this.db
      .prepare(
        "SELECT * FROM quote_frames WHERE trade_date = ? ORDER BY sequence DESC LIMIT 1",
      )
      .bind(tradeDate)
      .first();
    return row ? this.mapFrame(row) : null;
  }
  async framesForDate(tradeDate) {
    const rows = (
      await this.db
        .prepare(
          "SELECT * FROM quote_frames WHERE trade_date = ? ORDER BY sequence",
        )
        .bind(tradeDate)
        .all()
    ).results;
    return rows.map((row) => this.mapFrame(row));
  }
  // 从指定日期起（含）的全部已落盘帧，按 trade_date, sequence 排序：
  // 用于账户按序重放，覆盖重启恢复与跨日未消费缺口。
  async framesSince(fromDate) {
    const rows = (
      await this.db
        .prepare(
          "SELECT * FROM quote_frames WHERE trade_date >= ? ORDER BY trade_date, sequence",
        )
        .bind(fromDate)
        .all()
    ).results;
    return rows.map((row) => this.mapFrame(row));
  }
  mapFrame(row) {
    return {
      tradeDate: row.trade_date,
      sequence: row.sequence,
      observedAt: row.observed_at,
      poolDigest: row.pool_digest,
      digest: row.digest,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at,
    };
  }
}
