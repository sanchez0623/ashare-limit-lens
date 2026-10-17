import { canonicalJson, digestOf } from "../domain/research-lineage.js";
import {
  summarizeTQuality,
  tQualityEnabledForPlan,
} from "../domain/t-quality.js";

export function qualityPayload(plan) {
  if (!tQualityEnabledForPlan(plan)) return null;
  if (!plan.tQuality || !plan.tQualityEvidence)
    throw new Error("做T质量摘要与冻结证据缺失");
  const expected = summarizeTQuality(plan.tQualityEvidence.records, {
    signalDate: plan.signalDate,
    tradingDates: plan.tQualityEvidence.tradingDates,
  });
  if (canonicalJson(expected) !== canonicalJson(plan.tQuality))
    throw new Error("做T质量摘要与冻结证据重算不一致");
  return {
    tQuality: plan.tQuality,
    tQualityEvidence: plan.tQualityEvidence,
  };
}

export async function frozenQualityRow(db, plan, scope) {
  return db
    .prepare(
      "SELECT payload,digest FROM frozen_t_quality WHERE scope=? AND signal_date=?",
    )
    .bind(scope, plan.signalDate)
    .first();
}

// 与计划 INSERT 放进同一个 batch。只为本次实际保存的计划写副本，
// INSERT OR IGNORE 输掉竞争的调用不能冻结自己的另一套输入。
export async function freezeQualityStatement(db, plan, scope, planDigest) {
  const payload = qualityPayload(plan);
  if (!payload) return null;
  const shadow = scope.startsWith("shadow:");
  const table = shadow ? "shadow_plans" : "paper_plans";
  return db
    .prepare(
      `INSERT INTO frozen_t_quality (scope,signal_date,payload,digest,created_at)
       SELECT ?,?,?,?,? FROM ${table} WHERE signal_date=? AND digest=?
       ${shadow ? "AND account_id=?" : ""}
       ON CONFLICT(scope,signal_date) DO NOTHING`,
    )
    .bind(
      scope,
      plan.signalDate,
      JSON.stringify(payload),
      await digestOf(payload),
      plan.createdAt,
      plan.signalDate,
      planDigest,
      ...(shadow ? [scope.slice("shadow:".length)] : []),
    );
}

export async function assertFrozenTQuality(db, plan, scope) {
  if (!tQualityEnabledForPlan(plan)) return;
  const row = await frozenQualityRow(db, plan, scope);
  if (!row) throw new Error("做T质量摘要冻结副本缺失，拒绝执行");
  const payload = JSON.parse(row.payload);
  if (
    (await digestOf(payload)) !== row.digest ||
    canonicalJson(payload) !== canonicalJson(qualityPayload(plan))
  )
    throw new Error("做T质量摘要与账户冻结副本不一致");
}
