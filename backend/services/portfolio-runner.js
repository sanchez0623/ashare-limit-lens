import { ShadowAccountRepository } from "../storage/shadow.js";
import { buildOriginalScoreLookup, digest } from "../storage/paper.js";
import {
  selectionPolicyForBook,
  frozenSelectionPolicy,
  selectionPolicyDigest,
  selectionSnapshotDigest,
} from "../domain/signal-selection.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../domain/realtime.js";
import { createPlan, defensivePlan } from "../domain/trading.js";
import {
  extractTTrades,
  summarizeTQuality,
  buildTQualityEvidence,
} from "../domain/t-quality.js";
import { tradingCalendar } from "./market.js";
import { loadOrBuildExitContext } from "./exit-context.js";
import { assertStoredProgramPlan } from "./strategy-program-evidence.js";
import {
  latestPolicyBundle,
  verifyPolicyBundle,
} from "../storage/execution-cost.js";

// 组合执行器（§7.2）：指定 accountId 顺序消费已落盘行情帧与盘后结算。
// 每个账户按序消费；一账户的重试不重复其他账户的成交；崩溃后只消费已经落盘的帧。
// 账户状态、会话、成交与消费游标通过一次 CAS 提交原子完成。

export async function consumePortfolioFrame(
  env,
  accountId,
  frame,
  { shadows = new ShadowAccountRepository(env) } = {},
) {
  const account = await shadows.account(accountId);
  if (!account) return { skipped: true, reason: "影子账户不存在" };
  if (account.status !== "ACTIVE")
    return { skipped: true, reason: "账户已停用" };
  if (shadows.hasConsumed(account, frame.tradeDate, frame.sequence))
    return { skipped: true, consumed: true };
  if (account.cursorDate && frame.tradeDate < account.cursorDate)
    return { skipped: true, reason: "行情帧早于账户消费游标" };
  // 按序消费（§7.2）：同日游标之后的帧必须先消费前序帧，
  // 不能越过未消费的持久帧直接处理后续帧（乱序回填也不允许）。
  const cursorSequence =
    account.cursorDate === frame.tradeDate ? account.cursorSequence : 0;
  if (frame.sequence > cursorSequence + 1)
    return {
      stalled: true,
      accountId,
      reason: `存在未消费的前序帧（游标 ${frame.tradeDate}/${cursorSequence}），按序等待重放`,
    };
  const session = await shadows.session(accountId, frame.tradeDate);
  let working = session;
  if (!working) {
    const plan = await shadows.plan(accountId, account.book.lastDate);
    if (!plan)
      return {
        stalled: true,
        reason: "缺少执行日前冻结的计划，账户暂停消费；不事后构造计划",
      };
    // 首次开会话前核验政策摘要（§5.4）。
    if (
      plan.executionCostPolicy &&
      !(await verifyPolicyBundle(plan.executionCostPolicy))
    )
      return {
        stalled: true,
        reason: "计划成本政策与摘要不一致，账户暂停消费；请重新冻结计划",
      };
    await assertStoredProgramPlan(env, plan, account.book);
    working = openSession(account.book, plan, frame.tradeDate);
  } else if (
    // 已有会话同样逐帧核验：政策被篡改的会话不得继续成交（§5.4）。
    working.plan?.executionCostPolicy &&
    !(await verifyPolicyBundle(working.plan.executionCostPolicy))
  )
    return {
      stalled: true,
      reason: "会话计划成本政策与摘要不一致，账户暂停消费；请重新冻结计划",
    };
  const observation = {
    observedAt: frame.observedAt,
    quotes: frame.payload?.quotes ?? frame.quotes,
    pollIntervalSeconds:
      frame.payload?.pollIntervalSeconds ?? frame.pollIntervalSeconds,
  };
  if (session)
    await assertStoredProgramPlan(env, working.plan, working.initialBook);
  const result = advanceSession(account.book, working, observation);
  const runId = `shadow-${accountId}-${frame.tradeDate}-${frame.sequence}-${crypto.randomUUID()}`;
  const commit = await shadows.commitFrame({
    accountId,
    expectedRevision: account.revision,
    runId,
    tradeDate: frame.tradeDate,
    sequence: frame.sequence,
    book: result.book,
    session: result.session,
    observation,
    ledger: result.ledger,
  });
  return {
    applied: commit.applied,
    fills: result.ledger.length,
    sequence: frame.sequence,
    accountId,
  };
}

export async function settlePortfolioDay(
  env,
  accountId,
  date,
  dataset,
  { shadows = new ShadowAccountRepository(env) } = {},
) {
  const account = await shadows.account(accountId);
  if (!account || account.status !== "ACTIVE") return { skipped: true };
  if (account.book.lastDate === date)
    return { settled: true, duplicate: true, accountId };
  const session = await shadows.session(accountId, date);
  if (!session)
    return {
      stalled: true,
      accountId,
      reason: "当日无实时会话记录，不补造开盘或盘中成交",
    };
  await assertStoredProgramPlan(env, session.plan, session.initialBook);
  const result = closeSession(account.book, session, dataset);
  const runId = `shadow-settle-${accountId}-${date}-${crypto.randomUUID()}`;
  const commit = await shadows.commitSettlement({
    accountId,
    expectedRevision: account.revision,
    runId,
    tradeDate: date,
    book: result.book,
    equity: result.equity,
    session: result.session,
  });
  return {
    applied: commit.applied,
    accountId,
    equity: result.equity,
    outcomes: result.outcomes,
    notices: result.notices,
  };
}

export async function freezePortfolioPlan(
  env,
  accountId,
  { snapshot, strategy, strategyVersion, now },
  { shadows = new ShadowAccountRepository(env) } = {},
) {
  const account = await shadows.account(accountId);
  if (!account) throw new Error("影子账户不存在");
  const signalDate = snapshot?.date ?? account.book.lastDate;
  const existing = await shadows.plan(accountId, signalDate);
  if (existing) {
    frozenSelectionPolicy(existing);
    return existing;
  }
  const selectionPolicy = selectionPolicyForBook(account.book);
  // 同一批次与主账户冻结相同政策（§3.2）：影子组合是独立假设路径，
  // 但成本假设必须一致，否则对照与赛马排名不可比。
  const executionCostPolicy = await latestPolicyBundle(env.DB);
  // 持仓股掉出当日涨停池时，从最近快照归档回查原始评分用于计划展示。
  const originalScoreLookup = await buildOriginalScoreLookup(
    env.DB,
    snapshot?.date ?? account.book.lastDate,
    account.book.positions.map((position) => position.code),
  );
  // 方案 5 卖出上下文与主账户引用同一固化版本：影子计划对同一快照得到
  // 同一卖出决策，主账户冻结后日线 Parquet 补齐也不漂移。构建失败降级
  // 为无上下文（对应信号跳过），不阻断计划冻结。
  let exitContext = null;
  if (snapshot) {
    try {
      exitContext = await loadOrBuildExitContext({
        env,
        db: shadows.db,
        snapshot,
        date: snapshot.date,
      });
    } catch {
      exitContext = null;
    }
  }
  // 方案 7：做T质量摘要——影子账户从自己的成交流水派生做T记录并汇总
  // （与主账户同一规则口径）。日历不可用时 tradingDates 置空：停手窗口
  // 判定退化为保守阻止（连续亏损即停），质量约束不因日历缺失而解除；
  // 成交流水派生失败才退化为无闸门（无输入可用，不猜测）。
  const shadowSignalDate = snapshot?.date ?? account.book.lastDate;
  let tQuality = null;
  let tQualityEvidence = null;
  if (shadowSignalDate) {
    let tradingDates = [];
    try {
      const tFrom = new Date(
        new Date(`${shadowSignalDate}T00:00:00Z`).getTime() - 20 * 86400000,
      )
        .toISOString()
        .slice(0, 10);
      tradingDates = (await tradingCalendar(tFrom, shadowSignalDate)).dates;
    } catch {
      tradingDates = [];
    }
    try {
      const tRecords = extractTTrades(await shadows.ledger(accountId)).records;
      tQuality = summarizeTQuality(tRecords, {
        signalDate: shadowSignalDate,
        tradingDates,
      });
      tQualityEvidence = buildTQualityEvidence(tRecords, tradingDates);
    } catch {
      tQuality = null;
      tQualityEvidence = null;
    }
  }
  const plan = snapshot
    ? createPlan(snapshot, account.book, strategy, strategyVersion, now, {
        executionCostPolicy,
        originalScoreLookup,
        selectionPolicy,
        snapshotDigest: await selectionSnapshotDigest(snapshot),
        ...(exitContext ?? {}),
        ...(tQuality
          ? {
              tQuality,
              ...(tQualityEvidence ? { tQualityEvidence } : {}),
            }
          : {}),
      })
    : defensivePlan(
        account.book.lastDate,
        account.book,
        strategy,
        strategyVersion,
        now,
        { executionCostPolicy, originalScoreLookup, selectionPolicy },
      );
  return shadows.savePlan(accountId, plan);
}

// 晋级所依据的每个执行日都必须使用窗口政策；不能只检查当前账户标签。
// 没有政策标记的旧窗口保留历史兼容，新窗口检查实际冻结计划及内容摘要。
export async function portfolioSelectionMatches(env, accountId, manifest) {
  const evidence = await portfolioSelectionEvidence(env, accountId, manifest);
  return evidence.matches && evidence.complete;
}
export async function portfolioSelectionEvidence(env, accountId, manifest) {
  const policy = frozenSelectionPolicy(manifest);
  if (!manifest.selectionPolicy) return { matches: true, complete: true };
  const shadows = new ShadowAccountRepository(env);
  const dates = [
    manifest.captureDate,
    ...(manifest.windowDates ?? manifest.tradingDates ?? []).slice(0, -1),
  ];
  let complete = true;
  for (const date of dates) {
    const plan = await shadows.plan(accountId, date);
    if (!plan) {
      complete = false;
      continue;
    }
    const { digest: storedDigest, ...payload } = plan;
    try {
      if (
        selectionPolicyDigest(frozenSelectionPolicy(plan)) !==
          selectionPolicyDigest(policy) ||
        (await digest(payload)) !== storedDigest
      )
        return { matches: false, complete };
    } catch {
      return { matches: false, complete };
    }
  }
  return { matches: true, complete };
}
