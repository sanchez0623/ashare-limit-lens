import { aiConfig } from "./review.js";
import { feesForBook } from "../../shared/fees.js";
import { requestProposal } from "./improvement.js";
import { validateCandidate } from "../domain/validation.js";
import { validateCandidatePatch } from "../domain/research-policy.js";
import {
  selectResearchWindows,
  beijingMonth,
} from "../domain/research-windows.js";
import { digestOf } from "../domain/research-lineage.js";
import { ResearchRepository } from "../storage/research.js";
import { safeError } from "../http.js";

async function collectPairs(repository) {
  const dataRows = await repository.history("paper_market_days", 400);
  const snapshotRows = await repository.history("snapshots", 400);
  const snapshots = new Map(
    snapshotRows.map((row) => [row.trade_date, JSON.parse(row.payload)]),
  );
  const datasets = dataRows.map((row) => JSON.parse(row.payload)).reverse();
  return datasets
    .filter((day) => snapshots.has(day.previousTradingDate))
    .map((dataset) => ({
      dataset,
      snapshot: snapshots.get(dataset.previousTradingDate),
    }));
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
  if (active)
    return {
      status: "BUSY",
      experimentId: active.experimentId,
      reason: "同一研究空间同时只允许一个未结束的验证窗口",
    };
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
    await research.assertFreshOutcomeDates(windows.testDates);
  } catch (error) {
    return {
      status: "COLLECTING",
      days: pairs.length,
      reason: `等待未使用过的新测试日期：${error.message}`,
    };
  }
  const base = await repository.strategy(account.book);
  const feeConfig = feesForBook(account.book);
  let reserved;
  try {
    reserved = await research.reserveAttempt({
      policy,
      month,
      trainingDates: windows.trainingDates,
      testDates: windows.testDates,
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
    });
  } catch {
    return { status: "BUSY", reason: "并发预留冲突，本次未发起模型调用" };
  }
  if (!reserved)
    return { status: "BUSY", reason: "并发预留冲突，本次未发起模型调用" };
  const experimentId = reserved.experimentId;
  await research.appendEvent(experimentId, "REQUEST_ISSUED", {
    attemptSequence: reserved.attemptSequence,
    trainingDates: windows.trainingDates,
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
    const promptDigest = await digestOf({
      modelAlias: aiConfig(env).model,
      trainingDates: windows.trainingDates,
      evidenceDigest: proposal.evidenceDigest ?? null,
    });
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
      parentVersion: account.book.activeStrategy,
    });
    const validation = validateCandidate(
      windows.training,
      windows.holdout,
      base,
      candidate.params,
      account.book.initialCashCents / 100,
      feeConfig,
    );
    const report = {
      experimentId,
      attemptSequence: reserved.attemptSequence,
      parentVersion: account.book.activeVersion ?? account.book.activeStrategy,
      candidateVersion: versionId,
      trainingDates: windows.trainingDates,
      testDates: windows.testDates,
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
      initialCashCents: account.book.initialCashCents,
      method:
        "历史筛查只提供进入影子阶段的资格；通过不代表可启用，前瞻影子验证由后续批次实施",
      passed: validation.passed,
    };
    const { stage } = await research.concludeHistorical(
      experimentId,
      versionId,
      {
        passed: validation.passed,
        report,
        reason: validation.passed
          ? "历史筛查通过，等待影子账户阶段"
          : "历史筛查未通过，原策略继续运行",
      },
    );
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
