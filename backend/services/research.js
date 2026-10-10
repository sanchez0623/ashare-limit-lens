import { aiConfig } from "./review.js";
import { feesForBook } from "../../shared/fees.js";
import { requestProposal } from "./improvement.js";
import { replayStrategy, validateCandidate } from "../domain/validation.js";
import { validateCandidatePatch } from "../domain/research-policy.js";
import {
  isAdjacentTradingDay,
  tradingAdjacency,
} from "../domain/historical-input.js";
import { openHistoryStore } from "../storage/history.js";
import {
  selectResearchWindows,
  beijingMonth,
} from "../domain/research-windows.js";
import {
  digestOf,
  EXECUTION_VERSION,
  SCORING_VERSION,
} from "../domain/research-lineage.js";
import { ResearchRepository } from "../storage/research.js";
import { safeError } from "../http.js";

const EXECUTOR_ID = crypto.randomUUID();
const REQUEST_LEASE_MS = 120000;

async function collectPairs(repository) {
  const dataRows = await repository.history("paper_market_days", 400);
  const snapshotRows = await repository.history("snapshots", 400);
  const snapshots = new Map(
    snapshotRows.map((row) => [row.trade_date, JSON.parse(row.payload)]),
  );
  const datasets = dataRows.map((row) => JSON.parse(row.payload)).reverse();
  const pairs = [];
  for (const day of datasets) {
    const snapshot = snapshots.get(day.previousTradingDate);
    if (!snapshot) continue;
    const pair = { dataset: day, snapshot };
    if (day.executionMode === "realtime") {
      const ticks = await repository.db
        .prepare(
          "SELECT payload FROM paper_live_ticks WHERE trade_date = ? ORDER BY sequence",
        )
        .bind(day.date)
        .all();
      pair.observations = ticks.results.map((row) => JSON.parse(row.payload));
    }
    pairs.push(pair);
  }
  return pairs;
}
async function buildSample(pair, role) {
  const observations = pair.observations ?? [];
  const payload = {
    decisionDate: pair.snapshot.date,
    tradeDate: pair.dataset.date,
    labelEndDate: pair.dataset.date,
    availableAt: pair.dataset.date,
    role,
    snapshotDigest: await digestOf(pair.snapshot),
    marketDigest: await digestOf(pair.dataset),
    quoteManifestDigest: await digestOf({
      date: pair.dataset.date,
      count: observations.length,
      observations: observations.map((tick) => ({
        observedAt: tick?.observedAt ?? null,
        pollIntervalSeconds: tick?.pollIntervalSeconds ?? null,
        quotes: Object.fromEntries(
          Object.entries(tick?.quotes ?? {}).map(([code, quote]) => [
            code,
            {
              timestamp: quote?.timestamp ?? null,
              previousCloseCents: quote?.previousCloseCents ?? null,
              openCents: quote?.openCents ?? null,
              closeCents: quote?.closeCents ?? null,
              limitUpCents: quote?.limitUpCents ?? null,
              limitDownCents: quote?.limitDownCents ?? null,
              volumeShares: quote?.volumeShares ?? null,
            },
          ]),
        ),
      })),
    }),
  };
  return {
    date: pair.dataset.date,
    role,
    payload,
    digest: await digestOf(payload),
  };
}
async function buildSamples(windows) {
  const samples = [];
  for (const pair of windows.training)
    samples.push(await buildSample(pair, "TRAIN"));
  for (const pair of windows.holdout)
    samples.push(await buildSample(pair, "HISTORICAL_TEST"));
  return samples;
}
async function evaluateAndConclude({
  research,
  experimentId,
  versionId,
  parentVersion,
  training,
  holdout,
  base,
  candidateParams,
  account,
  feeConfig,
  initialCapitalCents = null,
  attemptSequence,
  recovered = false,
}) {
  const validation = validateCandidate(
    training,
    holdout,
    base,
    candidateParams,
    initialCapitalCents !== null
      ? initialCapitalCents / 100
      : account.book.initialCashCents / 100,
    feeConfig,
  );
  const report = {
    experimentId,
    attemptSequence,
    parentVersion,
    candidateVersion: versionId,
    trainingDates: training.map((pair) => pair.dataset.date),
    testDates: holdout.map((pair) => pair.dataset.date),
    checks: validation.checks,
    baseline: {
      totalReturn: validation.baseline.totalReturn,
      maxDrawdown: validation.baseline.maxDrawdown,
      fillCount: validation.baseline.fillCount,
      days: validation.baseline.days,
    },
    candidateResult: {
      totalReturn: validation.candidate.totalReturn,
      maxDrawdown: validation.candidate.maxDrawdown,
      fillCount: validation.candidate.fillCount,
      days: validation.candidate.days,
    },
    feeConfig,
    initialCashCents: initialCapitalCents ?? account.book.initialCashCents,
    recovered,
    method:
      "历史筛查只提供进入影子阶段的资格；通过不代表可启用，前瞻影子验证由后续批次实施",
    passed: validation.passed,
  };
  const { stage } = await research.concludeHistorical(experimentId, versionId, {
    passed: validation.passed,
    report,
    reason: validation.passed
      ? recovered
        ? "中断的历史验证已幂等恢复并通过"
        : "历史筛查通过，等待影子账户阶段"
      : "历史筛查未通过，原策略继续运行",
  });
  return { stage, validation };
}
async function recoverExperiment(repository, env, research, active) {
  const experiment = active.experiment;
  if (!experiment) return { outcome: "BUSY_BLOCKED" };
  if (experiment.stage === "PROPOSING") {
    const events = await research.experimentEvents(experiment.id);
    const issued = events.find((event) => event.eventType === "REQUEST_ISSUED");
    const leaseStart =
      issued?.payload?.requestIssuedAt ??
      issued?.createdAt ??
      experiment.reservationPayload?.reservedAt ??
      experiment.createdAt;
    const leaseMs = Number(env.RESEARCH_REQUEST_LEASE_MS ?? REQUEST_LEASE_MS);
    const leaseElapsed = Date.now() - Date.parse(leaseStart);
    if (Number.isFinite(leaseElapsed) && leaseElapsed < leaseMs)
      return { outcome: "IN_FLIGHT", experimentId: experiment.id };
    try {
      await research.recordError(
        experiment.id,
        null,
        issued
          ? "提案在响应持久化前中断且已超出请求租约；按错误处理，不重新调用模型挑选参数，预算与日期占用保留"
          : "预留后未发出请求即中断且已超出预留租约；按错误处理，预算与日期占用保留",
        experiment.revision,
      );
      return { outcome: "ERROR", experimentId: experiment.id };
    } catch {
      return { outcome: "BUSY_BLOCKED", experimentId: experiment.id };
    }
  }
  if (experiment.stage === "HISTORICAL_CHECK") {
    const manifest = experiment.proposalManifest;
    const versionId = manifest?.versionId ?? experiment.candidateVersion;
    if (!manifest?.candidateParams || !versionId) {
      await research.recordError(
        experiment.id,
        versionId ?? null,
        "冻结清单不完整，无法恢复历史验证",
        experiment.revision,
      );
      return { outcome: "ERROR", experimentId: experiment.id };
    }
    const frozenTrainingDates =
      manifest.trainingDates ??
      experiment.reservationPayload.trainingDates ??
      [];
    const frozenTestDates =
      manifest.testDates ?? experiment.reservationPayload.testDates ?? [];
    const account = await repository.account();
    const currentFees = feesForBook(account.book);
    if (manifest.feeConfigDigest !== (await digestOf(currentFees))) {
      await research.recordInvalidated(
        experiment.id,
        versionId,
        "手续费配置自冻结后变更，恢复验证判定失效",
        experiment.revision,
      );
      return {
        outcome: "INVALIDATED",
        experimentId: experiment.id,
        reason: "手续费配置自冻结后变更",
      };
    }
    if (
      manifest.initialCashCents !== undefined &&
      manifest.initialCashCents !== account.book.initialCashCents
    ) {
      await research.recordInvalidated(
        experiment.id,
        versionId,
        "初始资金自冻结后变更，恢复验证判定失效",
        experiment.revision,
      );
      return {
        outcome: "INVALIDATED",
        experimentId: experiment.id,
        reason: "初始资金自冻结后变更",
      };
    }
    const base = await research.parentParams(experiment.parentVersion);
    if (!base || manifest.parentParamsDigest !== (await digestOf(base))) {
      await research.recordInvalidated(
        experiment.id,
        versionId,
        "父策略参数与冻结清单不一致，恢复验证判定失效",
        experiment.revision,
      );
      return {
        outcome: "INVALIDATED",
        experimentId: experiment.id,
        reason: "父策略参数与冻结清单不一致",
      };
    }
    const pairs = await collectPairs(repository);
    const byDate = new Map(pairs.map((pair) => [pair.dataset.date, pair]));
    const storedSamples = await research.experimentSamples(experiment.id);
    const storedByDate = new Map(
      storedSamples.map((sample) => [sample.outcomeDate, sample]),
    );
    const training = [];
    const holdout = [];
    for (const [dates, role, target] of [
      [frozenTrainingDates, "TRAIN", training],
      [frozenTestDates, "HISTORICAL_TEST", holdout],
    ]) {
      for (const date of dates) {
        const pair = byDate.get(date);
        if (!pair) {
          await research.recordInvalidated(
            experiment.id,
            versionId,
            `恢复验证所需日期 ${date} 的行情或快照缺失`,
            experiment.revision,
          );
          return {
            outcome: "INVALIDATED",
            experimentId: experiment.id,
            reason: `恢复验证所需日期 ${date} 的行情或快照缺失`,
          };
        }
        const recomputed = await buildSample(pair, role);
        const stored = storedByDate.get(date);
        if (
          !stored ||
          stored.role !== role ||
          stored.digest !== recomputed.digest
        ) {
          await research.recordInvalidated(
            experiment.id,
            versionId,
            `日期 ${date} 的快照、行情或报价内容与冻结样本摘要不一致`,
            experiment.revision,
          );
          return {
            outcome: "INVALIDATED",
            experimentId: experiment.id,
            reason: `日期 ${date} 的快照、行情或报价内容与冻结样本摘要不一致`,
          };
        }
        target.push(pair);
      }
    }
    if (!holdout.length) {
      await research.recordError(
        experiment.id,
        versionId,
        "冻结清单缺少测试日期，无法恢复历史验证",
        experiment.revision,
      );
      return { outcome: "ERROR", experimentId: experiment.id };
    }
    const { stage, validation } = await evaluateAndConclude({
      research,
      experimentId: experiment.id,
      versionId,
      parentVersion: experiment.parentVersion,
      training,
      holdout,
      base,
      candidateParams: manifest.candidateParams,
      account,
      feeConfig: manifest.feeConfig,
      initialCapitalCents: manifest.initialCashCents,
      attemptSequence: experiment.reservationPayload.attemptSequence ?? null,
      recovered: true,
    });
    return {
      outcome: stage,
      experimentId: experiment.id,
      version: versionId,
      checks: validation.checks,
    };
  }
  return { outcome: "BUSY_BLOCKED" };
}
export async function proposeImprovement(
  repository,
  env,
  propose = requestProposal,
) {
  const research = new ResearchRepository(env);
  const policy = await research.getPolicy();
  const account = await repository.account();
  const pairs = await collectPairs(repository);
  if (!aiConfig(env).configured)
    return {
      status: "NOT_CONFIGURED",
      days: pairs.length,
      reason: "配置服务端大模型密钥后启用真实 AI 提案",
    };
  const windows = selectResearchWindows(pairs, policy.payload);
  if (!windows.ready)
    return {
      status: "COLLECTING",
      days: pairs.length,
      required: {
        trainDays: policy.payload.trainDays,
        histTestDays: policy.payload.histTestDays,
      },
      reason: windows.reason,
    };
  const active = await research.activeExperiment();
  if (active) {
    let recovery;
    try {
      recovery = await recoverExperiment(repository, env, research, active);
    } catch {
      return {
        status: "BUSY",
        experimentId: active.experimentId,
        reason: "恢复权竞争失败，请稍后重试",
      };
    }
    if (recovery.outcome === "AWAITING_SHADOW")
      return {
        status: "AWAITING_SHADOW",
        experimentId: recovery.experimentId,
        version: recovery.version,
        checks: recovery.checks,
        reason: "检测到中断的历史验证，已幂等恢复完成；期间未调用模型",
      };
    if (recovery.outcome === "REJECTED")
      return {
        status: "REJECTED",
        experimentId: recovery.experimentId,
        checks: recovery.checks,
        reason: "中断的历史验证已恢复并判定未通过，原策略继续运行",
      };
    if (recovery.outcome === "INVALIDATED")
      return {
        status: "INVALIDATED",
        experimentId: recovery.experimentId,
        reason: recovery.reason ?? "冻结输入已变化，恢复验证判定失效",
      };
    if (recovery.outcome === "IN_FLIGHT")
      return {
        status: "BUSY",
        experimentId: active.experimentId,
        reason: "提案请求进行中（租约未到期），不判定为停机",
      };
    if (recovery.outcome === "BUSY_BLOCKED")
      return {
        status: "BUSY",
        experimentId: active.experimentId,
        reason: `实验处于 ${active.experiment?.stage ?? "未知"} 阶段，无法自动恢复`,
      };
  }
  const month = beijingMonth();
  const used = await research.monthUsage(month);
  if (used >= policy.payload.monthlyProposalLimit)
    return {
      status: "BUDGET_EXHAUSTED",
      month,
      used,
      limit: policy.payload.monthlyProposalLimit,
      reason: "本月提案次数已用完；失败与错误同样占用预算",
    };
  try {
    await research.assertReservationFreshness(windows.testDates);
  } catch (error) {
    return {
      status: "COLLECTING",
      days: pairs.length,
      reason: `等待未使用过的新测试日期：${error.message}`,
    };
  }
  const base = await repository.strategy(account.book);
  const feeConfig = feesForBook(account.book);
  const samples = await buildSamples(windows);
  let reserved;
  try {
    reserved = await research.reserveAttempt({
      policy,
      month,
      parentVersion: account.book.activeStrategy,
      windowPayload: {
        trainingStart: windows.trainingStart,
        trainingEnd: windows.trainingEnd,
        testStart: windows.testStart,
        testEnd: windows.testEnd,
        trainDays: policy.payload.trainDays,
        histTestDays: policy.payload.histTestDays,
        forwardDays: policy.payload.forwardDays,
        forwardRule: "前瞻窗口由后续批次按冻结规则登记与计数",
      },
      testDates: windows.testDates,
      samples,
    });
  } catch (error) {
    const reason = String(error?.message ?? error);
    if (reason.includes("不能同时作为冷启动训练数据"))
      return {
        status: "NEED_DATA",
        reason: `训练日期与已用测试数据冲突，未消耗冷启动资格：${reason}`,
      };
    return { status: "BUSY", reason: "并发预留冲突，本次未发起模型调用" };
  }
  if (!reserved)
    return { status: "BUSY", reason: "并发预留冲突，本次未发起模型调用" };
  const experimentId = reserved.experimentId;
  const requestIssuedAt = new Date().toISOString();
  await research.appendEvent(experimentId, "REQUEST_ISSUED", {
    attemptSequence: reserved.attemptSequence,
    executorId: EXECUTOR_ID,
    requestIssuedAt,
    trainingDates: windows.trainingDates,
    sampleManifestDigest: await digestOf(
      samples.map(({ payload, digest }) => ({ payload, digest })),
    ),
    note: "提案请求只携带训练窗口；测试行情不进入提示词或会话记忆",
  });
  let versionId = null;
  try {
    const proposal = await propose(
      env,
      base,
      windows.training,
      account.book.initialCashCents / 100,
      feeConfig,
    );
    const candidate = validateCandidatePatch({
      proposal,
      parentParams: base,
      frozenPolicy: policy.payload,
    });
    versionId = experimentId;
    const promptDigest =
      proposal.requestDigest ??
      (await digestOf({
        modelAlias: aiConfig(env).model,
        trainingDates: windows.trainingDates,
        evidenceDigest: proposal.evidenceDigest ?? null,
      }));
    await research.freezeCandidate(experimentId, {
      versionId,
      params: candidate.params,
      patch: candidate.patch,
      rationale: candidate.rationale,
      policyId: policy.id,
      modelAlias: aiConfig(env).model,
      modelVersionReported: null,
      promptDigest,
      output: { rationale: candidate.rationale, patch: candidate.patch },
      trainingDates: windows.trainingDates,
      testDates: windows.testDates,
      parentVersion: account.book.activeStrategy,
      parentParamsDigest: await digestOf(base),
      feeConfig,
      feeConfigDigest: await digestOf(feeConfig),
      initialCashCents: account.book.initialCashCents,
      executionVersion: EXECUTION_VERSION,
      scoringVersion: SCORING_VERSION,
    });
    const { stage, validation } = await evaluateAndConclude({
      research,
      experimentId,
      versionId,
      parentVersion: account.book.activeStrategy,
      training: windows.training,
      holdout: windows.holdout,
      base,
      candidateParams: candidate.params,
      account,
      feeConfig,
      attemptSequence: reserved.attemptSequence,
    });
    return {
      status: stage === "AWAITING_SHADOW" ? "AWAITING_SHADOW" : "REJECTED",
      experimentId,
      version: versionId,
      checks: validation.checks,
      attemptSequence: reserved.attemptSequence,
      reason:
        stage === "AWAITING_SHADOW"
          ? "历史筛查通过；前瞻影子验证尚未实施，期间不提供任何启用资格"
          : "历史筛查未通过，原策略继续运行",
    };
  } catch (error) {
    await research
      .recordError(experimentId, versionId, safeError(error))
      .catch(() => {});
    return {
      status: "ERROR",
      experimentId,
      reason: "提案或历史验证失败；本次尝试已占用预算与日期，原策略继续运行",
    };
  }
}
export async function proposeBootstrapImprovement(
  repository,
  env,
  { datasetId } = {},
  propose = requestProposal,
) {
  const research = new ResearchRepository(env);
  const policy = await research.getPolicy();
  const minTrainingDays = policy.payload.bootstrapMinTrainingDays ?? 20;
  if (!aiConfig(env).configured)
    return {
      status: "NOT_CONFIGURED",
      reason: "配置服务端大模型密钥后启用 AI 冷启动初始化",
    };
  const account = await repository.account();
  const registry = await research.ensureRegistry();
  if (registry.bootstrapDone)
    return {
      status: "BOOTSTRAP_DONE",
      reason: "AI 冷启动初始化全局仅一次；失败与错误同样视为已消耗",
    };
  const store = openHistoryStore(env);
  const dataset = store && datasetId ? await store.getDataset(datasetId) : null;
  if (!dataset)
    return {
      status: "NEED_DATA",
      reason: store
        ? "请指定六因子历史评分数据集（SIX_FACTOR_V1）"
        : "AI 冷启动训练依赖本机历史研究存储：请配置 LOCAL_RESEARCH_DB_PATH 后在本机运行",
    };
  if (dataset.executionModel !== "SIX_FACTOR_V1")
    return {
      status: "NEED_DATA",
      reason: "冷启动训练需要六因子历史评分数据集",
    };
  const integrity = await store.datasetIntegrity(datasetId);
  if (integrity && !integrity.verified)
    return {
      status: "NEED_DATA",
      reason:
        "数据集 manifest 校验失败：输入与发布时不一致（可能被修改），拒绝用于冷启动训练",
    };
  const scores = await store.listScores(datasetId);
  const trainingPairs = [];
  const trainingDates = [];
  const samples = [];
  const adjacency = tradingAdjacency(dataset.coverage);
  for (let index = 0; index + 1 < scores.length; index++) {
    const signal = scores[index];
    const nextDate = scores[index + 1].tradeDate;
    if (!isAdjacentTradingDay(adjacency, signal.tradeDate, nextDate)) continue;
    const nextBars = await store.getObservationDaily(datasetId, nextDate);
    const signalBars = await store.getObservationDaily(
      datasetId,
      signal.tradeDate,
    );
    if (!nextBars || !Object.keys(nextBars).length) continue;
    const quotes = {};
    for (const [code, bar] of Object.entries(nextBars)) {
      const previousBar = signalBars ? signalBars[code] : null;
      if (!previousBar || !(previousBar.closeCents > 0)) continue;
      const previousCloseCents = previousBar.closeCents;
      if (bar.closeCents === null || bar.closeCents === undefined) continue;
      quotes[code] = {
        date: nextDate,
        previousCloseCents,
        openCents: bar.openCents ?? previousCloseCents,
        closeCents: bar.closeCents,
        highCents: bar.highCents ?? bar.closeCents,
        lowCents: bar.lowCents ?? bar.closeCents,
        volumeShares: bar.volumeShares ?? null,
        limitUpCents: Math.round(previousCloseCents * 1.1),
        limitDownCents: Math.round(previousCloseCents * 0.9),
        timestamp: `${nextDate}T15:00:00+08:00`,
      };
    }
    if (!Object.keys(quotes).length) continue;
    trainingPairs.push({
      snapshot: signal.payload,
      dataset: {
        date: nextDate,
        previousTradingDate: signal.tradeDate,
        quotes,
        minutes: {},
        source: `历史冷启动（${dataset.provider}，真实前复权日线）`,
        fetchedAt: new Date().toISOString(),
      },
    });
    trainingDates.push(nextDate);
    samples.push({
      date: nextDate,
      payload: {
        role: "HISTORICAL_TRAIN",
        signalDate: signal.tradeDate,
        datasetId,
        datasetManifestDigest: dataset.manifestDigest,
        scoreDigest: signal.digest,
      },
      digest: await digestOf({
        scoreDigest: signal.digest,
        nextDate,
        datasetManifestDigest: dataset.manifestDigest,
      }),
    });
  }
  if (trainingPairs.length < minTrainingDays)
    return {
      status: "NEED_DATA",
      days: trainingPairs.length,
      required: minTrainingDays,
      reason: `历史训练对不足（需要至少 ${minTrainingDays} 个信号-次日对）`,
    };
  const active = await research.activeExperiment();
  if (active)
    return {
      status: "BUSY",
      experimentId: active.experimentId,
      reason: "存在进行中的研究实验（冷启动与滚动提案共用活动槽）",
    };
  const month = beijingMonth();
  const used = await research.monthUsage(month);
  if (used >= policy.payload.monthlyProposalLimit)
    return {
      status: "BUDGET_EXHAUSTED",
      month,
      used,
      limit: policy.payload.monthlyProposalLimit,
      reason: "本月提案次数已用完；冷启动同样消耗预算",
    };
  const base = await repository.strategy(account.book);
  const feeConfig = feesForBook(account.book);
  const dryRun = replayStrategy(
    trainingPairs,
    base,
    account.book.initialCashCents / 100,
    feeConfig,
  );
  if (dryRun.covered === false || !dryRun.days)
    return {
      status: "NEED_DATA",
      days: trainingPairs.length,
      replayDays: dryRun.days,
      reason: `历史训练窗口无法重放（${dryRun.reason ?? "无有效重放日"}）；未消耗冷启动资格`,
    };
  let reserved;
  try {
    reserved = await research.reserveBootstrapAttempt({
      policy,
      month,
      parentVersion: account.book.activeStrategy,
      windowPayload: {
        kind: "BOOTSTRAP",
        datasetId,
        datasetManifestDigest: dataset.manifestDigest,
        trainingDays: trainingPairs.length,
        note: "AI 冷启动一次性初始化；训练日期登记为 HISTORICAL_TRAIN，不再用于未来前瞻测试",
      },
      trainingDates,
      samples,
      datasetId,
      datasetManifestDigest: dataset.manifestDigest,
    });
  } catch {
    return { status: "BUSY", reason: "并发预留冲突，本次未发起模型调用" };
  }
  if (!reserved)
    return { status: "BOOTSTRAP_DONE", reason: "冷启动资格已被并发流程消耗" };
  const experimentId = reserved.experimentId;
  await research.appendEvent(experimentId, "REQUEST_ISSUED", {
    attemptSequence: reserved.attemptSequence,
    executorId: EXECUTOR_ID,
    requestIssuedAt: new Date().toISOString(),
    trainingDates,
    datasetId,
    datasetManifestDigest: dataset.manifestDigest,
    note: "冷启动提案只携带历史训练窗口；无一次性测试日期消费",
  });
  let versionId = null;
  try {
    const proposal = await propose(
      env,
      base,
      trainingPairs,
      account.book.initialCashCents / 100,
      feeConfig,
    );
    const candidate = validateCandidatePatch({
      proposal,
      parentParams: base,
      frozenPolicy: policy.payload,
    });
    versionId = experimentId;
    await research.freezeCandidate(
      experimentId,
      {
        versionId,
        params: candidate.params,
        patch: candidate.patch,
        rationale: candidate.rationale,
        policyId: policy.id,
        modelAlias: aiConfig(env).model,
        modelVersionReported: null,
        promptDigest:
          proposal.requestDigest ??
          (await digestOf({
            modelAlias: aiConfig(env).model,
            trainingDates,
            evidenceDigest: proposal.evidenceDigest ?? null,
          })),
        output: { rationale: candidate.rationale, patch: candidate.patch },
        trainingDates,
        testDates: [],
        parentVersion: account.book.activeStrategy,
        parentParamsDigest: await digestOf(base),
        feeConfig,
        feeConfigDigest: await digestOf(feeConfig),
        initialCashCents: account.book.initialCashCents,
        executionVersion: EXECUTION_VERSION,
        scoringVersion: SCORING_VERSION,
      },
      "PROPOSING",
    );
    const baselineReplay = replayStrategy(
      trainingPairs,
      base,
      account.book.initialCashCents / 100,
      feeConfig,
    );
    const candidateReplay = replayStrategy(
      trainingPairs,
      candidate.params,
      account.book.initialCashCents / 100,
      feeConfig,
    );
    const { stage } = await research.concludeBootstrap(
      experimentId,
      versionId,
      {
        report: {
          experimentId,
          attemptSequence: reserved.attemptSequence,
          kind: "BOOTSTRAP",
          datasetId,
          datasetManifestDigest: dataset.manifestDigest,
          trainingDates,
          screen: {
            baseline: {
              totalReturn: baselineReplay.totalReturn,
              maxDrawdown: baselineReplay.maxDrawdown,
              fillCount: baselineReplay.fillCount,
            },
            candidate: {
              totalReturn: candidateReplay.totalReturn,
              maxDrawdown: candidateReplay.maxDrawdown,
              fillCount: candidateReplay.fillCount,
            },
            note: "开发屏幕仅为记录性指标，不构成验证或启用资格；候选等待未来前瞻影子验证",
          },
        },
        reason: "冷启动候选已冻结并登记为等待前瞻影子验证",
      },
    );
    return {
      status: stage === "AWAITING_SHADOW" ? "AWAITING_SHADOW" : "ERROR",
      experimentId,
      version: versionId,
      attemptSequence: reserved.attemptSequence,
      reason: "冷启动候选已冻结，直接进入前瞻影子队列；期间不提供任何启用资格",
    };
  } catch (error) {
    await research
      .recordError(experimentId, versionId, safeError(error))
      .catch(() => {});
    return {
      status: "ERROR",
      experimentId,
      reason: `冷启动提案失败（${safeError(error)}）；一次性资格与预算已消耗，原策略继续运行`,
    };
  }
}
export async function promoteCandidate(repository, env, id) {
  const research = new ResearchRepository(env);
  if (/^ai-\d{4}-\d{2}-\d{2}$/.test(id))
    throw new Error(
      "旧历史验证通过不再具有启用资格；请通过新研究流程使用新测试日期重新验证",
    );
  const experiment = await research.getExperiment(id);
  if (!experiment) throw new Error("研究实验不存在");
  if (experiment.stage !== "PROMOTED")
    throw new Error(
      `只有完成前瞻影子验证的实验才能启用（当前阶段：${experiment.stage}）；历史筛查通过不构成启用资格`,
    );
  return repository.activate(id);
}
export async function researchStatus(env) {
  const research = new ResearchRepository(env);
  const registry = await research.ensureRegistry();
  const policy = await research.getPolicy();
  const active = await research.activeExperiment();
  const month = beijingMonth();
  const used = await research.monthUsage(month);
  const experiments = await research.listExperiments(20);
  return {
    namespace: registry.namespace,
    bootstrapDone: registry.bootstrapDone,
    policy: {
      id: policy.id,
      digest: policy.digest,
      trainDays: policy.payload.trainDays,
      histTestDays: policy.payload.histTestDays,
      forwardDays: policy.payload.forwardDays,
      monthlyProposalLimit: policy.payload.monthlyProposalLimit,
      methodNote: policy.payload.methodNote,
    },
    registry: {
      attemptSequence: registry.attemptSequence,
      legacyCutoff: registry.legacyCutoff,
      legacyIncomplete: registry.payload.legacyIncomplete ?? false,
      legacyBackfillDone: registry.payload.legacyBackfillDone ?? false,
    },
    activeExperiment: active
      ? {
          experimentId: active.experimentId,
          stage: active.experiment?.stage ?? null,
          window: active.windowPayload,
          createdAt: active.createdAt,
        }
      : null,
    budget: { month, used, limit: policy.payload.monthlyProposalLimit },
    experiments: experiments.map((experiment) => ({
      experimentId: experiment.id,
      stage: experiment.stage,
      parentVersion: experiment.parentVersion,
      candidateVersion: experiment.candidateVersion,
      createdAt: experiment.createdAt,
    })),
    note: "启用必须通过完整前瞻验证；历史筛查通过不具有启用资格",
  };
}
