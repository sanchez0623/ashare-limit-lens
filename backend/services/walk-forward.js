import { ResearchRepository } from "../storage/research.js";
import { CohortRepository } from "../storage/cohorts.js";
import { RealtimeRepository } from "../storage/realtime.js";
import { ShadowAccountRepository } from "../storage/shadow.js";
import { adoptSingleExperiment } from "../storage/walk-forward.js";
import {
  scheduleCohortForward,
  cohortDetail,
  closingQuotesFromFrames,
} from "./strategy-tournament.js";
import { promoteCohortChampion } from "./promotion.js";
import { digestOf, eventDigest } from "../domain/research-lineage.js";
import { windowMetrics, completeRounds } from "../domain/cohort-metrics.js";
import { verifyResearchExport } from "../domain/research-verifier.js";

export async function listResearchExperiments(
  env,
  { limit = 20, cursor = null } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("分页数量应为 1–50");
  let boundary = null;
  if (cursor) {
    if (cursor.length > 200) throw new Error("研究分页游标无效");
    boundary = JSON.parse(cursor);
    if (
      typeof boundary.createdAt !== "string" ||
      !/^exp-[0-9a-f-]{36}$/.test(boundary.id)
    )
      throw new Error("研究分页游标无效");
  }
  const repository = new ResearchRepository(env);
  const rows = (
    await repository.db
      .prepare(
        `SELECT id,created_at FROM research_experiments WHERE namespace='main' ${boundary ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .bind(
        ...(boundary
          ? [boundary.createdAt, boundary.createdAt, boundary.id]
          : []),
        limit + 1,
      )
      .all()
  ).results;
  const page = rows.slice(0, limit);
  const experiments = [];
  for (const row of page) {
    const experiment = await repository.getExperiment(row.id);
    const member = await new CohortRepository(env).memberByExperiment(row.id);
    experiments.push({
      experimentId: experiment.id,
      stage: experiment.stage,
      kind: experiment.kind,
      parentVersion: experiment.parentVersion,
      candidateVersion: experiment.candidateVersion,
      createdAt: experiment.createdAt,
      attemptSequence: experiment.reservationPayload.attemptSequence,
      cohortId: member?.cohortId ?? null,
    });
  }
  return {
    experiments,
    nextCursor:
      rows.length > limit
        ? JSON.stringify({
            createdAt: page.at(-1).created_at,
            id: page.at(-1).id,
          })
        : null,
  };
}

export async function startSingleForward(env, experimentId, options = {}) {
  const adopted = await adoptSingleExperiment(env, experimentId);
  if (!adopted.cohortId) return adopted;
  const cohort = await new CohortRepository(env).getCohort(adopted.cohortId);
  if (cohort.mode !== "SINGLE") throw new Error("该实验属于多候选批次");
  return {
    ...adopted,
    ...(await scheduleCohortForward(env, adopted.cohortId, options)),
  };
}

export async function researchExperimentDetail(env, id) {
  const research = new ResearchRepository(env);
  const experiment = await research.getExperiment(id);
  if (!experiment) return null;
  const cohorts = new CohortRepository(env);
  const member = await cohorts.memberByExperiment(id);
  const forward = member ? await cohortDetail(env, member.cohortId) : null;
  if (
    forward &&
    !forward.accounts.some((account) => account.kind === "BASELINE_CONTINUOUS")
  ) {
    const continuous = await new ShadowAccountRepository(env).account(
      "shadow-baseline-continuous",
    );
    if (continuous) forward.accounts.push({ ...continuous, equities: [] });
  }
  const reports = (
    await research.db
      .prepare(
        "SELECT stage,payload,digest FROM research_reports WHERE experiment_id=? ORDER BY stage",
      )
      .bind(id)
      .all()
  ).results.map((row) => ({
    stage: row.stage,
    payload: JSON.parse(row.payload),
    digest: row.digest,
  }));
  const switches = (
    await research.db
      .prepare(
        "SELECT payload,digest FROM strategy_switch_events WHERE experiment_id=? ORDER BY account_revision",
      )
      .bind(id)
      .all()
  ).results.map((row) => ({
    payload: JSON.parse(row.payload),
    digest: row.digest,
  }));
  const performance = [];
  if (forward?.cohort.forwardManifest) {
    const manifest = forward.cohort.forwardManifest;
    const shadows = new ShadowAccountRepository(env);
    for (const account of forward.accounts) {
      const initial = manifest.initialAccounts[account.accountId];
      if (!initial || account.kind === "BASELINE_CONTINUOUS") continue;
      const dates = manifest.windowDates?.length
        ? manifest.windowDates
        : manifest.tradingDates;
      const equities = (await shadows.equities(account.accountId)).filter(
        (row) => dates.includes(row.tradeDate),
      );
      const ledger = (await shadows.ledger(account.accountId)).filter((row) =>
        dates.includes(row.date),
      );
      performance.push({
        accountId: account.accountId,
        kind: account.kind,
        metrics: windowMetrics({
          initial,
          final: equities.at(-1) ?? initial,
          equities,
          windowDates: dates,
        }),
        rounds: completeRounds(
          ledger,
          dates,
          Object.fromEntries(
            (manifest.initialPositions[account.accountId] ?? []).map((p) => [
              p.code,
              p.quantity,
            ]),
          ),
        ),
        equities,
        initialEquityCents: initial.equityCents,
      });
    }
  }
  const current = await new RealtimeRepository(env).account();
  return {
    experiment,
    reports,
    events: await research.experimentEvents(id),
    samples: await research.experimentSamples(id),
    forward,
    performance,
    switches,
    canPromote:
      experiment.stage === "APPROVED" &&
      Boolean(forward?.evaluation?.champion) &&
      !switches.some((row) => row.payload.eventType === "ROLLBACK"),
    canRollback:
      Boolean(switches.find((row) => row.payload.eventType === "PROMOTE")) &&
      !switches.some((row) => row.payload.eventType === "ROLLBACK") &&
      current?.book.activeStrategy === experiment.candidateVersion,
    progress: {
      completed: forward?.cohort.forwardManifest?.tradingDates.length ?? 0,
      required:
        experiment.reservationPayload.singleForward?.forwardDays ??
        forward?.cohort.forwardDays ??
        null,
    },
  };
}

// 读取完整原始输入，核验在独立纯模块里执行；普通详情 GET 不运行拟合或重放。
export async function exportResearchExperiment(
  env,
  id,
  { evaluation = null } = {},
) {
  const detail = await researchExperimentDetail(env, id);
  if (!detail) return null;
  const db = env.DB;
  const manifest = detail.forward?.cohort.forwardManifest;
  const dates = manifest?.windowDates?.length
    ? manifest.windowDates
    : (manifest?.tradingDates ?? []);
  const rowsAt = async (table, date, column = "trade_date") =>
    (
      await db
        .prepare(`SELECT payload,digest FROM ${table} WHERE ${column}=?`)
        .bind(date)
        .all()
    ).results.map((row) => ({
      payload: JSON.parse(row.payload),
      digest: row.digest,
    }));
  const market = [];
  const snapshots = [];
  const quoteFrames = [];
  if (manifest?.captureDate) {
    const archive = (
      await db
        .prepare(
          "SELECT payload FROM snapshots WHERE trade_date<=? ORDER BY trade_date DESC LIMIT 15",
        )
        .bind(manifest.captureDate)
        .all()
    ).results;
    for (const row of archive) {
      const payload = JSON.parse(row.payload);
      snapshots.push({ payload, digest: await digestOf(payload) });
    }
  }
  for (const date of dates) {
    const dataset = (await rowsAt("paper_market_days", date))[0];
    if (dataset) market.push(dataset);
    const previousDate = dataset?.payload.previousTradingDate;
    if (previousDate) {
      const snapshot = await db
        .prepare("SELECT payload FROM snapshots WHERE trade_date=?")
        .bind(previousDate)
        .first();
      if (
        snapshot &&
        !snapshots.some((row) => row.payload.date === previousDate)
      )
        snapshots.push({
          payload: JSON.parse(snapshot.payload),
          digest: await digestOf(JSON.parse(snapshot.payload)),
        });
    }
    const frames = (
      await db
        .prepare(
          "SELECT sequence,payload,digest,observed_at FROM quote_frames WHERE trade_date=? ORDER BY sequence",
        )
        .bind(date)
        .all()
    ).results;
    quoteFrames.push({
      date,
      frames: frames.map((row) => ({
        sequence: row.sequence,
        payload: JSON.parse(row.payload),
        digest: row.digest,
        observedAt: row.observed_at,
      })),
    });
  }
  const accounts = [];
  for (const account of detail.forward?.accounts ?? []) {
    if (!manifest?.initialAccounts[account.accountId]) continue;
    const plans = (
      await db
        .prepare(
          "SELECT payload,digest FROM shadow_plans WHERE account_id=? ORDER BY signal_date",
        )
        .bind(account.accountId)
        .all()
    ).results.map((row) => ({
      payload: JSON.parse(row.payload),
      digest: row.digest,
    }));
    const equities = (
      await db
        .prepare(
          "SELECT trade_date,payload,digest FROM shadow_equity WHERE account_id=? ORDER BY trade_date",
        )
        .bind(account.accountId)
        .all()
    ).results
      .filter((row) => dates.includes(row.trade_date))
      .map((row) => ({
        tradeDate: row.trade_date,
        payload: JSON.parse(row.payload),
        digest: row.digest,
      }));
    const sessions = (
      await db
        .prepare(
          "SELECT trade_date,payload,digest FROM shadow_sessions WHERE account_id=? ORDER BY trade_date",
        )
        .bind(account.accountId)
        .all()
    ).results
      .filter((row) => dates.includes(row.trade_date))
      .map((row) => ({
        tradeDate: row.trade_date,
        payload: JSON.parse(row.payload),
        digest: row.digest,
      }));
    accounts.push({
      ...account,
      plans,
      equities,
      sessions,
      ledger: (
        await new ShadowAccountRepository(env).ledger(account.accountId)
      ).filter((fill) => dates.includes(fill.date)),
    });
  }
  const policy = await db
    .prepare("SELECT payload,digest FROM research_policy_versions WHERE id=?")
    .bind(detail.experiment.policyId)
    .first();
  const claims = (
    await db
      .prepare(
        "SELECT * FROM research_test_claims WHERE namespace='main' ORDER BY outcome_date",
      )
      .all()
  ).results;
  const uses = (
    await db
      .prepare(
        "SELECT experiment_id,role,outcome_date,payload,digest FROM research_sample_uses WHERE namespace='main' ORDER BY outcome_date,experiment_id,role",
      )
      .all()
  ).results;
  const stressRow = detail.forward
    ? await db
        .prepare(
          "SELECT payload FROM execution_stress_reports WHERE cohort_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .bind(detail.forward.cohort.id)
        .first()
    : null;
  const versions = (
    await db
      .prepare("SELECT id,params FROM strategy_versions WHERE id IN (?,?)")
      .bind(detail.experiment.parentVersion, detail.experiment.candidateVersion)
      .all()
  ).results.map((row) => ({ id: row.id, params: JSON.parse(row.params) }));
  return {
    format: "limit-lens-research-v1",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    ...detail,
    evaluation: evaluation ?? detail.forward?.evaluation ?? null,
    policy: policy
      ? { payload: JSON.parse(policy.payload), digest: policy.digest }
      : null,
    versions,
    market,
    snapshots,
    quoteFrames,
    accounts,
    claims,
    uses,
    executionStress: stressRow ? JSON.parse(stressRow.payload) : null,
    note: "研究财务与统计的可重放导出；摘要证明输入一致性，不是外部签名或未来收益保证",
  };
}

export async function assertSinglePromotionEvidence(env, id, evaluation) {
  const bundle = await exportResearchExperiment(env, id, { evaluation });
  const audit = await verifyResearchExport(bundle);
  if (!audit.eligibleForPromotion)
    throw new Error(`单候选完整核验未通过：${audit.reasons.join("；")}`);
  const end = evaluation.windowDates.at(-1);
  const elapsed = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM paper_market_days WHERE trade_date > ?",
  )
    .bind(end)
    .first();
  if (elapsed.n > 2)
    throw new Error("批准后已等待超过两个交易日，旧报告资格失效");
  const primary = await new RealtimeRepository(env).account();
  if (primary.book.lastDate < end)
    throw new Error("主账户尚未结算到前瞻窗口末日，不能启用");
  if (
    (await new ResearchRepository(env).getPolicy()).id !==
    bundle.experiment.policyId
  )
    throw new Error("批准后研究政策已变化，旧报告资格失效");
}

export async function promoteSingleCandidate(env, id) {
  const cohorts = new CohortRepository(env);
  const member = await cohorts.memberByExperiment(id);
  const cohort = member ? await cohorts.getCohort(member.cohortId) : null;
  if (!cohort || cohort.mode !== "SINGLE")
    throw new Error("历史通过不构成启用资格；单候选尚未完成前瞻影子验证");
  return promoteCohortChampion(env, cohort.id);
}

export async function rollbackResearchCandidate(env, id, reason) {
  if (typeof reason !== "string" || !reason.trim() || reason.length > 500)
    throw new Error("回退需填写 1–500 字原因");
  const db = env.DB;
  const readSwitch = async (type) => {
    const row = await db
      .prepare(
        "SELECT payload,digest FROM strategy_switch_events WHERE experiment_id=? AND event_type=?",
      )
      .bind(id, type)
      .first();
    if (!row) return null;
    const payload = JSON.parse(row.payload);
    if ((await digestOf(payload)) !== row.digest)
      throw new Error("策略切换事件摘要不一致");
    return payload;
  };
  const prior = await readSwitch("ROLLBACK");
  if (prior)
    return { rolledBack: true, duplicate: true, versionId: prior.toVersion };
  const promotion = await readSwitch("PROMOTE");
  if (!promotion) throw new Error("该实验没有可核验的启用事件，不能回退");
  const papers = new RealtimeRepository(env);
  const account = await papers.account();
  if (account.book.activeStrategy !== promotion.toVersion)
    throw new Error("当前策略已变化，不能回退其他实验的切换");
  const parent = await db
    .prepare("SELECT params FROM strategy_versions WHERE id=?")
    .bind(promotion.fromVersion)
    .first();
  if (
    !parent ||
    (await digestOf(JSON.parse(parent.params))) !== promotion.parentParamsDigest
  )
    throw new Error("父策略参数与原启用记录不一致，拒绝回退");
  const runId = crypto.randomUUID();
  const book = structuredClone(account.book);
  book.activeStrategy = promotion.fromVersion;
  const now = new Date().toISOString();
  const payload = {
    id: `switch-${runId}`,
    cohortId: promotion.cohortId,
    experimentId: id,
    eventType: "ROLLBACK",
    fromVersion: promotion.toVersion,
    toVersion: promotion.fromVersion,
    accountRevision: account.revision + 1,
    promotionEventId: promotion.id,
    reason: reason.trim(),
    frozenThroughSignalDate:
      (await papers.plan(book.lastDate))?.signalDate ?? null,
    bookBeforeDigest: await digestOf(account.book),
    bookAfterDigest: await digestOf(book),
    createdAt: now,
  };
  const guarded = (sql, args) =>
    db
      .prepare(
        `${sql} WHERE EXISTS(SELECT 1 FROM paper_accounts WHERE id='primary' AND revision=? AND last_run_id=?)`,
      )
      .bind(...args, account.revision + 1, runId);
  const research = new ResearchRepository(env);
  const previous = await research.lastEvent(id);
  const event = {
    sequence: (previous?.sequence ?? 0) + 1,
    eventType: "ROLLED_BACK",
    createdAt: now,
    payload: {
      switchEventId: payload.id,
      reason: payload.reason,
      fromVersion: payload.fromVersion,
      toVersion: payload.toVersion,
    },
    previousDigest: previous?.digest ?? null,
  };
  const results = await db.batch([
    db
      .prepare(
        "UPDATE paper_accounts SET state=?,revision=revision+1,last_run_id=?,updated_at=? WHERE id='primary' AND revision=? AND json_extract(state,'$.activeStrategy')=? AND EXISTS(SELECT 1 FROM strategy_versions WHERE id=? AND params=?)",
      )
      .bind(
        JSON.stringify(book),
        runId,
        now,
        account.revision,
        promotion.toVersion,
        promotion.fromVersion,
        parent.params,
      ),
    guarded(
      "UPDATE strategy_versions SET status=CASE WHEN id=? THEN 'ACTIVE' WHEN status='ACTIVE' THEN 'RETIRED' ELSE status END",
      [promotion.fromVersion],
    ),
    guarded(
      "INSERT INTO strategy_switch_events(id,cohort_id,experiment_id,event_type,from_version,to_version,account_revision,payload,digest,created_at) SELECT ?,?,?,'ROLLBACK',?,?,?,?,?,?",
      [
        payload.id,
        promotion.cohortId,
        id,
        payload.fromVersion,
        payload.toVersion,
        payload.accountRevision,
        JSON.stringify(payload),
        await digestOf(payload),
        now,
      ],
    ),
    db
      .prepare(
        "UPDATE research_experiments SET stage='ROLLED_BACK',revision=revision+1,last_run_id=? WHERE id=? AND EXISTS(SELECT 1 FROM paper_accounts WHERE id='primary' AND revision=? AND last_run_id=?)",
      )
      .bind(runId, id, account.revision + 1, runId),
    db
      .prepare(
        "UPDATE strategy_cohort_members SET stage='ROLLED_BACK',updated_at=? WHERE experiment_id=? AND EXISTS(SELECT 1 FROM paper_accounts WHERE id='primary' AND revision=? AND last_run_id=?)",
      )
      .bind(now, id, account.revision + 1, runId),
    guarded(
      "INSERT INTO research_events(experiment_id,sequence,event_type,created_at,payload,previous_digest,digest) SELECT ?,?,?,?,?,?,?",
      [
        id,
        event.sequence,
        event.eventType,
        now,
        JSON.stringify(event.payload),
        event.previousDigest,
        await eventDigest(event),
      ],
    ),
  ]);
  if (results[0].meta.changes !== 1) {
    const retry = await readSwitch("ROLLBACK");
    if (retry)
      return { rolledBack: true, duplicate: true, versionId: retry.toVersion };
    throw new Error("主账户被并发更新，回退未应用，请重试");
  }
  return {
    rolledBack: true,
    versionId: promotion.fromVersion,
    frozenThroughSignalDate: payload.frozenThroughSignalDate,
    note: "回退用于之后尚未冻结的计划；持仓、费用、风险峰值和已有盈亏保留",
  };
}
