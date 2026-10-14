import {
  digestOf,
  eventDigest,
  EXECUTION_VERSION,
  SCORING_VERSION,
} from "./research-lineage.js";
import {
  verifyExecutionStress,
  verifyStressFreeze,
} from "./execution-stress.js";
import { validateResearchPolicy } from "./research-policy.js";
import { computeStatisticsBudget } from "./cohort-policy.js";
import {
  windowMetrics,
  completeRounds,
  unrealizedPnlCents,
} from "./cohort-metrics.js";
import {
  dailyReturns,
  pairedComparisonsStreaming,
} from "./research-statistics.js";
import { BASE_STRATEGY, createPlan } from "./trading.js";
import { openSession, advanceSession, closeSession } from "./realtime.js";
import {
  frozenSelectionPolicy,
  selectionSnapshotDigest,
} from "./signal-selection.js";
import { researchForwardBuildDigest } from "./research-build.js";

const requireEvidence = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function same(a, b, message) {
  requireEvidence((await digestOf(a)) === (await digestOf(b)), message);
}
async function hashRows(rows, label) {
  for (const row of rows)
    requireEvidence(
      (await digestOf(row.payload)) === row.digest,
      `${label}摘要不一致`,
    );
}
async function chain(events, label) {
  let previous = null;
  for (const [index, event] of events.entries()) {
    requireEvidence(
      event.sequence === index + 1 &&
        event.previousDigest === previous &&
        (await eventDigest(event)) === event.digest,
      `${label}事件链不一致`,
    );
    previous = event.digest;
  }
}
function closingQuotes(frames, existing, date) {
  const quotes = { ...existing };
  for (const frame of [...frames].reverse()) {
    for (const [code, quote] of Object.entries(frame.payload.quotes ?? {})) {
      const closeCents = quote.closeCents ?? quote.lastCents;
      if (!quotes[code] && closeCents > 0)
        quotes[code] = {
          ...quote,
          date,
          timestamp: `${date}T15:00:00+08:00`,
          closeCents,
          closingSource: "FRAME_LAST_OBSERVED",
        };
    }
  }
  return quotes;
}

// 独立核验器：重新生成计划、逐帧成交及日净值，再计算轮次、统计和压力闸门。
// 不信任报告里的通过标记；尚未结束或缺失输入明确没有启用资格。
export async function verifyResearchExport(bundle) {
  requireEvidence(
    bundle?.format === "limit-lens-research-v1" && bundle.schemaVersion === 1,
    "研究导出格式无效",
  );
  const experiment = bundle.experiment;
  requireEvidence(
    experiment?.id && experiment.proposalManifest,
    "研究冻结提案缺失",
  );
  requireEvidence(
    (await digestOf(experiment.proposalManifest)) === experiment.proposalDigest,
    "提案摘要不一致",
  );
  await chain(bundle.events, "研究");
  await hashRows(bundle.reports, "研究报告");
  await hashRows(
    bundle.samples.map((row) => ({ payload: row.payload, digest: row.digest })),
    "样本",
  );
  await hashRows(bundle.switches, "切换");
  const protocol = experiment.reservationPayload.singleForward;
  const reasons = [];
  if (
    !protocol ||
    !bundle.forward?.cohort.forwardManifest ||
    !bundle.evaluation
  )
    return {
      passed: true,
      eligibleForPromotion: false,
      reasons: ["单候选尚未完成事前冻结的前瞻窗口"],
    };
  const { digest: protocolDigest, ...protocolSource } = protocol;
  requireEvidence(
    (await digestOf(protocolSource)) === protocolDigest,
    "单候选协议摘要不一致",
  );
  requireEvidence(
    protocol.version === 1 && protocol.mode === "SINGLE",
    "单候选协议版本不支持",
  );
  requireEvidence(
    protocol.ruleBuildDigest === (await researchForwardBuildDigest()),
    "前瞻规则源码版本不匹配",
  );
  await verifyStressFreeze(protocol.executionStress);
  requireEvidence(
    bundle.policy &&
      (await digestOf(bundle.policy.payload)) === bundle.policy.digest &&
      bundle.policy.digest === protocol.policyDigest,
    "研究政策摘要不一致",
  );
  const policy = validateResearchPolicy(bundle.policy.payload);
  const k = experiment.reservationPayload.attemptSequence;
  const budget = computeStatisticsBudget({
    ks: [k],
    statistical: policy.statistical,
  });
  await same(
    protocol.statisticsBudget,
    budget,
    "统计预算未按全历史尝试序号冻结",
  );
  requireEvidence(
    protocol.forwardDays === policy.forwardDays &&
      protocol.minimumCompletedRounds === policy.minimumCompletedRounds,
    "前瞻窗口或轮次门槛被修改",
  );
  const cohort = bundle.forward.cohort;
  const members = bundle.forward.members;
  requireEvidence(
    cohort.mode === "SINGLE" &&
      cohort.maxCandidates === 1 &&
      members.length === 1 &&
      members[0].experimentId === experiment.id &&
      members[0].k === k,
    "单候选运行组身份不一致",
  );
  const member = members[0];
  requireEvidence(
    cohort.id === `single-${experiment.id.slice(4)}` &&
      member.memberId === "m1",
    "单候选运行组 id 不自洽",
  );
  const { reservationDigest, ...reservation } = cohort.reservationManifest;
  requireEvidence(
    (await digestOf(reservation)) === reservationDigest &&
      reservation.originalReservationDigest ===
        (await digestOf(experiment.reservationPayload)),
    "运行组与原预留清单不一致",
  );
  const reservedEvent = bundle.events[0];
  await same(
    reservedEvent.payload.reservation,
    experiment.reservationPayload,
    "原预留事件与清单不一致",
  );
  requireEvidence(
    reservedEvent.payload.reservationDigest ===
      (await digestOf(experiment.reservationPayload)),
    "原预留摘要不一致",
  );
  await chain(bundle.forward.events, "运行组");
  await same(
    reservation.executionStress,
    protocol.executionStress,
    "压力规则不一致",
  );
  const manifest = cohort.forwardManifest;
  await same(
    manifest.executionStress,
    protocol.executionStress,
    "捕获压力规则不一致",
  );
  requireEvidence(
    manifest.initialBookDigest === (await digestOf(manifest.initialBook)) &&
      manifest.initialAccountsDigest ===
        (await digestOf(manifest.initialAccounts)),
    "期初账本摘要不一致",
  );
  const initial = {
    equityCents: manifest.initialBook.equityCents,
    feesCents: manifest.initialBook.feesCents,
    realizedPnlCents: manifest.initialBook.realizedPnlCents,
    unrealizedPnlCents: unrealizedPnlCents(manifest.initialBook),
  };
  const inherited = (manifest.initialBook.positions ?? []).map((position) => ({
    code: position.code,
    quantity: position.lots.reduce((n, lot) => n + lot.quantity, 0),
  }));
  const report = bundle.evaluation;
  const { digest: reportDigest, ...reportSource } = report;
  requireEvidence(
    (await digestOf(reportSource)) === reportDigest &&
      report.cohortId === cohort.id &&
      !report.purpose,
    "最终报告摘要、身份或用途不一致",
  );
  requireEvidence(
    report.executionVersion === EXECUTION_VERSION &&
      report.scoringVersion === SCORING_VERSION,
    "执行或评分版本不支持",
  );
  const dates = manifest.windowDates;
  await same(dates, report.windowDates, "报告使用的前瞻日期不一致");
  requireEvidence(
    Array.isArray(dates) &&
      dates.every(
        (date, i) => date > manifest.captureDate && (!i || date > dates[i - 1]),
      ),
    "前瞻日期顺序或起点无效",
  );
  if (dates.length !== protocol.forwardDays || !budget.sufficient)
    reasons.push("前瞻窗口或统计计算额度不足");
  await hashRows(bundle.market, "市场日");
  await hashRows(bundle.snapshots, "快照");
  const proposal = experiment.proposalManifest;
  await same(member.params, proposal.candidateParams, "候选参数与提案不一致");
  requireEvidence(
    (await digestOf(member.params)) === member.paramsDigest &&
      member.strategyVersion === experiment.candidateVersion,
    "候选版本或参数摘要不一致",
  );
  await same(
    bundle.versions.find((v) => v.id === member.strategyVersion)?.params,
    member.params,
    "策略版本被修改",
  );
  await same(
    bundle.versions.find((v) => v.id === cohort.parentVersion)?.params,
    protocol.executionStress.parentParams,
    "父策略参数被修改",
  );
  await same(manifest.feeConfig, protocol.feeConfig, "费用口径不一致");
  requireEvidence(
    proposal.parentParamsDigest ===
      protocol.executionStress.parentParamsDigest &&
      proposal.feeConfigDigest === protocol.feeConfigDigest,
    "提案环境与事前协议不一致",
  );
  const accountIds = [
    manifest.accounts.candidates[0],
    manifest.accounts.parentMatch,
    manifest.accounts.baselineMatch,
  ];
  requireEvidence(
    accountIds[0] === `shadow-${experiment.id}` &&
      new Set(bundle.accounts.map((account) => account.accountId)).size ===
        bundle.accounts.length,
    "候选账户或导出账户身份不一致",
  );
  requireEvidence(
    new Set(accountIds).size === 3 && manifest.accounts.candidates.length === 1,
    "匹配账户身份不一致",
  );
  const metrics = new Map();
  for (const [index, accountId] of accountIds.entries()) {
    await same(
      manifest.initialAccounts[accountId],
      initial,
      "匹配账户期初权益不一致",
    );
    await same(
      manifest.initialPositions[accountId],
      inherited,
      "匹配账户继承持仓不一致",
    );
    const account = bundle.accounts.find((a) => a.accountId === accountId);
    if (!account) {
      reasons.push(`匹配账户 ${accountId} 缺失`);
      continue;
    }
    await hashRows(account.plans, "影子计划");
    await hashRows(account.equities, "影子净值");
    await hashRows(account.sessions, "影子会话");
    if (
      dates.some(
        (date) =>
          !bundle.market.some((row) => row.payload.date === date) ||
          !bundle.quoteFrames.find((row) => row.date === date)?.frames.length ||
          !account.equities.some((row) => row.tradeDate === date) ||
          !account.sessions.some((row) => row.tradeDate === date),
      )
    ) {
      reasons.push(`${accountId} 前瞻输入缺失`);
      continue;
    }
    const params = [
      member.params,
      protocol.executionStress.parentParams,
      BASE_STRATEGY,
    ][index];
    const versionId = [
      member.strategyVersion,
      cohort.parentVersion,
      "baseline-v1",
    ][index];
    let book = structuredClone(manifest.initialBook);
    const fills = [],
      equities = [];
    for (const date of dates) {
      const dataset = bundle.market.find(
        (row) => row.payload.date === date,
      )?.payload;
      const frames =
        bundle.quoteFrames.find((row) => row.date === date)?.frames ?? [];
      const equity = account.equities.find((row) => row.tradeDate === date);
      const storedSession = account.sessions.find(
        (row) => row.tradeDate === date,
      );
      if (!dataset || !frames.length || !equity || !storedSession) {
        reasons.push(`${accountId}/${date} 数据缺失`);
        break;
      }
      const claim = bundle.claims.find((row) => row.outcome_date === date);
      requireEvidence(
        claim?.owner_type === "COHORT" &&
          claim.owner_id === cohort.id &&
          manifest.tradingDates.includes(date),
        "前瞻日期占用或完整登记缺失",
      );
      const sample = bundle.samples.find(
        (row) => row.role === "FORWARD_TEST" && row.outcomeDate === date,
      );
      requireEvidence(
        sample &&
          !bundle.uses.some(
            (row) =>
              row.outcome_date === date &&
              row.experiment_id !== experiment.id &&
              row.role !== "TRAIN" &&
              row.role !== "HISTORICAL_TRAIN",
          ),
        "前瞻样本用途缺失或重复",
      );
      await hashRows(frames, "行情帧");
      requireEvidence(
        frames.every(
          (frame, i) =>
            frame.sequence === i + 1 &&
            frame.observedAt === frame.payload.observedAt &&
            (!i || frame.observedAt > frames[i - 1].observedAt),
        ),
        "行情帧顺序或时间不一致",
      );
      requireEvidence(
        dataset.previousTradingDate === book.lastDate,
        "前瞻市场日不连续",
      );
      const planRow = account.plans.find(
        (row) => row.payload.signalDate === book.lastDate,
      );
      const savedPlan = planRow?.payload;
      requireEvidence(
        savedPlan && savedPlan.createdAt < `${date}T01:15:00.000Z`,
        "执行日前计划缺失或事后生成",
      );
      const snapshot = bundle.snapshots.find(
        (row) => row.payload.date === book.lastDate,
      )?.payload;
      requireEvidence(snapshot, "事前评分快照缺失");
      const lookup = (code) => {
        for (const row of [...bundle.snapshots]
          .filter((row) => row.payload.date <= snapshot.date)
          .sort((a, b) => b.payload.date.localeCompare(a.payload.date))
          .slice(0, 15)) {
          const stock = row.payload.stocks?.find(
            (stock) =>
              stock.code === code &&
              stock.score != null &&
              Number.isFinite(Number(stock.score)),
          );
          if (stock) return Number(stock.score);
        }
        return null;
      };
      const expectedPlan = createPlan(
        snapshot,
        book,
        params,
        versionId,
        savedPlan.createdAt,
        {
          executionCostPolicy: protocol.executionStress.policy,
          selectionPolicy: frozenSelectionPolicy(manifest),
          originalScoreLookup: lookup,
          snapshotDigest: await selectionSnapshotDigest(snapshot),
        },
      );
      await same(savedPlan, expectedPlan, "影子计划与冻结参数/账本/快照不一致");
      let session = openSession(
        book,
        { ...savedPlan, digest: planRow.digest },
        date,
      );
      for (const frame of frames) {
        const observation = {
          observedAt: frame.observedAt,
          quotes: frame.payload.quotes,
          pollIntervalSeconds: frame.payload.pollIntervalSeconds,
        };
        const step = advanceSession(book, session, observation);
        book = step.book;
        session = step.session;
        fills.push(...step.ledger);
      }
      const settled = closeSession(book, session, {
        ...dataset,
        quotes: closingQuotes(frames, dataset.quotes, date),
      });
      book = settled.book;
      await same(settled.session, storedSession.payload, "会话逐帧重放不一致");
      await same(settled.equity, equity.payload, "日净值逐帧重放不一致");
      if (equity.payload.complete === false)
        reasons.push(`${accountId}/${date} 缺少收盘数据`);
      equities.push({ ...equity.payload, tradeDate: date });
    }
    await same(
      [...account.ledger].sort(
        (a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence,
      ),
      fills,
      "影子成交逐帧重放不一致",
    );
    const calculated = windowMetrics({
      initial,
      final: equities.at(-1) ?? initial,
      equities,
      windowDates: dates,
    });
    const rounds = completeRounds(
      fills,
      dates,
      Object.fromEntries(inherited.map((p) => [p.code, p.quantity])),
    );
    metrics.set(accountId, { metrics: calculated, rounds, equities });
  }
  const candidate = metrics.get(accountIds[0]),
    parent = metrics.get(accountIds[1]),
    baseline = metrics.get(accountIds[2]);
  const verdict = report.verdicts.find((v) => v.memberId === member.memberId);
  requireEvidence(verdict, "单候选评估结论缺失");
  if (candidate) {
    await same(
      verdict.metrics,
      candidate.metrics,
      "报告收益或回撤与账本不一致",
    );
    await same(verdict.rounds, candidate.rounds, "报告完整轮次不一致");
  }
  if (!report.fingerprint?.environmentValid || !verdict.checks?.fingerprint)
    reasons.push("运行环境指纹失效");
  if (candidate && parent && baseline && reasons.length === 0) {
    const returns = (accountId) =>
      dailyReturns({
        initialEquityCents: initial.equityCents,
        equities: metrics.get(accountId).equities,
        dates,
      });
    const statistics = await pairedComparisonsStreaming({
      dates,
      memberReturns: returns(accountIds[0]),
      comparisons: {
        againstParent: returns(accountIds[1]),
        againstBaseline: returns(accountIds[2]),
      },
      blockLength: budget.blockLength,
      resamples: budget.resamples,
      alphaPerComparison: budget.alphaPerComparison,
      seedInput: {
        cohortId: cohort.id,
        windowDates: dates,
        alphaPerComparison: budget.alphaPerComparison,
        blockLength: budget.blockLength,
      },
    });
    await same(verdict.statistics, statistics, "统计结果与固定种子重算不一致");
    if (
      !(
        candidate.rounds.rounds >= policy.minimumCompletedRounds &&
        parent.rounds.rounds >= policy.minimumCompletedRounds
      )
    )
      reasons.push("完整新建仓轮次不足");
    if (
      !(
        candidate.metrics.finalEquityCents >
          parent.metrics.finalEquityCents +
            Math.round(initial.equityCents * 0.001) &&
        candidate.metrics.finalEquityCents >= baseline.metrics.finalEquityCents
      )
    )
      reasons.push("净收益未通过经济门槛");
    if (
      !(
        candidate.metrics.windowDrawdownPpm <= 100000 &&
        candidate.metrics.windowDrawdownPpm <=
          parent.metrics.windowDrawdownPpm + 5000
      )
    )
      reasons.push("回撤未通过门槛");
    if (!statistics.againstParent.passed || !statistics.againstBaseline.passed)
      reasons.push("配对统计证据不足");
  }
  if (!bundle.executionStress) reasons.push("成本压力证据缺失");
  else {
    await verifyExecutionStress(bundle.executionStress);
    await same(
      bundle.executionStress.input.initialBook,
      manifest.initialBook,
      "压力起点与影子起点不一致",
    );
    await same(
      bundle.executionStress.input.frozen,
      protocol.executionStress,
      "压力协议不一致",
    );
    await same(
      bundle.executionStress.input.strategies[member.memberId],
      member.params,
      "压力候选参数不一致",
    );
    await same(
      bundle.executionStress.input.pairs.map((p) => p.dataset.date),
      dates,
      "压力窗口不一致",
    );
    requireEvidence(
      report.executionStress?.id === bundle.executionStress.id &&
        report.executionStress.digest === bundle.executionStress.digest,
      "压力报告引用不一致",
    );
    if (!bundle.executionStress.result.passed[member.memberId])
      reasons.push("成本压力闸门未通过");
  }
  if (reasons.length === 0) {
    requireEvidence(
      Object.values(verdict.checks).every((value) => value === true) &&
        ["ELIGIBLE", "PROMOTED"].includes(verdict.stage) &&
        report.champion?.memberId === member.memberId &&
        report.champion.finalEquityCents === candidate.metrics.finalEquityCents,
      "报告资格、逐项状态或候选结论与独立计算不一致",
    );
  }
  if (
    experiment.stage === "ROLLED_BACK" ||
    bundle.switches.some((row) => row.payload.eventType === "ROLLBACK")
  )
    reasons.push("该实验已回退，旧报告无再次启用资格");
  return {
    passed: true,
    eligibleForPromotion: reasons.length === 0,
    reasons,
    reportDigest,
  };
}
