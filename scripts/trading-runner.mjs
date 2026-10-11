import { pollTrading } from "../backend/services/realtime.js";
import { runTournamentPoll } from "../backend/services/strategy-tournament.js";
import { marketClock, inSession } from "../backend/domain/realtime.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import { recordOperationEvents } from "../backend/services/alerts.js";
import { reportProcessProgress } from "../backend/services/watchdog.js";

export function startTradingRunner(env, runDaily, options = {}) {
  const interval = Number(env.TRADING_POLL_SECONDS || 10);
  if (!Number.isInteger(interval) || interval < 3 || interval > 60)
    throw new Error("轮询间隔必须为 3–60 秒的整数");
  let timer,
    stopped = false,
    dailyDate = null,
    lastDailyAttempt = 0,
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
      // 赛马批次或连续基线运行时：一次联合采集行情帧，主账户随帧观察一次，
      // 影子账本按序重放消费；无联合采集需求时保持独立主账户轮询（§7.1）。
      const tournament = await runTournamentPoll(
        { ...env, TRADING_RUNNER: "server", TRADING_POLL_SECONDS: interval },
        current,
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
            current,
            providers,
          );
      // 运维事件（§5.1）：保存 pollTrading 的返回结果并交给规则器；
      // 只写结构化事件（本地快速提交），规则与发送在独立子进程推进，
      // 交易循环不等待通知供应商响应。正常 NON_TRADING_DAY 不是失败。
      loopSequence += 1;
      buffered.push({
        source: "loop",
        result: primary ?? { status: "SKIPPED" },
        now: current.toISOString(),
        tradeDate: clock.date,
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
      timer = setTimeout(
        loop,
        inSession(marketClock(now()).time)
          ? Math.max(
              1000,
              interval * 1000 - (now().getTime() - current.getTime()),
            )
          : 30000,
      );
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
