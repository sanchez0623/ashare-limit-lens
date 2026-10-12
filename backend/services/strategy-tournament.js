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
import { latestPolicyBundle } from "../storage/execution-cost.js";
import { pollTrading } from "./realtime.js";
import { marketClock, inSession } from "../domain/realtime.js";
import { captureQuoteFrame } from "./quote-stream.js";
import {
  consumePortfolioFrame,
  settlePortfolioDay,
  freezePortfolioPlan,
  portfolioSelectionEvidence,
} from "./portfolio-runner.js";
import { promoteCohortChampion } from "./promotion.js";
import {
  selectionPolicyForBook,
  selectionPolicyFields,
  selectionPolicyMatches,
  frozenSelectionPolicy,
} from "../domain/signal-selection.js";

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
  if (owner && owner.ownerType !== "COHORT")
    return {
      status: "BUSY",
      reason: "已有单候选实验占用研究窗口",
    };
  // COHORT 窗口占用不在此返回 BUSY：落入下方活动批次检查，
  // 使 PROPOSING 停机恢复可达，避免过期批次死锁研究窗口。
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
  const selectionPolicy = selectionPolicyForBook(account.book);
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
      selectionPolicy,
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
    if (
      !selectionPolicyMatches(
        selectionPolicyFields(selectionPolicy),
        (await repository.account()).book,
      )
    )
      throw new Error("预留期间选股政策已变化，拒绝混用研究输入");
    modelOutput = await propose(
      env,
      base,
      windows.training,
      account.book.initialCashCents / 100,
      feeConfig,
      memberCount,
      { selectionPolicy },
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
        ...selectionPolicyFields(selectionPolicy),
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
      null,
      null,
      { selectionPolicy },
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
        // 历史筛查起点与配置（§6）：统一期初资金、冻结费用与冻结测试窗口，
        // 候选与共同对照在同一冻结输入上比较，事后不回填、不换配置。
        historicalInputs: {
          initialCashCents: account.book.initialCashCents,
          feeConfigDigest,
          trainingDates: windows.trainingDates,
          testDates: windows.testDates,
        },
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
  // 取最后一次模型请求事件：同批次多次请求时以最新租约判定是否停机。
  const issued = [...events]
    .reverse()
    .find((event) => event.eventType === "REQUEST_ISSUED");
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
  // §6：只能在已结算、没有进行中盘中会话/时段的闭市时点捕获匹配起点。
  const clock = marketClock(new Date(now));
  if (inSession(clock.time))
    return {
      scheduled: false,
      reason: "存在进行中的盘中时段，等待闭市后捕获匹配起点",
    };
  const account = await papers.account();
  if (!account?.book?.lastDate)
    return { scheduled: false, reason: "主账户尚未结算，无法捕获匹配起点" };
  // 今日会话仍开放（午休、收盘后未结算）时同样拒绝：
  // 当日不是已结算的闭市时点，捕获会把盘中时点冒充为历史起点。
  const todaySession = await papers.session(clock.date);
  if (todaySession?.status === "OPEN")
    return {
      scheduled: false,
      reason: "今日盘中会话尚未关闭，等待当日结算后捕获匹配起点",
    };
  const feeConfig = feesForBook(account.book);
  const feeConfigDigest = await digestOf(feeConfig);
  // 捕获时点的执行成本政策快照（statistical-evidence.md §7.2 批次 C）。
  const executionCostPolicy = await latestPolicyBundle(env.DB).catch(
    () => null,
  );
  if (!selectionPolicyMatches(cohort.reservationManifest, account.book)) {
    await closeCohort(
      cohorts,
      cohortId,
      "SCHEDULED",
      "选股政策在冻结后变化，批次失效",
    );
    return { scheduled: false, reason: "选股政策已变化，批次失效" };
  }
  const selectionPolicy = frozenSelectionPolicy(cohort.reservationManifest);
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
  // 历史可重放起点（§6）：捕获日快照缺失时拒绝捕获，等待评分快照补齐。
  const snapshot = await papers.snapshot(account.book.lastDate);
  if (!snapshot)
    return {
      scheduled: false,
      reason: "捕获日评分快照缺失，无法冻结候选计划；等待数据补齐后重试",
    };
  const captureRevision = account.revision;
  const captureBook = structuredClone(account.book);
  const members = await cohorts.members(cohortId);
  const scheduledMembers = members.filter(
    (member) => member.stage === "SCHEDULED",
  );
  // 原子捕获（§6）：捕获 revision、创建组合与冻结计划在一个事务内完成；
  // 期间主账本 revision 变化则整体中止，不基于陈旧起点开跑。
  const createdAccountIds = [];
  const planJobs = [];
  const initialAccounts = {};
  const initialPositions = {};
  const atomic =
    typeof papers.db.transaction === "function"
      ? (fn) => papers.db.transaction(fn)
      : async (fn) => fn();
  let captured = null;
  try {
    captured = await atomic(async () => {
      const begin = await papers.account();
      if (begin.revision !== captureRevision)
        throw new Error("主账本在捕获前被并发更新");
      const candidateAccountIds = [];
      for (const member of scheduledMembers) {
        const accountId = `shadow-${member.experimentId}`;
        await shadows.ensureAccount(accountId, {
          kind: SHADOW_ACCOUNT_KINDS.CANDIDATE,
          cohortId,
          memberId: member.memberId,
          book: structuredClone(captureBook),
        });
        if (!createdAccountIds.includes(accountId))
          createdAccountIds.push(accountId);
        initialAccounts[accountId] = captureState(captureBook);
        initialPositions[accountId] = (captureBook.positions ?? []).map(
          (position) => ({
            code: position.code,
            quantity: position.lots.reduce((a, lot) => a + lot.quantity, 0),
          }),
        );
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
      if (!createdAccountIds.includes(parentAccountId))
        createdAccountIds.push(parentAccountId);
      initialAccounts[parentAccountId] = captureState(captureBook);
      initialPositions[parentAccountId] = (captureBook.positions ?? []).map(
        (position) => ({
          code: position.code,
          quantity: position.lots.reduce((a, lot) => a + lot.quantity, 0),
        }),
      );
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
      if (!createdAccountIds.includes(baselineAccountId))
        createdAccountIds.push(baselineAccountId);
      initialAccounts[baselineAccountId] = captureState(captureBook);
      initialPositions[baselineAccountId] = (captureBook.positions ?? []).map(
        (position) => ({
          code: position.code,
          quantity: position.lots.reduce((a, lot) => a + lot.quantity, 0),
        }),
      );
      planJobs.push({
        accountId: baselineAccountId,
        strategy: BASE_STRATEGY,
        strategyVersion: "baseline-v1",
      });
      // 连续固定基线：自升级起点连续运行，跨批次保留；不冒充实验内匹配对照。
      const existingContinuous = await shadows.account(continuousBaselineId);
      if (!existingContinuous) {
        await shadows.ensureAccount(continuousBaselineId, {
          kind: SHADOW_ACCOUNT_KINDS.BASELINE_CONTINUOUS,
          cohortId,
          memberId: "baseline-continuous",
          book: structuredClone(captureBook),
        });
        createdAccountIds.push(continuousBaselineId);
        initialAccounts[continuousBaselineId] = captureState(captureBook);
        initialPositions[continuousBaselineId] = (
          captureBook.positions ?? []
        ).map((position) => ({
          code: position.code,
          quantity: position.lots.reduce((a, lot) => a + lot.quantity, 0),
        }));
      }
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
      const after = await papers.account();
      if (after.revision !== captureRevision)
        throw new Error("主账本在捕获期间被并发更新");
      return {
        candidateAccountIds,
        parentAccountId,
        baselineAccountId,
      };
    });
  } catch (error) {
    // 事务不可用（D1）时补偿：使本次创建的组合失效，不留下陈旧起点。
    for (const accountId of createdAccountIds)
      await shadows.setStatus(accountId, "INVALIDATED").catch(() => {});
    await closeCohort(
      cohorts,
      cohortId,
      "SCHEDULED",
      `捕获匹配起点时主账本被并发更新，批次失效：${safeError(error)}`,
    ).catch(() => {});
    return {
      scheduled: false,
      reason: "捕获起点时主账本被并发更新，批次失效；占用保留可重新核验",
    };
  }
  const forwardManifest = {
    capturedAt: now,
    captureDate: account.book.lastDate,
    primaryRevision: captureRevision,
    initialEquityCents: captureBook.equityCents,
    feeConfig,
    feeConfigDigest,
    parentVersion: cohort.parentVersion,
    ...selectionPolicyFields(selectionPolicy),
    requiredDays: cohort.forwardDays,
    // 成本指纹（statistical-evidence.md §7.2 批次 C）：捕获时点的执行成本
    // 政策摘要随清单冻结；评估与晋级核验窗口期内成本口径未变化。
    executionCost: executionCostPolicy
      ? {
          modelVersion: executionCostPolicy.modelVersion,
          policyId: executionCostPolicy.id,
          version: executionCostPolicy.version,
          digest: executionCostPolicy.payloadDigest,
          calibrationStatus: executionCostPolicy.calibrationStatus,
        }
      : null,
    executionCostDigest: executionCostPolicy?.payloadDigest ?? null,
    // 固定窗口日历：随 runDaily 交易日历冻结，窗口结束日不因缺失顺延（§8.2）。
    windowDates: [],
    tradingDates: [],
    initialAccounts,
    initialAccountsDigest: await digestOf(initialAccounts),
    initialPositions,
    accounts: {
      candidates: captured.candidateAccountIds,
      parentMatch: captured.parentAccountId,
      baselineMatch: captured.baselineAccountId,
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
  const shadows = new ShadowAccountRepository(env);
  const papers = new RealtimeRepository(env);
  const cohort = await cohorts.activeCohort();
  const running = cohort?.stage === "RUNNING";
  // 连续固定基线跨批次持续运行（§6）：无活动批次时仍采集并喂给持续基线。
  const continuous = await shadows.account(continuousBaselineId);
  if (!running && continuous?.status !== "ACTIVE") return null;
  const frame = await captureQuoteFrame(env, now, { providers });
  if (!frame) return null;
  const frames = new QuoteFrameRepository(env);
  let primary = null;
  // 主账户与影子账户同源按序消费（§7.1/§7.2）：当日全部已落盘帧按
  // 观察时间（observedAt）匹配已消费观察，未匹配的帧逐帧喂给主账户，
  // 重启后不漏帧；观察数与帧数可能错位（无帧轮询、CAS 冲突重试），
  // 不能拿观察条数当帧游标。
  const dayFrames = await frames.framesForDate(frame.tradeDate);
  const primaryObservations = await papers
    .observations(frame.tradeDate)
    .catch(() => []);
  const consumedObservedAt = new Set(
    primaryObservations.map((row) => row.payload?.observedAt).filter(Boolean),
  );
  const pendingPrimary = dayFrames.filter(
    (candidate) => !consumedObservedAt.has(candidate.observedAt),
  );
  if (!pendingPrimary.length)
    primary = { status: "SKIPPED", reason: "主账户已消费当日全部已落盘帧" };
  // pollTrading 期望 calendar 是可调用函数；日历数据对象在此适配为
  // 异步返回函数，避免"calendar is not a function"打断主账户观察。
  const { calendar: providerCalendar, ...restProviders } = providers;
  const calendarFn =
    typeof providerCalendar === "function"
      ? providerCalendar
      : providerCalendar
        ? async () => providerCalendar
        : undefined;
  for (const primaryFrame of pendingPrimary) {
    try {
      primary = await pollTrading(env, now, {
        ...restProviders,
        ...(calendarFn ? { calendar: calendarFn } : {}),
        quotes: async (codes, date) => {
          if (date !== primaryFrame.tradeDate) return {};
          const frameQuotes =
            primaryFrame.payload?.quotes ?? primaryFrame.quotes ?? {};
          const quotes = {};
          for (const code of codes)
            if (frameQuotes[code]) quotes[code] = frameQuotes[code];
          return quotes;
        },
        observedAt: primaryFrame.observedAt,
      });
      // 只有"观察已提交"的状态才推进到后续帧（§7.2 按序消费）：CAS 冲突、
      // 错误、BLOCKED（上一交易日未结算）、MARKET_CLOSED / NON_TRADING_DAY /
      // SETTLED（当日尚未开盘或已结算）等状态都意味着当前帧观察未生效，
      // 必须停在当前帧等待下一轮重放。否则带上未生效的前序帧继续处理后帧，
      // 会跳过止损清仓帧等关键观察（上一日结算恰好完成时第二帧就生效了）。
      const committed =
        primary?.status === "RUNNING" || primary?.status === "STALE_QUOTES";
      if (!committed) break;
    } catch (error) {
      primary = { status: "ERROR", reason: safeError(error) };
      break;
    }
  }
  const accounts = await shadows.accounts();
  const activeAccounts = accounts.filter(
    (account) => account.status === "ACTIVE",
  );
  const ordered = (
    running
      ? activeAccounts.filter(
          (account) =>
            account.kind === SHADOW_ACCOUNT_KINDS.BASELINE_CONTINUOUS ||
            account.cohortId === cohort.id,
        )
      : activeAccounts.filter(
          (account) =>
            account.kind === SHADOW_ACCOUNT_KINDS.BASELINE_CONTINUOUS,
        )
  ).sort((a, b) => {
    const rank = (kind) => (kind === SHADOW_ACCOUNT_KINDS.CANDIDATE ? 1 : 0);
    return (
      rank(a.kind) - rank(b.kind) || a.accountId.localeCompare(b.accountId)
    );
  });
  const results = [];
  for (const account of ordered) {
    // 按序重放已落盘帧（§7.2）：从账户游标日期起补齐"已采集未消费"的帧，
    // 重启恢复与跨日缺口都从这里修复；一账户失败不阻塞其他账户。
    const since = account.cursorDate ?? frame.tradeDate;
    let replay = [frame];
    try {
      const persisted = await frames.framesSince(since);
      if (persisted.length) replay = persisted;
    } catch {
      replay = [frame];
    }
    let lastResult = null;
    for (const replayFrame of replay) {
      try {
        lastResult = await consumePortfolioFrame(
          env,
          account.accountId,
          replayFrame,
          { shadows },
        );
        if (lastResult.stalled) break;
      } catch (error) {
        lastResult = {
          accountId: account.accountId,
          frameSequence: replayFrame.sequence,
          stalled: true,
          reason: safeError(error),
        };
        break;
      }
    }
    results.push(lastResult ?? { accountId: account.accountId, skipped: true });
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
// 用当日已落盘帧为 dataset 缺失的候选独有代码补齐收盘盯市记录（§8.2）：
// 每只代码取**最新观测帧**的价格（从高序号帧向低序号查找），09:31 的首条
// 报价不会被误当作收盘价；时间戳固定为收盘时点并标注来源，缺少任何
// 观测价的代码保持缺失，由结算或覆盖闸门如实暴露。
export function closingQuotesFromFrames(frameRows, datasetQuotes, date) {
  const enriched = { ...datasetQuotes };
  const ordered = [...frameRows].sort((a, b) => b.sequence - a.sequence);
  for (const frame of ordered) {
    const quotes = frame.payload?.quotes ?? frame.quotes ?? {};
    for (const [code, quote] of Object.entries(quotes)) {
      if (enriched[code]) continue;
      const closeCents = quote.closeCents ?? quote.lastCents;
      if (!(Number(closeCents) > 0)) continue;
      enriched[code] = {
        ...quote,
        date,
        timestamp: `${date}T15:00:00+08:00`,
        closeCents,
        closingSource: "FRAME_LAST_OBSERVED",
      };
    }
  }
  return enriched;
}

async function settleAccounts(env, accountIds, date, dataset, { shadows }) {
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
  return settlements;
}

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
  if (!cohort) return null;
  if (cohort.stage === "EVALUATING") {
    // 评估中断恢复（§10）：盘后任务重入评估；已发布报告则幂等复用并收尾。
    const evaluation = await evaluateCohort(env, cohort.id, { calendarDates });
    return {
      status: "EVALUATION_RECOVERED",
      evaluation,
      reason: "评估阶段中断后由盘后任务恢复，批次收尾",
    };
  }
  if (cohort.stage !== "RUNNING") return null;
  const manifest = cohort.forwardManifest;
  if (!manifest?.captureDate || date <= manifest.captureDate)
    return {
      status: "CAPTURE_DAY",
      reason: "捕获日不是前瞻窗口市场日；窗口从下一交易日起计数",
    };
  const accountIds = [
    ...manifest.accounts.candidates,
    manifest.accounts.parentMatch,
    manifest.accounts.baselineMatch,
    manifest.accounts.baselineContinuous,
  ];
  // 窗口日历（§8.2）：以**主账户结算日序列**为准。主账户的盘后流程
  // 保证不跳日（上一交易日未结算即 BLOCKED 停摆），其已结算交易日就是
  // 可验证的真实交易日历；腾讯指数日线只含已收盘历史日期，未来日历
  // 不存在也不需要。窗口 = 捕获日之后主账户的前 requiredDays 个结算日，
  // 赛马侧某日登记失败时该日仍留在窗口内，由共同覆盖闸门暴露，
  // 不会被后续结算日顺延补满。
  const ordinalRow = await papers.db
    .prepare(
      "SELECT COUNT(*) AS n FROM paper_market_days WHERE trade_date > ? AND trade_date <= ?",
    )
    .bind(manifest.captureDate, date)
    .first();
  const primaryOrdinal = Number(ordinalRow?.n ?? 0);
  const windowDates = (
    await papers.db
      .prepare(
        "SELECT trade_date FROM paper_market_days WHERE trade_date > ? ORDER BY trade_date LIMIT ?",
      )
      .bind(manifest.captureDate, manifest.requiredDays)
      .all()
  ).results.map((row) => row.trade_date);
  // 统一收口（§8.2/§10）：窗口已满足评估条件却仍 RUNNING 时，冻结窗口、
  // 进入 EVALUATING 并评估。用于正常收口与"已登记但尚未评估即中断"的
  // 恢复；幂等——收口后阶段变为 EVALUATING，重入在阶段入口被拦截，不会
  // 重复评估。缺失日不补满，留待共同覆盖闸门暴露、整批无资格。
  const closeWindow = async (tradingDates) => {
    await cohorts.transitionCohort(cohort.id, {
      from: "RUNNING",
      to: "EVALUATING",
      eventType: "FORWARD_WINDOW_COMPLETE",
      payload: {
        days: tradingDates.length,
        missing: Math.max(0, manifest.requiredDays - tradingDates.length),
        windowEnd: windowDates.at(-1) ?? null,
        primaryOrdinal,
      },
      set: {
        forward_manifest: JSON.stringify({
          ...manifest,
          tradingDates,
          windowDates,
        }),
      },
    });
    return evaluateCohort(env, cohort.id, { calendarDates });
  };
  if (manifest.tradingDates.includes(date)) {
    // 已登记日：仍幂等重结算未完成账户（不重复 claim、样本或事件），
    // 修复"部分账户结算失败后被 DUPLICATE 早退卡住"的缺口。
    const datasetRow = await papers.db
      .prepare("SELECT payload FROM paper_market_days WHERE trade_date = ?")
      .bind(date)
      .first();
    const settlements = datasetRow
      ? await settleAccounts(
          env,
          accountIds,
          date,
          JSON.parse(datasetRow.payload),
          {
            shadows,
          },
        )
      : [];
    // 末日登记已落库、尚未进入 EVALUATING 时进程退出：同日重试按已满足的
    // 主账户结算序数恢复收口，避免批次永久 RUNNING 占锁（§10）。
    const evaluation =
      primaryOrdinal >= manifest.requiredDays
        ? await closeWindow(manifest.tradingDates)
        : null;
    return {
      status: "DUPLICATE",
      settlements,
      evaluation,
      reason: "该共同市场日已登记，幂等跳过；窗口已满足则恢复收口",
    };
  }
  const datasetRow = await papers.db
    .prepare("SELECT payload FROM paper_market_days WHERE trade_date = ?")
    .bind(date)
    .first();
  if (!datasetRow)
    return {
      status: "WAITING_PRIMARY",
      reason: "主账户当日尚未结算；影子账本与主账户结算保持追平，不提前结算",
    };
  if (primaryOrdinal > manifest.requiredDays) {
    // 主账户已进入窗口外的结算日：不登记、不延长。窗口若因此前中断而
    // 始终未收口（阶段仍 RUNNING），在此兜底收口；缺失日由共同覆盖闸门
    // 暴露，整批无资格。
    const evaluation = await closeWindow(manifest.tradingDates);
    return {
      status: "WINDOW_ENDED",
      evaluation,
      reason: "固定窗口已结束；窗口外交易日不登记、不延长窗口",
    };
  }
  const frameRows = await frames.framesForDate(date);
  const dataset = JSON.parse(datasetRow.payload);
  const enrichedDataset = {
    ...dataset,
    quotes: closingQuotesFromFrames(frameRows, dataset.quotes ?? {}, date),
  };
  const snapshot = await papers.snapshot(date);
  // 影子结算与次日计划照常（§6）：影子账本连续性不依赖日历可用性；
  // 空日历只影响共同市场日登记与窗口推进（见下方登记块）。
  const settlements = await settleAccounts(
    env,
    accountIds,
    date,
    enrichedDataset,
    { shadows },
  );
  // 冻结各账户下一交易日计划；账户按自身策略独立生成，不改写旧计划。
  const parentRow = await papers.db
    .prepare("SELECT params FROM strategy_versions WHERE id = ?")
    .bind(cohort.parentVersion)
    .first();
  const parentParams = parentRow ? JSON.parse(parentRow.params) : null;
  const strategyByAccount = new Map();
  for (const member of (await cohorts.members(cohort.id)).filter((candidate) =>
    accountIds.includes(`shadow-${candidate.experimentId}`),
  )) {
    strategyByAccount.set(`shadow-${member.experimentId}`, {
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
  const members = await cohorts.members(cohort.id);
  // 共同市场日先登记（claim 先于样本用途写入，满足一次性触发器约束）。
  await cohorts.claimCohortForwardDate(date, cohort.id);
  const previousDate = manifest.tradingDates.at(-1) ?? manifest.captureDate;
  const quoteManifestDigest = await digestOf({
    date,
    count: frameRows.length,
    frames: frameRows.map((row) => ({
      sequence: row.sequence,
      observedAt: row.observedAt,
      digest: row.digest,
    })),
  });
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
      marketDigest: await digestOf(enrichedDataset),
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
  // 追加共同市场日；窗口固定，不因缺失顺延到盈利。
  const tradingDates = [...manifest.tradingDates, date];
  await cohorts.transitionCohort(cohort.id, {
    from: "RUNNING",
    to: "RUNNING",
    eventType: "FORWARD_DAY_SETTLED",
    payload: { date, tradingDates: tradingDates.length },
    set: {
      forward_manifest: JSON.stringify({
        ...manifest,
        tradingDates,
        windowDates,
      }),
    },
  });
  // 评估由主账户结算序列触发（§8.2）：捕获日之后第 requiredDays 个
  // 主账户结算日结算完成即收口；缺失日不补满，赛马侧漏登记的日子
  // 保留在窗口列表内由共同覆盖闸门暴露。
  const evaluation =
    primaryOrdinal >= manifest.requiredDays
      ? await closeWindow(tradingDates)
      : null;
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
  { calendarDates = [], now = null } = {},
) {
  const cohorts = new CohortRepository(env);
  const papers = new RealtimeRepository(env);
  const shadows = new ShadowAccountRepository(env);
  const scheduled = await cohorts.activeCohort();
  let schedule = null;
  if (scheduled?.stage === "SCHEDULED")
    schedule = await scheduleCohortForward(env, scheduled.id, {
      now: now ?? new Date().toISOString(),
    });
  const settle = await settleTournamentDay(env, date, {
    calendarDates,
    now,
  });
  // 连续固定基线跨批次持续（§6）：无运行中批次时仍按日结算净值并冻结次计划。
  let continuous = null;
  const stillRunning = (await cohorts.activeCohort())?.stage === "RUNNING";
  if (!stillRunning) {
    const account = await shadows.account(continuousBaselineId);
    if (
      account?.status === "ACTIVE" &&
      account.book.lastDate &&
      account.book.lastDate < date
    ) {
      const datasetRow = await papers.db
        .prepare("SELECT payload FROM paper_market_days WHERE trade_date = ?")
        .bind(date)
        .first();
      if (datasetRow) {
        const dataset = JSON.parse(datasetRow.payload);
        const frameRows = await new QuoteFrameRepository(env).framesForDate(
          date,
        );
        const enrichedDataset = {
          ...dataset,
          quotes: closingQuotesFromFrames(
            frameRows,
            dataset.quotes ?? {},
            date,
          ),
        };
        continuous = await settlePortfolioDay(
          env,
          continuousBaselineId,
          date,
          enrichedDataset,
          { shadows },
        ).catch((error) => ({ stalled: true, reason: safeError(error) }));
        try {
          const snapshot = await papers.snapshot(date);
          await freezePortfolioPlan(
            env,
            continuousBaselineId,
            {
              snapshot,
              strategy: BASE_STRATEGY,
              strategyVersion: "baseline-v1",
              now: now ?? new Date().toISOString(),
            },
            { shadows },
          );
        } catch (error) {
          continuous = {
            ...(continuous ?? {}),
            planStalled: true,
            planReason: safeError(error),
          };
        }
      }
    }
  }
  return { schedule, settle, continuous };
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
  // 评估幂等（§10）：已发布报告直接复用并确保批次收尾——评估在收尾前
  // 中断时，盘后任务重入不重新计算、不产生新的选优机会。
  const published = await cohorts.report(cohortId, "EVALUATION");
  if (published?.payload) {
    const wasPromoted = Boolean(published.payload.promotion?.promoted);
    await cohorts
      .transitionCohort(cohortId, {
        from: "EVALUATING",
        to: "CLOSED",
        eventType: wasPromoted ? "CHAMPION_PROMOTED" : "COHORT_EVALUATED",
        payload: {
          champion: published.payload.champion ?? null,
          promoted: wasPromoted,
          note: "评估报告已发布，重入仅补齐批次收尾",
        },
        set: wasPromoted
          ? {
              evaluation_manifest: JSON.stringify(published.payload),
              effective_trade_date:
                published.payload.promotion?.effectiveTradeDate ?? null,
            }
          : { evaluation_manifest: JSON.stringify(published.payload) },
      })
      .catch(() => {});
    await cohorts.releaseWindowOwner("COHORT", cohortId).catch(() => {});
    return published.payload;
  }
  const manifest = cohort.forwardManifest;
  // 固定窗口（§8.2）：评估用冻结窗口日历（含缺失日），缺失由覆盖与共同数据
  // 检查暴露；窗口内的 tradingDates 只包含实际结算并登记的共同市场日。
  const windowDates = manifest.windowDates?.length
    ? manifest.windowDates
    : manifest.tradingDates;
  const frozenPolicy = cohort.reservationManifest?.cohortPolicy;
  const budget = cohort.proposalManifest?.statisticsBudget;
  const minimumRounds = frozenPolicy?.minimumCompletedRounds ?? 10;
  // 统计任务隔离与幂等（§10）：评估输入以任务记录隔离归档；
  // 同一冻结输入的重放复用已发布报告，不产生新的选优机会。
  const statisticsInputDigest = await digestOf({
    cohortId,
    windowDates,
    budget: budget ?? null,
    minimumRounds,
  });
  const priorTasks = await cohorts.tasksForOwner(cohortId, "COHORT_STATISTICS");
  const priorDone = priorTasks.find(
    (task) =>
      task.stage === "DONE" && task.inputDigest === statisticsInputDigest,
  );
  if (priorDone) {
    const existing = await cohorts.report(cohortId, "EVALUATION");
    if (existing?.payload) return existing.payload;
  }
  const statisticsTaskId = await cohorts.createTask({
    ownerId: cohortId,
    taskType: "COHORT_STATISTICS",
    inputDigest: statisticsInputDigest,
  });
  await cohorts.leaseTask(statisticsTaskId, {
    leaseOwner: `evaluate-${cohortId}`,
  });
  // 共同数据覆盖：每个窗口日必须有主账户结算数据、cohort 名下的日期登记，
  // 且该日已计入 tradingDates（即完整日登记——claim/样本用途/窗口推进全部
  // 落库）。只校验 claim 不够：claim 成功但完整登记失败时，该日会缺席
  // tradingDates，必须让整批无资格，而不是放行 29 天的批次晋级（§8.2）。
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
      registered: manifest.tradingDates.includes(date),
    });
  }
  let commonDataMissing = commonCoverage.some(
    (row) =>
      !row.datasetSettled ||
      row.claimOwner !== `COHORT:${cohortId}` ||
      !row.registered,
  );
  // 环境指纹（闸门 6）：费用、父策略、执行/评分版本与冻结成员清单一致性。
  // 成本联动（statistical-evidence.md §7.2 批次 C）：执行成本政策指纹
  // 绑定到正式评估报告；捕获清单记录了成本摘要的批次在政策变化后失效，
  // 旧批次（清单无此字段）不受影响。
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
  const executionCostPolicy = await latestPolicyBundle(env.DB).catch(
    () => null,
  );
  const executionCost = executionCostPolicy
    ? {
        modelVersion: executionCostPolicy.modelVersion,
        policyId: executionCostPolicy.id,
        version: executionCostPolicy.version,
        digest: executionCostPolicy.payloadDigest,
        calibrationStatus: executionCostPolicy.calibrationStatus,
        matchesManifest: manifest.executionCostDigest
          ? manifest.executionCostDigest === executionCostPolicy.payloadDigest
          : null,
      }
    : null;
  const fingerprint = {
    selectionPolicyMatches: selectionPolicyMatches(manifest, primary.book),
    feeConfigMatches: feeConfigDigest === manifest.feeConfigDigest,
    parentStrategyMatches: primary.book.activeStrategy === cohort.parentVersion,
    membersIntact,
    executionVersion: EXECUTION_VERSION,
    scoringVersion: SCORING_VERSION,
    executionCost,
    environmentValid:
      feeConfigDigest === manifest.feeConfigDigest &&
      primary.book.activeStrategy === cohort.parentVersion &&
      membersIntact &&
      executionCost?.matchesManifest !== false,
    // 当前账户与窗口冻结政策必须相同；源码同时保留 v1/v2，部署本身不改窗口。
  };
  fingerprint.environmentValid &&= fingerprint.selectionPolicyMatches;
  const controlSelection = await Promise.all(
    [manifest.accounts.parentMatch, manifest.accounts.baselineMatch].map((id) =>
      portfolioSelectionEvidence(env, id, { ...manifest, windowDates }),
    ),
  );
  fingerprint.controlSelectionMatches = controlSelection.every(
    (e) => e.matches,
  );
  commonDataMissing ||= controlSelection.some((e) => !e.complete);
  fingerprint.environmentValid &&= fingerprint.controlSelectionMatches;
  const metricsOf = async (accountId) => {
    const account = await shadows.account(accountId);
    if (!account) return null;
    const allEquities = await shadows.equities(accountId);
    const equities = allEquities.filter((row) =>
      windowDates.includes(row.tradeDate ?? row.trade_date),
    );
    // 期末状态（§8.2）：取窗口内最后一个已结算净值行，而非账本当前状态。
    // 末日登记已落库、尚未收口时进程退出后，次日的盘中轮询仍会推进影子
    // 账本（盯市与成交），恢复评估时账本当前权益已含窗口外盈亏；用当前
    // 账本会把窗口外收益混进标为原窗口的报告。窗口内无已结算净值时退回
    // 期初快照（零盈亏），缺失日由覆盖闸门判无资格。
    const finalRow = equities.at(-1);
    const final = finalRow
      ? {
          equityCents: finalRow.equityCents,
          feesCents: finalRow.feesCents,
          realizedPnlCents: finalRow.realizedPnlCents,
          unrealizedPnlCents: finalRow.unrealizedPnlCents,
        }
      : manifest.initialAccounts[accountId];
    const metrics = windowMetrics({
      initial: manifest.initialAccounts[accountId],
      final,
      equities,
      windowDates,
    });
    const ledger = await shadows.ledger(accountId);
    // 完整轮次从捕获时点的继承持仓数量起步重建（§8.2）：
    // 继承持仓平仓与 T 两腿不凑次数。
    const initialPositions = {};
    for (const position of manifest.initialPositions?.[accountId] ?? [])
      initialPositions[position.code] = position.quantity;
    const rounds = completeRounds(ledger, windowDates, initialPositions);
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
  // 已裁定终态（评估中断后重入）：保留既有结论、补齐报告指标，
  // 使唯一自动晋级在恢复时仍然成立，而不是把冠军当作"未进入窗口"。
  const decidedStages = [
    "ELIGIBLE",
    "PROMOTED",
    "REJECTED",
    "INCONCLUSIVE",
    "INVALIDATED",
    "ERROR",
  ];
  for (const member of members) {
    const decided = decidedStages.includes(member.stage);
    const accountId = `shadow-${member.experimentId}`;
    const metrics = await metricsOf(accountId);
    const selectionEvidence = await portfolioSelectionEvidence(env, accountId, {
      ...manifest,
      windowDates,
    });
    const checks = {
      fingerprint: fingerprint.environmentValid && selectionEvidence.matches,
      // 数据覆盖：窗口日缺失或净值行按盘中观测价盯市（complete:false）
      // 都算覆盖失败——盘中价不冒充收盘价参与晋级资格。
      coverage:
        selectionEvidence.complete &&
        Boolean(metrics) &&
        metrics.metrics.missingDates.length === 0 &&
        metrics.metrics.incompleteDates.length === 0,
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
    else if (commonDataMissing)
      // §8.2：共同对照或共同数据缺失使整个批次无资格，任何成员不晋级。
      verdict = "INCONCLUSIVE";
    else if (!checks.coverage) verdict = "INCONCLUSIVE";
    else if (!checks.rounds) verdict = "INCONCLUSIVE";
    else if (!checks.statistics) verdict = "INCONCLUSIVE";
    else if (!checks.returns || !checks.drawdown) verdict = "REJECTED";
    else verdict = "ELIGIBLE";
    // 重入幂等：已裁定成员保留既有结论（重算结果应与之一致），
    // 不再重复迁移；RUNNING 成员正常迁移。
    const finalVerdict = decided ? member.stage : verdict;
    if (member.stage === "RUNNING")
      await cohorts.transitionMember(cohortId, member.memberId, {
        from: "RUNNING",
        to: finalVerdict,
      });
    verdicts.push({
      memberId: member.memberId,
      stage: finalVerdict,
      accountId,
      checks,
      statistics: statisticsDetail,
      metrics: metrics?.metrics ?? null,
      rounds: metrics?.rounds ?? null,
      note: decided ? "评估重入：成员已裁定，补齐报告指标" : undefined,
    });
  }
  // 冠军排行含 PROMOTED：评估中断恢复时已晋级成员仍可回到排序首位，
  // 重入的晋级服务识别 duplicate，不产生第二次切换。
  const eligible = verdicts.filter((row) =>
    ["ELIGIBLE", "PROMOTED"].includes(row.stage),
  );
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
    ...selectionPolicyFields(frozenSelectionPolicy(manifest)),
    note: "仅从通过全部闸门的合格集合按冻结排序启用至多一个候选；全部不通过时保持当前策略",
  };
  // 报告摘要在晋级之前先按"未含晋级结果"的版本冻结：晋级服务重算该摘要
  // 核验报告输入未被篡改；晋级结束后重新定稿（含 promotion 结果），
  // 保证存储报告的摘要与内容一致——CAS 冲突后的合法重试不会被拒。
  report.digest = await digestOf(report);
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
  // 晋级后重新定稿：先剥离旧 digest 再重算，保证存储报告的摘要
  // 与"剥离 digest 后的内容"一致，CAS 冲突后的合法重试不会被拒。
  const { digest: prePromotionDigest, ...postPromotionSource } = report;
  void prePromotionDigest;
  report.digest = await digestOf(postPromotionSource);
  await cohorts.completeTask(statisticsTaskId, { outputDigest: report.digest });
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
