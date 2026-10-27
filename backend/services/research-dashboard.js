import { PaperRepository } from "../storage/paper.js";
import { sourceDays } from "./dragon-research.js";
import { aiConfig } from "./review.js";
import { PATTERN_POLICY } from "../domain/dragon-patterns.js";
import { scoringPolicy } from "./observation-scoring.js";

export async function researchDashboard(env) {
  const book = (await new PaperRepository(env).account())?.book;
  const selected = (await sourceDays(env)).slice(-80);
  const reviews = (
    await env.DB.prepare(
      "SELECT trade_date,payload FROM reviews ORDER BY trade_date DESC LIMIT 140",
    ).all()
  ).results;
  const eligible = new Set(
    reviews
      .filter((r) => JSON.parse(r.payload).researchEligible === true)
      .map((r) => r.trade_date),
  );
  const complete = selected.filter((s) => eligible.has(s.date)).length;
  const adjacent = selected.every(
    (s, i) => !i || s.plan.signalDate === selected[i - 1].date,
  );
  const month = new Date(Date.now() + 28800000).toISOString().slice(0, 7);
  const slots = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM research_generation_slots WHERE namespace='main' AND month=?",
  )
    .bind(month)
    .first();
  const attempts = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM dragon_ai_attempts WHERE month=?",
  )
    .bind(month)
    .first();
  const lock = await env.DB.prepare(
    "SELECT owner_type AS ownerType,owner_id AS ownerId FROM research_window_owners WHERE namespace='main'",
  ).first();
  const reasons = [];
  if (book?.tradingPolicyVersion !== "dragon-risk-v1")
    reasons.push("请先启用龙头交易政策");
  if (book?.pendingDragonConfigId || book?.dragonTransition?.candidate)
    reasons.push("已有配置等待验证或生效");
  if (selected.length < 80 || complete !== 80 || !adjacent)
    reasons.push("需要相邻60个完整训练日与20个封存日");
  if (!aiConfig(env).configured) reasons.push("模型未配置");
  if (lock) reasons.push(`研究窗口由 ${lock.ownerType} 占用`);
  const used = Math.max(slots?.n ?? 0, attempts?.n ?? 0);
  if (used >= PATTERN_POLICY.monthlyLimit)
    reasons.push("本月研究批次预算已用完");
  return {
    policy: PATTERN_POLICY,
    model: aiConfig(env),
    tradingPolicyVersion: book?.tradingPolicyVersion ?? null,
    improvementMode: book?.improvementMode ?? "auto",
    completeDays: complete,
    adjacent,
    requiredDays: 80,
    budget: { month, used, limit: PATTERN_POLICY.monthlyLimit },
    lock,
    canPropose: !reasons.length,
    reasons,
    scoring: await scoringPolicy(env),
  };
}

const archiveUnion =
  "SELECT id,'pattern' AS kind,created_at FROM dragon_pattern_batches UNION ALL SELECT config_id AS id,'template' AS kind,created_at FROM dragon_research_runs WHERE manifest IS NULL OR json_extract(manifest,'$.patternBatchId') IS NULL UNION ALL SELECT id,'cohort' AS kind,created_at FROM strategy_cohorts UNION ALL SELECT id,'experiment' AS kind,created_at FROM research_experiments";
export async function researchRecords(
  env,
  { id, kind, limit = 20, offset = 0 } = {},
) {
  const types = {
    pattern: ["dragon_pattern_batches", "id"],
    template: ["dragon_research_runs", "config_id"],
    cohort: ["strategy_cohorts", "id"],
    experiment: ["research_experiments", "id"],
  };
  if (id) {
    if (!types[kind]) throw new Error("未知研究记录类型");
    const [table, key] = types[kind];
    const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${key}=?`)
      .bind(id)
      .first();
    if (!row) return null;
    return {
      kind,
      id,
      readOnly: true,
      record: Object.fromEntries(
        Object.entries(row).map(([k, v]) => {
          if (typeof v !== "string" || !/^[\[{]/.test(v)) return [k, v];
          try {
            return [k, JSON.parse(v)];
          } catch {
            return [k, v];
          }
        }),
      ),
    };
  }
  const total = (
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${archiveUnion})`).first()
  ).n;
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM (${archiveUnion}) ORDER BY created_at DESC,kind,id LIMIT ? OFFSET ?`,
    )
      .bind(limit, offset)
      .all()
  ).results;
  return { rows, total, limit, offset };
}
