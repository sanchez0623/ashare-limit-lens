import test from "node:test";
import assert from "node:assert/strict";
import {
  tradingRunnerDelay,
  startTradingRunner,
} from "../scripts/trading-runner.mjs";
import { localDatabase } from "../scripts/local-db.mjs";
import { RealtimeRepository } from "../backend/storage/realtime.js";

const at = (time) => new Date(`2026-10-23T${time}+08:00`);

test("盘外轮询对齐09:30开盘和13:00复市，不被30秒等待越过", () => {
  assert.equal(tradingRunnerDelay(at("09:29:55"), at("09:29:58.500")), 1500);
  assert.equal(tradingRunnerDelay(at("12:59:50"), at("12:59:59.500")), 500);
  assert.equal(tradingRunnerDelay(at("09:29:59"), at("09:29:59.999")), 1);
  assert.equal(tradingRunnerDelay(at("12:29:59"), at("12:30:01")), 30000);
  assert.equal(tradingRunnerDelay(at("15:09:59"), at("15:10:01")), 30000);
});

test("盘中按实际耗时维持轮询周期，慢请求不会导致并发重叠或补造帧", () => {
  assert.equal(tradingRunnerDelay(at("09:35:00"), at("09:35:04")), 6000);
  assert.equal(tradingRunnerDelay(at("09:35:00"), at("09:35:21")), 1000);
  assert.equal(tradingRunnerDelay(at("13:05:00"), at("13:05:01"), 3), 2000);
});

test("盘前准备跨过开盘后，使用完成准备后的时刻进入实际交易轮询", async (t) => {
  const DB = localDatabase();
  let reads = 0,
    calendarCalls = 0;
  const runner = startTradingRunner({ DB }, async () => null, {
    now: () => (++reads === 1 ? at("09:29:59") : at("09:30:01")),
    providers: {
      calendar: async () => {
        calendarCalls++;
        return { dates: ["2026-10-22", "2026-10-23"], benchmark: [] };
      },
      quotes: async () => ({}),
    },
  });
  t.after(() => {
    runner.stop();
    DB.close();
  });
  await runner.ready;
  const health = await new RealtimeRepository({ DB }).health();
  assert.equal(calendarCalls, 1);
  assert.equal(health.checkedAt, at("09:30:01").toISOString());
  assert.equal(health.status, "BLOCKED"); // 缺盘前结算如实暂停，不能伪造交易或退回盘外等待。
});
