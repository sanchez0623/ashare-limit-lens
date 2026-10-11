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
      try {
        await recordOperationEvents(env, [
          {
            source: "loop",
            result: primary ?? { status: "SKIPPED" },
            now: current.toISOString(),
            tradeDate: clock.date,
            sourceSequence: loopSequence,
          },
        ]);
      } catch {
        // 事件没写进库：不能继续上报"进度健康"，否则外部监测学不到主库异常。
        storageOk = false;
      }
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
        await recordOperationEvents(env, [
          {
            source: "daily",
            result,
            now: now().toISOString(),
            tradeDate: clock.date,
            sourceSequence: loopSequence,
          },
        ]).catch(() => {});
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
      await recordOperationEvents(env, [
        {
          source: "loop",
          result: { status: "ERROR" },
          now: current.toISOString(),
          tradeDate: clock.date,
          sourceSequence: loopSequence,
        },
      ]).catch(() => {});
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
