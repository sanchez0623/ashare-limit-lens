import { database } from "./database.js";
import { digestOf } from "../domain/research-lineage.js";
import {
  DATA_SCOPES,
  METADATA_KINDS,
  DataUpdateError,
  DataUpdateCancelled,
  validateMetadataRecords,
} from "../domain/stock-metadata.js";

const snapshotCaches = new WeakMap();
const iso = () => new Date().toISOString();
const mapJob = (row) =>
  row && {
    id: row.id,
    scope: row.scope,
    status: row.status,
    stage: row.stage,
    progress: JSON.parse(row.progress),
    results: JSON.parse(row.results),
    error: row.error,
    cancelRequested: !!row.cancel_requested,
    workerId: row.worker_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };

export class StockMetadataRepository {
  constructor(env) {
    this.db = database(env);
  }
  async job(id) {
    return mapJob(
      await this.db
        .prepare("SELECT * FROM data_update_jobs WHERE id=?")
        .bind(id)
        .first(),
    );
  }
  async activeJob() {
    return mapJob(
      await this.db
        .prepare(
          "SELECT * FROM data_update_jobs WHERE status IN ('QUEUED','RUNNING') LIMIT 1",
        )
        .first(),
    );
  }
  async jobs() {
    return (
      await this.db
        .prepare(
          "SELECT * FROM data_update_jobs ORDER BY created_at DESC,id DESC LIMIT 20",
        )
        .all()
    ).results.map(mapJob);
  }
  async createJob(scope) {
    if (!DATA_SCOPES.includes(scope))
      throw new DataUpdateError(
        "更新范围必须为 stock_list、stock_em、industry_sw 或 all",
      );
    const now = iso(),
      id = `data-${crypto.randomUUID()}`;
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO data_update_jobs(id,scope,status,created_at,updated_at) VALUES (?,?,'QUEUED',?,?)",
      )
      .bind(id, scope, now, now)
      .run();
    const created = await this.job(id);
    if (created) return { job: created, reused: false };
    const job = await this.activeJob();
    if (!job) throw new DataUpdateError("更新任务未能创建，请重试", 503);
    if (job.scope !== scope)
      throw new DataUpdateError("另一个更新任务正在运行", 409, {
        activeJob: job,
      });
    return { job, reused: job.id !== id };
  }
  async cancel(id) {
    if (!(await this.job(id))) throw new DataUpdateError("更新任务不存在", 404);
    const now = iso();
    await this.db
      .prepare(
        "UPDATE data_update_jobs SET cancel_requested=1, status=CASE WHEN status='QUEUED' THEN 'CANCELLED' ELSE status END, stage=CASE WHEN status='QUEUED' THEN '已取消' ELSE stage END, finished_at=CASE WHEN status='QUEUED' THEN ? ELSE finished_at END, updated_at=? WHERE id=? AND status IN ('QUEUED','RUNNING')",
      )
      .bind(now, now, id)
      .run();
    return this.job(id);
  }
  async worker() {
    return this.db
      .prepare(
        "SELECT owner,heartbeat_at FROM data_update_worker WHERE singleton=1",
      )
      .first();
  }
  async claimWorker(owner, now = iso()) {
    const cutoff = new Date(Date.parse(now) - 30000).toISOString();
    return !!(
      await this.db
        .prepare(
          "UPDATE data_update_worker SET owner=?,heartbeat_at=? WHERE singleton=1 AND (owner IS NULL OR heartbeat_at<? OR owner=?)",
        )
        .bind(owner, now, cutoff, owner)
        .run()
    ).meta.changes;
  }
  async heartbeat(owner) {
    return !!(
      await this.db
        .prepare(
          "UPDATE data_update_worker SET heartbeat_at=? WHERE singleton=1 AND owner=?",
        )
        .bind(iso(), owner)
        .run()
    ).meta.changes;
  }
  async releaseWorker(owner) {
    await this.db
      .prepare(
        "UPDATE data_update_worker SET owner=NULL WHERE singleton=1 AND owner=?",
      )
      .bind(owner)
      .run();
  }
  async recoverInterrupted(owner) {
    const now = iso();
    await this.db
      .prepare(
        "UPDATE data_update_jobs SET status='FAILED',stage='执行中断，可重试',error='更新执行器中断；已发布的结果保留，未完成的数据未发布',finished_at=?,updated_at=? WHERE status='RUNNING' AND worker_id<>? AND EXISTS(SELECT 1 FROM data_update_worker WHERE singleton=1 AND owner=?)",
      )
      .bind(now, now, owner, owner)
      .run();
    // Staged rows are never visible through metadata_current. Remove orphaned
    // staging from previous workers after ownership has been recovered.
    await this.db
      .prepare(
        "DELETE FROM metadata_records WHERE snapshot_id IN (SELECT id FROM metadata_snapshots WHERE state='STAGED') AND EXISTS(SELECT 1 FROM data_update_worker WHERE singleton=1 AND owner=?)",
      )
      .bind(owner)
      .run();
    await this.db
      .prepare(
        "DELETE FROM metadata_snapshots WHERE state='STAGED' AND EXISTS(SELECT 1 FROM data_update_worker WHERE singleton=1 AND owner=?)",
      )
      .bind(owner)
      .run();
  }
  async claimJob(owner) {
    const now = iso();
    return mapJob(
      await this.db
        .prepare(
          "UPDATE data_update_jobs SET status='RUNNING',stage='准备更新',worker_id=?,started_at=?,updated_at=? WHERE id=(SELECT id FROM data_update_jobs WHERE status='QUEUED' ORDER BY created_at LIMIT 1) AND EXISTS(SELECT 1 FROM data_update_worker WHERE singleton=1 AND owner=?) RETURNING *",
        )
        .bind(owner, now, now, owner)
        .first(),
    );
  }
  async checkJob(id, owner) {
    const row = await this.db
      .prepare(
        "SELECT j.cancel_requested FROM data_update_jobs j JOIN data_update_worker w ON w.singleton=1 AND w.owner=j.worker_id WHERE j.id=? AND j.worker_id=? AND j.status='RUNNING'",
      )
      .bind(id, owner)
      .first();
    if (!row || row.cancel_requested) throw new DataUpdateCancelled();
  }
  async progress(id, owner, stage, progress) {
    await this.checkJob(id, owner);
    await this.db
      .prepare(
        "UPDATE data_update_jobs SET stage=?,progress=?,updated_at=? WHERE id=? AND worker_id=? AND status='RUNNING'",
      )
      .bind(stage, JSON.stringify(progress), iso(), id, owner)
      .run();
  }
  async finish(id, owner, status, results, error = null) {
    const now = iso();
    await this.db
      .prepare(
        "UPDATE data_update_jobs SET status=?,stage=?,results=?,error=?,finished_at=?,updated_at=? WHERE id=? AND worker_id=? AND status='RUNNING' AND EXISTS(SELECT 1 FROM data_update_worker WHERE singleton=1 AND owner=?)",
      )
      .bind(
        status,
        {
          SUCCEEDED: "更新完成",
          PARTIAL: "部分成功",
          FAILED: "更新失败，可重试",
          CANCELLED: "已取消",
        }[status],
        JSON.stringify(results),
        error,
        now,
        now,
        id,
        owner,
        owner,
      )
      .run();
    return this.job(id);
  }
  async snapshot(kind, { id, before } = {}) {
    const row =
      id || before
        ? await this.db
            .prepare(
              `SELECT * FROM metadata_snapshots WHERE kind=? AND state='PUBLISHED'${id ? " AND id=?" : ""}${before ? " AND fetched_at<=?" : ""} ORDER BY fetched_at DESC,id DESC LIMIT 1`,
            )
            .bind(kind, ...(id ? [id] : []), ...(before ? [before] : []))
            .first()
        : await this.db
            .prepare(
              "SELECT s.* FROM metadata_current c JOIN metadata_snapshots s ON s.id=c.snapshot_id WHERE c.kind=? AND s.state='PUBLISHED'",
            )
            .bind(kind)
            .first();
    if (!row) return null;
    let cache = snapshotCaches.get(this.db);
    if (!cache) snapshotCaches.set(this.db, (cache = new Map()));
    const cacheKey = id || before ? `${kind}:${row.id}` : kind;
    if (
      cache.get(cacheKey)?.id === row.id &&
      cache.get(cacheKey)?.fetchedAt === row.fetched_at &&
      cache.get(cacheKey)?.digest === row.digest
    )
      return cache.get(cacheKey);
    const records = (
      await this.db
        .prepare(
          "SELECT payload FROM metadata_records WHERE snapshot_id=? ORDER BY code",
        )
        .bind(row.id)
        .all()
    ).results.map((r) => JSON.parse(r.payload));
    const result = {
      id: row.id,
      kind,
      source: row.source,
      fetchedAt: row.fetched_at,
      digest: row.digest,
      stats: JSON.parse(row.stats),
      records,
      byCode: new Map(records.map((r) => [r.code, r])),
    };
    cache.set(cacheKey, result);
    return result;
  }
  async publish(kind, input, { jobId, owner, source, warnings = [] }) {
    let records = validateMetadataRecords(kind, input);
    const previous = await this.snapshot(kind),
      now = iso();
    const added = records.filter((r) => !previous?.byCode.has(r.code)).length;
    const nameChanges =
      kind === "stock_em" || kind === "stock_list"
        ? records.filter(
            (r) =>
              previous?.byCode.has(r.code) &&
              previous.byCode.get(r.code).name !== r.name,
          ).length
        : 0;
    const fields =
      kind === "stock_list"
        ? []
        : kind === "stock_em"
          ? ["emIndustry"]
          : ["swL1", "swL2", "swL3", "swCode"];
    const industryChanges = records.filter(
      (r) =>
        previous?.byCode.has(r.code) &&
        fields.some((f) => previous.byCode.get(r.code)[f] !== r[f]),
    ).length;
    const sourceCount = records.length;
    const covered =
      kind === "stock_em"
        ? records.filter((r) => r.emIndustry).length
        : sourceCount;
    const stats = {
      sourceCount,
      covered,
      coverage: covered / sourceCount,
      added,
      nameChanges,
      industryChanges,
      industryCount:
        kind === "stock_em"
          ? new Set(records.map((r) => r.emIndustry).filter(Boolean)).size
          : undefined,
      levels:
        kind === "industry_sw"
          ? [1, 2, 3].map((n) => new Set(records.map((r) => r[`swL${n}`])).size)
          : undefined,
      verifiedConflicts:
        kind === "industry_sw"
          ? records.filter(
              (r) =>
                r.swVerification?.source ===
                "sws-official-classification-history",
            ).length
          : undefined,
      sources:
        kind === "stock_list"
          ? Object.fromEntries(
              [
                ...new Set(records.map((r) => r.registrySource || "unknown")),
              ].map((source) => [
                source,
                records.filter(
                  (r) => (r.registrySource || "unknown") === source,
                ).length,
              ]),
            )
          : undefined,
      warnings: kind === "stock_list" || warnings.length ? warnings : undefined,
    };
    // Keep last-known stock identities, without inventing a delisting from one
    // missing provider observation. Coverage denominators use this fetch only.
    if (kind === "stock_em" || kind === "stock_list") {
      records = records.map((r) => ({
        ...r,
        presentInSource: true,
        lastSeenAt: now,
      }));
      const seen = new Set(records.map((r) => r.code));
      const absent =
        previous?.records
          .filter((r) => !seen.has(r.code))
          .map((r) => ({ ...r, presentInSource: false })) ?? [];
      stats.notSeen = absent.length;
      records.push(...absent);
    }
    const id = `meta-${crypto.randomUUID()}`,
      digest = await digestOf(records);
    await this.checkJob(jobId, owner);
    await this.db
      .prepare(
        "INSERT INTO metadata_snapshots(id,kind,source,fetched_at,digest,stats) VALUES (?,?,?,?,?,?)",
      )
      .bind(id, kind, source, now, digest, JSON.stringify(stats))
      .run();
    try {
      for (let i = 0; i < records.length; i += 100) {
        await this.checkJob(jobId, owner);
        await this.db.batch(
          records
            .slice(i, i + 100)
            .map((r) =>
              this.db
                .prepare(
                  "INSERT INTO metadata_records(snapshot_id,code,payload) VALUES (?,?,?)",
                )
                .bind(id, r.code, JSON.stringify(r)),
            ),
        );
      }
      // The worker uses the local transaction adapter. No network or parsing is
      // performed while holding this publication lock.
      const result = {
        status: "SUCCEEDED",
        source,
        snapshotId: id,
        fetchedAt: now,
        ...stats,
      };
      await this.db.transaction(async () => {
        await this.checkJob(jobId, owner);
        await this.db
          .prepare("UPDATE metadata_snapshots SET state='PUBLISHED' WHERE id=?")
          .bind(id)
          .run();
        await this.db
          .prepare(
            "INSERT INTO metadata_current(kind,snapshot_id) VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET snapshot_id=excluded.snapshot_id",
          )
          .bind(kind, id)
          .run();
        const job = await this.job(jobId);
        await this.db
          .prepare(
            "UPDATE data_update_jobs SET results=?,updated_at=? WHERE id=?",
          )
          .bind(JSON.stringify({ ...job.results, [kind]: result }), now, jobId)
          .run();
      });
      return result;
    } catch (error) {
      await this.db
        .prepare(
          "DELETE FROM metadata_records WHERE snapshot_id=? AND EXISTS(SELECT 1 FROM metadata_snapshots WHERE id=? AND state='STAGED')",
        )
        .bind(id, id)
        .run();
      await this.db
        .prepare("DELETE FROM metadata_snapshots WHERE id=? AND state='STAGED'")
        .bind(id)
        .run();
      throw error;
    }
  }
}

export async function metadataStatus(env) {
  const repo = new StockMetadataRepository(env);
  const [registry, em, sw, activeJob, jobs, worker] = await Promise.all([
    repo.snapshot("stock_list"),
    repo.snapshot("stock_em"),
    repo.snapshot("industry_sw"),
    repo.activeJob(),
    repo.jobs(),
    repo.worker(),
  ]);
  const available = env.DATA_UPDATE_RUNNER === "local";
  const workerHealthy =
    available &&
    !!worker?.owner &&
    Date.now() - Date.parse(worker.heartbeat_at) < 30000;
  const roster = registry ?? em,
    stocks = roster?.records.filter((r) => r.presentInSource !== false) ?? [];
  const describe = (snapshot) =>
    snapshot
      ? {
          snapshotId: snapshot.id,
          source: snapshot.source,
          fetchedAt: snapshot.fetchedAt,
          ...snapshot.stats,
        }
      : null;
  const missingEm = stocks.filter((r) => !em?.byCode.get(r.code)?.emIndustry);
  const missingSw = stocks.filter((r) => !sw?.byCode.has(r.code));
  const swSource = env.SW_METADATA_SOURCE || "lixinger",
    swReady =
      swSource === "legulegu" ||
      (swSource === "lixinger" && env.LIXINGER_CONFIGURED === true);
  return {
    available,
    workerHealthy,
    capabilityReason: !available
      ? "当前部署未启用本地更新执行器"
      : !workerHealthy
        ? "更新执行器尚未就绪或心跳中断，请稍后刷新"
        : null,
    scopeLabel: "沪深主板与创业板，基础名册包含 ST 信息",
    stockList: describe(registry),
    stockListFallback: !registry && !!em,
    stockEm: describe(em),
    industrySw: describe(sw),
    swProvider: {
      source: swSource,
      ready: swReady,
      description:
        swSource === "lixinger"
          ? "理杏仁申万 2021 批量 API · 2 次批量请求，需核验时加 1 次官方文件"
          : swSource === "legulegu"
            ? "乐咕网页 · 按三级行业逐个抓取，限流时耗时较长"
            : "申万数据源配置无效",
      reason: swReady
        ? null
        : swSource === "lixinger"
          ? "请在本项目 .env 配置 LIXINGER_TOKEN 并重启服务"
          : "SW_METADATA_SOURCE 必须为 lixinger 或 legulegu",
    },
    missingEm: {
      count: roster ? missingEm.length : null,
      covered: roster ? stocks.length - missingEm.length : null,
      coverage: stocks.length
        ? (stocks.length - missingEm.length) / stocks.length
        : null,
      samples: missingEm.slice(0, 20).map(({ code, name }) => ({ code, name })),
    },
    missingSw: {
      count: roster ? missingSw.length : null,
      covered: roster ? stocks.length - missingSw.length : null,
      coverage: stocks.length
        ? (stocks.length - missingSw.length) / stocks.length
        : null,
      samples: missingSw.slice(0, 20).map(({ code, name }) => ({ code, name })),
    },
    activeJob,
    jobs,
  };
}
