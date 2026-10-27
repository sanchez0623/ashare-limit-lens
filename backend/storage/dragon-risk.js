import {
  normalizeDragonConfig,
  DRAGON_POLICY_VERSION,
} from "../../shared/dragon-risk-config.js";
import { assertDragonPlan, isDragon } from "../domain/dragon-risk.js";
import { digestOf, canonicalJson } from "../domain/research-lineage.js";
import { executionEngineBuildDigest } from "../domain/execution-build.js";
import { industryContinuation } from "./industry-continuation.js";
import { assertManualExitReferences } from "./manual-exits.js";
import { registerEnvironmentPolicy } from "./market-environment.js";

export function dragonConfigProvenance(record) {
  if (!record.provenanceDigest) return null;
  return {
    origin: record.origin,
    validationMode: record.validationMode,
    replacesId: record.replacesId ?? null,
    digest: record.provenanceDigest,
  };
}
export async function verifyDragonConfigProvenance(record) {
  if (!record.provenanceDigest) return record.origin === "LEGACY";
  return (
    ["MANUAL", "AI", "RESEARCH", "ENGINE_UPGRADE"].includes(record.origin) &&
    ["MANUAL_UNVERIFIED", "RESEARCH_REQUIRED"].includes(
      record.validationMode,
    ) &&
    (await digestOf({
      id: record.id,
      configDigest: record.digest,
      engineBuild: record.engineBuild,
      baseId: record.baseId ?? null,
      origin: record.origin,
      validationMode: record.validationMode,
      replacesId: record.replacesId ?? null,
    })) === record.provenanceDigest
  );
}
export async function registerDragonConfig(
  db,
  config,
  baseId = null,
  options = {},
) {
  const normalized = normalizeDragonConfig(config),
    hash = await digestOf(normalized),
    build = await executionEngineBuildDigest();
  const id = options.id ?? `dragon-${crypto.randomUUID()}`;
  const record = {
    id,
    config: normalized,
    digest: hash,
    engineBuild: build,
    baseId,
    origin: options.origin ?? "RESEARCH",
    validationMode: options.validationMode ?? "RESEARCH_REQUIRED",
    replacesId: options.replacesId ?? null,
  };
  record.provenanceDigest = await digestOf({
    id,
    configDigest: hash,
    engineBuild: build,
    baseId,
    origin: record.origin,
    validationMode: record.validationMode,
    replacesId: record.replacesId,
  });
  if (!(await verifyDragonConfigProvenance(record)))
    throw new Error("新交易配置来源或验证方式无效");
  await db
    .prepare(
      "INSERT INTO dragon_config_versions(id,payload,digest,engine_build,base_id,created_at,origin,validation_mode,replaces_id,provenance_digest) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(
      id,
      JSON.stringify(normalized),
      hash,
      build,
      baseId,
      new Date().toISOString(),
      record.origin,
      record.validationMode,
      record.replacesId,
      record.provenanceDigest,
    )
    .run();
  return record;
}
export async function loadDragonConfig(db, id) {
  const row = await db
    .prepare("SELECT * FROM dragon_config_versions WHERE id=?")
    .bind(id)
    .first();
  if (!row) throw new Error("新交易配置版本不存在");
  const config = normalizeDragonConfig(JSON.parse(row.payload));
  if ((await digestOf(config)) !== row.digest)
    throw new Error("新交易配置内容摘要不一致");
  const record = {
    id: row.id,
    config,
    digest: row.digest,
    engineBuild: row.engine_build,
    baseId: row.base_id,
    origin: row.origin ?? "LEGACY",
    validationMode: row.validation_mode ?? "RESEARCH_REQUIRED",
    replacesId: row.replaces_id ?? null,
    provenanceDigest: row.provenance_digest ?? null,
  };
  if (!(await verifyDragonConfigProvenance(record)))
    throw new Error("新交易配置来源或验证方式摘要不一致");
  return record;
}
export async function bindDragonPlan(db, plan, scope) {
  if (!isDragon(plan)) return null;
  assertDragonPlan(plan);
  if (plan.dragonPolicy.marketEnvironmentPolicy) await registerEnvironmentPolicy(db);
  await assertManualExitReferences(db, plan, scope);
  const record = await loadDragonConfig(db, plan.dragonPolicy.configId);
  if (
    record.digest !== plan.dragonPolicy.configDigest ||
    canonicalJson(record.config) !== canonicalJson(plan.dragonPolicy.config) ||
    canonicalJson(dragonConfigProvenance(record)) !==
      canonicalJson(plan.dragonPolicy.provenance ?? null)
  )
    throw new Error("新政策计划与登记配置不一致");
  return db
    .prepare(
      "INSERT OR IGNORE INTO dragon_plan_bindings(scope,signal_date,config_id,plan_digest) VALUES(?,?,?,?)",
    )
    .bind(scope, plan.signalDate, record.id, await digestOf(plan));
}
export async function assertStoredDragonPlan(db, plan, book, scope) {
  if (plan) {
    const { digest: _digest, ...payload } = plan;
    plan = payload;
  }
  const binding =
    plan &&
    (await db
      .prepare(
        "SELECT * FROM dragon_plan_bindings WHERE scope=? AND signal_date=?",
      )
      .bind(scope, plan.signalDate)
      .first());
  if (!binding && !isDragon(plan) && !isDragon(book)) return false;
  assertDragonPlan(plan, book);
  await assertManualExitReferences(db, plan, scope, book);
  const record = await loadDragonConfig(db, plan.dragonPolicy.configId);
  if (
    !binding ||
    binding.config_id !== record.id ||
    binding.plan_digest !== (await digestOf(plan)) ||
    record.digest !== plan.dragonPolicy.configDigest ||
    canonicalJson(record.config) !== canonicalJson(plan.dragonPolicy.config) ||
    canonicalJson(dragonConfigProvenance(record)) !==
      canonicalJson(plan.dragonPolicy.provenance ?? null) ||
    plan.engineBuild !== record.engineBuild
  )
    throw new Error("新政策独立冻结依据、配置或执行指纹不一致");
  if (
    plan.engineBuild !== (await executionEngineBuildDigest()) &&
    !(await industryContinuation(db, plan, scope))
  )
    throw new Error("新政策独立冻结依据、配置或执行指纹不一致");
  return true;
}
export function dragonBookFields(record) {
  return {
    tradingPolicyVersion: DRAGON_POLICY_VERSION,
    dragonConfig: record.config,
    dragonConfigId: record.id,
    dragonConfigDigest: record.digest,
    dragonEngineBuild: record.engineBuild,
    ...(dragonConfigProvenance(record)
      ? { dragonConfigProvenance: dragonConfigProvenance(record) }
      : {}),
    entryExecutionMode: "intraday-conditional",
    selectionPolicyVersion: DRAGON_POLICY_VERSION,
  };
}
