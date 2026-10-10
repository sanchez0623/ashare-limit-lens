import { database } from "./database.js";
import { digestOf } from "../domain/research-lineage.js";

export const RESEARCH_NAMESPACE = "main";
export const HISTORY_STAGES = [
  "PLANNED",
  "PROBING",
  "DOWNLOADING",
  "NORMALIZING",
  "SCORING",
  "READY",
  "PARTIAL",
  "BLOCKED",
  "FAILED",
];
function historySqliteAdapter(sqlite) {
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
    exec: (sql) => sqlite.exec(sql),
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
    transactionQueue: Promise.resolve(),
    async transaction(fn) {
      const run = this.transactionQueue.then(async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn();
          sqlite.exec("COMMIT");
          return result;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      });
      this.transactionQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    close() {
      sqlite.close();
    },
  };
}
export class HistoryJobRepository {
  constructor(env) {
    this.db = database(env);
  }
  async createJob({ id, provider, kind, start, end, name }) {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO history_import_jobs (id, namespace, provider, kind, requested_start, requested_end, name, stage, progress, status_payload, dataset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNED', '{}', '{}', NULL, ?, ?)",
      )
      .bind(
        id,
        RESEARCH_NAMESPACE,
        provider,
        kind,
        start,
        end,
        name ?? null,
        now,
        now,
      )
      .run();
    return this.getJob(id);
  }
  async getJob(id) {
    const row = await this.db
      .prepare("SELECT * FROM history_import_jobs WHERE id = ?")
      .bind(id)
      .first();
    return row ? this.mapJob(row) : null;
  }
  mapJob(row) {
    return {
      id: row.id,
      namespace: row.namespace,
      provider: row.provider,
      kind: row.kind,
      requestedRange: { start: row.requested_start, end: row.requested_end },
      name: row.name,
      stage: row.stage,
      progress: JSON.parse(row.progress || "{}"),
      statusPayload: JSON.parse(row.status_payload || "{}"),
      datasetId: row.dataset_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  async listJobs(limit = 20) {
    const result = await this.db
      .prepare(
        "SELECT * FROM history_import_jobs ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .bind(limit)
      .all();
    return result.results.map((row) => this.mapJob(row));
  }
  async updateJob(id, { stage, progress, statusPayload, datasetId }) {
    const job = await this.getJob(id);
    if (!job) throw new Error("历史导入任务不存在");
    if (stage && !HISTORY_STAGES.includes(stage))
      throw new Error(`历史任务阶段无效：${stage}`);
    await this.db
      .prepare(
        "UPDATE history_import_jobs SET stage = ?, progress = ?, status_payload = ?, dataset_id = ?, updated_at = ? WHERE id = ?",
      )
      .bind(
        stage ?? job.stage,
        JSON.stringify(progress ?? job.progress),
        JSON.stringify({ ...job.statusPayload, ...(statusPayload ?? {}) }),
        datasetId ?? job.datasetId,
        new Date().toISOString(),
        id,
      )
      .run();
    return this.getJob(id);
  }
  async claimExecution(id, executorId, leaseMinutes = 30) {
    const now = new Date().toISOString();
    const fresh = await this.db
      .prepare(
        "UPDATE history_import_jobs SET stage = 'PROBING', progress = json_object('executorId', ?, 'claimedAt', ?), updated_at = ? WHERE id = ? AND stage IN ('PLANNED','PARTIAL','FAILED','BLOCKED')",
      )
      .bind(executorId, now, now, id)
      .run();
    if (fresh.meta.changes) return true;
    const cutoff = new Date(
      Date.now() - leaseMinutes * 60 * 1000,
    ).toISOString();
    const takeover = await this.db
      .prepare(
        "UPDATE history_import_jobs SET stage = 'PROBING', progress = json_object('executorId', ?, 'claimedAt', ?, 'tookOverAt', ?), updated_at = ? WHERE id = ? AND stage IN ('PROBING','DOWNLOADING','NORMALIZING','SCORING') AND json_extract(progress, '$.claimedAt') IS NOT NULL AND json_extract(progress, '$.claimedAt') <= ?",
      )
      .bind(executorId, now, now, now, id, cutoff)
      .run();
    return takeover.meta.changes > 0;
  }
  async finishJob(id, executorId, { stage, statusPayload, datasetId }) {
    if (!HISTORY_STAGES.includes(stage))
      throw new Error(`历史任务阶段无效：${stage}`);
    const job = await this.getJob(id);
    if (!job) throw new Error("历史导入任务不存在");
    const result = await this.db
      .prepare(
        "UPDATE history_import_jobs SET stage = ?, progress = ?, status_payload = ?, dataset_id = COALESCE(?, dataset_id), updated_at = ? WHERE id = ? AND json_extract(progress, '$.executorId') = ? AND stage IN ('PROBING','DOWNLOADING','NORMALIZING','SCORING')",
      )
      .bind(
        stage,
        JSON.stringify(job.progress),
        JSON.stringify({ ...job.statusPayload, ...(statusPayload ?? {}) }),
        datasetId ?? null,
        new Date().toISOString(),
        id,
        executorId,
      )
      .run();
    if (!result.meta.changes) return null;
    return this.getJob(id);
  }
  async progressJob(id, executorId, { stage, datasetId }) {
    const job = await this.getJob(id);
    if (!job) return null;
    if (stage && !HISTORY_STAGES.includes(stage))
      throw new Error(`历史任务阶段无效：${stage}`);
    const result = await this.db
      .prepare(
        "UPDATE history_import_jobs SET stage = ?, dataset_id = COALESCE(?, dataset_id), updated_at = ? WHERE id = ? AND json_extract(progress, '$.executorId') = ? AND stage IN ('PROBING','DOWNLOADING','NORMALIZING','SCORING')",
      )
      .bind(
        stage ?? job.stage,
        datasetId ?? null,
        new Date().toISOString(),
        id,
        executorId,
      )
      .run();
    if (!result.meta.changes) return null;
    return this.getJob(id);
  }
  async claimDataset(id, datasetId) {
    const result = await this.db
      .prepare(
        "UPDATE history_import_jobs SET dataset_id = ?, updated_at = ? WHERE id = ? AND dataset_id IS NULL",
      )
      .bind(datasetId, new Date().toISOString(), id)
      .run();
    return result.meta.changes > 0;
  }
  async stillOwner(id, executorId) {
    const row = await this.db
      .prepare(
        "SELECT 1 AS ok FROM history_import_jobs WHERE id = ? AND json_extract(progress, '$.executorId') = ? AND stage IN ('PROBING','DOWNLOADING','NORMALIZING','SCORING')",
      )
      .bind(id, executorId)
      .first();
    return Boolean(row);
  }
}
export class HistoryDatasetStore {
  constructor(path) {
    this.path = path;
    this.db = null;
    this.ready = false;
  }
  async ensure() {
    if (this.ready) return;
    const [{ DatabaseSync }, { mkdirSync }, { dirname }] = await Promise.all([
      import("node:sqlite"),
      import("node:fs"),
      import("node:path"),
    ]);
    mkdirSync(dirname(this.path), { recursive: true });
    const sqlite = new DatabaseSync(this.path);
    sqlite.exec("PRAGMA busy_timeout=5000;");
    this.db = historySqliteAdapter(sqlite);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_dataset_versions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        execution_model TEXT NOT NULL,
        requested_start TEXT NOT NULL,
        requested_end TEXT NOT NULL,
        observed_start TEXT,
        observed_end TEXT,
        coverage_payload TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history_daily_inputs (
        dataset_id TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL,
        PRIMARY KEY (dataset_id, trade_date)
      );
      CREATE TABLE IF NOT EXISTS history_scores (
        dataset_id TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        scoring_version TEXT NOT NULL,
        params_digest TEXT NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL,
        PRIMARY KEY (dataset_id, trade_date, scoring_version, params_digest)
      );
      CREATE TABLE IF NOT EXISTS history_reviews (
        dataset_id TEXT NOT NULL,
        signal_date TEXT NOT NULL,
        label_end_date TEXT NOT NULL,
        review_version TEXT NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL,
        PRIMARY KEY (dataset_id, signal_date, label_end_date, review_version)
      );
      CREATE TABLE IF NOT EXISTS history_chunks (
        job_id TEXT NOT NULL,
        chunk_key TEXT NOT NULL,
        dataset_id TEXT,
        request_range TEXT NOT NULL,
        actual_range TEXT,
        rows INTEGER NOT NULL,
        stage TEXT NOT NULL,
        raw_digest TEXT,
        artifact_ref TEXT,
        PRIMARY KEY (job_id, chunk_key)
      );
      CREATE TABLE IF NOT EXISTS history_minute_inputs (
        dataset_id TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL,
        PRIMARY KEY (dataset_id, trade_date, code)
      );
      CREATE TABLE IF NOT EXISTS history_observation_prices (
        dataset_id TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL,
        PRIMARY KEY (dataset_id, trade_date, code)
      );
      CREATE TABLE IF NOT EXISTS history_dataset_owners (
        dataset_id TEXT PRIMARY KEY,
        job_id TEXT,
        executor_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backtest_runs (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        name TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        strategy_params TEXT NOT NULL,
        params_digest TEXT NOT NULL,
        fee_config TEXT NOT NULL,
        fee_digest TEXT NOT NULL,
        execution_model TEXT NOT NULL,
        execution_version TEXT NOT NULL,
        initial_book TEXT NOT NULL,
        stage TEXT NOT NULL,
        coverage_payload TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backtest_plans (
        run_id TEXT NOT NULL,
        signal_date TEXT NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL,
        PRIMARY KEY (run_id, signal_date)
      );
      CREATE TABLE IF NOT EXISTS backtest_ledger (
        run_id TEXT NOT NULL,
        id TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (run_id, id)
      );
      CREATE TABLE IF NOT EXISTS backtest_equity (
        run_id TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL,
        PRIMARY KEY (run_id, trade_date)
      );
    `);
    const chunkColumns = (
      await this.db
        .prepare("SELECT name FROM pragma_table_info('history_chunks')")
        .all()
    ).results;
    if (!chunkColumns.some((column) => column.name === "dataset_id"))
      this.db.exec("ALTER TABLE history_chunks ADD COLUMN dataset_id TEXT;");
    this.rawDir = `${dirname(this.path)}/history-chunks`;
    mkdirSync(this.rawDir, { recursive: true });
    this.ready = true;
  }
  async acquireDatasetOwnership(datasetId, executorId, jobId = null) {
    await this.ensure();
    if (!datasetId) throw new Error("数据集所有权需要 datasetId");
    return this.db.transaction(async () => {
      const row = await this.db
        .prepare(
          "SELECT job_id, executor_id, generation FROM history_dataset_owners WHERE dataset_id = ?",
        )
        .bind(datasetId)
        .first();
      const now = new Date().toISOString();
      if (row && row.executor_id === executorId) {
        if (jobId)
          await this.db
            .prepare(
              "UPDATE history_dataset_owners SET job_id = ?, updated_at = ? WHERE dataset_id = ?",
            )
            .bind(jobId, now, datasetId)
            .run();
        return { datasetId, executorId, generation: Number(row.generation) };
      }
      const generation = row ? Number(row.generation) + 1 : 1;
      await this.db
        .prepare(
          "INSERT INTO history_dataset_owners (dataset_id, job_id, executor_id, generation, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (dataset_id) DO UPDATE SET job_id = excluded.job_id, executor_id = excluded.executor_id, generation = excluded.generation, updated_at = excluded.updated_at",
        )
        .bind(datasetId, jobId ?? null, executorId, generation, now)
        .run();
      return { datasetId, executorId, generation };
    });
  }
  async _applyGuarded(datasetId, owner, apply) {
    await this.ensure();
    return this.db.transaction(async () => {
      if (!datasetId) {
        if (owner) return { applied: false };
        apply();
        return { applied: true };
      }
      const row = await this.db
        .prepare(
          "SELECT executor_id, generation FROM history_dataset_owners WHERE dataset_id = ?",
        )
        .bind(datasetId)
        .first();
      if (row) {
        if (
          !owner ||
          row.executor_id !== owner.executorId ||
          Number(row.generation) !== Number(owner.generation)
        )
          return { applied: false };
      } else if (owner) {
        return { applied: false };
      }
      apply();
      return { applied: true };
    });
  }
  async createDatasetVersion({
    id,
    provider,
    kind,
    executionModel,
    requestedStart,
    requestedEnd,
    coverage,
  }) {
    await this.ensure();
    const manifest = await this.buildDatasetManifest(id, {
      executionModel: executionModel ?? null,
      coverage,
    });
    const digest = await digestOf(manifest);
    await this.db
      .prepare(
        "INSERT INTO history_dataset_versions (id, provider, kind, execution_model, requested_start, requested_end, observed_start, observed_end, coverage_payload, manifest_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        provider,
        kind,
        executionModel,
        requestedStart,
        requestedEnd,
        coverage.observedStart ?? null,
        coverage.observedEnd ?? null,
        JSON.stringify(coverage),
        digest,
        new Date().toISOString(),
      )
      .run();
    return { id, manifestDigest: digest };
  }
  async updateDatasetCoverage(id, coverage, owner = null) {
    await this.ensure();
    const manifest = await this.buildDatasetManifest(id, {
      executionModel: coverage.executionModel ?? null,
      coverage,
    });
    const digest = await digestOf(manifest);
    const result = await this._applyGuarded(id, owner, () => {
      this.db
        .prepare(
          "UPDATE history_dataset_versions SET coverage_payload = ?, manifest_digest = ?, observed_start = ?, observed_end = ?, execution_model = ? WHERE id = ?",
        )
        .bind(
          JSON.stringify(coverage),
          digest,
          coverage.observedStart ?? null,
          coverage.observedEnd ?? null,
          coverage.executionModel ?? "PENDING",
          id,
        )
        ._run();
    });
    return { applied: result.applied, manifest, manifestDigest: digest };
  }
  async saveChunk(
    jobId,
    {
      chunkKey,
      datasetId,
      requestRange,
      actualRange,
      rows,
      stage,
      rawDigest,
      raw,
      artifactRef,
    },
    owner = null,
  ) {
    await this.ensure();
    let storedRef = artifactRef ?? null;
    if (raw !== undefined && stage === "DONE") {
      const safeKey = chunkKey.replace(/[^a-zA-Z0-9_-]/g, "_");
      const suffix = owner ? `__g${owner.generation}` : "";
      const fileName = `${jobId}__${safeKey}${suffix}.json`;
      const artifactPath = `${this.rawDir}/${fileName}`;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(artifactPath, JSON.stringify(raw), "utf8");
      storedRef = `history-chunks/${fileName}`;
      rawDigest = await digestOf(raw);
    }
    const result = await this._applyGuarded(datasetId, owner, () => {
      this.db
        .prepare(
          "INSERT INTO history_chunks (job_id, chunk_key, dataset_id, request_range, actual_range, rows, stage, raw_digest, artifact_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (job_id, chunk_key) DO UPDATE SET stage = excluded.stage, actual_range = excluded.actual_range, rows = excluded.rows, dataset_id = excluded.dataset_id, raw_digest = excluded.raw_digest, artifact_ref = excluded.artifact_ref",
        )
        .bind(
          jobId,
          chunkKey,
          datasetId ?? null,
          requestRange,
          actualRange ?? null,
          rows ?? 0,
          stage,
          rawDigest ?? null,
          storedRef,
        )
        ._run();
    });
    return { applied: result.applied };
  }
  async completedChunkKeys(jobId) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT chunk_key FROM history_chunks WHERE job_id = ? AND stage IN ('DONE','EMPTY')",
      )
      .bind(jobId)
      .all();
    return new Set(result.results.map((row) => row.chunk_key));
  }
  async datasetChunkRefs(datasetId) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT job_id, chunk_key, raw_digest, artifact_ref FROM history_chunks WHERE dataset_id = ? AND stage = 'DONE' AND raw_digest IS NOT NULL ORDER BY chunk_key, job_id",
      )
      .bind(datasetId)
      .all();
    return result.results.map((row) => ({
      jobId: row.job_id,
      chunkKey: row.chunk_key,
      rawDigest: row.raw_digest,
      artifactRef: row.artifact_ref,
    }));
  }
  async datasetMinuteRefs(datasetId) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT trade_date, code, digest FROM history_minute_inputs WHERE dataset_id = ? ORDER BY trade_date, code",
      )
      .bind(datasetId)
      .all();
    return result.results.map((row) => ({
      tradeDate: row.trade_date,
      code: row.code,
      digest: row.digest,
    }));
  }
  async datasetObservationRefs(datasetId) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT trade_date, code, digest FROM history_observation_prices WHERE dataset_id = ? ORDER BY trade_date, code",
      )
      .bind(datasetId)
      .all();
    return result.results.map((row) => ({
      tradeDate: row.trade_date,
      code: row.code,
      digest: row.digest,
    }));
  }
  async datasetScoreRefs(datasetId) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT trade_date, scoring_version, params_digest, digest FROM history_scores WHERE dataset_id = ? ORDER BY trade_date, scoring_version",
      )
      .bind(datasetId)
      .all();
    return result.results.map((row) => ({
      tradeDate: row.trade_date,
      scoringVersion: row.scoring_version,
      paramsDigest: row.params_digest,
      digest: row.digest,
    }));
  }
  async buildDatasetManifest(datasetId, { executionModel, coverage }) {
    const inputs = await this.listDatasetDates(datasetId);
    const chunkRefs = await this.datasetChunkRefs(datasetId);
    const minuteRefs = await this.datasetMinuteRefs(datasetId);
    const observationRefs = await this.datasetObservationRefs(datasetId);
    const scoreRefs = await this.datasetScoreRefs(datasetId);
    return {
      executionModel: executionModel ?? null,
      coverage: coverage ?? null,
      chunkRefs,
      inputs,
      minuteRefs,
      observationRefs,
      scoreRefs,
    };
  }
  async datasetIntegrity(datasetId) {
    const dataset = await this.getDataset(datasetId);
    if (!dataset) return null;
    const manifest = await this.buildDatasetManifest(datasetId, {
      executionModel:
        dataset.executionModel === "PENDING" ? null : dataset.executionModel,
      coverage: dataset.coverage,
    });
    const recomputedDigest = await digestOf(manifest);
    const issues = [];
    if (recomputedDigest !== dataset.manifestDigest)
      issues.push(
        "数据集输入（日线/分钟/观察价格/评分）与发布时的 manifest 摘要不一致",
      );
    const contentTables = [
      {
        sql: "SELECT trade_date, payload, digest FROM history_daily_inputs WHERE dataset_id = ? ORDER BY trade_date",
        label: "日线输入",
        recompute: (payload) => digestOf(payload),
      },
      {
        sql: "SELECT trade_date, code, payload, digest FROM history_minute_inputs WHERE dataset_id = ? ORDER BY trade_date, code",
        label: "分钟采样",
        recompute: (payload) => digestOf(JSON.parse(payload)),
      },
      {
        sql: "SELECT trade_date, code, payload, digest FROM history_observation_prices WHERE dataset_id = ? ORDER BY trade_date, code",
        label: "观察日线",
        recompute: (payload) => digestOf(JSON.parse(payload)),
      },
      {
        sql: "SELECT trade_date, scoring_version, payload, digest FROM history_scores WHERE dataset_id = ? ORDER BY trade_date, scoring_version",
        label: "历史评分",
        recompute: (payload) => digestOf(JSON.parse(payload)),
      },
    ];
    for (const table of contentTables) {
      const rows = (await this.db.prepare(table.sql).bind(datasetId).all())
        .results;
      for (const row of rows) {
        let recomputed;
        try {
          recomputed = await table.recompute(row.payload);
        } catch {
          issues.push(`${table.label} ${row.trade_date} 的载荷不是合法 JSON`);
          continue;
        }
        if (recomputed !== row.digest)
          issues.push(
            `${table.label} ${row.trade_date}${row.code ? ` ${row.code}` : ""} 的内容摘要与存储摘要不一致（载荷被修改）`,
          );
      }
    }
    const { existsSync, readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    for (const ref of manifest.chunkRefs) {
      if (!ref.artifactRef) {
        issues.push(`下载块 ${ref.chunkKey} 缺少原始归档引用`);
        continue;
      }
      const artifactPath = join(dirname(this.path), ref.artifactRef);
      if (!existsSync(artifactPath)) {
        issues.push(
          `下载块 ${ref.chunkKey} 的原始归档文件缺失：${ref.artifactRef}`,
        );
        continue;
      }
      const archivedDigest = await digestOf(
        JSON.parse(readFileSync(artifactPath, "utf8")),
      );
      if (archivedDigest !== ref.rawDigest)
        issues.push(`下载块 ${ref.chunkKey} 的原始归档内容与摘要不一致`);
    }
    return {
      datasetId,
      verified: issues.length === 0,
      issues,
      manifestDigest: dataset.manifestDigest,
      recomputedDigest,
      manifest,
    };
  }
  async saveDailyInputs(
    datasetId,
    tradeDate,
    { normalized, provenance },
    owner = null,
  ) {
    await this.ensure();
    const payload = JSON.stringify({ normalized, provenance });
    const digest = await digestOf(payload);
    const result = await this._applyGuarded(datasetId, owner, () => {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO history_daily_inputs (dataset_id, trade_date, payload, digest) VALUES (?, ?, ?, ?)",
        )
        .bind(datasetId, tradeDate, payload, digest)
        ._run();
    });
    return { applied: result.applied };
  }
  async saveScore(
    datasetId,
    tradeDate,
    scoringVersion,
    paramsDigest,
    payload,
    owner = null,
  ) {
    await this.ensure();
    const payloadText = JSON.stringify(payload);
    const digest = await digestOf(payload);
    const result = await this._applyGuarded(datasetId, owner, () => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO history_scores (dataset_id, trade_date, scoring_version, params_digest, payload, digest) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          datasetId,
          tradeDate,
          scoringVersion,
          paramsDigest,
          payloadText,
          digest,
        )
        ._run();
    });
    return { applied: result.applied };
  }
  async saveReview(
    datasetId,
    signalDate,
    labelEndDate,
    reviewVersion,
    payload,
    owner = null,
  ) {
    await this.ensure();
    const payloadText = JSON.stringify(payload);
    const digest = await digestOf(payload);
    const result = await this._applyGuarded(datasetId, owner, () => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO history_reviews (dataset_id, signal_date, label_end_date, review_version, payload, digest) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          datasetId,
          signalDate,
          labelEndDate,
          reviewVersion,
          payloadText,
          digest,
        )
        ._run();
    });
    return { applied: result.applied };
  }
  async getDataset(id) {
    await this.ensure();
    const row = await this.db
      .prepare("SELECT * FROM history_dataset_versions WHERE id = ?")
      .bind(id)
      .first();
    if (!row) return null;
    return {
      id: row.id,
      provider: row.provider,
      kind: row.kind,
      executionModel: row.execution_model,
      requestedRange: { start: row.requested_start, end: row.requested_end },
      observedRange: { start: row.observed_start, end: row.observed_end },
      coverage: JSON.parse(row.coverage_payload),
      manifestDigest: row.manifest_digest,
      createdAt: row.created_at,
    };
  }
  async listDatasetDates(id) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT trade_date, digest FROM history_daily_inputs WHERE dataset_id = ? ORDER BY trade_date",
      )
      .bind(id)
      .all();
    return result.results.map((row) => ({
      tradeDate: row.trade_date,
      digest: row.digest,
    }));
  }
  async getDailyInput(datasetId, tradeDate) {
    await this.ensure();
    const row = await this.db
      .prepare(
        "SELECT payload FROM history_daily_inputs WHERE dataset_id = ? AND trade_date = ?",
      )
      .bind(datasetId, tradeDate)
      .first();
    return row ? JSON.parse(row.payload) : null;
  }
  async saveMinuteInputs(datasetId, tradeDate, code, payload, owner = null) {
    await this.ensure();
    const payloadText = JSON.stringify(payload);
    const digest = await digestOf(payload);
    const result = await this._applyGuarded(datasetId, owner, () => {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO history_minute_inputs (dataset_id, trade_date, code, payload, digest) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(datasetId, tradeDate, code, payloadText, digest)
        ._run();
    });
    return { applied: result.applied };
  }
  async listMinuteInputs(datasetId, tradeDate) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT code, payload FROM history_minute_inputs WHERE dataset_id = ? AND trade_date = ?",
      )
      .bind(datasetId, tradeDate)
      .all();
    return Object.fromEntries(
      result.results.map((row) => [row.code, JSON.parse(row.payload)]),
    );
  }
  async listMinuteDates(datasetId) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT DISTINCT trade_date FROM history_minute_inputs WHERE dataset_id = ? ORDER BY trade_date",
      )
      .bind(datasetId)
      .all();
    return result.results.map((row) => row.trade_date);
  }
  async saveObservationDaily(datasetId, tradeDate, byCode, owner = null) {
    await this.ensure();
    const entries =
      byCode instanceof Map
        ? [...byCode.entries()]
        : Object.entries(byCode ?? {});
    const prepared = [];
    for (const [code, row] of entries)
      prepared.push({
        code,
        payload: JSON.stringify(row),
        digest: await digestOf(row),
      });
    const result = await this._applyGuarded(datasetId, owner, () => {
      for (const item of prepared) {
        this.db
          .prepare(
            "INSERT OR REPLACE INTO history_observation_prices (dataset_id, trade_date, code, payload, digest) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(datasetId, tradeDate, item.code, item.payload, item.digest)
          ._run();
      }
    });
    return { applied: result.applied };
  }
  async getObservationDaily(datasetId, tradeDate) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT code, payload FROM history_observation_prices WHERE dataset_id = ? AND trade_date = ? ORDER BY code",
      )
      .bind(datasetId, tradeDate)
      .all();
    if (!result.results.length) return null;
    return Object.fromEntries(
      result.results.map((row) => [row.code, JSON.parse(row.payload)]),
    );
  }
  async cloneDatasetForMinutes(sourceId) {
    await this.ensure();
    const source = await this.getDataset(sourceId);
    if (!source) throw new Error(`要附加分钟数据的数据集不存在：${sourceId}`);
    const newId = `hds-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO history_dataset_versions (id, provider, kind, execution_model, requested_start, requested_end, observed_start, observed_end, coverage_payload, manifest_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        newId,
        source.provider,
        source.kind,
        source.executionModel,
        source.requestedRange.start,
        source.requestedRange.end,
        source.observedRange.start,
        source.observedRange.end,
        JSON.stringify(source.coverage),
        source.manifestDigest,
        now,
      )
      .run();
    await this.db
      .prepare(
        "INSERT INTO history_scores (dataset_id, trade_date, scoring_version, params_digest, payload, digest) SELECT ?, trade_date, scoring_version, params_digest, payload, digest FROM history_scores WHERE dataset_id = ?",
      )
      .bind(newId, sourceId)
      .run();
    await this.db
      .prepare(
        "INSERT INTO history_daily_inputs (dataset_id, trade_date, payload, digest) SELECT ?, trade_date, payload, digest FROM history_daily_inputs WHERE dataset_id = ?",
      )
      .bind(newId, sourceId)
      .run();
    await this.db
      .prepare(
        "INSERT INTO history_observation_prices (dataset_id, trade_date, code, payload, digest) SELECT ?, trade_date, code, payload, digest FROM history_observation_prices WHERE dataset_id = ?",
      )
      .bind(newId, sourceId)
      .run();
    await this.db
      .prepare(
        "INSERT INTO history_minute_inputs (dataset_id, trade_date, code, payload, digest) SELECT ?, trade_date, code, payload, digest FROM history_minute_inputs WHERE dataset_id = ?",
      )
      .bind(newId, sourceId)
      .run();
    return { id: newId, sourceCoverage: source.coverage };
  }
  async createBacktestRun({
    id,
    datasetId,
    name,
    strategyVersion,
    strategyParams,
    paramsDigest,
    feeConfig,
    feeDigest,
    executionModel,
    executionVersion,
    initialBook,
  }) {
    await this.ensure();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO backtest_runs (id, dataset_id, name, strategy_version, strategy_params, params_digest, fee_config, fee_digest, execution_model, execution_version, initial_book, stage, coverage_payload, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', '{}', ?, ?)",
      )
      .bind(
        id,
        datasetId,
        name,
        strategyVersion,
        JSON.stringify(strategyParams),
        paramsDigest,
        JSON.stringify(feeConfig),
        feeDigest,
        executionModel,
        executionVersion,
        JSON.stringify(initialBook),
        await digestOf({ initialBook, datasetId, strategyParams }),
        now,
      )
      .run();
    return this.getBacktestRun(id);
  }
  async saveBacktestPlan(runId, signalDate, payload) {
    await this.ensure();
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO backtest_plans (run_id, signal_date, payload, digest) VALUES (?, ?, ?, ?)",
      )
      .bind(runId, signalDate, JSON.stringify(payload), await digestOf(payload))
      .run();
  }
  async appendBacktestLedger(runId, tradeDate, rows) {
    await this.ensure();
    for (const row of rows)
      await this.db
        .prepare(
          "INSERT OR IGNORE INTO backtest_ledger (run_id, id, trade_date, payload) VALUES (?, ?, ?, ?)",
        )
        .bind(runId, row.id, tradeDate, JSON.stringify(row))
        .run();
  }
  async saveBacktestEquity(runId, tradeDate, payload) {
    await this.ensure();
    await this.db
      .prepare(
        "INSERT OR REPLACE INTO backtest_equity (run_id, trade_date, payload, digest) VALUES (?, ?, ?, ?)",
      )
      .bind(runId, tradeDate, JSON.stringify(payload), await digestOf(payload))
      .run();
  }
  async finishBacktestRun(id, stage, coverage) {
    await this.ensure();
    const digest = await digestOf(coverage);
    await this.db
      .prepare(
        "UPDATE backtest_runs SET stage = ?, coverage_payload = ?, digest = ? WHERE id = ?",
      )
      .bind(stage, JSON.stringify(coverage), digest, id)
      .run();
    return this.getBacktestRun(id);
  }
  async getBacktestRun(id) {
    await this.ensure();
    const row = await this.db
      .prepare("SELECT * FROM backtest_runs WHERE id = ?")
      .bind(id)
      .first();
    if (!row) return null;
    return {
      id: row.id,
      datasetId: row.dataset_id,
      name: row.name,
      strategyVersion: row.strategy_version,
      strategyParams: JSON.parse(row.strategy_params),
      paramsDigest: row.params_digest,
      feeConfig: JSON.parse(row.fee_config),
      feeDigest: row.fee_digest,
      executionModel: row.execution_model,
      executionVersion: row.execution_version,
      initialBook: JSON.parse(row.initial_book),
      stage: row.stage,
      coverage: JSON.parse(row.coverage_payload),
      digest: row.digest,
      createdAt: row.created_at,
    };
  }
  async listBacktestLedger(runId) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT id, trade_date, payload FROM backtest_ledger WHERE run_id = ? ORDER BY trade_date, id",
      )
      .bind(runId)
      .all();
    return result.results.map((row) => ({
      id: row.id,
      tradeDate: row.trade_date,
      ...JSON.parse(row.payload),
    }));
  }
  async listBacktestEquity(runId) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT trade_date, payload, digest FROM backtest_equity WHERE run_id = ? ORDER BY trade_date",
      )
      .bind(runId)
      .all();
    return result.results.map((row) => ({
      tradeDate: row.trade_date,
      ...JSON.parse(row.payload),
      digest: row.digest,
    }));
  }
  async listBacktestRuns(limit = 20) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT id, dataset_id, name, stage, execution_model, coverage_payload, created_at FROM backtest_runs ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .bind(limit)
      .all();
    return result.results.map((row) => ({
      id: row.id,
      datasetId: row.dataset_id,
      name: row.name,
      stage: row.stage,
      executionModel: row.execution_model,
      coverage: JSON.parse(row.coverage_payload),
      createdAt: row.created_at,
    }));
  }
  async listBacktestPlans(runId) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT signal_date, payload, digest FROM backtest_plans WHERE run_id = ? ORDER BY signal_date",
      )
      .bind(runId)
      .all();
    return result.results.map((row) => ({
      signalDate: row.signal_date,
      ...JSON.parse(row.payload),
      digest: row.digest,
    }));
  }
  async listScores(datasetId) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT trade_date, scoring_version, params_digest, payload, digest FROM history_scores WHERE dataset_id = ? ORDER BY trade_date",
      )
      .bind(datasetId)
      .all();
    return result.results.map((row) => ({
      tradeDate: row.trade_date,
      scoringVersion: row.scoring_version,
      paramsDigest: row.params_digest,
      payload: JSON.parse(row.payload),
      digest: row.digest,
    }));
  }
  async listReviews(datasetId) {
    await this.ensure();
    const result = await this.db
      .prepare(
        "SELECT signal_date, label_end_date, review_version, payload, digest FROM history_reviews WHERE dataset_id = ? ORDER BY signal_date",
      )
      .bind(datasetId)
      .all();
    return result.results.map((row) => ({
      signalDate: row.signal_date,
      labelEndDate: row.label_end_date,
      reviewVersion: row.review_version,
      payload: JSON.parse(row.payload),
      digest: row.digest,
    }));
  }
  close() {
    if (this.db) this.db.close();
  }
}
export function openHistoryStore(env) {
  const path = env?.LOCAL_RESEARCH_DB_PATH;
  if (!path) return null;
  return new HistoryDatasetStore(path);
}
export function historyJobDatabase(env) {
  return database(env);
}
