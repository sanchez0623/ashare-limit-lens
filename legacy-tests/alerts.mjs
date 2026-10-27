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
import { evaluateWatchdogHealth } from "../backend/services/watchdog.js";

function buildEnv(patch = {}) {
  const DB = localDatabase();
  return { DB, ...patch };
}

const NOW = "2026-10-09T01:35:00.000Z"; // 周五 09:35 北京时间，连续竞价期间

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
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push(target);
    bodies.push(init?.body ?? null);
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
  return { calls, bodies, restore: () => (globalThis.fetch = original) };
}

test("事实分类：正常执行结果不产生告警事件，运行阻塞与故障如实入账", () => {
  // 未执行任何验证的轮次（休市/已结算/跳过）既没有问题事实也没有恢复证据。
  for (const status of [
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
  // 真正执行过的一轮：没有问题，但会给出"哪些规则本轮已验证正常"的恢复证据。
  const running = classifyOperationalFacts(loopInput({ status: "RUNNING" }));
  assert.deepEqual(
    running.filter((event) => !event.cleared),
    [],
    "RUNNING 不产生问题事件",
  );
  assert.deepEqual(
    running.map((event) => event.ruleType).sort(),
    [
      "LOOP_FAILED",
      "PROTECTIVE_EXIT_BLOCKED",
      "REQUIRED_QUOTE_STALE",
      "SESSION_BLOCKED",
      "T_RECOVERY_INCOMPLETE",
    ],
    "RUNNING 给出正向恢复证据",
  );
  assert.ok(
    running.every((event) => event.cleared && event.reasonCode === null),
    "恢复证据不带原因",
  );
  // 连续 ERROR 返回（未抛异常）也产生事件——覆盖最容易漏掉的路径。
  // ERROR 轮次只可能来自未捕获异常：不能依赖 error instanceof Error 识别，
  // 异常跨过序列化边界后类型信息丢失（runner 只传 status: "ERROR"）。
  const errors = classifyOperationalFacts(loopInput({ status: "ERROR" }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ruleType, RULE_TYPES.LOOP_FAILED);
  assert.equal(errors[0].reasonCode, REASON_CODES.RUNNER_FAILED);
  assert.equal(errors[0].safeFacts.isException, true);
  // 失败轮次什么都没验证：不能给出任何恢复证据。
  assert.ok(errors.every((event) => !event.cleared));
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
  // 盘后三项都完成：只给恢复证据，不给问题事实。
  const dailyOk = classifyOperationalFacts({
    source: "daily",
    result: {
      paper: { status: "SETTLED", nextPlan: { orders: [] } },
      snapshot: { saved: true },
    },
    now: NOW,
  });
  assert.ok(
    dailyOk.every((event) => event.cleared),
    `盘后成功只给恢复证据：${JSON.stringify(dailyOk)}`,
  );
  assert.deepEqual(
    dailyOk.map((event) => event.ruleType).sort(),
    ["SETTLEMENT_LATE"],
    "盘后三项完成即恢复结算迟延",
  );
  // 本轮压根没有研究任务：什么都没验证，不得给出研究恢复证据。
  assert.ok(
    dailyOk.every(
      (event) => event.ruleType !== RULE_TYPES.AI_OR_RESEARCH_FAILED,
    ),
  );
  const dailyWithResearch = classifyOperationalFacts({
    source: "daily",
    result: {
      paper: { status: "SETTLED", nextPlan: { orders: [] } },
      snapshot: { saved: true },
      tournament: { error: null },
    },
    now: NOW,
  });
  assert.deepEqual(
    dailyWithResearch.map((event) => event.ruleType).sort(),
    ["AI_OR_RESEARCH_FAILED", "SETTLEMENT_LATE"],
    "研究任务跑过且没报错才是恢复证据",
  );
  // 账本不变式异常立即入账。
  const ledger = classifyOperationalFacts({ source: "ledger", now: NOW });
  assert.equal(ledger[0].ruleType, RULE_TYPES.LEDGER_INVARIANT_FAILED);
});

test("时段语义：异常类故障全天有效，结算迟延按时间升级", () => {
  const policy = DEFAULT_ALERT_POLICY;
  const lunch = marketPhase({
    date: "2026-10-09",
    time: "11:45:00",
    weekday: 5,
    calendarConfirmed: true,
  });
  assert.equal(lunch.phase, "LUNCH");
  // ERROR 轮次来自未捕获异常，是程序故障而非"不成交"：午休与盘后都不抑制。
  // 旧实现按 reasonCode 把缺 error 字段的 ERROR 归为普通执行错误并抑制，
  // 盘后抛出的异常因此漏报（P1-5）。时段按事实的观测时刻（occurredAt）判定。
  const evaluation = evaluateAlertRules({
    events: classifyOperationalFacts(
      loopInput({ status: "ERROR" }, { now: "2026-10-09T03:45:00.000Z" }),
    ),
    previousIncident: null,
    policy,
  });
  assert.equal(evaluation[0].suppressed, false, "异常类循环失败不受午休抑制");
  const afterClose = evaluateAlertRules({
    events: classifyOperationalFacts(
      loopInput(
        { status: "ERROR" },
        { now: "2026-10-09T12:00:00.000Z", sequence: 9 },
      ),
    ),
    previousIncident: null,
    policy,
  });
  assert.equal(
    afterClose[0].suppressed,
    false,
    "盘后抛出的异常同样不得被时段抑制",
  );
  // 结算迟延：15:20 警告，15:30 升级（按观测时刻定级）。
  const dailyEvent = classifyOperationalFacts({
    source: "daily",
    result: { paper: { status: "BEFORE_CLOSE" }, snapshot: { saved: false } },
    now: "2026-10-09T07:22:00.000Z",
  });
  const warning = evaluateAlertRules({
    events: dailyEvent,
    previousIncident: null,
    policy,
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
  })[0];
  assert.equal(critical.severity, "CRITICAL");
  // 迟到的旧事实按它被观测到的时段定级：15:10 观测仍是 WARNING，
  // 不因处理时刻已越过升级时点而变成 CRITICAL。
  const stale = evaluateAlertRules({
    events: classifyOperationalFacts({
      source: "daily",
      result: { paper: { status: "BEFORE_CLOSE" }, snapshot: { saved: false } },
      now: "2026-10-09T07:10:00.000Z",
    }),
    previousIncident: null,
    policy,
    now: "2026-10-09T09:00:00.000Z",
  })[0];
  assert.equal(stale.severity, "WARNING", "迟到的旧事实按观测时段定级");
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
  })[0];
  const opened = transitionIncident({ incident: null, evaluation, now: NOW });
  assert.equal(opened.action, "OPEN");
  assert.equal(opened.notify.type, "OPEN");
  // 评估时钟是事实的观测时刻（as-of）：每个步骤用各自观测时刻的事实评估。
  const observed = (at, severity) => ({
    ...evaluateAlertRules({
      events: classifyOperationalFacts(
        loopInput({ status: "ERROR" }, { now: at }),
      ),
      previousIncident: null,
      policy,
    })[0],
    severity,
  });
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
      notifyScheduledAt: NOW,
      payload: {},
    },
    evaluation: observed("2026-10-09T01:40:00.000Z", "WARNING"),
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
      notifyScheduledAt: NOW,
      payload: {},
    },
    evaluation: observed("2026-10-09T01:50:00.000Z", "WARNING"),
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
      notifyScheduledAt: NOW,
      payload: {},
    },
    evaluation: observed("2026-10-09T01:50:00.000Z", "WARNING"),
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
      notifyScheduledAt: NOW,
      payload: {},
    },
    evaluation: observed("2026-10-09T01:50:00.000Z", "CRITICAL"),
    now: "2026-10-09T01:50:00.000Z",
  });
  assert.equal(escalatedUnderAck.action, "ESCALATE");
  assert.equal(escalatedUnderAck.notify?.type, "ESCALATED", "升级穿透确认");
  // 条件消失：只有正向证据（cleared）才允许恢复，且必须过宽限期。
  const clearedIncident = {
    status: "OPEN",
    severity: "WARNING",
    ruleType: event.ruleType,
    firstSeen: NOW,
    lastSeen: NOW,
    ackUntil: null,
    resolvedAt: null,
    notifiedOnce: true,
    payload: {},
  };
  const cleared = (now) =>
    transitionIncident({
      incident: clearedIncident,
      evaluation: {
        cleared: true,
        fingerprint: "LOOP_FAILED:primary",
        severity: "WARNING",
      },
      now,
    });
  // 刚清除、还没过宽限期：不恢复。
  assert.equal(
    cleared("2026-10-09T01:36:00.000Z").action,
    "KEEP",
    "宽限期内不恢复",
  );
  const resolved = cleared("2026-10-09T01:45:00.000Z");
  assert.equal(resolved.action, "RESOLVE");
  assert.equal(resolved.notify.type, "RESOLVED");
  // 关键：本批没有任何事实时既不恢复也不通知（恢复必须有正向证据）。
  const absent = transitionIncident({
    incident: clearedIncident,
    evaluation: {
      absent: true,
      fingerprint: "LOOP_FAILED:primary",
      severity: "WARNING",
    },
    now: "2026-10-09T05:00:00.000Z",
  });
  assert.equal(absent.action, "KEEP", "没有新证据不得自动判定恢复");
  assert.equal(absent.notify, null);
  assert.deepEqual(absent.patch, {}, "没有新证据不写状态");
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
  // 关键：本批没有 LOOP_FAILED 事实，只代表"本轮没有新证据"，不得据此
  // 判定恢复（交易循环停摆时正需要告警持续在案）。
  const loopIncident = await store.getIncident(incident.id);
  assert.equal(loopIncident.status, "OPEN", "没有新证据不得自动恢复");
  assert.equal(loopIncident.resolvedAt, null);
  // 发送：只有结算迟延一条任务。
  const sent = await processAlertOutbox(enabledEnv, {
    now: "2026-10-09T07:22:31.000Z",
  });
  assert.equal(sent.length, 1, "只有结算迟延一条任务");
  assert.ok(sent[0].sent);
  // 送达成功后才落"已通知"（入队不等于送达）。
  const notified = await store.getIncident(settlement.id);
  assert.equal(notified.notifiedOnce, true, "送达成功后通知标志已保存");
  assert.ok(notified.lastNotifiedAt);
  assert.ok(notified.notifyScheduledAt, "入队时刻单独记录");
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
  // 正向证据（一轮成功执行）到达后才允许恢复，并发一次恢复摘要。
  await recordOperationEvents(enabledEnv, [
    loopInput(
      { status: "RUNNING" },
      { now: "2026-10-09T07:24:00.000Z", sequence: 5 },
    ),
  ]);
  await processAlerts(enabledEnv, { now: "2026-10-09T07:30:00.000Z" });
  const recovered = await store.getIncident(incident.id);
  assert.equal(recovered.status, "RESOLVED", "正向证据驱动恢复");
  assert.ok(recovered.resolvedAt);
  const summary = await processAlertOutbox(enabledEnv, {
    now: "2026-10-09T07:30:01.000Z",
  });
  assert.equal(summary.length, 1, "恢复只通知一次");
  assert.ok(summary[0].sent);
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

test("消息时间按北京时间显示：库里的 UTC 时刻不得直接当北京时间展示", () => {
  const incident = {
    id: "inc-tz",
    fingerprint: "LOOP_FAILED:primary",
    ruleType: RULE_TYPES.LOOP_FAILED,
    severity: "WARNING",
    firstSeen: "2026-10-11T10:41:46.000Z", // 北京时间 18:41:46
    lastSeen: "2026-10-11T10:41:46.000Z",
    entityRef: "primary",
  };
  const message = formatSafeNotification({
    event: { reasonCode: REASON_CODES.EXECUTION_ERROR },
    incident,
    instanceAlias: "windows-paper",
    now: "2026-10-11T10:41:46.925Z",
  });
  assert.ok(
    message.text.includes("北京时间: 2026-10-11 18:41:46"),
    `北京时间应为 UTC+8，实际消息：${message.text}`,
  );
  assert.ok(!message.text.includes("10:41:46"), "不得出现未换算的 UTC 时刻");
  const resolved = formatResolvedNotification({
    incident,
    instanceAlias: "windows-paper",
    now: "2026-10-11T11:02:03.000Z",
  });
  assert.ok(resolved.text.includes("发生: 2026-10-11 18:41:46"));
  assert.ok(resolved.text.includes("恢复: 2026-10-11 19:02:03"));
});

test("消息不编造持续时间：刚触发的告警不写“持续时间: 1 分钟”", () => {
  const incident = {
    id: "inc-dur",
    fingerprint: "LOOP_FAILED:primary",
    ruleType: RULE_TYPES.LOOP_FAILED,
    severity: "WARNING",
    firstSeen: "2026-10-09T01:35:00.000Z",
    lastSeen: "2026-10-09T01:35:00.000Z",
    entityRef: "primary",
  };
  const opened = formatSafeNotification({
    event: { reasonCode: REASON_CODES.EXECUTION_ERROR },
    incident,
    instanceAlias: "windows-paper",
    now: "2026-10-09T01:35:01.000Z",
  });
  assert.ok(
    !opened.text.includes("持续时间"),
    `刚触发不应报持续时间：${opened.text}`,
  );
  // 满一分钟才给出，且数值如实反映间隔。
  const later = formatSafeNotification({
    event: { reasonCode: REASON_CODES.EXECUTION_ERROR },
    incident,
    instanceAlias: "windows-paper",
    now: "2026-10-09T01:47:30.000Z",
  });
  assert.ok(later.text.includes("持续时间: 13 分钟"), later.text);
});

test("告警消息带结构化原因：操作者能分辨是哪一类失败", async () => {
  const env = buildEnv();
  const enabled = {
    ...env,
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  };
  const mock = installFetchMock({
    "https://open.feishu.cn/": { code: 0, msgId: "om_reason" },
  });
  try {
    await recordOperationEvents(enabled, [loopInput({ status: "ERROR" })]);
    await processAlerts(enabled, { now: NOW });
    await processAlertOutbox(enabled, { now: "2026-10-09T01:35:01.000Z" });
    const sent = JSON.parse(mock.bodies[0]);
    assert.ok(
      sent.content.text.includes(`原因: ${REASON_CODES.RUNNER_FAILED}`),
      `消息应含结构化原因：${sent.content.text}`,
    );
    // 原始异常文本永不进消息。
    assert.ok(!sent.content.text.includes("http"));
  } finally {
    mock.restore();
  }
  env.DB.close();
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

test("测试通知：未配置通道拒绝；配置错误不重复撞接口；时间按北京时间显示", async () => {
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
  // 测试通知同样不得把 UTC 时刻贴上"北京时间"标签。
  const ok = installFetchMock({
    "https://open.feishu.cn/": { code: 0, msgId: "om_test" },
  });
  try {
    const sent = await sendTestNotification({
      ...env,
      FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
    });
    assert.equal(sent.sent, true);
    const text = JSON.parse(ok.bodies[0]).content.text;
    const stamp = text.match(/北京时间: (\S+ \S+)/)?.[1];
    const eventId = text.match(/事件: \S+:test:na:0:TEST:test:(\S+)/)?.[1];
    assert.ok(stamp && eventId, `消息应含北京时间与事件时间：${text}`);
    // 事件时间（UTC）换算到北京时间必须相差 8 小时。
    const offsetHours =
      (Date.parse(`${stamp.replace(" ", "T")}Z`) -
        Date.parse(eventId.replace(/\.\d+Z$/, "Z"))) /
      3600000;
    assert.equal(offsetHours, 8, `北京时间应为 UTC+8：${text}`);
  } finally {
    ok.restore();
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

test("飞书加签：timestamp/sign 在JSON请求体中，符合官方自定义机器人协议", async () => {
  const secret = "s3cret-key";
  const calls = [];
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    bodies.push(JSON.parse(init.body));
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
    assert.equal(sent.pathname, "/open-apis/bot/v2/hook/abc");
    assert.equal(sent.search, "");
    const { timestamp, sign } = bodies[0];
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
  const problems = (input) =>
    classifyOperationalFacts(input).filter((event) => !event.cleared);
  // 只有部分股票新鲜不再算健康：缺失清单必须入账。
  const partial = problems(
    loopInput({
      status: "STALE_QUOTES",
      freshQuotes: 2,
      watchedCodes: 3,
      missingQuoteCodes: ["600001"],
      affectsProtectiveExit: true,
    }),
  );
  assert.equal(partial.length, 1);
  assert.equal(partial[0].ruleType, RULE_TYPES.REQUIRED_QUOTE_STALE);
  assert.equal(partial[0].safeFacts.missingQuotes, 1);
  assert.equal(
    partial[0].safeFacts.affectsProtectiveExit,
    true,
    "缺失报价影响保护退出时如实标注",
  );
  // 回撤触及硬约束：与"本轮 status 是什么"无关。
  const drawdown = problems(
    loopInput({ status: "RUNNING", drawdownBreached: true, drawdown: 0.13 }),
  );
  assert.equal(drawdown.length, 1);
  assert.equal(drawdown[0].ruleType, RULE_TYPES.DRAWDOWN_TRIPPED);
  assert.equal(drawdown[0].reasonCode, REASON_CODES.DRAWDOWN_LIMIT);
  // 保护退出阻塞与做 T 第二腿未完成。
  const blocked = problems(
    loopInput({ status: "RUNNING", blockedProtectiveExits: ["600002"] }),
  );
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].ruleType, RULE_TYPES.PROTECTIVE_EXIT_BLOCKED);
  assert.deepEqual(blocked[0].safeFacts.codes, ["600002"]);
  const recovery = problems(
    loopInput({ status: "RUNNING", incompleteRecoveries: ["600003"] }),
  );
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].ruleType, RULE_TYPES.T_RECOVERY_INCOMPLETE);
  assert.deepEqual(recovery[0].safeFacts.codes, ["600003"]);
  // 除权不匹配：报价被引擎拒收，属于需要处理的运行阻塞。
  const held = problems(
    loopInput({ status: "RUNNING", corporateActionHolds: ["600004"] }),
  );
  assert.equal(held.length, 1);
  assert.equal(held[0].ruleType, RULE_TYPES.SESSION_BLOCKED);
  assert.equal(held[0].reasonCode, REASON_CODES.CORPORATE_ACTION_UNVERIFIED);
  assert.deepEqual(held[0].safeFacts.codes, ["600004"]);
  // 一次轮询同时暴露多项风险时逐项入账，而不是只留第一条。
  const combined = problems(
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
  // 同一轮的多条事实必须能同时落库：事件 ID 少了 ruleType 就会被
  // INSERT OR IGNORE 静默丢弃（回撤与保护退出同时触发时只剩第一条）。
  const sameRound = problems(
    loopInput({
      status: "RUNNING",
      drawdownBreached: true,
      blockedProtectiveExits: ["600002"],
      incompleteRecoveries: ["600003"],
      corporateActionHolds: ["600004"],
    }),
  );
  assert.equal(sameRound.length, 4, "同一轮四项风险都产出事实");
  assert.equal(
    new Set(sameRound.map((event) => event.ruleType)).size,
    4,
    "四项风险规则互不相同",
  );
});

test("同轮多条事实同时落库：事件 ID 必须区分规则", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  await recordOperationEvents(env, [
    loopInput({
      status: "RUNNING",
      drawdownBreached: true,
      drawdown: 0.13,
      blockedProtectiveExits: ["600002"],
      incompleteRecoveries: ["600003"],
      corporateActionHolds: ["600004"],
    }),
  ]);
  const rows = await store.eventsSince(null);
  const problemRules = rows
    .filter((row) => !(row.payload ?? {}).cleared)
    .map((row) => row.ruleType)
    .sort();
  assert.deepEqual(
    problemRules,
    [
      "DRAWDOWN_TRIPPED",
      "PROTECTIVE_EXIT_BLOCKED",
      "SESSION_BLOCKED",
      "T_RECOVERY_INCOMPLETE",
    ],
    "四项风险全部落库，没有被 INSERT OR IGNORE 吞掉",
  );
  // 恢复证据也必须落库且可被识别，否则会被误当成问题制造假实例。
  const cleared = rows
    .filter((row) => (row.payload ?? {}).cleared === true)
    .map((row) => row.ruleType)
    .sort();
  assert.deepEqual(cleared, ["LOOP_FAILED", "REQUIRED_QUOTE_STALE"]);
  await processAlerts(env, { now: NOW });
  const incidents = await store.listIncidents({ activeOnly: true });
  assert.deepEqual(
    incidents.map((incident) => incident.ruleType).sort(),
    [
      "DRAWDOWN_TRIPPED",
      "PROTECTIVE_EXIT_BLOCKED",
      "SESSION_BLOCKED",
      "T_RECOVERY_INCOMPLETE",
    ],
    "只有问题事实创建实例，恢复证据不建实例",
  );
  env.DB.close();
});

test("升级与提醒按持续时间推进：只看本轮事件永远得不到升级", () => {
  const previous = {
    status: "OPEN",
    severity: "WARNING",
    fingerprint: "LOOP_FAILED:primary",
    firstSeen: "2026-10-09T01:35:00.000Z",
    lastSeen: "2026-10-09T01:35:00.000Z",
    ackUntil: null,
    resolvedAt: null,
    notifiedOnce: true,
    notifyScheduledAt: "2026-10-09T01:35:00.000Z",
    lastNotifiedAt: "2026-10-09T01:35:00.000Z",
    payload: {},
  };
  // 观测于 01:36:40 的新事实：持续 100 秒（超过 loopFailedEscalateSeconds=90）
  // → 升级为 CRITICAL。评估时钟取事实自身的观测时刻（as-of）。
  const at = "2026-10-09T01:36:40.000Z";
  const event = classifyOperationalFacts(
    loopInput({ status: "ERROR" }, { now: at, sequence: 2 }),
  )[0];
  const evaluation = evaluateAlertRules({
    events: [event],
    previousIncident: previous,
    policy: DEFAULT_ALERT_POLICY,
  })[0];
  assert.equal(evaluation.severity, "CRITICAL", "持续时间驱动升级");
  const escalated = transitionIncident({
    incident: previous,
    evaluation,
    now: at,
  });
  assert.equal(escalated.action, "ESCALATE");
  assert.equal(escalated.notify.type, "ESCALATED");
  // 提醒按"上次成功通知时刻"推进，而不是被每轮事件刷新的 lastSeen：
  // 观测于 01:50:50 的事实距上次通知已超过 15 分钟。
  const remindEvent = classifyOperationalFacts(
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:50:50.000Z", sequence: 3 },
    ),
  )[0];
  const remindEvaluation = {
    ...evaluateAlertRules({
      events: [remindEvent],
      previousIncident: previous,
      policy: DEFAULT_ALERT_POLICY,
    })[0],
    severity: "WARNING",
  };
  const reminded = transitionIncident({
    incident: { ...previous, lastSeen: "2026-10-09T01:36:35.000Z" },
    evaluation: remindEvaluation,
    now: "2026-10-09T01:50:50.000Z",
  });
  assert.equal(reminded.action, "KEEP");
  assert.equal(reminded.notify?.type, "REMIND", "持续问题按节奏提醒");
});

test("状态迁移与入队同一事务：CAS 竞争不留下半成品", async () => {
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
  // 携带过期 revision（模拟另一执行器已先更新）：写入必须整体放弃。
  const contended = await store.commitIncidentTransition({
    id: incident.id,
    patch: { status: "ESCALATED_FOR_TEST" },
    eventType: "ESCALATED",
    channels: ["feishu"],
    now: NOW,
    expectedRevision: incident.revision - 1,
  });
  assert.equal(contended.applied, false, "过期 revision 不得写入");
  assert.equal(contended.reason, "CONTENTION");
  // 状态、审计事件与入队必须一起放弃：不能只留下一张发不出去的通知。
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
  assert.ok(resumed.notifyScheduledAt, "窗口结束后重新安排通知");
  assert.equal(resumed.notifiedOnce, false, "入队不再等于已通知");
  const mock = installFetchMock({
    "https://open.feishu.cn/": { code: 0, msgId: "om_maint" },
  });
  try {
    const delivered = await processAlertOutbox(enabled, {
      now: "2026-10-09T01:38:11.000Z",
    });
    assert.ok(
      delivered.some((row) => row.sent),
      "恢复后的告警真正发出",
    );
  } finally {
    mock.restore();
  }
  assert.equal(
    (await store.getIncident(loopIncident.id)).notifiedOnce,
    true,
    "送达成功后才落已通知标志",
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

test("旧游标折算不得跳过已入库未处理事件", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  // 复现旧方案的分页现场：旧方案按 (occurred_at, id) 每页消费，游标是
  // "已消费的最大键"。下面这条账本事件键最大（发生最晚），但最早入库——
  // 旧方案的一页在游标处截断时它还没被读到，属于"未消费"。
  await recordOperationEvents(env, [
    {
      source: "ledger",
      now: "2026-10-09T01:36:00.000Z",
      tradeDate: "2026-10-09",
    },
  ]);
  // 199 条键更小的事件，加上游标事件正好凑满旧方案的一页（200 条）。
  for (let index = 0; index < 199; index++)
    await recordOperationEvents(env, [
      loopInput(
        { status: "ERROR" },
        { now: "2026-10-09T01:00:00.000Z", sequence: 100 + index },
      ),
    ]);
  // 游标事件：键排在账本事件之前，正好是旧方案那一页的最后一条。
  await recordOperationEvents(env, [
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:35:00.000Z", sequence: 999 },
    ),
  ]);
  const rows = await store.eventsSince(null, 500);
  assert.equal(rows.length, 201);
  const cursorRow = rows.find(
    (row) => row.occurredAt === "2026-10-09T01:35:00.000Z",
  );
  assert.equal(cursorRow.ingestSeq, 201, "游标行是最后入库的一条");
  // 升级现场：分发器状态里存着旧方案写入的按发生时间游标。
  await env.DB.prepare(
    "INSERT INTO alert_processor_state (id, revision, last_event_cursor, last_progress_at, last_run_id) VALUES ('dispatcher', 1, ?, ?, 'legacy')",
  )
    .bind(
      JSON.stringify({ occurredAt: cursorRow.occurredAt, id: cursorRow.id }),
      "2026-10-09T01:35:01.000Z",
    )
    .run();
  // 折算必须退回到"未消费事件"之前：账本事件的 ingest_seq 比游标行更小，
  // 直接取游标行的 ingest_seq 会把它永久跳过。
  const folded = (await store.processorState()).lastEventCursor;
  assert.ok(
    folded.ingestSeq < 1,
    `折算结果必须覆盖早入库的未消费事件，实际 ${folded.ingestSeq}`,
  );
  await processAlerts(env, { now: "2026-10-09T01:36:01.000Z" });
  await processAlerts(env, { now: "2026-10-09T01:36:02.000Z" });
  assert.ok(
    await store.activeIncident("LEDGER_INVARIANT_FAILED:primary"),
    "未消费的账本事件不得被游标折算跳过",
  );
  env.DB.close();
});

test("并发保护：过期快照不得覆盖更新的严重程度，也不得回退游标", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  await recordOperationEvents(env, [loopInput({ status: "ERROR" })]);
  await processAlerts(env, { now: NOW });
  const stale = await store.activeIncident("LOOP_FAILED:primary");
  // 另一个执行器先把实例升级为 CRITICAL。
  await store.commitIncidentTransition({
    id: stale.id,
    patch: { severity: "CRITICAL" },
    now: "2026-10-09T01:35:30.000Z",
    expectedRevision: stale.revision,
  });
  // 基于旧快照的评估（WARNING）不得把已升级的状态写回去。
  const overwritten = await store.commitIncidentTransition({
    id: stale.id,
    patch: { severity: "WARNING", lastSeen: "2026-10-09T01:35:40.000Z" },
    now: "2026-10-09T01:35:40.000Z",
    expectedRevision: stale.revision,
  });
  assert.equal(overwritten.applied, false, "过期快照不得覆盖新状态");
  assert.equal(
    (await store.getIncident(stale.id)).severity,
    "CRITICAL",
    "严重程度保持为最新值",
  );
  // 游标同理：携带过期 revision 的写入必须被拒绝，游标不得回退。
  const state = await store.processorState();
  const advanced = await store.advanceProcessorState({
    lastEventCursor: { ingestSeq: 0 },
    now: "2026-10-09T01:35:40.000Z",
    expectedRevision: state.revision - 1,
  });
  assert.equal(advanced.applied, false, "过期快照不得回退游标");
  assert.deepEqual(
    (await store.processorState()).lastEventCursor,
    state.lastEventCursor,
    "游标保持最新位置",
  );
  env.DB.close();
});

test("并发保护：并发 create 撞活动指纹唯一索引按冲突处理，不抛 UNIQUE", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  const create = (severity) => ({
    fingerprint: "LOOP_FAILED:primary",
    severity,
    ruleType: "LOOP_FAILED",
    ruleVersion: "rules-1",
    payload: {},
  });
  // 第一个执行器已建立活动实例。
  const first = await store.commitIncidentTransition({
    create: create("WARNING"),
    now: NOW,
  });
  assert.equal(first.applied, true);
  // 第二个执行器仍以为实例不存在，重复 create：必须返回冲突（让调用方重读
  // 实例重新评估），绝不能抛出 UNIQUE 中断整轮 processAlerts。
  const second = await store.commitIncidentTransition({
    create: create("CRITICAL"),
    now: "2026-10-09T01:35:10.000Z",
  });
  assert.equal(second.applied, false, "重复 create 必须判为冲突");
  assert.equal(second.reason, "CONTENTION");
  assert.equal(second.id, null);
  // 活动指纹唯一：冲突方既不得新增实例，也不得改写胜出者的实例。
  assert.equal(await store.countIncidents(true), 1, "同一指纹活动实例唯一");
  assert.equal(
    (await store.activeIncident("LOOP_FAILED:primary")).severity,
    "WARNING",
    "冲突方不得改写胜出者的实例",
  );
  env.DB.close();
});

test("通知丢失：重试耗尽后健康不通过，确认后恢复", async () => {
  const env = buildEnv();
  const enabled = {
    ...env,
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network unreachable");
  };
  const store = new AlertRepository(enabled);
  try {
    await recordOperationEvents(enabled, [loopInput({ status: "ERROR" })]);
    await processAlerts(enabled, { now: NOW });
    const started = Date.parse(NOW);
    for (let round = 0; round < DEFAULT_ALERT_POLICY.maxAttempts + 1; round++) {
      const results = await processAlertOutbox(enabled, {
        now: new Date(started + (round + 1) * 3600_000).toISOString(),
      });
      if (results.some((row) => row.expired)) break;
    }
    const health = await store.outboxHealth();
    assert.equal(health.expired, 1, "关键通知重试耗尽");
    // 丢失即不健康：外部监测必须能发现，而不是被阈值吞掉。
    assert.equal(
      evaluateWatchdogHealth({
        runnerProgress: null,
        storageHealth: { ok: true },
        queueHealth: health,
        pipelineState: { lastProgressAt: new Date().toISOString() },
        now: Date.now(),
      }).alertPipeline,
      false,
      "通知丢失后不得上报管道健康",
    );
    // 所有者确认即表示已知悉这次丢失，健康可以恢复。
    const incident = await store.activeIncident("LOOP_FAILED:primary");
    await ackIncident(enabled, incident.id, { hours: 1 });
    assert.equal(
      (await store.outboxHealth()).expired,
      0,
      "确认后失败信号被清除",
    );
  } finally {
    globalThis.fetch = original;
  }
  env.DB.close();
});

test("积压计时基于入队时刻：重试刷新 updated_at 不重置等待", async () => {
  const env = buildEnv();
  const enabled = {
    ...env,
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  };
  await recordOperationEvents(enabled, [loopInput({ status: "ERROR" })]);
  await processAlerts(enabled, { now: NOW });
  const store = new AlertRepository(enabled);
  // 模拟连续失败重试：updated_at 被刷新到检查时刻前 10 秒。按 updated_at
  // 计时的旧实现会把它当成"刚入队"而报健康，实际上这通知已等待 150 秒。
  await env.DB.prepare(
    "UPDATE alert_outbox SET status = 'PENDING', updated_at = ?, next_attempt_at = ?",
  )
    .bind("2026-10-09T01:37:20.000Z", "2026-10-09T01:37:20.000Z")
    .run();
  const health = await store.outboxHealth({ now: "2026-10-09T01:37:30.000Z" });
  assert.equal(
    health.longPending,
    1,
    "入队超过 2 分钟仍未送达：失败重试不得重置计时",
  );
  assert.equal(
    evaluateWatchdogHealth({
      runnerProgress: null,
      storageHealth: { ok: true },
      queueHealth: health,
      pipelineState: { lastProgressAt: "2026-10-09T01:37:30.000Z" },
      now: Date.parse("2026-10-09T01:37:30.000Z"),
    }).alertPipeline,
    false,
    "重试积压下外部监测不得报平安",
  );
  env.DB.close();
});

test("迁移防重：补读旧事件不重开已恢复实例，恢复后的新故障才重新打开", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  // 失败事实创建实例，正向证据恢复它。
  await recordOperationEvents(env, [loopInput({ status: "ERROR" })]);
  await processAlerts(env, { now: NOW });
  await recordOperationEvents(env, [
    loopInput(
      { status: "RUNNING" },
      { now: "2026-10-09T01:45:00.000Z", sequence: 2 },
    ),
  ]);
  await processAlerts(env, { now: "2026-10-09T01:45:10.000Z" });
  const resolved = await store.recentIncident("LOOP_FAILED:primary");
  assert.equal(resolved.status, "RESOLVED");
  // 补读旧事件（发生时刻早于恢复时刻）：幂等守卫必须命中。服务层只查
  // 活动实例时，transitionIncident 永远拿不到 RESOLVED 实例，旧事件会把
  // 已恢复的告警重新打开并再次入队。
  await recordOperationEvents(env, [
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:40:00.000Z", sequence: 3 },
    ),
  ]);
  await processAlerts(env, { now: "2026-10-09T01:46:00.000Z" });
  const kept = await store.recentIncident("LOOP_FAILED:primary");
  assert.equal(kept.status, "RESOLVED", "旧事件重放不得重新打开已恢复实例");
  assert.equal(kept.resolvedAt, resolved.resolvedAt, "恢复标记未被清除");
  // 恢复之后发生的新故障：重新打开同指纹实例，视为新一段故障。
  await recordOperationEvents(env, [
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:50:00.000Z", sequence: 4 },
    ),
  ]);
  await processAlerts(env, { now: "2026-10-09T01:50:10.000Z" });
  const reopened = await store.recentIncident("LOOP_FAILED:primary");
  assert.equal(reopened.status, "OPEN", "恢复后的新故障重新打开实例");
  assert.equal(reopened.id, resolved.id, "同指纹实例被重新打开");
  assert.equal(reopened.resolvedAt, null, "重开时清除恢复标记");
  assert.equal(
    reopened.firstSeen,
    "2026-10-09T01:50:00.000Z",
    "重开重置起始时刻为观测时刻，不继承旧故障的持续时间",
  );
  assert.ok(
    await store.activeIncident("LOOP_FAILED:primary"),
    "重开后活动实例查询可见",
  );
  env.DB.close();
});

test("并发冲突后重评仍提交：严重度相同的升级不得随游标丢失", async () => {
  const env = buildEnv();
  const enabled = {
    ...env,
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  };
  const store = new AlertRepository(env);
  await recordOperationEvents(enabled, [loopInput({ status: "ERROR" })]);
  await processAlerts(enabled, { now: NOW });
  // 模拟并发执行器在评估读取与提交之间推进 revision（ACK、心跳等）：
  // 第一次实例 UPDATE 的 CAS 必然失败，触发重读重评路径。
  const realPrepare = env.DB.prepare.bind(env.DB);
  let failFirstUpdate = true;
  env.DB.prepare = (sql) => {
    if (failFirstUpdate && sql.includes("UPDATE alert_incidents")) {
      failFirstUpdate = false;
      return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) };
    }
    return realPrepare(sql);
  };
  let result;
  try {
    await recordOperationEvents(enabled, [
      loopInput(
        { status: "ERROR" },
        { now: "2026-10-09T01:55:00.000Z", sequence: 2 },
      ),
    ]);
    result = await processAlerts(enabled, { now: "2026-10-09T01:55:10.000Z" });
  } finally {
    env.DB.prepare = realPrepare;
  }
  assert.ok(result.contended >= 1, "CAS 冲突确实发生过");
  const escalated = await store.activeIncident("LOOP_FAILED:primary");
  // 持续 20 分钟的 ERROR 事实评估为 CRITICAL；重评后严重度与评估值相同
  // （实例已被并发推进到同一严重度的场景也覆盖），修复前在"严重度未变"
  // 处提前退出，升级与通知未提交而游标照常推进，这次升级被永久跳过。
  assert.equal(escalated.severity, "CRITICAL", "冲突后升级仍必须提交");
  assert.ok((await store.outboxHealth()).pending >= 1, "升级通知已入队");
  assert.equal(
    (await store.processorState()).lastEventCursor.ingestSeq,
    2,
    "事实提交完成后游标推进",
  );
  env.DB.close();
});

test("持续冲突时游标不得越过未提交事实：停在原位等待下轮重放", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  await recordOperationEvents(env, [loopInput({ status: "ERROR" })]);
  await processAlerts(env, { now: NOW });
  const before = (await store.processorState()).lastEventCursor;
  // 实例 UPDATE 永远失败：三次重试耗尽后本批事实仍未提交。
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql.includes("UPDATE alert_incidents"))
      return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) };
    return realPrepare(sql);
  };
  let result;
  try {
    await recordOperationEvents(env, [
      loopInput(
        { status: "ERROR" },
        { now: "2026-10-09T01:55:00.000Z", sequence: 2 },
      ),
    ]);
    result = await processAlerts(env, { now: "2026-10-09T01:55:10.000Z" });
  } finally {
    env.DB.prepare = realPrepare;
  }
  assert.ok(result.contended >= 3, "重试耗尽仍冲突");
  assert.deepEqual(
    (await store.processorState()).lastEventCursor,
    before,
    "未提交的事实不得被游标越过",
  );
  // 冲突解除后重放同一批事件：状态机幂等处理，事实最终提交，游标推进。
  await processAlerts(env, { now: "2026-10-09T01:55:20.000Z" });
  assert.equal(
    (await store.activeIncident("LOOP_FAILED:primary")).severity,
    "CRITICAL",
    "重放后事实提交",
  );
  assert.equal(
    (await store.processorState()).lastEventCursor.ingestSeq,
    2,
    "重放成功后游标推进",
  );
  env.DB.close();
});

test("游标写入单调：首次启动路径也不得把游标写回旧位置", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  await recordOperationEvents(env, [loopInput({ status: "ERROR" })]);
  await processAlerts(env, { now: NOW });
  assert.equal((await store.processorState()).lastEventCursor.ingestSeq, 1);
  // expectedRevision=null 是首次启动/游标自愈路径：不做 CAS 校验，但仍
  // 不得把已推进的游标写回更旧的位置——写回旧位置就是永久漏读。
  const stale = await store.advanceProcessorState({
    lastEventCursor: { ingestSeq: 0 },
    now: "2026-10-09T01:36:00.000Z",
    expectedRevision: null,
  });
  assert.equal(stale.applied, true);
  assert.deepEqual(
    (await store.processorState()).lastEventCursor,
    { ingestSeq: 1 },
    "首次启动路径同样受单调保护",
  );
  env.DB.close();
});

test("观测顺序守卫：迟到的执行器不得把已升级实例降级，也不得回退 lastSeen", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  await recordOperationEvents(env, [loopInput({ status: "ERROR" })]);
  await processAlerts(env, { now: NOW }); // 实例 WARNING，lastSeen=NOW
  const opened = await store.activeIncident("LOOP_FAILED:primary");
  // 并发执行器 B 用更晚的观测把实例升级为 CRITICAL，lastSeen 也推进到更晚。
  const bNow = "2026-10-09T01:36:31.000Z"; // 距 firstSeen 91s，越过升级阈值
  await store.commitIncidentTransition({
    id: opened.id,
    patch: { severity: "CRITICAL", lastSeen: bNow },
    now: bNow,
    expectedRevision: opened.revision,
  });
  // 迟到的执行器 A 用更早的观测（now < lastSeen=01:36:31）重放同一批事实：
  // 其评估时长仅 60s，按旧逻辑会被判为 WARNING 并写回，把 CRITICAL 降级、
  // lastSeen 拉回。观测顺序守卫必须整体跳过这次陈旧评估。
  await recordOperationEvents(env, [
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:36:00.000Z", sequence: 2 },
    ),
  ]);
  await processAlerts(env, { now: "2026-10-09T01:36:00.000Z" });
  const after = await store.getIncident(opened.id);
  assert.equal(after.severity, "CRITICAL", "迟到的旧评估不得把实例降级");
  assert.equal(after.lastSeen, bNow, "lastSeen 不得被旧观测回退");
  env.DB.close();
});

test("同批补读：组内历史重放被忽略，后续新故障仍必须处理并推进游标", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  // 建立实例 → 正向证据恢复它。
  await recordOperationEvents(env, [loopInput({ status: "ERROR" })]);
  await processAlerts(env, { now: NOW });
  await recordOperationEvents(env, [
    loopInput(
      { status: "RUNNING" },
      { now: "2026-10-09T01:45:00.000Z", sequence: 2 },
    ),
  ]);
  await processAlerts(env, { now: "2026-10-09T01:45:10.000Z" });
  const resolved = await store.recentIncident("LOOP_FAILED:primary");
  assert.equal(resolved.status, "RESOLVED");
  // 同一批里两条同指纹事实：一条是恢复前的历史重放（应被幂等守卫忽略），
  // 另一条是恢复之后发生的真实新故障。修复前只取组内第一条评估，
  // 历史重放被判为无需写库，同组的新故障随之被游标永久吞掉。
  await recordOperationEvents(env, [
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:40:00.000Z", sequence: 3 },
    ),
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:50:00.000Z", sequence: 4 },
    ),
  ]);
  await processAlerts(env, { now: "2026-10-09T01:50:10.000Z" });
  const reopened = await store.recentIncident("LOOP_FAILED:primary");
  assert.equal(reopened.status, "OPEN", "同组新故障必须重新打开实例");
  assert.equal(reopened.resolvedAt, null, "重开时清除恢复标记");
  // 摄取序号按每条落库事实计数：1 条 ERROR + RUNNING 的 5 条恢复证据 + 本批 2 条 = 8。
  assert.equal(
    (await store.processorState()).lastEventCursor.ingestSeq,
    8,
    "组内全部事实处理完成后游标推进到批尾",
  );
  env.DB.close();
});

test("观测顺序守卫按源观测时间判定：迟到的旧事实不得降级已升级实例", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  const daily = (now, sequence) => ({
    source: "daily",
    result: { paper: { status: "BEFORE_CLOSE" }, snapshot: { saved: false } },
    now,
    tradeDate: "2026-10-09",
    sourceSequence: sequence,
  });
  // 15:31 观测的结算迟延已越过升级时点：实例 CRITICAL，lastSeen 记录观测时刻。
  await recordOperationEvents(env, [daily("2026-10-09T07:31:00.000Z", 1)]);
  await processAlerts(env, { now: "2026-10-09T07:31:10.000Z" });
  const opened = await store.recentIncident("SETTLEMENT_LATE:primary");
  assert.equal(opened.severity, "CRITICAL");
  // 15:10 观测的旧事实迟到最后才入库（处理时刻 17:00，已越过升级时点）：
  // 按处理时间评估会把它判成 WARNING 并覆盖写回。守卫必须比较源观测时间——
  // 旧观测早于 lastSeen 即为旧信息，无论它何时被处理都不得写回。
  await recordOperationEvents(env, [daily("2026-10-09T07:10:00.000Z", 2)]);
  await processAlerts(env, { now: "2026-10-09T09:00:00.000Z" });
  const after = await store.getIncident(opened.id);
  assert.equal(after.severity, "CRITICAL", "迟到的旧观测不得把实例降级");
  assert.equal(
    after.lastSeen,
    "2026-10-09T07:31:00.000Z",
    "lastSeen 保持为最新观测时刻",
  );
  env.DB.close();
});

test("同批恢复证据不随问题事实丢弃：逐条应用后实例恢复且游标推进", async () => {
  const env = buildEnv();
  const store = new AlertRepository(env);
  await recordOperationEvents(env, [loopInput({ status: "ERROR" })]);
  await processAlerts(env, { now: "2026-10-09T01:35:05.000Z" });
  // 同一页内：01:37 的新故障（持续 120s → CRITICAL），随后连续两轮 RUNNING。
  // 旧实现批量评估发现组内有问题事实后把同组 cleared 全部过滤，两轮恢复
  // 证据随游标一起被吞掉，实例永远停在 OPEN/CRITICAL。
  await recordOperationEvents(env, [
    loopInput(
      { status: "ERROR" },
      { now: "2026-10-09T01:37:00.000Z", sequence: 2 },
    ),
    loopInput(
      { status: "RUNNING" },
      { now: "2026-10-09T01:38:00.000Z", sequence: 3 },
    ),
    loopInput(
      { status: "RUNNING" },
      { now: "2026-10-09T01:41:00.000Z", sequence: 4 },
    ),
  ]);
  await processAlerts(env, { now: "2026-10-09T01:41:30.000Z" });
  const resolved = await store.recentIncident("LOOP_FAILED:primary");
  assert.equal(resolved.severity, "CRITICAL", "页内新故障先完成升级");
  assert.equal(resolved.status, "RESOLVED", "同页恢复证据驱动恢复");
  assert.equal(
    resolved.resolvedAt,
    "2026-10-09T01:41:00.000Z",
    "恢复标记取恢复事实的观测时刻（01:38 距故障仅 60s，宽限内保持）",
  );
  // 摄取序号按每条落库事实计数：1 条 ERROR + 两轮 RUNNING 各 5 条 cleared = 11。
  assert.equal(
    (await store.processorState()).lastEventCursor.ingestSeq,
    1 + 11,
    "组内全部事实处理完成后游标推进到批尾",
  );
  env.DB.close();
});
