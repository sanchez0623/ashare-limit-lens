import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { AlertRepository } from "../backend/storage/alerts.js";
import {
  DEFAULT_ALERT_POLICY,
  EVENT_TYPES,
  classifyOperationalFacts,
  evaluateAlertRules,
  transitionIncident,
  validateAlertPolicy,
  marketPhase,
  RULE_TYPES,
  REASON_CODES,
} from "../backend/domain/alert-rules.js";
import {
  formatSafeNotification,
  formatResolvedNotification,
} from "../backend/domain/alert-messages.js";
import {
  recordOperationEvents,
  processAlerts,
  processAlertOutbox,
  alertsStatus,
  ackIncident,
  saveAlertRules,
  sendTestNotification,
  setMaintenanceWindow,
  maintenanceUntil,
} from "../backend/services/alerts.js";
import {
  notificationChannels,
  sendNotification,
} from "../backend/services/notifications.js";

function buildEnv(patch = {}) {
  const DB = localDatabase();
  return { DB, ...patch };
}

const NOW = "2026-10-09T01:35:00.000Z"; // 周五 09:35 北京时间，连续竞价期间

// marketPhase 消费北京时间字符串（与 marketClock 一致），从 UTC 转换。
function marketContext(now = NOW) {
  const beijing = new Date(new Date(now).getTime() + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 19);
  return {
    date: beijing.slice(0, 10),
    time: beijing.slice(11, 19),
    weekday: new Date(`${beijing}Z`).getUTCDay(),
    calendarConfirmed: true,
  };
}

function loopInput(result, { now = NOW, sequence = 1 } = {}) {
  return {
    source: "loop",
    result,
    now,
    tradeDate: now.slice(0, 10),
    sourceSequence: sequence,
  };
}

// 网络替身：按 URL 前缀返回预设供应商响应（{status, body}），杜绝真实外呼。
function installFetchMock(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    const route = Object.entries(routes).find(([prefix]) =>
      target.startsWith(prefix),
    );
    if (!route) throw new Error(`unexpected fetch: ${target}`);
    const [status, body] = Array.isArray(route[1]) ? route[1] : [200, route[1]];
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("事实分类：正常执行结果不产生告警事件，运行阻塞与故障如实入账", () => {
  // 正常结果：RUNNING / NON_TRADING_DAY / SETTLED / MARKET_CLOSED 都不告警。
  for (const status of [
    "RUNNING",
    "NON_TRADING_DAY",
    "SETTLED",
    "MARKET_CLOSED",
    "SKIPPED",
  ])
    assert.deepEqual(
      classifyOperationalFacts(loopInput({ status })),
      [],
      `${status} 不产生告警事件`,
    );
  // 连续 ERROR 返回（未抛异常）也产生事件——覆盖最容易漏掉的路径。
  const errors = classifyOperationalFacts(loopInput({ status: "ERROR" }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ruleType, RULE_TYPES.LOOP_FAILED);
  assert.equal(errors[0].reasonCode, REASON_CODES.EXECUTION_ERROR);
  // BLOCKED 按结构化原因区分：缺计划 vs 缺前日结算。
  const missingPlan = classifyOperationalFacts(
    loopInput({ status: "BLOCKED", reason: "缺少执行日前冻结的计划" }),
  );
  assert.equal(missingPlan[0].reasonCode, REASON_CODES.MISSING_PLAN);
  const missingSettlement = classifyOperationalFacts(
    loopInput({ status: "BLOCKED", reason: "上一交易日未结算" }),
  );
  assert.equal(
    missingSettlement[0].reasonCode,
    REASON_CODES.MISSING_SETTLEMENT,
  );
  // 报价陈旧产生 REQUIRED_QUOTE_STALE 而非整体 RUNNING 掩盖。
  const stale = classifyOperationalFacts(
    loopInput({ status: "STALE_QUOTES", freshQuotes: 0, watchedCodes: 3 }),
  );
  assert.equal(stale[0].ruleType, RULE_TYPES.REQUIRED_QUOTE_STALE);
  // 盘后返回失败对象（不是异常）→ SETTLEMENT_LATE；HTTP 200 不当完成。
  const daily = classifyOperationalFacts({
    source: "daily",
    result: {
      paper: { status: "SETTLED", nextPlan: null },
      snapshot: { saved: false },
    },
    now: NOW,
  });
  assert.equal(daily[0].ruleType, RULE_TYPES.SETTLEMENT_LATE);
  assert.equal(daily[0].safeFacts.nextPlan, false);
  // 盘后成功与 NON_TRADING_DAY 不告警。
  assert.deepEqual(
    classifyOperationalFacts({
      source: "daily",
      result: {
        paper: { status: "SETTLED", nextPlan: { orders: [] } },
        snapshot: { saved: true },
      },
      now: NOW,
    }),
    [],
  );
  // 账本不变式异常立即入账。
  const ledger = classifyOperationalFacts({ source: "ledger", now: NOW });
  assert.equal(ledger[0].ruleType, RULE_TYPES.LEDGER_INVARIANT_FAILED);
});

test("时段语义：午休与非交易时段不把不成交视为故障；结算迟延按时间升级", () => {
  const policy = DEFAULT_ALERT_POLICY;
  const lunch = marketPhase({
    date: "2026-10-09",
    time: "11:45:00",
    weekday: 5,
    calendarConfirmed: true,
  });
  assert.equal(lunch.phase, "LUNCH");
  const evaluation = evaluateAlertRules({
    events: classifyOperationalFacts(loopInput({ status: "ERROR" })),
    previousIncident: null,
    policy,
    marketContext: lunch,
  });
  assert.equal(evaluation[0].suppressed, true, "午休期间循环失败被抑制");
  // 结算迟延：15:20 警告，15:30 升级。
  const warningPhase = marketPhase({
    date: "2026-10-09",
    time: "15:22:00",
    weekday: 5,
    calendarConfirmed: true,
  });
  const criticalPhase = marketPhase({
    date: "2026-10-09",
    time: "15:31:00",
    weekday: 5,
    calendarConfirmed: true,
  });
  const dailyEvent = classifyOperationalFacts({
    source: "daily",
    result: { paper: { status: "BEFORE_CLOSE" }, snapshot: { saved: false } },
    now: "2026-10-09T07:22:00.000Z",
  });
  const warning = evaluateAlertRules({
    events: dailyEvent,
    previousIncident: null,
    policy,
    marketContext: warningPhase,
  })[0];
  assert.equal(warning.severity, "WARNING");
  const critical = evaluateAlertRules({
    events: classifyOperationalFacts({
      source: "daily",
      result: { paper: { status: "BEFORE_CLOSE" }, snapshot: { saved: false } },
      now: "2026-10-09T07:31:00.000Z",
    }),
    previousIncident: null,
    policy,
    marketContext: criticalPhase,
  })[0];
  assert.equal(critical.severity, "CRITICAL");
  // 日历无法确认是独立 WARNING 语义：marketContext 标注，不自动按休市处理。
  const unknown = marketPhase({
    date: "2026-10-09",
    time: "10:00:00",
    weekday: 5,
    calendarConfirmed: false,
  });
  assert.equal(unknown.calendarConfirmed, false);
});

test("状态机：去重升级提醒、确认不掩盖升级、恢复只通知一次", () => {
  const policy = DEFAULT_ALERT_POLICY;
  const event = classifyOperationalFacts(loopInput({ status: "ERROR" }))[0];
  const evaluation = evaluateAlertRules({
    events: [event],
    previousIncident: null,
    policy,
    marketContext: marketContext(),
  })[0];
  const opened = transitionIncident({ incident: null, evaluation, now: NOW });
  assert.equal(opened.action, "OPEN");
  assert.equal(opened.notify.type, "OPEN");
  // 同一问题持续：不重复 OPEN；5 分钟后升级 CRITICAL。
  const stillOpen = transitionIncident({
    incident: {
      status: "OPEN",
      severity: "WARNING",
      ruleType: event.ruleType,
      firstSeen: NOW,
      lastSeen: NOW,
      ackUntil: null,
      resolvedAt: null,
      notifiedOnce: true,
      payload: {},
    },
    evaluation: { ...evaluation, severity: "WARNING" },
    now: "2026-10-09T01:40:00.000Z",
  });
  assert.equal(stillOpen.action, "KEEP");
  // WARNING 持续 15 分钟后提醒一次。
  const reminded = transitionIncident({
    incident: {
      status: "OPEN",
      severity: "WARNING",
      ruleType: event.ruleType,
      firstSeen: NOW,
      lastSeen: NOW,
      ackUntil: null,
      resolvedAt: null,
      notifiedOnce: true,
      payload: {},
    },
    evaluation: { ...evaluation, severity: "WARNING" },
    now: "2026-10-09T01:50:00.000Z",
  });
  assert.equal(reminded.notify?.type, "REMIND");
  // ACK 静默提醒，但升级仍通知。
  const acked = transitionIncident({
    incident: {
      status: "OPEN",
      severity: "WARNING",
      ruleType: event.ruleType,
      firstSeen: NOW,
      lastSeen: NOW,
      ackUntil: "2026-10-09T03:00:00.000Z",
      resolvedAt: null,
      notifiedOnce: true,
      payload: {},
    },
    evaluation: { ...evaluation, severity: "WARNING" },
    now: "2026-10-09T01:50:00.000Z",
  });
  assert.equal(acked.notify, null, "确认期内提醒被静默");
  assert.equal(acked.silent, true);
  const escalatedUnderAck = transitionIncident({
    incident: {
      status: "OPEN",
      severity: "WARNING",
      ruleType: event.ruleType,
      firstSeen: NOW,
      lastSeen: NOW,
      ackUntil: "2026-10-09T03:00:00.000Z",
      resolvedAt: null,
      notifiedOnce: true,
      payload: {},
    },
    evaluation: { ...evaluation, severity: "CRITICAL" },
    now: "2026-10-09T01:50:00.000Z",
  });
  assert.equal(escalatedUnderAck.action, "ESCALATE");
  assert.equal(escalatedUnderAck.notify?.type, "ESCALATED", "升级穿透确认");
  // 条件消失：宽限后 RESOLVE；未成功通知过则发"发生并恢复"摘要。
  const resolved = transitionIncident({
    incident: {
      status: "OPEN",
      severity: "WARNING",
      ruleType: event.ruleType,
      firstSeen: NOW,
      lastSeen: NOW,
      ackUntil: null,
      resolvedAt: null,
      notifiedOnce: true,
      payload: {},
    },
    evaluation: {
      absent: true,
      fingerprint: "LOOP_FAILED:primary",
      severity: "WARNING",
    },
    now: "2026-10-09T01:45:00.000Z",
  });
  assert.equal(resolved.action, "RESOLVE");
  assert.equal(resolved.notify.type, "RESOLVED");
});

test("规则版本：阈值范围校验拒绝非法配置，合法配置版本化", async () => {
  assert.throws(
    () =>
      validateAlertPolicy({ ...DEFAULT_ALERT_POLICY, escalateAfterSeconds: 1 }),
    /escalateAfterSeconds/,
  );
  assert.throws(
    () => validateAlertPolicy({ ...DEFAULT_ALERT_POLICY, backoffSeconds: [] }),
    /backoffSeconds/,
  );
  assert.throws(
    () =>
      validateAlertPolicy({
        ...DEFAULT_ALERT_POLICY,
        settlementLateWarningAt: "15:40:00",
      }),
    /警告时点/,
  );
  const env = buildEnv();
  const version = await saveAlertRules(env, { escalateAfterSeconds: 600 });
  assert.ok(version.id.startsWith("rules-"));
  assert.equal(version.payload.escalateAfterSeconds, 600);
  const stored = await new AlertRepository(env).latestRuleVersion();
  assert.equal(stored.id, version.id);
  env.DB.close();
});

test("端到端：事件入站 → 规则推进 → outbox → 发送（含重试、429 与业务失败）", async () => {
  const env = buildEnv();
  const mock = installFetchMock({
    "https://open.feishu.cn/": { code: 0, msgId: "om_1" },
    "https://feishu.test/429": [429, { code: 9499 }],
  });
  // 交易循环写事件：只写本地表，不等待通知供应商。
  await recordOperationEvents(env, [loopInput({ status: "ERROR" })]);
  const store = new AlertRepository(env);
  assert.equal((await store.eventsSince(null)).length, 1, "事件已落库");
  // 规则推进生成实例与 outbox；未配置通道时事件保留但不入队发送。
  const first = await processAlerts(env, { now: NOW });
  assert.equal(first.processed, 1);
  const incident = await store.activeIncident("LOOP_FAILED:primary");
  assert.ok(incident, "实例已创建");
  assert.equal(incident.status, "OPEN");
  // 重复同因事件：去重不产生新实例。
  await recordOperationEvents(env, [
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:36:00.000Z", sequence: 2 },
    ),
  ]);
  await processAlerts(env, { now: "2026-10-09T01:36:10.000Z" });
  const incidents = await store.listIncidents({ activeOnly: true });
  assert.equal(incidents.length, 1, "同因聚合，不刷屏");
  // 配置飞书后再次推进：通知事件入队。
  const enabledEnv = {
    ...env,
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  };
  const secondIncident = await store.activeIncident("SETTLEMENT_LATE:primary");
  assert.equal(secondIncident, null);
  await recordOperationEvents(enabledEnv, [
    {
      source: "daily",
      result: { paper: { status: "BEFORE_CLOSE" }, snapshot: { saved: false } },
      now: "2026-10-09T07:22:00.000Z",
      tradeDate: "2026-10-09",
      sourceSequence: 3,
    },
  ]);
  await processAlerts(enabledEnv, { now: "2026-10-09T07:22:30.000Z" });
  const settlement = await store.activeIncident("SETTLEMENT_LATE:primary");
  assert.ok(settlement, "结算迟延实例已创建");
  // 发送：成功一次后 notifiedOnce 落库。
  const sent = await processAlertOutbox(enabledEnv, {
    now: "2026-10-09T07:22:31.000Z",
  });
  assert.equal(sent.length, 1, "一条通道一条任务");
  // 失败路径：429 → 可重试；CONFIG_ERROR → 不再撞接口。
  const rateLimited = await sendNotification({
    channelRef: "feishu",
    env: { FEISHU_WEBHOOK_URL: "https://feishu.test/429" },
    safeMessage: { text: "x" },
  });
  assert.equal(rateLimited.retryable, true);
  assert.ok(
    mock.calls.some((url) => url.startsWith("https://feishu.test/429")),
  );
  mock.restore();
  env.DB.close();
});

test("脱敏：消息不含金额、持仓、URL、密钥或堆栈；fingerprint 不含中文原因", () => {
  const incident = {
    id: "inc-1",
    fingerprint: "SETTLEMENT_LATE:primary",
    ruleType: RULE_TYPES.SETTLEMENT_LATE,
    severity: "CRITICAL",
    firstSeen: "2026-10-09T07:20:00.000Z",
    lastSeen: "2026-10-09T07:25:00.000Z",
    entityRef: "primary",
  };
  const message = formatSafeNotification({
    event: { reasonCode: REASON_CODES.SETTLEMENT_FAILED, safeFacts: {} },
    incident,
    instanceAlias: "windows-paper",
    now: "2026-10-09T07:25:30.000Z",
  });
  assert.ok(
    !/\d{4,}/.test(message.text.replace(/2026[-/]\d{2}[-/]\d{2}|:\d{2}/g, "")),
    "不含大额数字",
  );
  assert.ok(!message.text.includes("http"), "不含 URL");
  assert.ok(!message.text.includes("secret"), "不含密钥");
  assert.ok(message.text.includes("windows-paper"), "含实例别名");
  const resolved = formatResolvedNotification({
    incident,
    instanceAlias: "windows-paper",
    now: "2026-10-09T07:30:00.000Z",
  });
  assert.ok(resolved.title.includes("已恢复"));
});

test("恢复摘要与维护窗口：维护期抑制非风险规则，账本异常不受静默", async () => {
  const env = buildEnv();
  const result = await setMaintenanceWindow(env, {
    minutes: 30,
    reason: "演练",
  });
  assert.ok(result.until > new Date().toISOString());
  assert.ok(await maintenanceUntil(env));
  // 维护窗口记录进入事件流。
  const store = new AlertRepository(env);
  const events = await store.eventsSince(null);
  assert.equal(events[0].type, EVENT_TYPES.MAINTENANCE);
  env.DB.close();
});

test("API 状态与确认：未配置通道明确显示未启用，确认写入审计", async () => {
  const env = buildEnv();
  const status = await alertsStatus(env);
  assert.equal(status.enabled, false);
  assert.ok(status.note.includes("未启用"));
  assert.deepEqual(
    notificationChannels(env).map((c) => c.configured),
    [false],
  );
  // 实例确认：ack_until 落库且事件审计追加。
  await recordOperationEvents(env, [loopInput({ status: "ERROR" })]);
  await processAlerts(env, { now: NOW });
  const store = new AlertRepository(env);
  const incident = await store.activeIncident("LOOP_FAILED:primary");
  const acked = await ackIncident(env, incident.id, { hours: 2 });
  assert.ok(acked.ackUntil > new Date().toISOString());
  const detail = await store.getIncident(incident.id);
  assert.ok(detail.ackUntil > new Date().toISOString());
  env.DB.close();
});

test("测试通知：未配置通道拒绝；配置错误不重复撞接口", async () => {
  const env = buildEnv();
  await assert.rejects(() => sendTestNotification(env), /未启用/);
  const mock = installFetchMock({
    "https://feishu.test/": { code: 19021 },
  });
  try {
    const failing = {
      ...env,
      FEISHU_WEBHOOK_URL: "https://feishu.test/config-error",
    };
    const outcome = await sendNotification({
      channelRef: "feishu",
      env: failing,
      safeMessage: { text: "测试" },
    });
    assert.equal(outcome.retryable, false, "配置错误不重试");
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
  env.DB.close();
});

test("outbox 租约：接管过期租约，重试按退避推进，超限过期", async () => {
  const env = buildEnv();
  const mock = installFetchMock({
    "https://open.feishu.cn/": { code: 0, msgId: "om_9" },
  });
  const store = new AlertRepository(env);
  await recordOperationEvents(env, [loopInput({ status: "ERROR" })]);
  const enabled = {
    ...env,
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  };
  // 通道在实例创建前配置：OPEN 通知直接入队。
  await processAlerts(enabled, { now: NOW });
  // 第二个同因事件不重复入队：规则去重，不刷屏。
  await recordOperationEvents(env, [
    loopInput(
      { status: "STALE_QUOTES", freshQuotes: 0, watchedCodes: 2 },
      { sequence: 2 },
    ),
  ]);
  await processAlerts(enabled, { now: NOW });
  const deliveries = await store.claimDeliveries({
    now: NOW,
    leaseOwner: "runner-a",
  });
  assert.ok(deliveries.length >= 1);
  // 第二个执行器在租约内不能领取同一任务。
  const again = await store.claimDeliveries({
    now: NOW,
    leaseOwner: "runner-b",
  });
  for (const delivery of again)
    assert.notEqual(delivery.id, deliveries[0].id, "租约期内不被接管");
  // 模拟租约过期后可被接管。
  await store.retryDelivery({
    id: deliveries[0].id,
    nextAttemptAt: NOW,
    now: NOW,
  });
  const takeover = await store.claimDeliveries({
    now: "2026-10-09T01:36:00.000Z",
    leaseOwner: "runner-c",
    leaseSeconds: 1,
  });
  assert.ok(takeover.length >= 1, "到期任务重新可领");
  mock.restore();
  env.DB.close();
});
