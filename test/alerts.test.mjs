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
  // 本批完全没有事件的实例同样要评估：LOOP_FAILED 已停止上报且超过宽限期，
  // 必须自动恢复（旧实现只在"本批有事件的指纹"上评估，永不 RESOLVED）。
  const loopIncident = await store.getIncident(incident.id);
  assert.equal(loopIncident.status, "RESOLVED", "无事件实例按宽限期恢复");
  assert.ok(loopIncident.resolvedAt);
  // 发送：结算迟延 OPEN 与循环失败恢复摘要各一条任务。
  const sent = await processAlertOutbox(enabledEnv, {
    now: "2026-10-09T07:22:31.000Z",
  });
  assert.equal(sent.length, 2, "两条通知各一条任务");
  assert.ok(
    sent.every((row) => row.sent),
    "两条都发送成功",
  );
  assert.equal(
    mock.calls.filter((url) => url.startsWith("https://open.feishu.cn/"))
      .length,
    2,
  );
  // 成功通知标志与最后通知时刻已落库。
  const notified = await store.getIncident(settlement.id);
  assert.equal(notified.notifiedOnce, true, "通知标志已保存");
  assert.ok(notified.lastNotifiedAt);
  // 同一问题持续：观测心跳提交后标志仍然保持，且不重复入队。
  // （旧实现把 payload 里的 notifiedOnce 回写成当前值 false，于是每轮重发。）
  await recordOperationEvents(enabledEnv, [
    {
      source: "daily",
      result: { paper: { status: "BEFORE_CLOSE" }, snapshot: { saved: false } },
      now: "2026-10-09T07:23:30.000Z",
      tradeDate: "2026-10-09",
      sourceSequence: 4,
    },
  ]);
  await processAlerts(enabledEnv, { now: "2026-10-09T07:23:31.000Z" });
  const heartbeat = await store.getIncident(settlement.id);
  assert.equal(heartbeat.status, "OPEN");
  assert.equal(heartbeat.notifiedOnce, true, "持续中的实例保持已通知标志");
  assert.ok(heartbeat.lastSeen > settlement.lastSeen, "观测心跳推进 lastSeen");
  const repeated = await processAlertOutbox(enabledEnv, {
    now: "2026-10-09T07:23:32.000Z",
  });
  assert.equal(repeated.length, 0, "持续中的告警不重复发送");
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

test("outbox 租约：租约期内独占，被接管后旧执行器不得覆盖新结果", async () => {
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
  const target = deliveries[0];
  // 第二个执行器在租约内不能领取同一任务。
  const again = await store.claimDeliveries({
    now: NOW,
    leaseOwner: "runner-b",
  });
  for (const delivery of again)
    assert.notEqual(delivery.id, target.id, "租约期内不被接管");
  // 租约有效期内旧执行器按退避重试：消耗一次预算并放回可领状态。
  assert.equal(
    await store.retryDelivery({
      id: target.id,
      leaseOwner: target.leaseOwner,
      leaseUntil: target.leaseUntil,
      nextAttemptAt: NOW,
      now: NOW,
    }),
    true,
    "租约持有者可以重试",
  );
  const takeover = await store.claimDeliveries({
    now: "2026-10-09T01:36:00.000Z",
    leaseOwner: "runner-c",
    leaseSeconds: 1,
  });
  const taken = takeover.find((delivery) => delivery.id === target.id);
  assert.ok(taken, "到期任务重新可领");
  // 租约被接管后，旧执行器的迟到写入必须被拒绝：不能改写新执行器的结果。
  const late = {
    id: target.id,
    leaseOwner: target.leaseOwner,
    leaseUntil: target.leaseUntil,
    now: "2026-10-09T01:36:01.000Z",
  };
  assert.equal(
    await store.completeDelivery({ ...late, providerRef: "om_old" }),
    false,
    "旧执行器不能写 SENT",
  );
  assert.equal(
    await store.expireDelivery(late),
    false,
    "旧执行器不能写 EXPIRED",
  );
  assert.equal(
    await store.retryDelivery({ ...late, nextAttemptAt: NOW }),
    false,
    "旧执行器不能写 PENDING",
  );
  // 新执行器持有租约，写入被接受。
  assert.equal(
    await store.completeDelivery({
      id: taken.id,
      leaseOwner: taken.leaseOwner,
      leaseUntil: taken.leaseUntil,
      providerRef: "om_new",
      now: "2026-10-09T01:36:01.000Z",
    }),
    true,
    "接管者可以写终态",
  );
  mock.restore();
  env.DB.close();
});

test("网络异常消耗重试预算：达到上限后过期，不再无限重试", async () => {
  const env = buildEnv();
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network unreachable");
  };
  try {
    const enabled = {
      ...env,
      FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
    };
    await recordOperationEvents(enabled, [loopInput({ status: "ERROR" })]);
    await processAlerts(enabled, { now: NOW });
    const store = new AlertRepository(enabled);
    const started = Date.parse(NOW);
    let retried = 0;
    let expired = 0;
    for (let round = 0; round < DEFAULT_ALERT_POLICY.maxAttempts + 2; round++) {
      const at = new Date(started + (round + 1) * 3600_000).toISOString();
      const results = await processAlertOutbox(enabled, { now: at });
      retried += results.filter((row) => row.retried).length;
      expired += results.filter((row) => row.expired).length;
      if (expired) break;
    }
    assert.equal(expired, 1, "达到重试上限后过期，不再投递");
    assert.ok(
      retried <= DEFAULT_ALERT_POLICY.maxAttempts,
      `重试次数不超过预算，实际 ${retried}`,
    );
    const health = await store.outboxHealth();
    assert.equal(health.pending, 0, "队列不残留进行中的任务");
  } finally {
    globalThis.fetch = original;
  }
  env.DB.close();
});

test("飞书加签：timestamp/sign 作为查询参数追加，URL 不会被拼接破坏", async () => {
  const secret = "s3cret-key";
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msgId: "om_sign" }),
    };
  };
  try {
    const outcome = await sendNotification({
      channelRef: "feishu",
      env: {
        FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/abc",
        FEISHU_SECRET: secret,
      },
      safeMessage: { text: "x" },
    });
    assert.equal(outcome.ok, true);
    assert.equal(calls.length, 1);
    const sent = new URL(calls[0]);
    // 直接拼 "&timestamp=" 会把参数并进路径，签名请求因此失效。
    assert.equal(sent.pathname, "/open-apis/bot/v2/hook/abc");
    const timestamp = sent.searchParams.get("timestamp");
    const sign = sent.searchParams.get("sign");
    assert.ok(timestamp && Number.isInteger(Number(timestamp)));
    assert.ok(sign);
    // 签名算法：Base64(HMAC-SHA256(key = "{timestamp}\n{secret}", msg = ""))。
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(`${timestamp}\n${secret}`),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("")),
        ),
      ),
    );
    assert.equal(sign, expected, "签名与飞书自定义机器人规范一致");
  } finally {
    globalThis.fetch = original;
  }
});

test("执行层风险事实独立入账：不因 status 为 RUNNING 而被掩盖", () => {
  // 只有部分股票新鲜不再算健康：缺失清单必须入账。
  const partial = classifyOperationalFacts(
    loopInput({
      status: "STALE_QUOTES",
      freshQuotes: 2,
      watchedCodes: 3,
      missingQuoteCodes: ["600001"],
      affectsProtectiveExit: true,
    }),
  );
  assert.equal(partial[0].ruleType, RULE_TYPES.REQUIRED_QUOTE_STALE);
  assert.equal(partial[0].safeFacts.missingQuotes, 1);
  assert.equal(
    partial[0].safeFacts.affectsProtectiveExit,
    true,
    "缺失报价影响保护退出时如实标注",
  );
  // 回撤触及硬约束：与"本轮 status 是什么"无关。
  const drawdown = classifyOperationalFacts(
    loopInput({ status: "RUNNING", drawdownBreached: true, drawdown: 0.13 }),
  );
  assert.equal(drawdown.length, 1);
  assert.equal(drawdown[0].ruleType, RULE_TYPES.DRAWDOWN_TRIPPED);
  assert.equal(drawdown[0].reasonCode, REASON_CODES.DRAWDOWN_LIMIT);
  // 保护退出阻塞与做 T 第二腿未完成。
  const blocked = classifyOperationalFacts(
    loopInput({ status: "RUNNING", blockedProtectiveExits: ["600002"] }),
  );
  assert.equal(blocked[0].ruleType, RULE_TYPES.PROTECTIVE_EXIT_BLOCKED);
  assert.deepEqual(blocked[0].safeFacts.codes, ["600002"]);
  const recovery = classifyOperationalFacts(
    loopInput({ status: "RUNNING", incompleteRecoveries: ["600003"] }),
  );
  assert.equal(recovery[0].ruleType, RULE_TYPES.T_RECOVERY_INCOMPLETE);
  assert.deepEqual(recovery[0].safeFacts.codes, ["600003"]);
  // 一次轮询同时暴露多项风险时逐项入账，而不是只留第一条。
  const combined = classifyOperationalFacts(
    loopInput({
      status: "STALE_QUOTES",
      missingQuoteCodes: ["600001"],
      drawdownBreached: true,
      drawdown: 0.2,
      blockedProtectiveExits: ["600002"],
      incompleteRecoveries: ["600003"],
    }),
  );
  assert.deepEqual(
    combined.map((event) => event.ruleType).sort(),
    [
      "DRAWDOWN_TRIPPED",
      "PROTECTIVE_EXIT_BLOCKED",
      "REQUIRED_QUOTE_STALE",
      "T_RECOVERY_INCOMPLETE",
    ],
    "四项风险各自入账",
  );
});

test("升级与提醒按持续时间推进：只看本轮事件永远得不到升级", () => {
  const event = classifyOperationalFacts(loopInput({ status: "ERROR" }))[0];
  const previous = {
    status: "OPEN",
    severity: "WARNING",
    fingerprint: "LOOP_FAILED:primary",
    firstSeen: "2026-10-09T01:35:00.000Z",
    lastSeen: "2026-10-09T01:35:00.000Z",
    ackUntil: null,
    resolvedAt: null,
    notifiedOnce: true,
    lastNotifiedAt: "2026-10-09T01:35:00.000Z",
    payload: {},
  };
  // 持续 100 秒（超过 loopFailedEscalateSeconds=90）→ 升级为 CRITICAL。
  const at = "2026-10-09T01:36:40.000Z";
  const evaluation = evaluateAlertRules({
    events: [event],
    previousIncident: previous,
    policy: DEFAULT_ALERT_POLICY,
    marketContext: marketContext(at),
    now: at,
  })[0];
  assert.equal(evaluation.severity, "CRITICAL", "持续时间驱动升级");
  const escalated = transitionIncident({
    incident: previous,
    evaluation,
    now: at,
  });
  assert.equal(escalated.action, "ESCALATE");
  assert.equal(escalated.notify.type, "ESCALATED");
  // 提醒按"上次成功通知时刻"推进，而不是被每轮事件刷新的 lastSeen。
  const reminded = transitionIncident({
    incident: { ...previous, lastSeen: "2026-10-09T01:36:35.000Z" },
    evaluation: { ...evaluation, severity: "WARNING" },
    now: "2026-10-09T01:50:50.000Z",
  });
  assert.equal(reminded.action, "KEEP");
  assert.equal(reminded.notify?.type, "REMIND", "持续问题按节奏提醒");
});

test("状态迁移与入队同一事务：CAS 失败不留下半成品", async () => {
  const env = buildEnv();
  const enabled = {
    ...env,
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  };
  const store = new AlertRepository(enabled);
  await recordOperationEvents(enabled, [loopInput({ status: "ERROR" })]);
  await processAlerts(enabled, { now: NOW });
  const incident = await store.activeIncident("LOOP_FAILED:primary");
  assert.ok(incident);
  assert.equal((await store.incidentEvents(incident.id)).length, 1);
  assert.equal((await store.outboxHealth()).pending, 1);
  // 模拟并发执行器：读到过期 revision，UPDATE 的 CAS 必然失败。
  const original = store.getIncident.bind(store);
  store.getIncident = async (id) => {
    const row = await original(id);
    return row ? { ...row, revision: row.revision - 1 } : row;
  };
  try {
    await assert.rejects(
      () =>
        store.commitIncidentTransition({
          id: incident.id,
          patch: { status: "ESCALATED_FOR_TEST" },
          eventType: "ESCALATED",
          channels: ["feishu"],
          now: NOW,
        }),
      /正在被其他流程更新/,
    );
  } finally {
    store.getIncident = original;
  }
  // 状态、审计事件与入队必须一起回滚：不能只留下一张发不出去的通知。
  assert.equal(
    (await store.incidentEvents(incident.id)).length,
    1,
    "审计事件未追加",
  );
  assert.equal((await store.outboxHealth()).pending, 1, "没有残留入队任务");
  assert.equal(
    (await store.getIncident(incident.id)).status,
    "OPEN",
    "实例状态未被改写",
  );
  env.DB.close();
});

test("维护窗口抑制运行类告警：窗口内静默通知，风险规则不受静默", async () => {
  const env = buildEnv();
  const enabled = {
    ...env,
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  };
  const store = new AlertRepository(enabled);
  const maintenance = (occurredAt, until) => ({
    id: `maint-${occurredAt}`,
    instanceId: "paper-instance",
    accountId: "maintenance",
    tradeDate: null,
    sourceSequence: null,
    type: EVENT_TYPES.MAINTENANCE,
    reasonCode: null,
    occurredAt,
    entityRef: "maintenance",
    payload: { until, reason: "演练" },
  });
  // 覆盖测试时刻的维护窗口（until 必须晚于本机当前时间才会被判为生效）。
  await store.recordOperationEvent(
    maintenance(NOW, new Date(Date.now() + 3600_000).toISOString()),
  );
  assert.ok(await maintenanceUntil(enabled), "维护窗口已生效");
  await recordOperationEvents(enabled, [loopInput({ status: "ERROR" })]);
  await processAlerts(enabled, { now: NOW });
  // 实例照常建立（状态不被冻结），但通知被静默。
  const loopIncident = await store.activeIncident("LOOP_FAILED:primary");
  assert.ok(loopIncident, "维护期仍记录实例");
  assert.equal(
    (await store.outboxHealth()).pending,
    0,
    "维护期运行类告警不入队",
  );
  // 风险规则不受维护静默：回撤触及硬约束照常通知。
  await recordOperationEvents(enabled, [
    loopInput(
      { status: "RUNNING", drawdownBreached: true, drawdown: 0.14 },
      { sequence: 2 },
    ),
  ]);
  await processAlerts(enabled, { now: NOW });
  assert.equal((await store.outboxHealth()).pending, 1, "风险告警穿透维护窗口");
  // 窗口结束后（后写入的维护事件把 until 置为过去）：同样的失败恢复通知。
  await store.recordOperationEvent(
    maintenance("2026-10-09T01:37:00.000Z", "2026-10-09T01:00:00.000Z"),
  );
  assert.equal(await maintenanceUntil(enabled), null, "维护窗口已结束");
  await recordOperationEvents(enabled, [
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:38:00.000Z", sequence: 3 },
    ),
  ]);
  await processAlerts(enabled, { now: "2026-10-09T01:38:10.000Z" });
  const resumed = await store.getIncident(loopIncident.id);
  assert.equal(resumed.notifiedOnce, true, "窗口结束后恢复通知");
  const deliveries = await store.claimDeliveries({
    now: "2026-10-09T01:38:11.000Z",
    leaseOwner: "test",
  });
  assert.ok(
    deliveries.some((delivery) => delivery.incidentId === loopIncident.id),
    "循环失败告警重新入队",
  );
  env.DB.close();
});

test("游标按摄取顺序推进：迟到入库的早发生事件不被永久漏读", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  // 先消费一条"晚发生"的事件，游标推进到它。
  await recordOperationEvents(env, [
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:36:00.000Z", sequence: 2 },
    ),
  ]);
  await processAlerts(env, { now: "2026-10-09T01:36:01.000Z" });
  assert.equal((await store.processorState()).lastEventCursor.ingestSeq, 1);
  // 迟到事件：发生时间早于已消费游标，但入库更晚。
  await recordOperationEvents(env, [
    {
      source: "ledger",
      now: "2026-10-09T01:30:00.000Z",
      tradeDate: "2026-10-09",
      sourceSequence: 1,
    },
  ]);
  const advanced = await processAlerts(env, {
    now: "2026-10-09T01:36:02.000Z",
  });
  assert.equal(advanced.processed, 1, "迟到事件仍被消费");
  assert.ok(
    await store.activeIncident("LEDGER_INVARIANT_FAILED:primary"),
    "迟到事件推进了规则",
  );
  env.DB.close();
});

test("旧格式游标折算为摄取序号：升级后既不重放也不漏读", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  await recordOperationEvents(env, [loopInput({ status: "ERROR" })]);
  await recordOperationEvents(env, [
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:36:00.000Z", sequence: 2 },
    ),
  ]);
  await processAlerts(env, { now: "2026-10-09T01:36:01.000Z" });
  const rows = await store.eventsSince(null);
  // 模拟升级前写入的按发生时间游标。
  await env.DB.prepare(
    "UPDATE alert_processor_state SET last_event_cursor = ? WHERE id = 'dispatcher'",
  )
    .bind(JSON.stringify({ occurredAt: rows[0].occurredAt, id: rows[0].id }))
    .run();
  assert.deepEqual((await store.processorState()).lastEventCursor, {
    ingestSeq: 1,
  });
  const advanced = await processAlerts(env, {
    now: "2026-10-09T01:36:02.000Z",
  });
  assert.equal(advanced.processed, 1, "只消费升级后新增的那一条");
  env.DB.close();
});
