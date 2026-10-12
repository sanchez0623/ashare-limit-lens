// 统计证据持久化（docs/design/statistical-evidence.md §8.2）：
// 政策版本、每日指标（最新修订覆盖，报告冻结自身输入）、不可变报告
// 与输入 manifest。同输入/政策/方法唯一发布，INSERT OR IGNORE。
import { database } from "./database.js";
import { digestOf } from "../domain/research-lineage.js";
import { normalizeEvidencePolicy } from "../domain/evidence-policy.js";

function parsePolicyRow(row) {
  const payload = JSON.parse(row.payload);
  return {
    id: row.id,
    version: row.version,
    payload: normalizeEvidencePolicy(payload),
    digest: row.digest,
    effectiveFrom: row.effective_from,
    createdAt: row.created_at,
  };
}

export class EvidenceRepository {
  constructor(env) {
    this.db = database(env);
  }
  async latestPolicy() {
    let row;
    try {
      row = await this.db
        .prepare(
          "SELECT * FROM evidence_policies ORDER BY version DESC LIMIT 1",
        )
        .first();
    } catch (error) {
      if (/no such table/i.test(String(error?.message ?? error))) return null;
      throw error;
    }
    return row ? parsePolicyRow(row) : null;
  }
  async listPolicies(limit = 10) {
    const rows = await this.db
      .prepare("SELECT * FROM evidence_policies ORDER BY version DESC LIMIT ?")
      .bind(limit)
      .all();
    return rows.results.map(parsePolicyRow);
  }
  async savePolicy(payload, { effectiveFrom = null } = {}) {
    const normalized = normalizeEvidencePolicy(payload);
    const digest = await digestOf(normalized);
    const row = await this.db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM evidence_policies",
      )
      .first();
    const version = row.version + 1;
    const id = `evidence-policy-v${version}`;
    await this.db
      .prepare(
        "INSERT INTO evidence_policies (id,version,payload,digest,effective_from,created_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        id,
        version,
        JSON.stringify(normalized),
        digest,
        effectiveFrom,
        new Date().toISOString(),
      )
      .run();
    return { id, version, payload: normalized, digest, effectiveFrom };
  }
  // 每日指标：同 series/date/context 覆盖为最新修订（sourceDigest 变化
  // 体现在 source_digest）；报告冻结自身输入，不受覆盖影响。
  async saveDailyMetric({
    namespace,
    seriesId,
    outcomeDate,
    contextDigest,
    sourceDigest,
    payload,
  }) {
    const digest = await digestOf(payload);
    await this.db
      .prepare(
        "INSERT INTO evidence_daily_metrics (id,namespace,series_id,outcome_date,context_digest,source_digest,payload,digest,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,source_digest=excluded.source_digest,digest=excluded.digest,created_at=excluded.created_at",
      )
      .bind(
        `${namespace}:${seriesId}:${outcomeDate}:${contextDigest.slice(0, 16)}`,
        namespace,
        seriesId,
        outcomeDate,
        contextDigest,
        sourceDigest,
        JSON.stringify(payload),
        digest,
        new Date().toISOString(),
      )
      .run();
    return { digest };
  }
  async listDailyMetrics({ seriesId, contextDigest, fromDate, toDate }) {
    const rows = await this.db
      .prepare(
        "SELECT * FROM evidence_daily_metrics WHERE series_id=? AND context_digest=? AND outcome_date>=? AND outcome_date<=? ORDER BY outcome_date",
      )
      .bind(seriesId, contextDigest, fromDate, toDate)
      .all();
    return rows.results.map((row) => ({
      outcomeDate: row.outcome_date,
      sourceDigest: row.source_digest,
      payload: JSON.parse(row.payload),
      digest: row.digest,
    }));
  }
  // 跨证据 epoch 列出同一系列的全部每日指标：调用方据此选择最新上下文
  // 并标记 MIXED_CONTEXT（§5.2）。
  async listDailyMetricsAcrossContexts({ seriesId, fromDate, toDate }) {
    const rows = await this.db
      .prepare(
        "SELECT * FROM evidence_daily_metrics WHERE series_id=? AND outcome_date>=? AND outcome_date<=? ORDER BY outcome_date",
      )
      .bind(seriesId, fromDate, toDate)
      .all();
    return rows.results.map((row) => ({
      outcomeDate: row.outcome_date,
      contextDigest: row.context_digest,
      sourceDigest: row.source_digest,
      payload: JSON.parse(row.payload),
      digest: row.digest,
    }));
  }
  // 不可变发布：同 (series, asOf, horizon, purpose, input, policy, method)
  // 唯一；重复发布返回已有行且 created=false，不覆写。
  async publishReport({
    namespace,
    seriesId,
    asOf,
    horizon,
    purpose,
    inputDigest,
    policyDigest,
    methodVersion,
    payload,
    inputs,
  }) {
    const digest = await digestOf(payload);
    const id = `evidence-${await digestOf({ seriesId, asOf, horizon, purpose, inputDigest, policyDigest, methodVersion })}`;
    const inserted = await this.db
      .prepare(
        "INSERT OR IGNORE INTO evidence_reports (id,namespace,series_id,as_of,horizon,purpose,input_digest,policy_digest,method_version,payload,digest,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        namespace,
        seriesId,
        asOf,
        horizon,
        purpose,
        inputDigest,
        policyDigest,
        methodVersion,
        JSON.stringify(payload),
        digest,
        new Date().toISOString(),
      )
      .run();
    const changes = inserted.meta?.changes ?? inserted.changes;
    if (changes) {
      await this.db
        .prepare(
          "INSERT OR REPLACE INTO evidence_report_inputs (report_id,ordered_dates,source_refs,source_digests,manifest_digest) VALUES (?,?,?,?,?)",
        )
        .bind(
          id,
          JSON.stringify(inputs.orderedDates),
          JSON.stringify(inputs.sourceRefs),
          JSON.stringify(inputs.sourceDigests),
          await digestOf(inputs),
        )
        .run();
    }
    const row = await this.db
      .prepare("SELECT * FROM evidence_reports WHERE id=?")
      .bind(id)
      .first();
    return {
      created: !!changes,
      report: row
        ? {
            id: row.id,
            namespace: row.namespace,
            seriesId: row.series_id,
            asOf: row.as_of,
            horizon: row.horizon,
            purpose: row.purpose,
            inputDigest: row.input_digest,
            policyDigest: row.policy_digest,
            methodVersion: row.method_version,
            payload: JSON.parse(row.payload),
            digest: row.digest,
            createdAt: row.created_at,
          }
        : null,
    };
  }
  async getReport(id) {
    const row = await this.db
      .prepare("SELECT * FROM evidence_reports WHERE id=?")
      .bind(id)
      .first();
    if (!row) return null;
    const inputs = await this.db
      .prepare("SELECT * FROM evidence_report_inputs WHERE report_id=?")
      .bind(id)
      .first();
    return {
      id: row.id,
      namespace: row.namespace,
      seriesId: row.series_id,
      asOf: row.as_of,
      horizon: row.horizon,
      purpose: row.purpose,
      inputDigest: row.input_digest,
      policyDigest: row.policy_digest,
      methodVersion: row.method_version,
      payload: JSON.parse(row.payload),
      digest: row.digest,
      createdAt: row.created_at,
      inputs: inputs
        ? {
            orderedDates: JSON.parse(inputs.ordered_dates),
            sourceRefs: JSON.parse(inputs.source_refs),
            sourceDigests: JSON.parse(inputs.source_digests),
            manifestDigest: inputs.manifest_digest,
          }
        : null,
    };
  }
  async listReports({ seriesId, limit = 30 }) {
    const rows = await this.db
      .prepare(
        "SELECT id,series_id,as_of,horizon,purpose,payload,digest,created_at FROM evidence_reports WHERE series_id=? ORDER BY as_of DESC, horizon LIMIT ?",
      )
      .bind(seriesId, limit)
      .all();
    return rows.results.map((row) => ({
      id: row.id,
      seriesId: row.series_id,
      asOf: row.as_of,
      horizon: row.horizon,
      purpose: row.purpose,
      payload: JSON.parse(row.payload),
      digest: row.digest,
      createdAt: row.created_at,
    }));
  }
}
