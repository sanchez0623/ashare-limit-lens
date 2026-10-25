import { eventDigest } from "../domain/research-lineage.js";

// 与账户配置 CAS 同批提交；只释放本次明确指定的所有者，样本和额度不回收。
export async function prepareResearchCancellation(env, owner, reason) {
  const db = env.DB,
    stamp = new Date().toISOString(),
    extra = [],
    conditions = [],
    values = [];
  const requireRow = (sql, args) => {
    conditions.push(sql);
    values.push(...args);
  };
  requireRow(
    "EXISTS (SELECT 1 FROM research_window_owners WHERE namespace='main' AND owner_type=? AND owner_id=?)",
    [owner.ownerType, owner.ownerId],
  );
  const statement = (sql, args) =>
    extra.push((guard, guardArgs) =>
      db.prepare(`${sql} AND ${guard}`).bind(...args, ...guardArgs),
    );
  const appendEvent = async (table, idColumn, id, type, payload) => {
    const previous = await db
      .prepare(
        `SELECT sequence,digest FROM ${table} WHERE ${idColumn}=? ORDER BY sequence DESC LIMIT 1`,
      )
      .bind(id)
      .first();
    const event = {
      sequence: (previous?.sequence ?? 0) + 1,
      eventType: type,
      createdAt: stamp,
      payload,
      previousDigest: previous?.digest ?? null,
    };
    const digest = await eventDigest(event);
    extra.push((guard, args) =>
      db
        .prepare(
          `INSERT INTO ${table}(${idColumn},sequence,event_type,created_at,payload,previous_digest,digest) SELECT ?,?,?,?,?,?,? WHERE ${guard}`,
        )
        .bind(
          id,
          event.sequence,
          type,
          stamp,
          JSON.stringify(payload),
          event.previousDigest,
          digest,
          ...args,
        ),
    );
  };
  const invalidateExperiment = async (id) => {
    const row = await db
      .prepare(
        "SELECT revision,stage,candidate_version FROM research_experiments WHERE id=?",
      )
      .bind(id)
      .first();
    if (!row) throw new Error("待终止研究实验不存在");
    if (row.stage === "PROMOTED")
      throw new Error("已启用的实验不能作为活动研究终止");
    requireRow(
      "EXISTS (SELECT 1 FROM research_experiments WHERE id=? AND revision=? AND stage=?)",
      [id, row.revision, row.stage],
    );
    statement(
      "UPDATE research_experiments SET stage='INVALIDATED',revision=revision+1 WHERE id=?",
      [id],
    );
    await appendEvent("research_events", "experiment_id", id, "INVALIDATED", {
      reason,
    });
    if (row.candidate_version)
      statement(
        "UPDATE strategy_versions SET status='INVALIDATED' WHERE id=? AND status NOT IN ('ACTIVE','RETIRED')",
        [row.candidate_version],
      );
  };
  if (owner.ownerType === "DRAGON") {
    const row = await db
      .prepare(
        "SELECT status,updated_at FROM dragon_research_runs WHERE config_id=?",
      )
      .bind(owner.ownerId)
      .first();
    if (!row) throw new Error("待终止龙头研究不存在");
    requireRow(
      "EXISTS (SELECT 1 FROM dragon_research_runs WHERE config_id=? AND status=? AND updated_at=?)",
      [owner.ownerId, row.status, row.updated_at],
    );
    statement(
      "UPDATE dragon_research_runs SET status='INVALIDATED',updated_at=? WHERE config_id=?",
      [stamp, owner.ownerId],
    );
    statement(
      "UPDATE shadow_accounts SET status='INVALIDATED',revision=revision+1,updated_at=? WHERE account_id IN (?,?,?)",
      [
        stamp,
        `dragon-observer:${owner.ownerId}`,
        `dragon-parent:${owner.ownerId}`,
        `dragon-baseline:${owner.ownerId}`,
      ],
    );
  } else if (owner.ownerType === "EXPERIMENT") {
    await invalidateExperiment(owner.ownerId);
  } else if (owner.ownerType === "COHORT") {
    const row = await db
      .prepare("SELECT revision,stage FROM strategy_cohorts WHERE id=?")
      .bind(owner.ownerId)
      .first();
    if (!row || row.stage === "CLOSED")
      throw new Error("待终止赛马批次状态已变化");
    requireRow(
      "EXISTS (SELECT 1 FROM strategy_cohorts WHERE id=? AND revision=? AND stage=?)",
      [owner.ownerId, row.revision, row.stage],
    );
    statement(
      "UPDATE strategy_cohorts SET stage='CLOSED',revision=revision+1,updated_at=? WHERE id=?",
      [stamp, owner.ownerId],
    );
    await appendEvent(
      "cohort_events",
      "cohort_id",
      owner.ownerId,
      "USER_CANCELLED",
      { from: row.stage, to: "CLOSED", reason, promoted: false },
    );
    const members = (
      await db
        .prepare(
          "SELECT experiment_id FROM strategy_cohort_members WHERE cohort_id=? AND stage<>'PROMOTED'",
        )
        .bind(owner.ownerId)
        .all()
    ).results;
    for (const member of members)
      if (member.experiment_id)
        await invalidateExperiment(member.experiment_id);
    statement(
      "UPDATE strategy_cohort_members SET stage='INVALIDATED',failure_reason=?,updated_at=? WHERE cohort_id=? AND stage<>'PROMOTED'",
      [reason, stamp, owner.ownerId],
    );
    statement(
      "UPDATE shadow_accounts SET status='INVALIDATED',revision=revision+1,updated_at=? WHERE cohort_id=?",
      [stamp, owner.ownerId],
    );
  } else throw new Error("未知活动研究类型，不能直接释放研究锁");
  statement(
    "DELETE FROM research_window_owners WHERE namespace='main' AND owner_type=? AND owner_id=?",
    [owner.ownerType, owner.ownerId],
  );
  return {
    condition: { sql: conditions.join(" AND "), args: values },
    extra,
    detail: { ...owner, reason, cancelledAt: stamp },
  };
}
