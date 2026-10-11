// 告警服务（§6）：从已提交事实推进规则与告警实例；发送队列有界重试。
// 交易循环只写事件（快）；规则评估与发送在独立 runner 或惰性入口推进。
import { AlertRepository } from "../storage/alerts.js";
import { marketClock } from "../domain/realtime.js";
import {
  DEFAULT_ALERT_POLICY,
  EVENT_TYPES,
  classifyOperationalFacts,
  evaluateAlertRules,
  transitionIncident,
  validateAlertPolicy,
  fingerprintOf,
  RULE_TYPES,
} from "../domain/alert-rules.js";
import {
  formatSafeNotification,
  formatResolvedNotification,
  instanceAlias,
} from "../domain/alert-messages.js";
import {
  notificationChannels,
  alertsEnabled,
  sendNotification,
} from "./notifications.js";

const nowIso = () => new Date().toISOString();

function eventId(event) {
  return `${event.instanceId}:${event.accountId}:${event.tradeDate ?? "na"}:${event.sourceSequence ?? 0}:${event.type}:${event.entityRef ?? "primary"}:${event.occurredAt}`;
}

// ---------- 事实入站（交易循环调用，只写事件表） ----------
export async function recordOperationEvents(env, inputs) {
  const store = new AlertRepository(env);
  const instanceId = instanceAlias(env);
  const written = [];
  for (const input of inputs) {
    for (const event of classifyOperationalFacts(input)) {
      const full = {
        ...event,
        instanceId,
        accountId: input.accountId ?? "primary",
        sourceSequence: input.sourceSequence ?? null,
        payload: event.safeFacts ?? {},
      };
      await store.recordOperationEvent({ ...full, id: eventId(full) });
      written.push(full);
    }
  }
  return written;
}

// ---------- 规则推进：消费事件游标 → 状态机 → outbox ----------
export async function processAlerts(
  env,
  { now = nowIso(), leaseOwner = "alerts" } = {},
) {
  const store = new AlertRepository(env);
  const state = await store.processorState();
  const cursor = state?.lastEventCursor ?? null;
  const events = await store.eventsSince(cursor, 200);
  if (!events.length) return { processed: 0, cursor };
  const policy =
    (await store.latestRuleVersion())?.payload ?? DEFAULT_ALERT_POLICY;
  const clock = marketClock(new Date(now));
  const marketContext = {
    date: clock.date,
    time: clock.time,
    weekday: clock.weekday,
    calendarConfirmed: true,
  };
  const grouped = new Map();
  for (const row of events) {
    if (!row.ruleType) continue; // 维护/测试等非规则事件不推进规则
    // 直接消费已落库事实（rule_type/reason_code/entity_ref 随事件落库），
    // 不在规则器里重新分类——分类只发生在事实入站时。
    const classified = {
      ruleType: row.ruleType,
      reasonCode: row.reasonCode,
      entityRef: row.entityRef ?? "primary",
      occurredAt: row.occurredAt,
      tradeDate: row.tradeDate,
      safeFacts: row.payload ?? {},
      type: row.type,
    };
    const fingerprint = fingerprintOf(classified);
    if (!grouped.has(fingerprint)) grouped.set(fingerprint, []);
    grouped
      .get(fingerprint)
      .push({ ...classified, instanceId: row.instanceId, rowId: row.id });
  }
  let incidents = 0;
  for (const [fingerprint, group] of grouped) {
    const previous = await store.activeIncident(fingerprint);
    const evaluations = evaluateAlertRules({
      events: group,
      previousIncident: previous,
      policy,
      marketContext,
    });
    // 同一指纹的多条事件按根因聚合：一次评估，摘要列出受影响角色（§5.3）。
    const evaluation = evaluations.find((row) => !row.absent) ?? evaluations[0];
    if (!evaluation || evaluation.suppressed) continue;
    const transition = transitionIncident({
      incident: previous,
      evaluation,
      now,
    });
    if (!transition || transition.action === "KEEP") continue;
    const ruleVersion = (await store.latestRuleVersion())?.id ?? "default";
    let incidentId = previous?.id ?? null;
    if (transition.action === "OPEN") {
      const created = await store.transitionIncident({
        create: {
          fingerprint,
          severity: transition.notify.severity,
          ruleType: evaluation.event.ruleType,
          ruleVersion,
          payload: {
            entityRef: evaluation.event.entityRef ?? "primary",
            affected: [...new Set(group.map((row) => row.accountId))],
          },
        },
        now,
      });
      incidentId = created.id;
      incidents += 1;
    } else if (
      transition.action === "ESCALATE" ||
      transition.action === "RESOLVE"
    ) {
      await store.transitionIncident({
        id: incidentId,
        patch: {
          ...transition.patch,
          notifiedOnce: previous?.notifiedOnce || Boolean(transition.notify),
          payload: {
            ...(previous?.payload ?? {}),
            ...(transition.action === "RESOLVE" ? { resolvedBy: "rules" } : {}),
          },
        },
        now,
      });
      incidents += 1;
    }
    if (transition.notify && alertsEnabled(env)) {
      const sequence = await store.appendAlertEvent(
        incidentId,
        transition.notify.type,
        { severity: transition.notify.severity ?? null },
        now,
      );
      const incident = await store.getIncident(incidentId);
      const message =
        transition.action === "RESOLVE"
          ? formatResolvedNotification({
              incident,
              instanceAlias: instanceAlias(env),
              now,
            })
          : formatSafeNotification({
              event: evaluation.event,
              incident,
              instanceAlias: instanceAlias(env),
              now,
            });
      for (const channel of notificationChannels(env).filter(
        (c) => c.configured,
      ))
        await store.enqueueDelivery({
          incidentId,
          eventSequence: sequence,
          channelRef: channel.ref,
          now,
        });
      void message;
    }
  }
  const latest = events.at(-1);
  const nextCursor = { occurredAt: latest.occurredAt, id: latest.id };
  await store.advanceProcessorState({ lastEventCursor: nextCursor, now });
  return { processed: events.length, incidents, cursor: nextCursor };
}

// ---------- 发送：租约 → 适配器 → 有界退避重试 ----------
export async function processAlertOutbox(
  env,
  { now = nowIso(), leaseOwner = "alerts" } = {},
) {
  const store = new AlertRepository(env);
  const deliveries = await store.claimDeliveries({ now, leaseOwner });
  const results = [];
  const policy =
    (await store.latestRuleVersion())?.payload ?? DEFAULT_ALERT_POLICY;
  for (const delivery of deliveries) {
    const incident = await store.getIncident(delivery.incidentId);
    if (!incident) {
      await store.expireDelivery(delivery.id, now);
      results.push({ id: delivery.id, expired: true });
      continue;
    }
    const alertEvent = (await store.incidentEvents(incident.id)).find(
      (row) => row.sequence === delivery.eventSequence,
    );
    if (!alertEvent) {
      await store.expireDelivery(delivery.id, now);
      results.push({ id: delivery.id, expired: true });
      continue;
    }
    const resolved = incident.status === "RESOLVED";
    const message = resolved
      ? formatResolvedNotification({
          incident,
          instanceAlias: instanceAlias(env),
          now,
        })
      : formatSafeNotification({
          event: null,
          incident,
          instanceAlias: instanceAlias(env),
          now,
          privacyMode: true,
        });
    const outcome = await sendNotification({
      channelRef: delivery.channelRef,
      env,
      safeMessage: message,
      eventId: `${incident.id}#${delivery.eventSequence}`,
    });
    if (outcome.ok) {
      await store.completeDelivery(delivery.id, outcome.providerRef, now);
      if (!incident.notifiedOnce)
        await store
          .transitionIncident({
            id: incident.id,
            patch: {
              payload: { ...(incident.payload ?? {}), notifiedOnce: true },
            },
            now,
          })
          .catch(() => {});
      results.push({ id: delivery.id, sent: true });
      continue;
    }
    const attempt = delivery.attempt + 1;
    if (!outcome.retryable || attempt >= policy.maxAttempts) {
      await store.expireDelivery(delivery.id, now);
      results.push({ id: delivery.id, expired: true, reason: outcome.reason });
      continue;
    }
    const backoff =
      policy.backoffSeconds[
        Math.min(attempt - 1, policy.backoffSeconds.length - 1)
      ];
    const nextAttemptAt = new Date(
      new Date(now).getTime() +
        backoff * 1000 +
        Math.floor(Math.random() * 1000),
    ).toISOString();
    await store.retryDelivery({ id: delivery.id, nextAttemptAt, now });
    results.push({ id: delivery.id, retried: true, nextAttemptAt });
  }
  return results;
}

// ---------- 状态与接口（§7） ----------
export async function alertsStatus(env) {
  const store = new AlertRepository(env);
  const state = await store.processorState();
  const health = await store.outboxHealth();
  return {
    enabled: alertsEnabled(env),
    channels: notificationChannels(env).map(({ ref, name, configured }) => ({
      ref,
      name,
      configured,
    })),
    watchdog: {
      progressConfigured: Boolean(env?.WATCHDOG_PROGRESS_URL),
      pipelineConfigured: Boolean(env?.WATCHDOG_PIPELINE_URL),
      lastProgressAt: state?.lastProgressAt ?? null,
    },
    outbox: health,
    ruleVersion: (await store.latestRuleVersion())?.id ?? "default",
    note: alertsEnabled(env)
      ? "主动告警已启用"
      : "主动告警未启用：请在服务端 .env 配置 FEISHU_WEBHOOK_URL",
  };
}

export async function listAlertIncidents(
  env,
  { cursor = 0, activeOnly = false } = {},
) {
  const store = new AlertRepository(env);
  const limit = 20;
  const offset = Number(cursor) || 0;
  const incidents = await store.listIncidents({ limit, offset, activeOnly });
  return {
    incidents,
    nextCursor: incidents.length === limit ? offset + limit : null,
  };
}

export async function incidentDetail(env, incidentId) {
  const store = new AlertRepository(env);
  const incident = await store.getIncident(incidentId);
  if (!incident) return null;
  return { incident, events: await store.incidentEvents(incidentId) };
}

export async function ackIncident(env, incidentId, { hours = 1 } = {}) {
  const store = new AlertRepository(env);
  const incident = await store.getIncident(incidentId);
  if (!incident) return null;
  if (!Number.isFinite(hours) || hours < 0.5 || hours > 72)
    throw new Error("确认时长必须为 0.5–72 小时");
  const now = nowIso();
  const ackUntil = new Date(
    new Date(now).getTime() + hours * 3600 * 1000,
  ).toISOString();
  await store.transitionIncident({
    id: incidentId,
    patch: { ackUntil, payload: { ...(incident.payload ?? {}) } },
    now,
  });
  await store.appendAlertEvent(incidentId, "ACKED", { ackUntil }, now);
  return { ackUntil };
}

export async function saveAlertRules(env, policy) {
  const validated = validateAlertPolicy({ ...DEFAULT_ALERT_POLICY, ...policy });
  const store = new AlertRepository(env);
  const version = await store.saveRuleVersion(validated, nowIso());
  return version;
}

export async function sendTestNotification(env) {
  if (!alertsEnabled(env))
    throw new Error("主动告警未启用：请先配置 FEISHU_WEBHOOK_URL");
  const store = new AlertRepository(env);
  const now = nowIso();
  const instanceId = instanceAlias(env);
  const event = {
    instanceId,
    accountId: "test",
    tradeDate: null,
    sourceSequence: null,
    type: EVENT_TYPES.TEST,
    reasonCode: null,
    occurredAt: now,
    entityRef: "test",
    payload: { source: "test" },
    id: `${instanceId}:test:na:0:${EVENT_TYPES.TEST}:test:${now}`,
  };
  await store.recordOperationEvent(event);
  const outcome = await sendNotification({
    channelRef: "feishu",
    env,
    safeMessage: {
      title: "[测试] 告警通道",
      text: `[测试] 告警通道\n实例: ${instanceId}\n北京时间: ${now.replace("T", " ").slice(0, 19)}\n这是一条用户主动触发的测试通知`,
    },
    eventId: event.id,
  });
  if (!outcome.ok) throw new Error(`测试通知发送失败：${outcome.reason}`);
  return { sent: true, providerRef: outcome.providerRef ?? null };
}

export async function setMaintenanceWindow(
  env,
  { minutes = 60, reason = "" } = {},
) {
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 24 * 60)
    throw new Error("维护窗口必须为 15–1440 分钟");
  const store = new AlertRepository(env);
  const now = nowIso();
  const until = new Date(
    new Date(now).getTime() + minutes * 60000,
  ).toISOString();
  await store.recordOperationEvent({
    id: `maint:${now}:${crypto.randomUUID().slice(0, 8)}`,
    instanceId: instanceAlias(env),
    accountId: "maintenance",
    tradeDate: null,
    sourceSequence: null,
    type: EVENT_TYPES.MAINTENANCE,
    reasonCode: null,
    occurredAt: now,
    entityRef: "maintenance",
    payload: { until, reason: String(reason).slice(0, 120) },
  });
  await store.advanceProcessorState({ now });
  return { until };
}

// 维护窗口内的非账本/非风险告警被抑制（§4.2）：供规则推进前过滤。
export async function maintenanceUntil(env) {
  const store = new AlertRepository(env);
  const row = await store.db
    .prepare(
      "SELECT payload FROM operation_events WHERE type = 'MAINTENANCE' ORDER BY occurred_at DESC LIMIT 1",
    )
    .first();
  if (!row) return null;
  const payload = JSON.parse(row.payload);
  return payload.until > nowIso() ? payload.until : null;
}

export const ALERT_RULE_TYPES = RULE_TYPES;
