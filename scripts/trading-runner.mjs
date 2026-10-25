import { pollTrading } from "../backend/services/realtime.js";
import { runTournamentPoll } from "../backend/services/strategy-tournament.js";
import { marketClock, inSession } from "../backend/domain/realtime.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import { recordOperationEvents } from "../backend/services/alerts.js";
import { reportProcessProgress } from "../backend/services/watchdog.js";
import { observePreopenAuction } from "../backend/services/intraday-inputs.js";
import { preparePendingEntryObservation } from "../backend/services/entry-observation.js";
import {
  preparePendingDragonObservation,
  refreshDragonEngine,
} from "../backend/services/dragon-risk.js";
import { runPaperDay } from "../backend/services/paper.js";
import { OBSERVATION_SCHEDULE } from "../shared/observation-schedule.js";

export function tradingRunnerDelay(
  startedAt,
  finishedAt,
  intervalSeconds = 10,
) {
  const clock = marketClock(finishedAt);
  const normalDelay = inSession(clock.time)
    ? Math.max(1000, intervalSeconds * 1000 - (finishedAt - startedAt))
    : 30000;
  // 盘外的 30 秒等待不能跨过上午开盘或下午复市；覆盖核验仍按原阈值执行。
  const untilOpen = ["09:30:00", "13:00:00"]
    .map(
      (time) =>
        Date.parse(`${clock.date}T${time}+08:00`) - finishedAt.getTime(),
    )
    .filter((milliseconds) => milliseconds > 0);
  return Math.max(1, Math.min(normalDelay, ...untilOpen));
}

export function startTradingRunner(env, runDaily, options = {}) {
  const interval = Number(env.TRADING_POLL_SECONDS || 10);
  if (!Number.isInteger(interval) || interval < 3 || interval > 60)
    throw new Error("轮询间隔必须为 3–60 秒的整数");
  let timer,
    stopped = false,
    dailyDate = null,
    lastDailyAttempt = 0,
    lastEntryPreparation = 0,
    loopSequence = 0;
  const now = options.now || (() => new Date());
  const providers = options.providers ?? {};
  // 事件缓冲：账户提交已经成功，随后的事件写入失败不能把这一帧的风险事实
  // 直接丢掉（回撤、保护退出阻塞这类一次性风险错过就永久漏报）。缓冲有界，
  // 超限丢弃最旧的并让进度健康停止上报，由外部监测暴露主库异常。
  // 进程退出前必须尽力刷盘：通过 shutdown handler 强制同步写入，失败则记录供外部监测感知。
  const MAX_BUFFERED_EVENTS = 200;
  const buffered = [];
  let shuttingDown = false;
  const flushOperationEvents = async (force = false) => {
    if (!buffered.length) return true;
    // 关机时无限重试直到成功或进程被强杀；平时失败保留缓冲等待下一轮。
    const maxAttempts = force ? 10 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await recordOperationEvents(env, buffered);
        buffered.length = 0;
        return true;
      } catch {
        if (!force) {
          if (buffered.length > MAX_BUFFERED_EVENTS)
            buffered.splice(0, buffered.length - MAX_BUFFERED_EVENTS);
          return false;
        }
        // 关机重试：指数退避，最长等待 2 秒
        await new Promise((r) =>
          setTimeout(r, Math.min(100 * 2 ** attempt, 2000)),
        );
      }
    }
    return false;
  };
  // 关机钩子：尽力把内存里的风险事实落库，失败则由外部监测感知存储不可用。
  const shutdownHandler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopped = true;
    clearTimeout(timer);
    await flushOperationEvents(true);
  };
  if (typeof process !== "undefined" && process.on) {
    process.on("SIGTERM", shutdownHandler);
    process.on("SIGINT", shutdownHandler);
    process.on("beforeExit", shutdownHandler);
  }
  const loop = async () => {
    if (stopped) return;
    const current = now(),
      clock = marketClock(current);
    let storageOk = true;
    try {
      const preparationInterval =
        clock.time < OBSERVATION_SCHEDULE.preparationEnd
          ? interval * 1000
          : 300000;
      if (current.getTime() - lastEntryPreparation >= preparationInterval) {
        lastEntryPreparation = current.getTime();
        await refreshDragonEngine(env, current);
        if (clock.time < OBSERVATION_SCHEDULE.preparationEnd) {
          const repo = new RealtimeRepository(env);
          const account = await repo.account();
          if (
            account?.book.entryExecutionMode === "intraday-conditional" &&
            account.book.lastDate < clock.date &&
            !(await repo.plan(account.book.lastDate))
          ) {
            try {
              await runPaperDay(env, account.book.lastDate);
            } catch {
              /* 数据未就绪时保持暂停，不越过盘前闸门。 */
            }
          }
        }
        try {
          await preparePendingEntryObservation(env, current);
          await preparePendingDragonObservation(env, current);
        } catch {
          /* 日线稍后到达时重试，不补造历史。 */
        }
      }
      try {
        await observePreopenAuction(env, current, providers);
      } catch {
        /* 竞价采集失败不阻塞持仓保护。 */
      }
      // 赛马批次或连续基线运行时：一次联合采集行情帧，主账户随帧观察一次，
      // 影子账本按序重放消费；无联合采集需求时保持独立主账户轮询（§7.1）。
      // 盘前准备/竞价请求可能跨过开盘，采集必须使用准备完成后的实际时刻。
      const pollAt = now();
      const tournament = await runTournamentPoll(
        { ...env, TRADING_RUNNER: "server", TRADING_POLL_SECONDS: interval },
        pollAt,
        { providers },
      );
      // 联合采集时必须保留独立轮询的返回结果：丢成 SKIPPED 会把
      // ERROR / BLOCKED 一起吞掉，规则器永远收不到失败事实。
      const primary = tournament
        ? tournament.primary
        : await pollTrading(
            {
              ...env,
              TRADING_RUNNER: "server",
              TRADING_POLL_SECONDS: interval,
            },
            pollAt,
            providers,
          );
      // 运维事件（§5.1）：保存 pollTrading 的返回结果并交给规则器；
      // 只写结构化事件（本地快速提交），规则与发送在独立子进程推进，
      // 交易循环不等待通知供应商响应。正常 NON_TRADING_DAY 不是失败。
      // 提交成功路径的风险事实已随账户提交同一事务落库（eventsRecorded），
      // 不再入缓冲；其余结果（含 CONFLICT/BLOCKED 等不产风险事实的状态）
      // 照常缓冲兜底，事件写入失败时由下一轮补写。
      loopSequence += 1;
      if (!primary?.eventsRecorded)
        buffered.push({
          source: "loop",
          result: primary ?? { status: "SKIPPED" },
          now: pollAt.toISOString(),
          tradeDate: marketClock(pollAt).date,
          sourceSequence: loopSequence,
        });
      if (!(await flushOperationEvents())) storageOk = false;
      await reportProcessProgress(env, {
        sequence: loopSequence,
        completedAt: now().toISOString(),
        storageOk,
      }).catch(() => {});
      if (
        clock.time >= "15:05:00" &&
        dailyDate !== clock.date &&
        current.getTime() - lastDailyAttempt >= 300000
      ) {
        lastDailyAttempt = current.getTime();
        const result = await runDaily();
        buffered.push({
          source: "daily",
          result,
          now: now().toISOString(),
          tradeDate: clock.date,
          sourceSequence: loopSequence,
        });
        await flushOperationEvents();
        if (
          (result.paper?.status === "SETTLED" &&
            result.paper.nextPlan &&
            result.snapshot?.saved) ||
          result.paper?.status === "NON_TRADING_DAY"
        )
          dailyDate = clock.date;
      }
    } catch {
      // Never log upstream URLs, request headers, environment values or raw provider errors.
      try {
        await new RealtimeRepository(env).heartbeat({
          status: "ERROR",
          reason: "执行循环失败，将自动重试",
          checkedAt: current.toISOString(),
          automatic: true,
          runner: "server",
          pollIntervalSeconds: interval,
        });
      } catch {}
      buffered.push({
        source: "loop",
        result: { status: "ERROR" },
        now: current.toISOString(),
        tradeDate: clock.date,
        sourceSequence: loopSequence,
      });
      // 失败路径同样不能丢：主库恢复后下一轮补写，外部监测在此期间不报平安。
      if (!(await flushOperationEvents())) storageOk = false;
      await reportProcessProgress(env, {
        sequence: loopSequence,
        completedAt: now().toISOString(),
        storageOk,
      }).catch(() => {});
    }
    if (!stopped)
      timer = setTimeout(loop, tradingRunnerDelay(current, now(), interval));
  };
  const ready = loop();
  return {
    ready,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
