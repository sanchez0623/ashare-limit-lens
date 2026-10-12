import { RealtimeRepository } from "../storage/realtime.js";
import {
  openSession,
  advanceSession,
  marketClock,
  inSession,
  TERMINAL,
} from "../domain/realtime.js";
import { RISK_LIMITS } from "../domain/trading.js";
import { tradingQuotes, tradingCalendar } from "./market.js";
import { readWeights } from "./review.js";
import { buildOperationEvents } from "./alerts.js";
import { instanceAlias } from "../domain/alert-messages.js";
import { verifyPolicyBundle } from "../storage/execution-cost.js";
import { safeError } from "../http.js";
const calendars = new Map();
async function calendarFor(start, date, now) {
  const cached = calendars.get(date);
  if (cached && now.getTime() - cached.time < 300000) return cached.value;
  const value = await tradingCalendar(start, date);
  calendars.clear();
  calendars.set(date, { time: now.getTime(), value });
  return value;
}

export async function pollTrading(env, now = new Date(), providers = {}) {
  const repo = new RealtimeRepository(env),
    clock = marketClock(now);
  const heartbeat = async (result) => {
    await repo.heartbeat({
      ...result,
      checkedAt: now.toISOString(),
      pollIntervalSeconds: Number(env.TRADING_POLL_SECONDS || 10),
      runner: env.TRADING_RUNNER || "api",
      automatic: env.TRADING_RUNNER === "server",
    });
    return result;
  };
  if (!inSession(clock.time))
    return heartbeat({
      status: "MARKET_CLOSED",
      reason: "非连续竞价时间，保留订单等待下一时段",
    });
  if ([0, 6].includes(clock.weekday))
    return heartbeat({
      status: "NON_TRADING_DAY",
      reason: "周末不执行 A 股交易",
    });
  try {
    const account = await repo.initialize(await readWeights(env));
    if (account.book.lastDate === clock.date)
      return heartbeat({ status: "SETTLED", reason: "当天已结算" });
    let session = await repo.session(clock.date);
    if (!session) {
      const start = new Date(now.getTime() - 30 * 86400000)
        .toISOString()
        .slice(0, 10);
      const calendar = await (providers.calendar || calendarFor)(
        start,
        clock.date,
        now,
      );
      if (!calendar.dates.includes(clock.date))
        return heartbeat({
          status: "NON_TRADING_DAY",
          reason: "指数数据未确认今日交易",
        });
      const previous = calendar.dates.filter((d) => d < clock.date).at(-1);
      if (account.book.lastDate !== previous)
        return heartbeat({
          status: "BLOCKED",
          reason: "上一交易日未结算，停止新增交易",
        });
      const plan = await repo.plan(previous);
      // 执行前核验计划冻结的成本政策摘要（§5.4）：损坏政策不进入执行链。
      if (
        plan?.executionCostPolicy &&
        !(await verifyPolicyBundle(plan.executionCostPolicy))
      )
        return heartbeat({
          status: "BLOCKED",
          reason: "计划成本政策与摘要不一致，暂停交易；请重新冻结计划",
        });
      session = openSession(account.book, plan, clock.date);
    }
    if (session.status !== "OPEN")
      return heartbeat({ status: session.status, reason: "交易日已关闭" });
    const codes = [
      ...new Set([
        ...session.orders.map((o) => o.code),
        ...account.book.positions.map((p) => p.code),
      ]),
    ];
    const quotes = await (providers.quotes || tradingQuotes)(codes, clock.date);
    const observation = {
      // 帧驱动重放时观察时间取帧采集时刻：与帧内报价自洽，按序补齐停机
      // 期间的持久帧，而不是用当前时间把历史报价全部判为陈旧。
      observedAt:
        providers.observedAt ??
        (providers.quotes ? now.toISOString() : new Date().toISOString()),
      quotes,
      pollIntervalSeconds: Number(env.TRADING_POLL_SECONDS || 10),
    };
    const result = advanceSession(account.book, session, observation);
    const observedMs = new Date(observation.observedAt).getTime();
    const fresh = (quote) => {
      const time = new Date(quote?.timestamp).getTime();
      return (
        Number.isFinite(time) &&
        observedMs - time >= -3000 &&
        observedMs - time <= 15000
      );
    };
    // 关键报价覆盖：持仓与挂单涉及的每只股票都必须有本帧有效报价。
    // 只数"新鲜条数"会把整只股票缺失掩盖成 RUNNING，风险事实随之漏报。
    const missingQuoteCodes = codes.filter((code) => !fresh(quotes[code]));
    const freshQuotes = codes.length - missingQuoteCodes.length;
    const orders = result.session.orders;
    const protectiveCodes = new Set(
      orders
        .filter((order) => order.protective && order.triggered)
        .map((o) => o.code),
    );
    const blockedProtectiveExits = [
      ...new Set(
        orders
          .filter(
            (order) =>
              order.protective &&
              order.triggered &&
              !TERMINAL.has(order.status) &&
              order.filledQuantity < order.quantity,
          )
          .map((order) => order.code),
      ),
    ];
    // 做 T 第一腿已成交、检查时点后第二腿仍未恢复：敞口留在账上。
    const incompleteRecoveries = [
      ...new Set(
        orders
          .filter((order) => {
            const pair =
              order.side === "PAIR" && order.firstFilled > order.secondFilled;
            const carried =
              order.recovery && order.filledQuantity < order.quantity;
            return (pair || carried) && clock.time >= "14:50:00";
          })
          .map((order) => order.code),
      ),
    ];
    // 除权不匹配导致暂停交易的股票：报价被引擎拒收，必须如实上报，
    // 否则其他股票正常就会把整轮报成 RUNNING 掩盖掉该股停摆。
    const corporateActionHolds = [
      ...new Set(
        orders
          .filter((order) => order.holdCode && !TERMINAL.has(order.status))
          .map((order) => order.code),
      ),
    ];
    const drawdown = 1 - result.book.equityCents / result.book.peakEquityCents;
    // 没有需要盯的股票时不存在"报价缺失"，与旧语义一致判为正常运行。
    const quoted = codes.length === 0 || missingQuoteCodes.length === 0;
    const summary = {
      status: quoted ? "RUNNING" : "STALE_QUOTES",
      date: clock.date,
      sequence: result.session.sequence,
      fills: result.ledger.length,
      freshQuotes,
      watchedCodes: codes.length,
      missingQuoteCodes,
      drawdown,
      drawdownBreached: drawdown >= RISK_LIMITS.maxDrawdown,
      blockedProtectiveExits,
      incompleteRecoveries,
      corporateActionHolds,
      affectsProtectiveExit: missingQuoteCodes.some((code) =>
        protectiveCodes.has(code),
      ),
      lastQuoteAt:
        Object.values(result.session.quotes)
          .map((q) => q.timestamp)
          .sort()
          .at(-1) || null,
      reason: quoted
        ? "实时模拟交易循环已处理"
        : "报价陈旧或缺失，本轮不执行成交",
    };
    // 风险事实（回撤、保护退出阻塞、做 T 未恢复、报价缺失）必须在账户
    // 提交的同一事务里入账：退出钩子覆盖不了 SIGKILL/断电，先提交账户
    // 再写事件的窗口内进程终止，这些一次性风险就永久漏报。事件写入失败
    // 时整个提交回滚，下一轮按帧重新观察并再次产出事实。
    const operationEvents = buildOperationEvents(
      {
        source: "loop",
        result: summary,
        now: observation.observedAt,
        tradeDate: clock.date,
        sourceSequence: result.session.sequence,
      },
      instanceAlias(env),
    );
    if (
      !(await repo.commitObservation(
        account.revision,
        result,
        observation,
        operationEvents,
      ))
    )
      return heartbeat({
        status: "CONFLICT",
        reason: "另一个执行器先提交，本次结果丢弃，下轮重新读取",
      });
    // 风险事实已随账户提交落库；runner 据此跳过重复缓冲（同 ID 重复写
    // 也会被 INSERT OR IGNORE 忽略，这里只是省掉一次无谓写入）。
    return heartbeat({ ...summary, eventsRecorded: true });
  } catch (error) {
    return heartbeat({ status: "ERROR", reason: safeError(error) });
  }
}

export async function realtimeStatus(env, now = new Date()) {
  const repo = new RealtimeRepository(env),
    health = await repo.health(),
    clock = marketClock(now);
  const session = await repo.session(clock.date);
  const age = health
    ? Math.max(0, now.getTime() - new Date(health.checkedAt).getTime())
    : null;
  const staleAfter = Math.max(
    inSession(clock.time) ? 30000 : 120000,
    (health?.pollIntervalSeconds || 10) * 4000,
  );
  return {
    health,
    running: !!health?.automatic && age <= staleAfter,
    stale: !!health && age > staleAfter,
    ageSeconds: age === null ? null : Math.round(age / 1000),
    marketOpen: inSession(clock.time),
    session: session
      ? {
          date: session.date,
          status: session.status,
          sequence: session.sequence,
          fillCount: session.fillCount,
          lastObservedAt: session.lastObservedAt,
          orders: session.orders.filter((o) => !o.protective || o.triggered),
        }
      : null,
    requirement:
      "持续自动执行需要常驻服务；网页关闭不影响常驻服务，Sites 单独托管不提供秒级后台轮询。",
  };
}
