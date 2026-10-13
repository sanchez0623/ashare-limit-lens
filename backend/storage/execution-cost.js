// 执行成本政策版本与校准/敏感性结果的持久化（§5.4）。
// 政策追加不可变：修改参数产生新版本；读取时重新校验摘要。
import { database } from "./database.js";
import { RESEARCH_NAMESPACE } from "./cohorts.js";
import { verifyExecutionCalibration } from "../domain/execution-calibration.js";
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

async function verifiedCalibration(db, id) {
  const row = await db
    .prepare(
      "SELECT report,digest,input_digest,cutoff FROM execution_cost_calibrations WHERE id=?",
    )
    .bind(id)
    .first();
  if (!row) throw new Error("已校准政策缺少可核验校准报告");
  const { inputId, report } = JSON.parse(row.report);
  const inputRow = await db
    .prepare(
      "SELECT payload,digest FROM execution_calibration_inputs WHERE id=?",
    )
    .bind(inputId)
    .first();
  if (!inputRow) throw new Error("已校准政策缺少独立原始输入");
  const { input, basePolicy } = JSON.parse(inputRow.payload);
  if (
    (await policyDigest(basePolicy)) !== (await policyDigest(report.basePolicy))
  )
    throw new Error("校准基础政策与冻结输入不一致");
  if (inputRow.digest !== row.input_digest || row.cutoff !== report.cutoff)
    throw new Error("校准输入元数据不一致");
  const audit = await verifyExecutionCalibration({
    id,
    inputId,
    digest: row.digest,
    input,
    report,
  });
  if (!audit.eligible) throw new Error("校准报告未通过后续验证闸门");
  return report;
}

async function verifyCalibrationLink(db, row, bundle) {
  if (bundle.calibrationStatus === "PRIOR_UNCALIBRATED") return;
  const report = await verifiedCalibration(db, row.calibration_id);
  if (
    report.payloadDigest !== bundle.payloadDigest ||
    report.calibrationStatus !== bundle.calibrationStatus ||
    report.cutoff !== bundle.calibrationCutoff ||
    !bundle.effectiveFrom ||
    bundle.effectiveFrom <= report.cutoff
  )
    throw new Error("校准政策参数、证据等级、截止日或生效日期与报告不一致");
}

// 执行前核验：bundle 内嵌 payload 必须与摘要一致（§3.2/§5.4）。
// 修改参数但保留旧摘要的政策在这里被拒绝。
export async function verifyPolicyBundle(bundle) {
  if (!bundle?.payload || !/^[0-9a-f]{64}$/.test(bundle.payloadDigest ?? ""))
    return false;
  try {
    return (await policyDigest(bundle.payload)) === bundle.payloadDigest;
  } catch {
    return false;
  }
}

// 政策读取：表未迁移时回退默认政策；行存在但内容损坏或摘要不一致时
// 必须抛错，不能静默回退默认值继续交易。
export async function latestPolicyBundle(db) {
  let row;
  try {
    row = await db
      .prepare(
        "SELECT * FROM execution_cost_policies WHERE model_version=? ORDER BY version DESC LIMIT 1",
      )
      .bind(EXECUTION_COST_MODEL)
      .first();
  } catch (error) {
    if (/no such table/i.test(String(error?.message ?? error)))
      return defaultExecutionCostPolicy();
    throw error;
  }
  if (!row) return defaultExecutionCostPolicy();
  let bundle;
  try {
    bundle = rowToBundle(row);
  } catch {
    throw new Error(
      `成本政策 v${row.version} 存储内容损坏，拒绝静默回退；请修复或删除该版本`,
    );
  }
  if (!(await verifyPolicyBundle(bundle)))
    throw new Error(
      `成本政策 v${row.version} 存储内容与摘要不一致，拒绝静默回退；请修复或删除该版本`,
    );
  await verifyCalibrationLink(db, row, bundle);
  return bundle;
}

// 参数摘要允许重复，历史引用必须按 ID/版本/模型定位，不能被新版替换。
export async function policyBundleByReference(db, reference) {
  const fallback = defaultExecutionCostPolicy();
  if (
    reference.policyId === fallback.id &&
    reference.version === fallback.version &&
    reference.modelVersion === fallback.modelVersion &&
    reference.digest === fallback.payloadDigest
  )
    return fallback;
  const row = await db
    .prepare(
      "SELECT * FROM execution_cost_policies WHERE id=? AND version=? AND model_version=?",
    )
    .bind(reference.policyId, reference.version, reference.modelVersion)
    .first();
  if (!row) return null;
  const bundle = rowToBundle(row);
  if (
    !(await verifyPolicyBundle(bundle)) ||
    bundle.payloadDigest !== reference.digest
  )
    throw new Error(`成本政策 v${row.version} 存储内容与摘要不一致`);
  await verifyCalibrationLink(db, row, bundle);
  return bundle;
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
    calibrationId = null,
  }) {
    const normalized = normalizeExecutionCostPayload(payload);
    const digest = await policyDigest(normalized);
    if (
      calibrationStatus !== "PRIOR_UNCALIBRATED" &&
      effectiveFrom !==
        new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    )
      throw new Error(
        "校准政策只允许从当前日期后的新计划生效，不能回填或预约生效日期",
      );
    if (calibrationStatus !== "PRIOR_UNCALIBRATED") {
      const report = await verifiedCalibration(this.db, calibrationId);
      if (
        report.payloadDigest !== digest ||
        report.calibrationStatus !== calibrationStatus ||
        report.cutoff !== calibrationCutoff ||
        !effectiveFrom ||
        effectiveFrom <= calibrationCutoff
      )
        throw new Error(
          "只有校准报告的冻结参数与证据等级可以发布，生效日必须晚于校准截止日",
        );
    } else if (calibrationId || calibrationCutoff)
      throw new Error("未校准政策不能携带真实校准声明");
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
    // 窗口守卫与写入原子化（§3.2）：消除“检查无锁后、写入前取得窗口锁”
    // 的竞态——同一语句内 NOT EXISTS 判定，活动研究窗口存在时插入 0 行。
    const result = await this.db
      .prepare(
        "INSERT INTO execution_cost_policies (id,version,model_version,payload,digest,calibration_status,calibration_cutoff,effective_from,created_at,calibration_id) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM research_window_owners WHERE namespace = ?)",
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
        calibrationId,
        RESEARCH_NAMESPACE,
      )
      .run();
    const changes = result.meta?.changes ?? result.changes;
    if (!changes)
      throw new Error(
        "存在活动研究窗口，冻结政策继续服务已有批次，不能混用成本政策",
      );
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
