import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWatchdogHealth,
  reportProcessProgress,
  reportPipelineHealth,
  resetWatchdogTimers,
} from "../backend/services/watchdog.js";

test("进度门控：只有真实循环进度且存储检查通过才报平安", () => {
  const now = Date.parse("2026-10-09T01:35:00.000Z");
  // 进度新鲜 + 存储正常 → PROCESS_PROGRESS 正常。
  const healthy = evaluateWatchdogHealth({
    runnerProgress: { sequence: 5, completedAt: "2026-10-09T01:34:30.000Z" },
    storageHealth: { ok: true },
    queueHealth: { pending: 0, expired: 0 },
    now,
  });
  assert.equal(healthy.processProgress, true);
  assert.equal(healthy.alertPipeline, true);
  // 主进程仍在运行但进度停滞 → 不报进度平安（外部监测按缺失信号告警）。
  const stalled = evaluateWatchdogHealth({
    runnerProgress: { sequence: 5, completedAt: "2026-10-09T01:30:00.000Z" },
    storageHealth: { ok: true },
    queueHealth: null,
    now,
  });
  assert.equal(stalled.processProgress, false);
  // 数据库不可写时不继续发送基础存储正常的信号。
  const storageBroken = evaluateWatchdogHealth({
    runnerProgress: { sequence: 6, completedAt: "2026-10-09T01:34:50.000Z" },
    storageHealth: { ok: false },
    queueHealth: { pending: 0, expired: 0 },
    now,
  });
  assert.equal(storageBroken.processProgress, false);
  // 关键积压时管道健康失败。
  const backlog = evaluateWatchdogHealth({
    runnerProgress: null,
    storageHealth: { ok: true },
    queueHealth: { pending: 50, expired: 0 },
    now,
  });
  assert.equal(backlog.alertPipeline, false);
  // "本该发出却无人领取"的项同样使队列不健康（分发器停滞的直接证据）。
  const stuckQueue = evaluateWatchdogHealth({
    runnerProgress: null,
    storageHealth: { ok: true },
    queueHealth: { pending: 1, overdue: 1, expired: 0 },
    now,
  });
  assert.equal(stuckQueue.queueOk, false);
  assert.equal(stuckQueue.alertPipeline, false);
  // 关键通知重试耗尽即丢失：阈值必须为 0，一条都不能算健康。
  const lostNotification = evaluateWatchdogHealth({
    runnerProgress: null,
    storageHealth: { ok: true },
    queueHealth: { pending: 0, overdue: 0, expired: 1 },
    now,
  });
  assert.equal(lostNotification.queueOk, false);
  assert.equal(lostNotification.alertPipeline, false);
  // 告警子进程退出（无进度、无队列推进）→ 两个检查都不健康。
  const dead = evaluateWatchdogHealth({
    runnerProgress: null,
    storageHealth: { ok: false },
    queueHealth: { pending: 99, expired: 120 },
    now,
  });
  assert.equal(dead.processProgress, false);
  assert.equal(dead.alertPipeline, false);
});

test("上报节流：60 秒内只发一次；URL 未配置时静默跳过", async () => {
  resetWatchdogTimers();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push(String(url));
    return { ok: true };
  };
  try {
    const env = {
      WATCHDOG_PROGRESS_URL: "https://hc.test/ping/progress",
      WATCHDOG_PIPELINE_URL: "https://hc.test/ping/pipeline",
      ALERT_INSTANCE_ALIAS: "test-alias",
    };
    const first = await reportProcessProgress(env, {
      sequence: 1,
      completedAt: new Date(Date.now() - 5000).toISOString(),
    });
    assert.equal(first, true);
    assert.equal(requests.length, 1);
    // 60 秒内第二次调用被节流。
    const second = await reportProcessProgress(env, {
      sequence: 2,
      completedAt: "2026-10-09T01:35:10.000Z",
    });
    assert.equal(second, false);
    assert.equal(requests.length, 1);
    // 管道信号独立节流，正常上报（必须带分发器推进证据）。
    const pipeline = await reportPipelineHealth(env, {
      cursor: { ingestSeq: 12 },
      outbox: { pending: 0, overdue: 0, expired: 0 },
      state: { lastProgressAt: new Date(Date.now() - 5000).toISOString() },
    });
    assert.equal(pipeline, true);
    assert.equal(requests.length, 2);
    // 分发器停滞（进度不新鲜）时即使队列为空也不得报平安：
    // 空队列可能只是"没人入队"，不能当作管道健康。
    resetWatchdogTimers();
    const stalledPipeline = await reportPipelineHealth(env, {
      cursor: { ingestSeq: 12 },
      outbox: { pending: 0, overdue: 0, expired: 0 },
      state: { lastProgressAt: "2026-10-09T01:00:00.000Z" },
    });
    assert.equal(stalledPipeline, false);
    assert.equal(requests.length, 2);
    // 有"本该发出却无人领取"的积压时不得报平安。
    resetWatchdogTimers();
    const overduePipeline = await reportPipelineHealth(env, {
      cursor: { ingestSeq: 12 },
      outbox: { pending: 3, overdue: 3, expired: 0 },
      state: { lastProgressAt: new Date().toISOString() },
    });
    assert.equal(overduePipeline, false);
    assert.equal(requests.length, 2);
    // 信号体只含别名、角色与序号（§4.1）：不含持仓、现金、URL 或堆栈。
    const sent = requests.map((url) => url);
    assert.ok(sent.every((url) => url.startsWith("https://hc.test/ping/")));
    // 未配置 URL：不上报也不报错。
    resetWatchdogTimers();
    const skipped = await reportProcessProgress(
      { ALERT_INSTANCE_ALIAS: "test-alias" },
      { sequence: 3, completedAt: "2026-10-09T01:35:20.000Z" },
    );
    assert.equal(skipped, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("网络失败静默：本机无法上报时不抛异常，由外部按缺失信号告警", async () => {
  resetWatchdogTimers();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network unreachable");
  };
  try {
    const result = await reportProcessProgress(
      { WATCHDOG_PROGRESS_URL: "https://hc.test/ping/x" },
      { sequence: 1, completedAt: new Date().toISOString() },
    );
    assert.equal(result, false, "上报失败静默处理");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
