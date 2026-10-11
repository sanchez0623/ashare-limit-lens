// 告警服务（§6）：从已提交事实推进规则与告警实例；发送队列有界重试。
// 交易循环只写事件（快）；规则评估与发送在独立 runner 或惰性入口推进。
import { AlertRepository } from "../storage/alerts.js";
import { marketClock } from "../domain/realtime.js";
import { safeError } from "../http.js";
import {
  DEFAULT_ALERT_POLICY,
  EVENT_TYPES,
  classifyOperationalFacts,
  evaluateAlertRules,
  transitionIncident,
  validateAlertPolicy,
  fingerprintOf,
  suppressedByMaintenance,
  RULE_TYPES,
} from "../domain/alert-rules.js";
import {
  formatSafeNotification,
  formatResolvedNotification,
  beijingStamp,
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
  const limit = 200;
  const events = await store.eventsSince(cursor, limit);
  const policy =
    (await store.latestRuleVersion())?.payload ?? DEFAULT_ALERT_POLICY;
  const clock = marketClock(new Date(now));
  const marketContext = {
    date: clock.date,
    time: clock.time,
    weekday: clock.weekday,
    calendarConfirmed: true,
  };
  const maintenance = await maintenanceUntil(env);
  const ruleVersion = (await store.latestRuleVersion())?.id ?? "default";
  // 通道在入队时固定：发送由 outbox 独立完成，规则推进不等待供应商。
  const channels = alertsEnabled(env)
    ? notificationChannels(env)
        .filter((channel) => channel.configured)
        .map((channel) => channel.ref)
    : [];
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
  const commit = async ({ previous, evaluation, group }) => {
    const transition = transitionIncident({
      incident: previous,
      evaluation,
      now,
      policy,
    });
    if (!transition) return false;
    // 维护窗口只静默通知，不冻结状态：观测心跳与严重度仍继续更新。
    const maintenanceSuppressed = suppressedByMaintenance(
      evaluation.event?.ruleType,
      maintenance,
      now,
    );
    const notify = maintenanceSuppressed ? null : transition.notify;
    const notifying = Boolean(notify) && channels.length > 0;
    const hasPatch = Object.keys(transition.patch ?? {}).length > 0;
    if (transition.action === "KEEP" && !notifying && !hasPatch) return false;
    const notificationFacts = notifying
      ? {
          notifiedOnce: true,
          lastNotifiedAt: now,
          lastNotifiedType: notify.type,
        }
      : {};
    const create = !previous;
    await store.commitIncidentTransition({
      create: create
        ? {
            fingerprint: evaluation.fingerprint,
            severity: notify?.severity ?? evaluation.severity,
            ruleType: evaluation.event.ruleType,
            ruleVersion,
            payload: {
              entityRef: evaluation.event.entityRef ?? "primary",
              affected: [...new Set((group ?? []).map((row) => row.accountId))],
              ...notificationFacts,
            },
          }
        : null,
      id: create ? null : previous.id,
      patch: create
        ? null
        : {
            ...transition.patch,
            ...(notifying ? { notifiedOnce: true, lastNotifiedAt: now } : {}),
            payload: {
              ...(previous?.payload ?? {}),
              ...(transition.action === "RESOLVE"
                ? { resolvedBy: "rules" }
                : {}),
              ...notificationFacts,
            },
          },
      // 只有需要通知时才追加审计事件与入队；纯观测心跳不写事件表。
      eventType: notifying ? notify.type : null,
      eventPayload: {
        severity: notify?.severity ?? evaluation.severity,
        // 结构化原因随审计事件落库，发送时据此如实说明触发原因（不含原始异常文本）。
        reasonCode: evaluation.event?.reasonCode ?? null,
        ...(transition.action === "RESOLVE" ? { resolvedBy: "rules" } : {}),
      },
      channels: notifying ? channels : [],
      now,
    });
    if (transition.action !== "KEEP") incidents += 1;
    return true;
  };
  for (const [fingerprint, group] of grouped) {
    const previous = await store.activeIncident(fingerprint);
    const evaluations = evaluateAlertRules({
      events: group,
      previousIncident: previous,
      policy,
      marketContext,
      now,
    });
    // 同一指纹的多条事件按根因聚合：一次评估，摘要列出受影响角色（§5.3）。
    const evaluation = evaluations.find((row) => !row.absent) ?? evaluations[0];
    if (!evaluation || evaluation.suppressed) continue;
    await commit({ previous, evaluation, group });
  }
  // 本批完全没有事件的未恢复实例：条件已消失，交给宽限期与恢复判定。
  // 只在整批事件都消费完时判定，否则积压尾部的实例会被误判为"已消失"。
  if (events.length < limit)
    for (const incident of await store.activeIncidents()) {
      if (grouped.has(incident.fingerprint)) continue;
      await commit({
        previous: incident,
        evaluation: {
          event: null,
          fingerprint: incident.fingerprint,
          severity: incident.severity,
          absent: true,
          suppressed: false,
        },
        group: [],
      });
    }
  // 游标只按摄取顺序前进；无事件时不回退（null 表示从头读，绝不能写回）。
  const nextCursor = events.length
    ? { ingestSeq: events.at(-1).ingestSeq }
    : cursor;
  // 空转也要更新进度心跳：停滞检测依赖 lastProgressAt，"空闲"不等于"停滞"。
  await store.advanceProcessorState({ lastEventCursor: nextCursor, now });
  return {
    processed: events.length,
    incidents,
    cursor: nextCursor,
    maintenanceUntil: maintenance,
  };
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
  const backoffFor = (attempt) =>
    new Date(
      new Date(now).getTime() +
        policy.backoffSeconds[
          Math.min(attempt - 1, policy.backoffSeconds.length - 1)
        ] *
          1000 +
        Math.floor(Math.random() * 1000),
    ).toISOString();
  // 每一次失败——包括适配器抛异常——都必须消耗一次重试预算，否则网络异常
  // 会绕过 maxAttempts 无限重试。
  const retryOrExpire = async (delivery, reason) => {
    const attempt = delivery.attempt + 1;
    const lease = {
      id: delivery.id,
      leaseOwner: delivery.leaseOwner,
      leaseUntil: delivery.leaseUntil,
      now,
    };
    if (attempt >= policy.maxAttempts) {
      const applied = await store.expireDelivery(lease);
      return applied
        ? { id: delivery.id, expired: true, reason }
        : { id: delivery.id, stale: true };
    }
    const nextAttemptAt = backoffFor(attempt);
    const applied = await store.retryDelivery({ ...lease, nextAttemptAt });
    return applied
      ? { id: delivery.id, retried: true, nextAttemptAt, reason }
      : { id: delivery.id, stale: true };
  };
  for (const delivery of deliveries) {
    try {
      const incident = await store.getIncident(delivery.incidentId);
      if (!incident) {
        await store.expireDelivery({
          id: delivery.id,
          leaseOwner: delivery.leaseOwner,
          leaseUntil: delivery.leaseUntil,
          now,
        });
        results.push({
          id: delivery.id,
          expired: true,
          reason: "INCIDENT_GONE",
        });
        continue;
      }
      const alertEvent = (await store.incidentEvents(incident.id)).find(
        (row) => row.sequence === delivery.eventSequence,
      );
      if (!alertEvent) {
        await store.expireDelivery({
          id: delivery.id,
          leaseOwner: delivery.leaseOwner,
          leaseUntil: delivery.leaseUntil,
          now,
        });
        results.push({ id: delivery.id, expired: true, reason: "EVENT_GONE" });
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
            // 结构化原因来自审计事件本身：操作者需要知道"哪一类失败"，
            // 但原始异常文本绝不进消息。
            event: { reasonCode: alertEvent.payload?.reasonCode ?? null },
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
        const applied = await store.completeDelivery({
          id: delivery.id,
          leaseOwner: delivery.leaseOwner,
          leaseUntil: delivery.leaseUntil,
          providerRef: outcome.providerRef,
          now,
        });
        // 租约已被接管时旧执行器不得覆盖新执行器的结果，只如实记录丢弃。
        results.push(
          applied
            ? { id: delivery.id, sent: true }
            : { id: delivery.id, stale: true },
        );
        continue;
      }
      const attempt = delivery.attempt + 1;
      if (!outcome.retryable || attempt >= policy.maxAttempts) {
        const applied = await store.expireDelivery({
          id: delivery.id,
          leaseOwner: delivery.leaseOwner,
          leaseUntil: delivery.leaseUntil,
          now,
        });
        results.push(
          applied
            ? { id: delivery.id, expired: true, reason: outcome.reason }
            : { id: delivery.id, stale: true },
        );
        continue;
      }
      const nextAttemptAt = backoffFor(attempt);
      const applied = await store.retryDelivery({
        id: delivery.id,
        leaseOwner: delivery.leaseOwner,
        leaseUntil: delivery.leaseUntil,
        nextAttemptAt,
        now,
      });
      results.push(
        applied
          ? { id: delivery.id, retried: true, nextAttemptAt }
          : { id: delivery.id, stale: true },
      );
    } catch (error) {
      results.push(await retryOrExpire(delivery, safeError(error)));
    }
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
  // 确认与审计事件同一事务提交，避免确认已生效却没有审计记录。
  await store.commitIncidentTransition({
    id: incidentId,
    patch: { ackUntil },
    eventType: "ACKED",
    eventPayload: { ackUntil },
    now,
  });
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
      text: `[测试] 告警通道\n实例: ${instanceId}\n北京时间: ${beijingStamp(now)}\n这是一条用户主动触发的测试通知`,
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
  // 不在此处推进分发器状态：维护窗口只是一条事实，由分发器按摄取顺序消费；
  // 从 API 进程改写游标会与分发器抢 CAS，导致维护入口 503 或游标回退。
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
