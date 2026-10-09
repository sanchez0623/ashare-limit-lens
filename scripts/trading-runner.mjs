import { pollTrading } from "../backend/services/realtime.js";
import { marketClock, inSession } from "../backend/domain/realtime.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";

export function startTradingRunner(env, runDaily, options = {}) {
  const interval = Number(env.TRADING_POLL_SECONDS || 10);
  if (!Number.isInteger(interval) || interval < 3 || interval > 60)
    throw new Error("轮询间隔必须为 3–60 秒的整数");
  let timer,
    stopped = false,
    dailyDate = null,
    lastDailyAttempt = 0;
  const now = options.now || (() => new Date());
  const loop = async () => {
    if (stopped) return;
    const current = now(),
      clock = marketClock(current);
    try {
      await pollTrading(
        { ...env, TRADING_RUNNER: "server", TRADING_POLL_SECONDS: interval },
        current,
      );
      if (
        clock.time >= "15:05:00" &&
        dailyDate !== clock.date &&
        current.getTime() - lastDailyAttempt >= 300000
      ) {
        lastDailyAttempt = current.getTime();
        const result = await runDaily();
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
