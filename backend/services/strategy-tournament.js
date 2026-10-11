import { ResearchRepository } from "../storage/research.js";
import { CohortRepository } from "../storage/cohorts.js";
import {
  ShadowAccountRepository,
  SHADOW_ACCOUNT_KINDS,
} from "../storage/shadow.js";
import { QuoteFrameRepository } from "../storage/quotes.js";
import { RealtimeRepository } from "../storage/realtime.js";
import { collectPairs, buildSamples } from "./research.js";
import {
  selectResearchWindows,
  beijingMonth,
} from "../domain/research-windows.js";
import { validateCandidatePatch } from "../domain/research-policy.js";
import { validateCandidate } from "../domain/validation.js";
import { BASE_STRATEGY } from "../domain/trading.js";
import {
  digestOf,
  eventDigest,
  EXECUTION_VERSION,
  SCORING_VERSION,
} from "../domain/research-lineage.js";
import { feesForBook } from "../../shared/fees.js";
import { aiConfig } from "./review.js";
import { requestCohortProposal } from "./improvement.js";
import {
  computeStatisticsBudget,
  frozenParamDistance,
} from "../domain/cohort-policy.js";
import {
  resampleIndexMatrix,
  pairedLowerBoundTest,
  dailyReturns,
} from "../domain/research-statistics.js";
import {
  windowMetrics,
  completeRounds,
  rankEligibleMembers,
  unrealizedPnlCents,
} from "../domain/cohort-metrics.js";
import { safeError } from "../http.js";
import { pollTrading } from "./realtime.js";
import { captureQuoteFrame } from "./quote-stream.js";
import {
  consumePortfolioFrame,
  settlePortfolioDay,
  freezePortfolioPlan,
} from "./portfolio-runner.js";
import { promoteCohortChampion } from "./promotion.js";

const REQUEST_LEASE_MS = 120000;
const continuousBaselineId = "shadow-baseline-continuous";

function captureState(book) {
  return {
    equityCents: book.equityCents,
    feesCents: book.feesCents,
    realizedPnlCents: book.realizedPnlCents,
    unrealizedPnlCents: unrealizedPnlCents(book),
  };
}
// ---------- 批次预留：一次生成并冻结全部候选（§3/§5.1） ----------
export async function reserveCohort(
  repository,
  env,
  { propose = requestCohortProposal } = {},
) {
  const cohorts = new CohortRepository(env);
  const research = new ResearchRepository(env);
  const policy = await cohorts.getTournamentPolicy();
  const researchPolicy = await research.getPolicy();
  await research.ensureRegistry();
  const account = await repository.account();
  if (!account?.book)
    return { status: "COLLECTING", reason: "主账户尚未初始化" };
  const pairs = await collectPairs(repository);
  if (!aiConfig(env).configured && propose === requestCohortProposal)
    return {
      status: "NOT_CONFIGURED",
      reason: "配置服务端大模型密钥后启用赛马批次生成",
    };
  const windows = selectResearchWindows(pairs, researchPolicy.payload);
  if (!windows.ready)
    return {
      status: "COLLECTING",
      days: pairs.length,
      reason: windows.reason,
    };
  const owner = await cohorts.windowOwner();
  if (owner)
    return {
      status: "BUSY",
      reason:
        owner.ownerType === "COHORT"
          ? "已有赛马批次占用研究窗口"
          : "已有单候选实验占用研究窗口",
    };
  const active = await cohorts.activeCohort();
  if (active) {
    if (active.stage === "PROPOSING") {
      const recovery = await recoverStuckCohort(env, active);
      if (recovery === "IN_FLIGHT")
        return {
          status: "BUSY",
          cohortId: active.id,
          reason: "赛马候选请求进行中（租约未到期），不判定为停机",
        };
      return {
        status: "ERROR",
        cohortId: active.id,
        reason: "上一个批次在候选冻结前中断，已按错误收尾；预算与日期占用保留",
      };
    }
    return {
      status: "BUSY",
      cohortId: active.id,
      reason: `已有赛马批次处于 ${active.stage} 阶段`,
    };
  }
  const month = beijingMonth();
  const used = await research.monthUsage(month);
  if (used >= policy.payload.monthlyGenerationLimit)
    return {
      status: "BUDGET_EXHAUSTED",
      month,
      used,
      limit: policy.payload.monthlyGenerationLimit,
      reason: "本月生成批次预算已用完；AI 与人工模板共用生成批次预算",
    };
  // 统计计算预算作为事前资格检查（§5.3）：不足时返回 COMPUTE_BUDGET_INSUFFICIENT。
  const registry = await research.ensureRegistry();
  const memberCount = policy.payload.maxCandidates;
  const ks = Array.from(
    { length: memberCount },
    (_, index) => registry.attemptSequence + index + 1,
  );
  const budget = computeStatisticsBudget({
    ks,
    statistical: policy.payload.statistical,
  });
  if (!budget.sufficient)
    return {
      status: "COMPUTE_BUDGET_INSUFFICIENT",
      requiredResamples: budget.requiredResamples,
      resampleCap: budget.resampleCap,
      ks,
      reason: budget.note,
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
  const feeConfigDigest = await digestOf(feeConfig);
  const samples = await buildSamples(windows);
  let reserved;
  try {
    reserved = await cohorts.reserveCohort({
      cohortPolicy: policy,
      researchPolicy,
      month,
      parentVersion: account.book.activeStrategy,
      windowPayload: {
        trainingStart: windows.trainingStart,
        trainingEnd: windows.trainingEnd,
        testStart: windows.testStart,
        testEnd: windows.testEnd,
        trainDays: researchPolicy.payload.trainDays,
        histTestDays: researchPolicy.payload.histTestDays,
        forwardDays: policy.payload.forwardDays,
        forwardRule: "前瞻窗口按冻结交易日计数，不因缺失顺延",
      },
      testDates: windows.testDates,
      samples,
      forwardDays: policy.payload.forwardDays,
      cohortPolicyPayload: policy.payload,
      statisticsBudget: {
        alphaPerComparison: budget.alphaPerComparison,
        resamples: budget.resamples,
        blockLength: budget.blockLength,
      },
      feeConfig,
      feeConfigDigest,
    });
  } catch (error) {
    return {
      status: "BUSY",
      reason: `并发预留冲突，本次未发起模型调用：${safeError(error)}`,
    };
  }
  if (!reserved)
    return { status: "BUSY", reason: "并发预留冲突，本次未发起模型调用" };
  const cohortId = reserved.cohortId;
  const requestIssuedAt = new Date().toISOString();
  await appendCohortEvent(cohorts, cohortId, "REQUEST_ISSUED", {
    requestIssuedAt,
    attemptSequences: reserved.members.map((member) => member.k),
    trainingDates: windows.trainingDates,
    sampleManifestDigest: await digestOf(
      samples.map(({ payload, digest }) => ({ payload, digest })),
    ),
    note: "模型请求只携带训练窗口；测试行情不进入提示词或会话记忆",
  });
  let modelOutput = null;
  let modelError = null;
  try {
    modelOutput = await propose(
      env,
      base,
      windows.training,
      account.book.initialCashCents / 100,
      feeConfig,
      memberCount,
    );
  } catch (error) {
    modelError = safeError(error);
  }
  const members = [];
  const seenDigests = new Set();
  const parentParamsDigest = await digestOf(base);
  for (const member of reserved.members) {
    const memberId = member.memberId;
    if (modelError) {
      members.push({
        memberId,
        stage: "ERROR",
        failureReason: modelError,
      });
      await cohorts
        .transitionMember(cohortId, memberId, {
          from: "PROPOSING",
          to: "ERROR",
          failureReason: modelError,
        })
        .catch(() => {});
      continue;
    }
    const output = modelOutput.candidates[member.slotIndex - 1];
    try {
      const candidate = validateCandidatePatch({
        proposal: output,
        parentParams: base,
        frozenPolicy: researchPolicy.payload,
      });
      const paramsDigest = await digestOf(candidate.params);
      if (seenDigests.has(paramsDigest))
        throw new Error("候选与同批其他成员重复，登记为失败并占用尝试序号");
      seenDigests.add(paramsDigest);
      const versionId = member.experimentId;
      const promptDigest =
        modelOutput.requestDigest ??
        (await digestOf({
          modelAlias: aiConfig(env).model,
          trainingDates: windows.trainingDates,
          evidenceDigest: modelOutput.evidenceDigest ?? null,
        }));
      await cohorts.freezeMemberExperiment(member.experimentId, {
        cohortId,
        memberId,
        versionId,
        attemptSequence: member.k,
        candidateParams: candidate.params,
        patch: candidate.patch,
        rationale: candidate.rationale,
        paramsDigest,
        policyId: researchPolicy.id,
        cohortPolicyId: policy.id,
        modelAlias: aiConfig(env).model,
        modelVersionReported: null,
        promptDigest,
        output: { rationale: candidate.rationale, patch: candidate.patch },
        trainingDates: windows.trainingDates,
        testDates: windows.testDates,
        parentVersion: account.book.activeStrategy,
        parentParamsDigest,
        feeConfig,
        feeConfigDigest,
        initialCashCents: account.book.initialCashCents,
        executionVersion: EXECUTION_VERSION,
        scoringVersion: SCORING_VERSION,
        frozenAt: new Date().toISOString(),
      });
      await cohorts.updateMember(cohortId, memberId, {
        strategy_version: versionId,
        params: candidate.params,
        params_digest: paramsDigest,
        params_distance: frozenParamDistance(candidate.params, base),
      });
      members.push({
        memberId,
        stage: "HISTORICAL_CHECK",
        versionId,
        paramsDigest,
      });
    } catch (error) {
      const failureReason = safeError(error);
      members.push({ memberId, stage: "ERROR", failureReason });
      await cohorts
        .transitionMember(cohortId, memberId, {
          from: "PROPOSING",
          to: "ERROR",
          failureReason,
        })
        .catch(() => {});
    }
  }
  const liveMembers = members.filter((member) => member.versionId);
  await cohorts.transitionCohort(cohortId, {
    from: "PROPOSING",
    to: "FROZEN",
    eventType: "CANDIDATES_FROZEN",
    payload: {
      modelAlias: aiConfig(env).model,
      promptDigest: modelOutput?.requestDigest ?? null,
      members: members.map((member) => ({
        memberId: member.memberId,
        stage: member.stage,
        versionId: member.versionId ?? null,
      })),
      statisticsBudget: {
        alphaPerComparison: budget.alphaPerComparison,
        resamples: budget.resamples,
        blockLength: budget.blockLength,
      },
    },
    set: {
      proposal_manifest: JSON.stringify({
        frozenAt: new Date().toISOString(),
        modelAlias: modelError ? null : aiConfig(env).model,
        promptDigest: modelOutput?.requestDigest ?? null,
        evidenceDigest: modelOutput?.evidenceDigest ?? null,
        requestDigest: modelOutput?.requestDigest ?? null,
        members,
        statisticsBudget: {
          alphaPerComparison: budget.alphaPerComparison,
          resamples: budget.resamples,
          blockLength: budget.blockLength,
        },
        feeConfig,
        feeConfigDigest,
        note: "全部合法候选的参数在任何成员进行历史测试收益计算前持久化；失败成员保留并占用序号",
      }),
    },
  });
  if (!liveMembers.length) {
    await closeCohort(
      cohorts,
      cohortId,
      "FROZEN",
      "全部候选生成失败，批次结束；预算与日期占用保留",
    );
    return {
      status: "ERROR",
      cohortId,
      members,
      reason: "全部候选生成失败；批次已结束，本月生成预算与尝试序号保留",
    };
  }
  // 历史筛查：候选与共同对照在同一冻结测试窗口上比较（§5.2 共享测试日期）。
  await cohorts.transitionCohort(cohortId, {
    from: "FROZEN",
    to: "HISTORICAL_CHECK",
    eventType: "HISTORICAL_CHECK_STARTED",
    payload: { members: liveMembers.length },
  });
  const historical = [];
  for (const member of liveMembers) {
    const memberRow = await cohorts.member(cohortId, member.memberId);
    const validation = validateCandidate(
      windows.training,
      windows.holdout,
      base,
      memberRow.params,
      account.book.initialCashCents / 100,
      feeConfig,
    );
    const passed = validation.passed;
    await cohorts.transitionMember(cohortId, member.memberId, {
      from: "HISTORICAL_CHECK",
      to: passed ? "SCHEDULED" : "REJECTED",
    });
    historical.push({
      memberId: member.memberId,
      passed,
      checks: validation.checks,
    });
  }
  const scheduled = historical.filter((row) => row.passed).length;
  for (const row of historical) {
    const entry = members.find((member) => member.memberId === row.memberId);
    if (entry) entry.stage = row.passed ? "SCHEDULED" : "REJECTED";
  }
  if (!scheduled) {
    await closeCohort(
      cohorts,
      cohortId,
      "HISTORICAL_CHECK",
      "历史筛查全部未通过，批次结束；不登记前瞻窗口",
    );
    return {
      status: "REJECTED",
      cohortId,
      members,
      historical,
      reason: "全部候选历史筛查未通过；批次已结束，测试日期与预算保留",
    };
  }
  await cohorts.transitionCohort(cohortId, {
    from: "HISTORICAL_CHECK",
    to: "SCHEDULED",
    eventType: "HISTORICAL_CHECK_DONE",
    payload: { scheduled, rejected: historical.length - scheduled },
    set: {
      proposal_manifest: JSON.stringify({
        frozenAt: new Date().toISOString(),
        historical,
        members,
        statisticsBudget: {
          alphaPerComparison: budget.alphaPerComparison,
          resamples: budget.resamples,
          blockLength: budget.blockLength,
        },
        feeConfig,
        feeConfigDigest,
      }),
    },
  });
  return {
    status: "SCHEDULED",
    cohortId,
    members,
    historical,
    attemptSequences: reserved.members.map((member) => member.k),
    reason:
      "候选已冻结并通过历史筛查；将在最近一个已结算闭市时点捕获主账户账本并创建匹配组合",
  };
}

async function appendCohortEvent(cohorts, cohortId, eventType, payload) {
  const previous = await cohorts.lastEvent(cohortId);
  const event = {
    sequence: (previous?.sequence ?? 0) + 1,
    eventType,
    createdAt: new Date().toISOString(),
    payload,
    previousDigest: previous?.digest ?? null,
  };
  await cohorts.appendEvent(cohortId, event);
}

async function closeCohort(cohorts, cohortId, from, reason) {
  await cohorts.transitionCohort(cohortId, {
    from,
    to: "CLOSED",
    eventType: "COHORT_CLOSED",
    payload: { reason },
  });
  await cohorts.releaseWindowOwner("COHORT", cohortId);
}

async function recoverStuckCohort(env, cohort) {
  const cohorts = new CohortRepository(env);
  const events = await cohorts.events(cohort.id);
  const issued = events.find((event) => event.eventType === "REQUEST_ISSUED");
  const leaseStart =
    issued?.payload?.requestIssuedAt ?? issued?.createdAt ?? cohort.createdAt;
  const leaseMs = Number(env.RESEARCH_REQUEST_LEASE_MS ?? REQUEST_LEASE_MS);
  if (
    Number.isFinite(Date.parse(leaseStart)) &&
    Date.now() - Date.parse(leaseStart) < leaseMs
  )
    return "IN_FLIGHT";
  const members = await cohorts.members(cohort.id);
  for (const member of members) {
    if (member.stage !== "PROPOSING") continue;
    await cohorts
      .transitionMember(cohort.id, member.memberId, {
        from: "PROPOSING",
        to: "ERROR",
        failureReason: "候选请求在响应持久化前中断且超出租约；不自动重调模型",
      })
      .catch(() => {});
  }
  await closeCohort(
    cohorts,
    cohort.id,
    "PROPOSING",
    "候选请求中断且超出租约，批次按错误收尾",
  );
  return "CLOSED";
}

// ---------- 捕获匹配起点并创建影子组合（§6） ----------
export async function scheduleCohortForward(
  env,
  cohortId,
  { now = new Date().toISOString() } = {},
) {
  const cohorts = new CohortRepository(env);
  const papers = new RealtimeRepository(env);
  const shadows = new ShadowAccountRepository(env);
  const cohort = await cohorts.getCohort(cohortId);
  if (!cohort) throw new Error("赛马批次不存在");
  if (cohort.stage !== "SCHEDULED")
    return { scheduled: false, reason: `批次处于 ${cohort.stage} 阶段` };
  const account = await papers.account();
  if (!account?.book?.lastDate)
    return { scheduled: false, reason: "主账户尚未结算，无法捕获匹配起点" };
  const liveSession = await papers.session(account.book.lastDate);
  if (liveSession?.status === "OPEN")
    return { scheduled: false, reason: "存在进行中的盘中会话，等待闭市后捕获" };
  const feeConfig = feesForBook(account.book);
  const feeConfigDigest = await digestOf(feeConfig);
  if (feeConfigDigest !== cohort.reservationManifest?.feeConfigDigest) {
    await closeCohort(
      cohorts,
      cohortId,
      "SCHEDULED",
      "费用配置在冻结后变化，批次失效；保留财务路径与占用记录",
    );
    return { scheduled: false, reason: "费用配置已变化，批次失效" };
  }
  const parentRow = await papers.db
    .prepare("SELECT params FROM strategy_versions WHERE id = ?")
    .bind(cohort.parentVersion)
    .first();
  if (!parentRow) throw new Error("父策略版本缺失");
  const parentParams = JSON.parse(parentRow.params);
  const snapshot = await papers.snapshot(account.book.lastDate);
  const captureBook = structuredClone(account.book);
  const initialAccounts = {};
  const members = await cohorts.members(cohortId);
  const scheduledMembers = members.filter(
    (member) => member.stage === "SCHEDULED",
  );
  const planJobs = [];
  const candidateAccountIds = [];
  for (const member of scheduledMembers) {
    const accountId = `shadow-${member.experimentId}`;
    await shadows.ensureAccount(accountId, {
      kind: SHADOW_ACCOUNT_KINDS.CANDIDATE,
      cohortId,
      memberId: member.memberId,
      book: structuredClone(captureBook),
    });
    initialAccounts[accountId] = captureState(captureBook);
    candidateAccountIds.push(accountId);
    planJobs.push({
      accountId,
      strategy: member.params,
      strategyVersion: member.strategyVersion,
    });
  }
  const parentAccountId = `shadow-parent-${cohortId}`;
  await shadows.ensureAccount(parentAccountId, {
    kind: SHADOW_ACCOUNT_KINDS.PARENT_MATCH,
    cohortId,
    memberId: "parent",
    book: structuredClone(captureBook),
  });
  initialAccounts[parentAccountId] = captureState(captureBook);
  planJobs.push({
    accountId: parentAccountId,
    strategy: parentParams,
    strategyVersion: cohort.parentVersion,
  });
  const baselineAccountId = `shadow-baseline-${cohortId}`;
  await shadows.ensureAccount(baselineAccountId, {
    kind: SHADOW_ACCOUNT_KINDS.BASELINE_MATCH,
    cohortId,
    memberId: "baseline",
    book: structuredClone(captureBook),
  });
  initialAccounts[baselineAccountId] = captureState(captureBook);
  planJobs.push({
    accountId: baselineAccountId,
    strategy: BASE_STRATEGY,
    strategyVersion: "baseline-v1",
  });
  // 连续固定基线：自升级起点连续运行，跨批次保留；不冒充实验内匹配对照。
  const existingContinuous = await shadows.account(continuousBaselineId);
  if (!existingContinuous)
    await shadows.ensureAccount(continuousBaselineId, {
      kind: SHADOW_ACCOUNT_KINDS.BASELINE_CONTINUOUS,
      cohortId,
      memberId: "baseline-continuous",
      book: structuredClone(captureBook),
    });
  planJobs.push({
    accountId: continuousBaselineId,
    strategy: BASE_STRATEGY,
    strategyVersion: "baseline-v1",
  });
  for (const job of planJobs)
    await freezePortfolioPlan(
      env,
      job.accountId,
      {
        snapshot,
        strategy: job.strategy,
        strategyVersion: job.strategyVersion,
        now,
      },
      { shadows },
    );
  const forwardManifest = {
    capturedAt: now,
    captureDate: account.book.lastDate,
    primaryRevision: account.revision,
    initialEquityCents: captureBook.equityCents,
    feeConfig,
    feeConfigDigest,
    parentVersion: cohort.parentVersion,
    requiredDays: cohort.forwardDays,
    tradingDates: [],
    initialAccounts,
    accounts: {
      candidates: candidateAccountIds,
      parentMatch: parentAccountId,
      baselineMatch: baselineAccountId,
      baselineContinuous: continuousBaselineId,
    },
    note: "六个匹配组合共享同一期初权益、现金和持仓状态；期间指标从捕获时点起算，不重复累计",
  };
  await cohorts.transitionCohort(cohortId, {
    from: "SCHEDULED",
    to: "RUNNING",
    eventType: "FORWARD_SCHEDULED",
    payload: { captureDate: account.book.lastDate },
    set: { forward_manifest: JSON.stringify(forwardManifest) },
  });
  for (const member of scheduledMembers)
    await cohorts.transitionMember(cohortId, member.memberId, {
      from: "SCHEDULED",
      to: "RUNNING",
    });
  return { scheduled: true, cohortId, captureDate: account.book.lastDate };
}

// ---------- 一次联合采集，多账本独立消费（§7.1/§7.2） ----------
export async function runTournamentPoll(env, now, { providers = {} } = {}) {
  const cohorts = new CohortRepository(env);
  const cohort = await cohorts.activeCohort();
  if (!cohort || cohort.stage !== "RUNNING") return null;
  const frame = await captureQuoteFrame(env, now, { providers });
  if (!frame) return null;
  const shadows = new ShadowAccountRepository(env);
  let primary = null;
  try {
    primary = await pollTrading(env, now, {
      ...providers,
      quotes: async (codes, date) => {
        if (date !== frame.tradeDate) return {};
        const quotes = {};
        for (const code of codes)
          if (frame.quotes[code]) quotes[code] = frame.quotes[code];
        return quotes;
      },
    });
  } catch (error) {
    primary = { status: "ERROR", reason: safeError(error) };
  }
  const accounts = await shadows.accounts();
  const ordered = accounts
    .filter(
      (account) =>
        account.kind === SHADOW_ACCOUNT_KINDS.BASELINE_CONTINUOUS ||
        (account.cohortId === cohort.id &&
          account.kind !== SHADOW_ACCOUNT_KINDS.BASELINE_CONTINUOUS),
    )
    .sort((a, b) => {
      const rank = (kind) => (kind === SHADOW_ACCOUNT_KINDS.CANDIDATE ? 1 : 0);
      return (
        rank(a.kind) - rank(b.kind) || a.accountId.localeCompare(b.accountId)
      );
    });
  const results = [];
  for (const account of ordered) {
    try {
      results.push(
        await consumePortfolioFrame(env, account.accountId, frame, { shadows }),
      );
    } catch (error) {
      results.push({
        accountId: account.accountId,
        stalled: true,
        reason: safeError(error),
      });
    }
  }
  return {
    tradeDate: frame.tradeDate,
    sequence: frame.sequence,
    poolSize: frame.poolCodes.length,
    missingCodes: frame.missingCodes,
    primary,
    shadows: results,
  };
}

// ---------- 盘后：影子结算、共同市场日登记与窗口收口（§6/§10） ----------
export async function settleTournamentDay(
  env,
  date,
  { calendarDates = [], now = null } = {},
) {
  const cohorts = new CohortRepository(env);
  const papers = new RealtimeRepository(env);
  const shadows = new ShadowAccountRepository(env);
  const frames = new QuoteFrameRepository(env);
  const cohort = await cohorts.activeCohort();
  if (!cohort || cohort.stage !== "RUNNING") return null;
  const manifest = cohort.forwardManifest;
  if (!manifest?.captureDate || date <= manifest.captureDate)
    return {
      status: "CAPTURE_DAY",
      reason: "捕获日不是前瞻窗口市场日；窗口从下一交易日起计数",
    };
  if (manifest.tradingDates.includes(date))
    return {
      status: "DUPLICATE",
      reason: "该共同市场日已登记，幂等跳过；不重复结算或延长窗口",
    };
  const datasetRow = await papers.db
    .prepare("SELECT payload FROM paper_market_days WHERE trade_date = ?")
    .bind(date)
    .first();
  if (!datasetRow)
    return {
      status: "WAITING_PRIMARY",
      reason: "主账户当日尚未结算；影子账本与主账户结算保持追平，不提前结算",
    };
  const dataset = JSON.parse(datasetRow.payload);
  const snapshot = await papers.snapshot(date);
  // 共同市场日先登记（claim 先于样本用途写入，满足一次性触发器约束）。
  await cohorts.claimCohortForwardDate(date, cohort.id);
  const previousDate = manifest.tradingDates.at(-1) ?? manifest.captureDate;
  const frameRows = await frames.framesForDate(date);
  const quoteManifestDigest = await digestOf({
    date,
    count: frameRows.length,
    frames: frameRows.map((row) => ({
      sequence: row.sequence,
      observedAt: row.observedAt,
      digest: row.digest,
    })),
  });
  const accountIds = [
    ...manifest.accounts.candidates,
    manifest.accounts.parentMatch,
    manifest.accounts.baselineMatch,
    manifest.accounts.baselineContinuous,
  ];
  const settlements = [];
  for (const accountId of accountIds) {
    try {
      settlements.push(
        await settlePortfolioDay(env, accountId, date, dataset, { shadows }),
      );
    } catch (error) {
      settlements.push({
        accountId,
        stalled: true,
        reason: safeError(error),
      });
    }
  }
  const members = await cohorts.members(cohort.id);
  for (const member of members) {
    if (member.stage !== "RUNNING") continue;
    const payload = {
      decisionDate: previousDate,
      tradeDate: date,
      labelEndDate: date,
      availableAt: date,
      role: "FORWARD_TEST",
      cohortId: cohort.id,
      memberId: member.memberId,
      snapshotDigest: snapshot ? await digestOf(snapshot) : null,
      marketDigest: await digestOf(dataset),
      quoteManifestDigest,
    };
    await cohorts.recordMemberSampleUse({
      experimentId: member.experimentId,
      sample: {
        date,
        role: "FORWARD_TEST",
        payload,
        digest: await digestOf(payload),
      },
    });
  }
  // 冻结各账户下一交易日计划；账户按自身策略独立生成，不改写旧计划。
  const parentRow = await papers.db
    .prepare("SELECT params FROM strategy_versions WHERE id = ?")
    .bind(cohort.parentVersion)
    .first();
  const parentParams = parentRow ? JSON.parse(parentRow.params) : null;
  const strategyByAccount = new Map();
  for (const member of members) {
    const accountId = `shadow-${member.experimentId}`;
    if (accountIds.includes(accountId))
      strategyByAccount.set(accountId, {
        strategy: member.params,
        strategyVersion: member.strategyVersion,
      });
  }
  strategyByAccount.set(manifest.accounts.parentMatch, {
    strategy: parentParams,
    strategyVersion: cohort.parentVersion,
  });
  strategyByAccount.set(manifest.accounts.baselineMatch, {
    strategy: BASE_STRATEGY,
    strategyVersion: "baseline-v1",
  });
  strategyByAccount.set(manifest.accounts.baselineContinuous, {
    strategy: BASE_STRATEGY,
    strategyVersion: "baseline-v1",
  });
  const planNotes = [];
  for (const accountId of accountIds) {
    const account = await shadows.account(accountId);
    if (!account || account.book.lastDate !== date) continue;
    const config = strategyByAccount.get(accountId);
    if (!config?.strategy) continue;
    try {
      await freezePortfolioPlan(
        env,
        accountId,
        {
          snapshot,
          strategy: config.strategy,
          strategyVersion: config.strategyVersion,
          now: now ?? new Date().toISOString(),
        },
        { shadows },
      );
    } catch (error) {
      planNotes.push({ accountId, reason: safeError(error) });
    }
  }
  // 追加共同市场日；窗口固定，不因缺失顺延到盈利。
  const tradingDates = [...manifest.tradingDates, date];
  await cohorts.transitionCohort(cohort.id, {
    from: "RUNNING",
    to: "RUNNING",
    eventType: "FORWARD_DAY_SETTLED",
    payload: { date, tradingDates: tradingDates.length },
    set: {
      forward_manifest: JSON.stringify({ ...manifest, tradingDates }),
    },
  });
  let evaluation = null;
  if (tradingDates.length >= manifest.requiredDays) {
    await cohorts.transitionCohort(cohort.id, {
      from: "RUNNING",
      to: "EVALUATING",
      eventType: "FORWARD_WINDOW_COMPLETE",
      payload: { days: tradingDates.length },
    });
    evaluation = await evaluateCohort(env, cohort.id, { calendarDates });
  }
  return {
    status: "SETTLED",
    date,
    settlements,
    planNotes,
    tradingDays: tradingDates.length,
    requiredDays: manifest.requiredDays,
    evaluation,
  };
}

// 盘后统一入口：先为 SCHEDULED 批次捕获匹配起点，再结算运行中的前瞻窗口。
export async function runDailyTournament(
  env,
  date,
  { calendarDates = [] } = {},
) {
  const cohorts = new CohortRepository(env);
  const scheduled = await cohorts.activeCohort();
  let schedule = null;
  if (scheduled?.stage === "SCHEDULED")
    schedule = await scheduleCohortForward(env, scheduled.id, {
      now: new Date().toISOString(),
    });
  const settle = await settleTournamentDay(env, date, { calendarDates });
  return { schedule, settle };
}

// ---------- 最终评估、固定排序与受控晋级（§8） ----------
export async function evaluateCohort(
  env,
  cohortId,
  { now = new Date().toISOString(), calendarDates = [] } = {},
) {
  const cohorts = new CohortRepository(env);
  const papers = new RealtimeRepository(env);
  const shadows = new ShadowAccountRepository(env);
  const cohort = await cohorts.getCohort(cohortId);
  if (!cohort) throw new Error("赛马批次不存在");
  if (cohort.stage !== "EVALUATING")
    throw new Error(`批次处于 ${cohort.stage} 阶段，不能评估`);
  const manifest = cohort.forwardManifest;
  const windowDates = manifest.tradingDates;
  const frozenPolicy = cohort.reservationManifest?.cohortPolicy;
  const budget = cohort.proposalManifest?.statisticsBudget;
  const minimumRounds = frozenPolicy?.minimumCompletedRounds ?? 10;
  // 共同数据覆盖：每个窗口日必须有主账户结算数据与 cohort 名下的日期登记。
  const commonCoverage = [];
  for (const date of windowDates) {
    const datasetRow = await papers.db
      .prepare("SELECT payload FROM paper_market_days WHERE trade_date = ?")
      .bind(date)
      .first();
    const claim = await papers.db
      .prepare(
        "SELECT owner_type, owner_id FROM research_test_claims WHERE namespace = ? AND outcome_date = ?",
      )
      .bind("main", date)
      .first();
    commonCoverage.push({
      date,
      datasetSettled: Boolean(datasetRow),
      claimOwner: claim ? `${claim.owner_type}:${claim.owner_id}` : null,
    });
  }
  const commonDataMissing = commonCoverage.some(
    (row) => !row.datasetSettled || row.claimOwner !== `COHORT:${cohortId}`,
  );
  // 环境指纹（闸门 6）：费用、父策略、执行/评分版本与冻结成员清单一致性。
  const members = await cohorts.members(cohortId);
  const membersIntact = (
    await Promise.all(
      members.map((member) =>
        member.params
          ? digestOf(member.params).then((d) => d === member.paramsDigest)
          : true,
      ),
    )
  ).every(Boolean);
  const primary = await papers.account();
  const feeConfig = feesForBook(primary.book);
  const feeConfigDigest = await digestOf(feeConfig);
  const fingerprint = {
    feeConfigMatches: feeConfigDigest === manifest.feeConfigDigest,
    parentStrategyMatches: primary.book.activeStrategy === cohort.parentVersion,
    membersIntact,
    executionVersion: EXECUTION_VERSION,
    scoringVersion: SCORING_VERSION,
    environmentValid:
      feeConfigDigest === manifest.feeConfigDigest &&
      primary.book.activeStrategy === cohort.parentVersion &&
      membersIntact,
  };
  const metricsOf = async (accountId) => {
    const account = await shadows.account(accountId);
    if (!account) return null;
    const allEquities = await shadows.equities(accountId);
    const equities = allEquities.filter((row) =>
      windowDates.includes(row.tradeDate ?? row.trade_date),
    );
    const metrics = windowMetrics({
      initial: manifest.initialAccounts[accountId],
      finalBook: account.book,
      equities,
      windowDates,
    });
    const ledger = await shadows.ledger(accountId);
    const rounds = completeRounds(ledger, windowDates);
    return { account, equities, metrics, rounds };
  };
  const parentMetrics = await metricsOf(manifest.accounts.parentMatch);
  const baselineMetrics = await metricsOf(manifest.accounts.baselineMatch);
  // 统计：所有成员与两个对照共用同一按日期重采样的索引（§5.3）。
  // 共同对照的每日净值缺失时，统计证据不足，整个批次不晋级。
  let matrix = null;
  let parentReturns = null;
  let baselineReturns = null;
  if (budget && parentMetrics && baselineMetrics) {
    try {
      matrix = await resampleIndexMatrix({
        dates: windowDates,
        blockLength: budget.blockLength,
        resamples: budget.resamples,
        seedInput: {
          cohortId,
          windowDates,
          alphaPerComparison: budget.alphaPerComparison,
          blockLength: budget.blockLength,
        },
      });
      parentReturns = dailyReturns({
        initialEquityCents:
          manifest.initialAccounts[manifest.accounts.parentMatch].equityCents,
        equities: parentMetrics.equities,
        dates: windowDates,
      });
      baselineReturns = dailyReturns({
        initialEquityCents:
          manifest.initialAccounts[manifest.accounts.baselineMatch].equityCents,
        equities: baselineMetrics.equities,
        dates: windowDates,
      });
    } catch {
      matrix = null;
      parentReturns = null;
      baselineReturns = null;
    }
  }
  const verdicts = [];
  for (const member of members) {
    if (!["RUNNING", "SCHEDULED"].includes(member.stage)) {
      verdicts.push({
        memberId: member.memberId,
        stage: member.stage,
        note: "成员未进入前瞻窗口，保留失败路径",
      });
      continue;
    }
    const accountId = `shadow-${member.experimentId}`;
    const metrics = await metricsOf(accountId);
    const checks = {
      fingerprint: fingerprint.environmentValid,
      coverage: Boolean(metrics) && metrics.metrics.missingDates.length === 0,
      rounds:
        Boolean(metrics) &&
        metrics.rounds.rounds >= minimumRounds &&
        parentMetrics &&
        parentMetrics.rounds.rounds >= minimumRounds,
      returns: false,
      drawdown: false,
      statistics: false,
    };
    let statisticsDetail = null;
    let memberReturns = null;
    if (checks.fingerprint && checks.coverage && matrix && metrics) {
      try {
        memberReturns = dailyReturns({
          initialEquityCents: manifest.initialAccounts[accountId].equityCents,
          equities: metrics.equities,
          dates: windowDates,
        });
      } catch {
        memberReturns = null;
      }
    }
    if (memberReturns && parentReturns && baselineReturns) {
      const againstParent = pairedLowerBoundTest({
        memberReturns,
        comparisonReturns: parentReturns,
        matrix,
        alphaPerComparison: budget.alphaPerComparison,
      });
      const againstBaseline = pairedLowerBoundTest({
        memberReturns,
        comparisonReturns: baselineReturns,
        matrix,
        alphaPerComparison: budget.alphaPerComparison,
      });
      statisticsDetail = { againstParent, againstBaseline };
      checks.statistics = againstParent.passed && againstBaseline.passed;
      // 收益闸门（整数分比较）：候选净收益高于匹配父策略至少 0.1 个百分点，
      // 且不低于匹配固定基线。
      const improvementThreshold = Math.round(
        manifest.initialAccounts[accountId].equityCents * 0.001,
      );
      checks.returns =
        metrics.metrics.finalEquityCents >
          parentMetrics.metrics.finalEquityCents + improvementThreshold &&
        metrics.metrics.finalEquityCents >=
          baselineMetrics.metrics.finalEquityCents;
      // 回撤闸门：不超过 10%，相对父策略最多恶化 0.5 个百分点（百万分值）。
      checks.drawdown =
        metrics.metrics.windowDrawdownPpm <= 100_000 &&
        metrics.metrics.windowDrawdownPpm <=
          parentMetrics.metrics.windowDrawdownPpm + 5_000;
    }
    let verdict;
    if (!checks.fingerprint) verdict = "INVALIDATED";
    else if (!checks.coverage) verdict = "INCONCLUSIVE";
    else if (!checks.rounds) verdict = "INCONCLUSIVE";
    else if (!checks.statistics) verdict = "INCONCLUSIVE";
    else if (!checks.returns || !checks.drawdown) verdict = "REJECTED";
    else verdict = "ELIGIBLE";
    if (member.stage === "RUNNING")
      await cohorts.transitionMember(cohortId, member.memberId, {
        from: "RUNNING",
        to: verdict,
      });
    verdicts.push({
      memberId: member.memberId,
      stage: verdict,
      accountId,
      checks,
      statistics: statisticsDetail,
      metrics: metrics?.metrics ?? null,
      rounds: metrics?.rounds ?? null,
    });
  }
  const eligible = verdicts.filter((row) => row.stage === "ELIGIBLE");
  const ranked = rankEligibleMembers(
    eligible.map((row) => ({
      memberId: row.memberId,
      finalEquityCents: row.metrics.finalEquityCents,
      windowDrawdownPpm: row.metrics.windowDrawdownPpm,
      feesDeltaCents: row.metrics.feesDeltaCents,
      paramsDistance:
        members.find((m) => m.memberId === row.memberId)?.paramsDistance ?? 0,
    })),
  );
  const champion = ranked[0] ?? null;
  const report = {
    cohortId,
    evaluatedAt: now,
    windowDates,
    requiredDays: manifest.requiredDays,
    commonCoverage,
    commonDataMissing,
    fingerprint,
    minimumCompletedRounds: minimumRounds,
    statisticsBudget: budget,
    verdicts,
    ranked,
    champion,
    promotion: null,
    executionVersion: EXECUTION_VERSION,
    scoringVersion: SCORING_VERSION,
    note: "仅从通过全部闸门的合格集合按冻结排序启用至多一个候选；全部不通过时保持当前策略",
  };
  // 批次结束时的唯一自动晋级：验证报告摘要、成员资格与配置指纹后 CAS 切换。
  // 已冻结计划（信号日=窗口末日）不替换：新策略从之后第一个尚未冻结的计划起生效，
  // 其执行日为窗口末日的下一交易日的下一交易日。
  if (champion) {
    const effectiveTradeDate = calendarDates[1] ?? calendarDates[0] ?? null;
    try {
      report.promotion = await promoteCohortChampion(env, cohortId, {
        evaluation: report,
        effectiveTradeDate,
      });
    } catch (error) {
      report.promotion = { promoted: false, reason: safeError(error) };
    }
  }
  const saved = await cohorts.saveReport(cohortId, "EVALUATION", report);
  if (report.promotion?.promoted) {
    await cohorts
      .transitionCohort(cohortId, {
        from: "EVALUATING",
        to: "CLOSED",
        eventType: "CHAMPION_PROMOTED",
        payload: {
          champion,
          effectiveTradeDate: report.promotion.effectiveTradeDate ?? null,
        },
        set: {
          evaluation_manifest: JSON.stringify(report),
          effective_trade_date: report.promotion.effectiveTradeDate ?? null,
          promotion_digest: saved.digest,
        },
      })
      .catch(async () => {
        await closeCohort(cohorts, cohortId, "EVALUATING", "批次评估完成");
      });
  } else {
    await cohorts.transitionCohort(cohortId, {
      from: "EVALUATING",
      to: "CLOSED",
      eventType: "COHORT_EVALUATED",
      payload: { champion, promoted: false },
      set: { evaluation_manifest: JSON.stringify(report) },
    });
  }
  await cohorts.releaseWindowOwner("COHORT", cohortId);
  return report;
}

// ---------- 状态与导出（§11） ----------
export async function tournamentStatus(env, { limit = 10, offset = 0 } = {}) {
  const cohorts = new CohortRepository(env);
  const shadows = new ShadowAccountRepository(env);
  const policy = await cohorts.getTournamentPolicy();
  const active = await cohorts.activeCohort();
  const { cohorts: list, total } = await cohorts.listCohorts({
    limit,
    offset,
  });
  const accounts = active
    ? await shadows.accounts({ cohortId: active.id })
    : [];
  return {
    policy: {
      id: policy.id,
      digest: policy.digest,
      maxCandidates: policy.payload.maxCandidates,
      monthlyGenerationLimit: policy.payload.monthlyGenerationLimit,
      forwardDays: policy.payload.forwardDays,
      minimumCompletedRounds: policy.payload.minimumCompletedRounds,
      methodNote: policy.payload.methodNote,
    },
    activeCohort: active
      ? {
          id: active.id,
          stage: active.stage,
          parentVersion: active.parentVersion,
          forwardDays: active.forwardDays,
          forwardManifest: active.forwardManifest,
          members: await cohorts.members(active.id),
          accounts: accounts.map((account) => ({
            accountId: account.accountId,
            kind: account.kind,
            memberId: account.memberId,
            cursorDate: account.cursorDate,
            cursorSequence: account.cursorSequence,
            equityCents: account.book.equityCents,
            lastDate: account.book.lastDate,
          })),
        }
      : null,
    cohorts: list.map((cohort) => ({
      id: cohort.id,
      stage: cohort.stage,
      parentVersion: cohort.parentVersion,
      createdAt: cohort.createdAt,
      maxCandidates: cohort.maxCandidates,
    })),
    total,
    note: "排行榜领先只是纸面领先；只有最终合格报告支持启用，收益不在独立候选之间求和",
  };
}

export async function cohortDetail(env, cohortId) {
  const cohorts = new CohortRepository(env);
  const shadows = new ShadowAccountRepository(env);
  const cohort = await cohorts.getCohort(cohortId);
  if (!cohort) return null;
  const members = await cohorts.members(cohortId);
  const events = await cohorts.events(cohortId);
  const evaluation = await cohorts.report(cohortId, "EVALUATION");
  const accounts = [];
  for (const account of await shadows.accounts({ cohortId })) {
    const equities = await shadows.equities(account.accountId);
    accounts.push({
      accountId: account.accountId,
      kind: account.kind,
      memberId: account.memberId,
      status: account.status,
      cursor: {
        date: account.cursorDate,
        sequence: account.cursorSequence,
      },
      book: account.book,
      equities: equities.map((row) => ({
        tradeDate: row.tradeDate ?? row.trade_date,
        equityCents: row.equityCents,
        dailyReturn: row.dailyReturn ?? null,
      })),
    });
  }
  return {
    cohort,
    members,
    events,
    evaluation: evaluation?.payload ?? null,
    evaluationDigest: evaluation?.digest ?? null,
    accounts,
  };
}

export async function cohortLineage(env, cohortId) {
  const cohorts = new CohortRepository(env);
  const cohort = await cohorts.getCohort(cohortId);
  if (!cohort) return null;
  const members = await cohorts.members(cohortId);
  const lineage = [];
  for (const member of members) {
    const experiment = await cohorts.db
      .prepare("SELECT * FROM research_experiments WHERE id = ?")
      .bind(member.experimentId)
      .first();
    const events = (
      await cohorts.db
        .prepare(
          "SELECT sequence, event_type, created_at, payload, previous_digest, digest FROM research_events WHERE experiment_id = ? ORDER BY sequence",
        )
        .bind(member.experimentId)
        .all()
    ).results;
    lineage.push({
      memberId: member.memberId,
      experimentId: member.experimentId,
      k: member.k,
      familyId: member.familyId,
      paramsDigest: member.paramsDigest,
      paramsDistance: member.paramsDistance,
      stage: member.stage,
      reservation: experiment
        ? JSON.parse(experiment.reservation_payload)
        : null,
      manifestDigest: experiment?.proposal_digest ?? null,
      manifest: experiment?.proposal_manifest
        ? JSON.parse(experiment.proposal_manifest)
        : null,
      events,
    });
  }
  return {
    cohortId,
    reservationManifest: cohort.reservationManifest,
    proposalManifest: cohort.proposalManifest,
    forwardManifest: cohort.forwardManifest,
    members: lineage,
    events: await cohorts.events(cohortId),
  };
}

export async function cohortExport(env, cohortId) {
  const detail = await cohortDetail(env, cohortId);
  if (!detail) return null;
  const shadows = new ShadowAccountRepository(env);
  const frames = new QuoteFrameRepository(env);
  const ledgers = [];
  const plans = [];
  for (const account of detail.accounts) {
    ledgers.push({
      accountId: account.accountId,
      fills: await shadows.ledger(account.accountId),
    });
    const rows = (
      await shadows.db
        .prepare(
          "SELECT signal_date, payload, digest FROM shadow_plans WHERE account_id = ? ORDER BY signal_date",
        )
        .bind(account.accountId)
        .all()
    ).results;
    plans.push({
      accountId: account.accountId,
      plans: rows.map((row) => ({
        signalDate: row.signal_date,
        payload: JSON.parse(row.payload),
        digest: row.digest,
      })),
    });
  }
  const windowDates = detail.cohort.forwardManifest?.tradingDates ?? [];
  const framesByDate = [];
  for (const date of windowDates) {
    const rows = await frames.framesForDate(date);
    framesByDate.push({
      date,
      frames: rows.map((row) => ({
        sequence: row.sequence,
        observedAt: row.observedAt,
        digest: row.digest,
        poolDigest: row.poolDigest,
      })),
    });
  }
  return {
    format: "limit-lens-cohort-v1",
    exportedAt: new Date().toISOString(),
    ...detail,
    ledgers,
    plans,
    quoteFrames: framesByDate,
    note: "检查点一致的批次研究导出：成员冻结清单、逐账户计划/成交/净值、事件链与统计输入",
  };
}
