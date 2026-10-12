import { ShadowAccountRepository } from "../storage/shadow.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../domain/realtime.js";
import { createPlan, defensivePlan } from "../domain/trading.js";
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
  // 同一批次与主账户冻结相同政策（§3.2）：影子组合是独立假设路径，
  // 但成本假设必须一致，否则对照与赛马排名不可比。
  const executionCostPolicy = await latestPolicyBundle(env.DB);
  const plan = snapshot
    ? createPlan(snapshot, account.book, strategy, strategyVersion, now, {
        executionCostPolicy,
      })
    : defensivePlan(
        account.book.lastDate,
        account.book,
        strategy,
        strategyVersion,
        now,
        { executionCostPolicy },
      );
  return shadows.savePlan(accountId, plan);
}
