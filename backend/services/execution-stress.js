import { PaperRepository } from "../storage/paper.js";
import { CohortRepository } from "../storage/cohorts.js";
import { BASE_STRATEGY } from "../domain/trading.js";
import { frozenSelectionPolicy } from "../domain/signal-selection.js";
import { digestOf } from "../domain/research-lineage.js";
import {
  replayExecutionStress,
  verifyExecutionStress,
  verifyStressFreeze,
} from "../domain/execution-stress.js";
import { calibrationForPolicy } from "./execution-calibration.js";
import { ShadowAccountRepository } from "../storage/shadow.js";
import { frozenProgramSignal } from "../storage/strategy-signals.js";
import { loadPersistedExitInputs } from "./exit-context.js";

export async function cohortStressInput(env, cohort, windowDates) {
  const frozen = cohort.reservationManifest?.executionStress;
  await verifyStressFreeze(frozen);
  const { reservationDigest, ...reservation } = cohort.reservationManifest;
  if ((await digestOf(reservation)) !== reservationDigest)
    throw new Error("成本压力的事前预留清单摘要不一致");
  const manifest = cohort.forwardManifest;
  if (
    (await digestOf(manifest.executionStress)) !== (await digestOf(frozen)) ||
    !manifest.initialBook ||
    (await digestOf(manifest.initialBook)) !== manifest.initialBookDigest ||
    manifest.initialBook.equityCents !== manifest.initialEquityCents
  )
    throw new Error("压力测试捕获起点或冻结政策不一致");
  if (
    windowDates.length !== manifest.requiredDays ||
    (await digestOf(windowDates)) !== (await digestOf(manifest.windowDates))
  )
    throw new Error("压力测试必须使用完整冻结前瞻窗口");
  const papers = new PaperRepository(env);
  const pairs = [];
  for (const date of windowDates) {
    const row = await env.DB.prepare(
      "SELECT payload, digest FROM paper_market_days WHERE trade_date=?",
    )
      .bind(date)
      .first();
    if (!row) throw new Error(`压力测试缺少市场日 ${date}`);
    const dataset = JSON.parse(row.payload);
    if ((await digestOf(dataset)) !== row.digest)
      throw new Error("压力行情摘要不一致");
    const referenceAccount =
      manifest.accounts?.candidates?.[0] ?? manifest.accounts?.parentMatch;
    const referencePlan = referenceAccount
      ? await new ShadowAccountRepository(env).plan(
          referenceAccount,
          dataset.previousTradingDate,
        )
      : null;
    const snapshot =
      (await frozenProgramSignal(env.DB, referencePlan)) ??
      (await papers.snapshot(dataset.previousTradingDate));
    if (!snapshot) throw new Error("压力测试缺少事前评分快照");
    const pair = { dataset, snapshot };
    // 卖出上下文与实盘引用同一固化版本（方案 5）：压力重放的卖出决策
    // 与主账户同源，不按当前 Parquet 重推。
    const exitInputs = await loadPersistedExitInputs(
      env.DB,
      dataset.previousTradingDate,
    );
    if (exitInputs) pair.exitContext = exitInputs;
    if (dataset.executionMode === "realtime") {
      const frames = (
        await env.DB.prepare(
          "SELECT payload, digest FROM quote_frames WHERE trade_date=? ORDER BY sequence",
        )
          .bind(date)
          .all()
      ).results;
      pair.observations = [];
      for (const frame of frames) {
        const payload = JSON.parse(frame.payload);
        if ((await digestOf(payload)) !== frame.digest)
          throw new Error("压力行情帧摘要不一致");
        pair.observations.push(payload);
      }
    }
    pairs.push(pair);
  }
  const strategies = { parent: frozen.parentParams, baseline: BASE_STRATEGY };
  for (const member of await new CohortRepository(env).members(cohort.id)) {
    if (!member.params || !member.strategyVersion) continue;
    if ((await digestOf(member.params)) !== member.paramsDigest)
      throw new Error("压力候选参数摘要不一致");
    const version = await env.DB.prepare(
      "SELECT params FROM strategy_versions WHERE id=?",
    )
      .bind(member.strategyVersion)
      .first();
    if (
      !version ||
      (await digestOf(JSON.parse(version.params))) !== member.paramsDigest
    )
      throw new Error("压力候选版本与冻结参数不一致");
    strategies[member.memberId] = member.params;
  }
  return {
    cohortId: cohort.id,
    frozen,
    calibration:
      frozen.policy.calibrationStatus === "PRIOR_UNCALIBRATED"
        ? null
        : await calibrationForPolicy(env, frozen.policy.id),
    pairs,
    initialBook: manifest.initialBook,
    strategies,
    feeConfig: manifest.feeConfig,
    selectionPolicy: frozenSelectionPolicy(manifest),
  };
}

export async function runCohortExecutionStress(env, cohort, windowDates) {
  const input = await cohortStressInput(env, cohort, windowDates);
  const inputDigest = await digestOf(input);
  const cached = await env.DB.prepare(
    "SELECT payload FROM execution_stress_reports WHERE cohort_id=? AND input_digest=?",
  )
    .bind(cohort.id, inputDigest)
    .first();
  if (cached) {
    const bundle = JSON.parse(cached.payload);
    await verifyExecutionStress(bundle);
    return bundle;
  }
  const taskId = `cost-task-${inputDigest}`,
    leaseOwner = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO research_tasks(id,owner_id,task_type,input_digest,stage,payload,created_at,updated_at) VALUES(?,?, 'EXECUTION_STRESS',?,'PENDING','{}',?,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(taskId, cohort.id, inputDigest, now, now)
    .run();
  const leased = await env.DB.prepare(
    "UPDATE research_tasks SET stage='RUNNING',lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND (stage IN ('PENDING','ERROR','DONE') OR (stage='RUNNING' AND lease_until<=?))",
  )
    .bind(
      leaseOwner,
      new Date(Date.now() + 120000).toISOString(),
      now,
      taskId,
      now,
    )
    .run();
  const busy = () =>
    Object.assign(
      new Error("成本压力任务正在计算或租约已改变，等待下次盘后恢复"),
      { code: "EXECUTION_STRESS_BUSY" },
    );
  if (!(leased.meta?.changes ?? leased.changes)) throw busy();
  let refreshedAt = Date.now();
  const cache = {
    async heartbeat(force = false) {
      if (!force && Date.now() - refreshedAt < 10000) return;
      const updated = await env.DB.prepare(
        "UPDATE research_tasks SET lease_until=?,updated_at=? WHERE id=? AND stage='RUNNING' AND lease_owner=?",
      )
        .bind(
          new Date(Date.now() + 120000).toISOString(),
          new Date().toISOString(),
          taskId,
          leaseOwner,
        )
        .run();
      if (!(updated.meta?.changes ?? updated.changes)) throw busy();
      refreshedAt = Date.now();
    },
    async load(multiplier, id) {
      const row = await env.DB.prepare(
        "SELECT payload,digest FROM execution_stress_paths WHERE input_digest=? AND multiplier=? AND strategy_id=?",
      )
        .bind(inputDigest, multiplier, id)
        .first();
      if (!row) return null;
      const path = JSON.parse(row.payload);
      if ((await digestOf(path)) !== row.digest)
        throw new Error("成本压力路径检查点摘要不一致");
      return path;
    },
    async save(multiplier, id, path) {
      await this.heartbeat(true);
      await env.DB.prepare(
        "INSERT INTO execution_stress_paths(input_digest,multiplier,strategy_id,payload,digest) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
      )
        .bind(
          inputDigest,
          multiplier,
          id,
          JSON.stringify(path),
          await digestOf(path),
        )
        .run();
    },
  };
  try {
    const source = {
      schemaVersion: 1,
      namespace: "execution-cost",
      input,
      result: await replayExecutionStress(input, cache),
    };
    const digest = await digestOf(source);
    const bundle = { ...source, id: `stress-${digest}`, digest };
    await cache.heartbeat(true);
    const saved = await env.DB.prepare(
      "INSERT INTO execution_stress_reports (id,cohort_id,input_digest,payload,digest,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM research_tasks WHERE id=? AND stage='RUNNING' AND lease_owner=? AND lease_until>?) ON CONFLICT(id) DO NOTHING",
    )
      .bind(
        bundle.id,
        cohort.id,
        inputDigest,
        JSON.stringify(bundle),
        digest,
        new Date().toISOString(),
        taskId,
        leaseOwner,
        new Date().toISOString(),
      )
      .run();
    if (!(saved.meta?.changes ?? saved.changes)) throw busy();
    await env.DB.prepare(
      "UPDATE research_tasks SET stage='DONE',output_digest=?,lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=?",
    )
      .bind(digest, new Date().toISOString(), taskId, leaseOwner)
      .run();
    return bundle;
  } catch (error) {
    await env.DB.prepare(
      "UPDATE research_tasks SET stage='ERROR',lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=?",
    )
      .bind(new Date().toISOString(), taskId, leaseOwner)
      .run()
      .catch(() => {});
    throw error;
  }
}

export async function exportExecutionStress(env, id, { verify = true } = {}) {
  const row = await env.DB.prepare(
    "SELECT payload FROM execution_stress_reports WHERE id=?",
  )
    .bind(id)
    .first();
  if (!row) throw new Error("成本压力报告不存在");
  const bundle = JSON.parse(row.payload);
  const { id: bundleId, digest, ...source } = bundle;
  if (
    bundleId !== id ||
    id !== `stress-${digest}` ||
    (await digestOf(source)) !== digest
  )
    throw new Error("成本压力报告 id 或摘要不一致");
  if (verify) await verifyExecutionStress(bundle);
  return bundle;
}

export async function assertCohortStressPromotion(env, cohort, report) {
  const input = await cohortStressInput(env, cohort, report.windowDates);
  if (!report.executionStress?.id) throw new Error("晋级报告缺少成本压力证据");
  const bundle = await exportExecutionStress(env, report.executionStress.id);
  if (
    (await digestOf(input)) !== (await digestOf(bundle.input)) ||
    report.executionStress.digest !== bundle.digest ||
    !bundle.result.passed[report.champion.memberId]
  )
    throw new Error("候选未通过全部冻结成本情景，或压力输入与批次不一致");
}
