// 执行成本政策版本与校准/敏感性结果的持久化（§5.4）。
// 政策追加不可变：修改参数产生新版本；读取时重新校验摘要。
import { database } from "./database.js";
import {
  EXECUTION_COST_MODEL,
  defaultExecutionCostPolicy,
  normalizeExecutionCostPayload,
  normalizeExecutionCostPolicy,
} from "../../shared/execution-cost.js";

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
export async function policyDigest(value) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function rowToBundle(row) {
  const bundle = normalizeExecutionCostPolicy({
    id: row.id,
    version: row.version,
    modelVersion: row.model_version,
    payloadDigest: row.digest,
    calibrationStatus: row.calibration_status,
    calibrationCutoff: row.calibration_cutoff,
    effectiveFrom: row.effective_from,
    payload: JSON.parse(row.payload),
  });
  return bundle;
}

// 政策尚未迁移（D1 未应用 0012）或查询失败时回退默认政策：
// 默认政策与未自定义时的行为一致，不阻塞结算。
export async function latestPolicyBundle(db) {
  try {
    const row = await db
      .prepare(
        "SELECT * FROM execution_cost_policies WHERE model_version=? ORDER BY version DESC LIMIT 1",
      )
      .bind(EXECUTION_COST_MODEL)
      .first();
    if (!row) return defaultExecutionCostPolicy();
    return rowToBundle(row);
  } catch {
    return defaultExecutionCostPolicy();
  }
}

export class ExecutionCostRepository {
  constructor(env) {
    this.db = database(env);
  }
  async latest() {
    return latestPolicyBundle(this.db);
  }
  async list(limit = 20) {
    const rows = await this.db
      .prepare(
        "SELECT * FROM execution_cost_policies WHERE model_version=? ORDER BY version DESC LIMIT ?",
      )
      .bind(EXECUTION_COST_MODEL, limit)
      .all();
    return rows.results.map(rowToBundle);
  }
  async save({
    payload,
    calibrationStatus = "PRIOR_UNCALIBRATED",
    calibrationCutoff = null,
    effectiveFrom = null,
  }) {
    const normalized = normalizeExecutionCostPayload(payload);
    const digest = await policyDigest(normalized);
    const row = await this.db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM execution_cost_policies WHERE model_version=?",
      )
      .bind(EXECUTION_COST_MODEL)
      .first();
    const version = row.version + 1;
    const id = `exec-cost-v${version}`;
    const bundle = normalizeExecutionCostPolicy({
      id,
      version,
      modelVersion: EXECUTION_COST_MODEL,
      payloadDigest: digest,
      calibrationStatus,
      calibrationCutoff,
      effectiveFrom,
      payload: normalized,
    });
    await this.db
      .prepare(
        "INSERT INTO execution_cost_policies (id,version,model_version,payload,digest,calibration_status,calibration_cutoff,effective_from,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        version,
        EXECUTION_COST_MODEL,
        JSON.stringify(normalized),
        digest,
        calibrationStatus,
        calibrationCutoff,
        effectiveFrom,
        new Date().toISOString(),
      )
      .run();
    return bundle;
  }
  async saveSensitivityRun(run) {
    const manifestDigest = await policyDigest(run.manifest);
    await this.db
      .prepare(
        "INSERT OR REPLACE INTO execution_sensitivity_runs (id,namespace,manifest,status,result_digest,payload,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        run.id,
        run.namespace,
        JSON.stringify(run.manifest),
        run.status,
        await policyDigest(run.payload ?? {}),
        JSON.stringify(run.payload ?? {}),
        new Date().toISOString(),
      )
      .run();
    return manifestDigest;
  }
  async sensitivityRun(id) {
    const row = await this.db
      .prepare("SELECT * FROM execution_sensitivity_runs WHERE id=?")
      .bind(id)
      .first();
    return row
      ? {
          id: row.id,
          namespace: row.namespace,
          manifest: JSON.parse(row.manifest),
          status: row.status,
          resultDigest: row.result_digest,
          payload: JSON.parse(row.payload),
          createdAt: row.created_at,
        }
      : null;
  }
  async listSensitivityRuns(limit = 10) {
    const rows = await this.db
      .prepare(
        "SELECT id,namespace,status,created_at FROM execution_sensitivity_runs ORDER BY created_at DESC LIMIT ?",
      )
      .bind(limit)
      .all();
    return rows.results;
  }
}
