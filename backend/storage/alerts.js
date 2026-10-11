// 告警存储（§5.2）：事件追加、规则版本、实例 CAS、事件审计、outbox 租约。
// 事件与交易提交共用现有 CAS 守卫；通知供应商网络失败不回滚交易。
import { digestOf } from "../domain/research-lineage.js";

// 实例 payload 合并。通知状态字段（notifiedOnce / lastNotifiedAt /
// notifyScheduledAt）由通知层独占：合并时一律取"当前行"的值，只有显式
// patch 才能推进。否则调用方基于旧快照拼的 payload 会把已送达标记回写成
// false，导致告警反复重发。
const NOTIFICATION_FIELDS = [
  "notifiedOnce",
  "lastNotifiedAt",
  "notifyScheduledAt",
];

function mergedIncidentPayload(current, patch) {
  const next = { ...current.payload, ...(patch?.payload ?? {}) };
  for (const field of NOTIFICATION_FIELDS) {
    next[field] = patch?.[field] ?? current.payload?.[field];
    if (next[field] === undefined) delete next[field];
  }
  return next;
}

// 活动指纹唯一索引（alert_incidents_active_fp，resolved_at IS NULL）冲突判定。
// 两个执行器同时判定"实例不存在"、并发 INSERT 同一指纹时，后到者会撞索引。
// 这是竞争而不是错误，必须识别出来走冲突重试，不能把 UNIQUE 异常抛出中断
// 整轮评估（否则同一批里其余指纹会被连带漏处理）。
function isActiveFingerprintConflict(error) {
  const message = String(error?.message ?? "");
  return (
    /unique constraint failed/i.test(message) &&
    message.includes("alert_incidents.fingerprint")
  );
}

export class AlertRepository {
  constructor(env) {
    this.db = env.DB;
  }

  // ---------- 追加事实（源事件 ID 幂等；rule_type 随事实落库） ----------
  // ingest_seq 在插入时取当前最大值 +1，是唯一的分发游标：只反映入库顺序，
  // 迟到事件（occurred_at 更早但入库更晚）因此不会被永久跳过。
  async recordOperationEvent(event) {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO operation_events (id, instance_id, account_id, trade_date, source_sequence, type, rule_type, reason_code, occurred_at, entity_ref, payload, ingest_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(ingest_seq), 0) + 1 FROM operation_events))",
      )
      .bind(
        event.id,
        event.instanceId,
        event.accountId,
        event.tradeDate ?? null,
        event.sourceSequence ?? null,
        event.type,
        event.ruleType ?? null,
        event.reasonCode ?? null,
        event.occurredAt,
        event.entityRef ?? null,
        JSON.stringify(event.payload ?? event.safeFacts ?? {}),
      )
      .run();
  }

  async eventsSince(cursor, limit = 200) {
    const columns =
      "ingest_seq, occurred_at, id, instance_id, account_id, trade_date, source_sequence, type, rule_type, reason_code, entity_ref, payload";
    const rows =
      cursor?.ingestSeq == null
        ? (
            await this.db
              .prepare(
                `SELECT ${columns} FROM operation_events ORDER BY ingest_seq LIMIT ?`,
              )
              .bind(limit)
              .all()
          ).results
        : (
            await this.db
              .prepare(
                `SELECT ${columns} FROM operation_events WHERE ingest_seq > ? ORDER BY ingest_seq LIMIT ?`,
              )
              .bind(cursor.ingestSeq, limit)
              .all()
          ).results;
    return rows.map((row) => ({
      ingestSeq: Number(row.ingest_seq),
      occurredAt: row.occurred_at,
      id: row.id,
      instanceId: row.instance_id,
      accountId: row.account_id,
      tradeDate: row.trade_date,
      sourceSequence: row.source_sequence,
      type: row.type,
      ruleType: row.rule_type,
      reasonCode: row.reason_code,
      entityRef: row.entity_ref,
      payload: JSON.parse(row.payload),
    }));
  }

  async latestEventCursor() {
    const row = await this.db
      .prepare("SELECT MAX(ingest_seq) AS n FROM operation_events")
      .first();
    return row?.n == null ? null : { ingestSeq: Number(row.n) };
  }

  // ---------- 规则版本（不可变；阈值范围校验在服务层） ----------
  async latestRuleVersion() {
    const row = await this.db
      .prepare(
        "SELECT id, created_at, payload, digest FROM alert_rule_versions ORDER BY created_at DESC LIMIT 1",
      )
      .first();
    return row
      ? {
          id: row.id,
          createdAt: row.created_at,
          payload: JSON.parse(row.payload),
          digest: row.digest,
        }
      : null;
  }

  async saveRuleVersion(payload, now) {
    const id = `rules-${now}`;
    await this.db
      .prepare(
        "INSERT INTO alert_rule_versions (id, created_at, payload, digest) VALUES (?, ?, ?, ?)",
      )
      .bind(id, now, JSON.stringify(payload), await digestOf(payload))
      .run();
    return { id, createdAt: now, payload, digest: await digestOf(payload) };
  }

  // ---------- 告警实例（活动指纹唯一 + revision CAS） ----------
  async activeIncident(fingerprint) {
    const row = await this.db
      .prepare(
        "SELECT * FROM alert_incidents WHERE fingerprint = ? AND resolved_at IS NULL",
      )
      .bind(fingerprint)
      .first();
    return row ? this.rowToIncident(row) : null;
  }

  // 最近实例：优先活动实例，没有活动实例时返回最近恢复的实例。
  // 迁移防重（P1-4）依赖已恢复实例做幂等判定——"补读旧事件不得重新打开
  // 已恢复告警"的守卫在 transitionIncident 里比较 resolvedAt，只查活动
  // 实例时该守卫永远无法命中。
  async recentIncident(fingerprint) {
    const row = await this.db
      .prepare(
        "SELECT * FROM alert_incidents WHERE fingerprint = ? ORDER BY (resolved_at IS NULL) DESC, last_seen DESC LIMIT 1",
      )
      .bind(fingerprint)
      .first();
    return row ? this.rowToIncident(row) : null;
  }

  rowToIncident(row) {
    const payload = JSON.parse(row.payload);
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      generation: row.generation,
      status: row.status,
      severity: row.severity,
      ruleType: row.rule_type,
      entityRef: payload.entityRef ?? null,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      ackUntil: row.ack_until,
      resolvedAt: row.resolved_at,
      ruleVersion: row.rule_version,
      revision: row.revision,
      notifiedOnce: Boolean(payload.notifiedOnce),
      lastNotifiedAt: payload.lastNotifiedAt ?? null,
      notifyScheduledAt: payload.notifyScheduledAt ?? null,
      payload,
    };
  }

  async getIncident(id) {
    const row = await this.db
      .prepare("SELECT * FROM alert_incidents WHERE id = ?")
      .bind(id)
      .first();
    return row ? this.rowToIncident(row) : null;
  }

  async listIncidents({ limit = 20, offset = 0, activeOnly = false } = {}) {
    const rows = activeOnly
      ? (
          await this.db
            .prepare(
              "SELECT * FROM alert_incidents WHERE resolved_at IS NULL ORDER BY last_seen DESC LIMIT ? OFFSET ?",
            )
            .bind(limit, offset)
            .all()
        ).results
      : (
          await this.db
            .prepare(
              "SELECT * FROM alert_incidents ORDER BY last_seen DESC LIMIT ? OFFSET ?",
            )
            .bind(limit, offset)
            .all()
        ).results;
    return rows.map((row) => this.rowToIncident(row));
  }

  async countIncidents(activeOnly = false) {
    const row = activeOnly
      ? await this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM alert_incidents WHERE resolved_at IS NULL",
          )
          .first()
      : await this.db
          .prepare("SELECT COUNT(*) AS n FROM alert_incidents")
          .first();
    return Number(row?.n ?? 0);
  }

  // 单事务提交（§5.2/§7.2）：实例状态迁移、事件审计与发送入队必须一起生效。
  // 分开提交会留下"状态已迁移但关键通知永久丢失"的窗口；这里在同一个
  // IMMEDIATE 事务内完成 CAS 迁移、追加 alert_events 与 alert_outbox。
  // eventType 为 null 时只推进状态（观测心跳），不追加审计事件也不入队。
  async commitIncidentTransition({
    create = null,
    id = null,
    patch = null,
    eventType = null,
    eventPayload = {},
    channels = [],
    now,
    expectedRevision = null,
  }) {
    return this.db.transaction(async () => {
      const runId = crypto.randomUUID();
      let incidentId = id;
      let revision;
      if (create) {
        incidentId = `inc-${now}-${crypto.randomUUID().slice(0, 8)}`;
        revision = 1;
        try {
          await this.db
            .prepare(
              "INSERT INTO alert_incidents (id, fingerprint, generation, status, severity, rule_type, first_seen, last_seen, ack_until, resolved_at, rule_version, revision, last_run_id, payload) VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, NULL, NULL, ?, 1, ?, ?)",
            )
            .bind(
              incidentId,
              create.fingerprint,
              create.generation ?? 1,
              create.severity,
              create.ruleType,
              create.firstSeen ?? now,
              now,
              create.ruleVersion,
              runId,
              JSON.stringify(create.payload ?? {}),
            )
            .run();
        } catch (error) {
          // 并发 create 撞活动指纹唯一索引：让调用方按既有冲突路径重读实例
          // 重新评估（此时胜出者已提交，重评会走 UPDATE 分支）。其余错误照抛，
          // 避免把 NOT NULL 等真正的数据缺陷伪装成竞争而陷入重复重试。
          if (isActiveFingerprintConflict(error))
            return {
              id: null,
              applied: false,
              reason: "CONTENTION",
              revision: null,
            };
          throw error;
        }
      } else {
        const current = await this.getIncident(id);
        if (!current) throw new Error("告警实例不存在");
        // 调用方读到的 revision 才是它的评估依据。只比对"事务内新读的
        // revision"挡不住写—写竞争：一个基于旧快照的评估会把已经升级的
        // 严重程度、或已恢复的状态覆盖回旧值。
        if (expectedRevision !== null && expectedRevision !== current.revision)
          return {
            id,
            applied: false,
            reason: "CONTENTION",
            revision: current.revision,
          };
        revision = current.revision + 1;
        // 显式 null 与"未指定"必须区分：重开实例要清除 resolved_at 与
        // ack_until、重置 first_seen，?? 会把 null 当缺省值回填旧数据，
        // 导致重开后恢复标记残留、活动实例查询永远漏掉它。
        const pick = (key) =>
          patch && Object.prototype.hasOwnProperty.call(patch, key)
            ? patch[key]
            : current[key];
        const result = await this.db
          .prepare(
            "UPDATE alert_incidents SET status = ?, severity = ?, last_seen = ?, ack_until = ?, resolved_at = ?, first_seen = ?, revision = revision + 1, last_run_id = ?, payload = ? WHERE id = ? AND revision = ?",
          )
          .bind(
            pick("status"),
            pick("severity"),
            pick("lastSeen"),
            pick("ackUntil"),
            pick("resolvedAt"),
            pick("firstSeen"),
            runId,
            JSON.stringify(mergedIncidentPayload(current, patch)),
            id,
            current.revision,
          )
          .run();
        if (result.meta.changes !== 1)
          return {
            id,
            applied: false,
            reason: "CONTENTION",
            revision: current.revision,
          };
      }
      if (!eventType)
        return {
          id: incidentId,
          applied: true,
          revision,
          runId,
          sequence: null,
        };
      const sequence =
        Number(
          (
            await this.db
              .prepare(
                "SELECT COALESCE(MAX(sequence), 0) AS n FROM alert_events WHERE incident_id = ?",
              )
              .bind(incidentId)
              .first()
          )?.n ?? 0,
        ) + 1;
      await this.db
        .prepare(
          "INSERT INTO alert_events (incident_id, sequence, type, created_at, payload) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          incidentId,
          sequence,
          eventType,
          now,
          JSON.stringify(eventPayload ?? {}),
        )
        .run();
      const deliveryIds = [];
      for (const channelRef of channels) {
        const deliveryId = `out-${now}-${crypto.randomUUID().slice(0, 8)}`;
        await this.db
          .prepare(
            "INSERT OR IGNORE INTO alert_outbox (id, incident_id, event_sequence, channel_ref, status, attempt, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)",
          )
          .bind(deliveryId, incidentId, sequence, channelRef, now, now, now)
          .run();
        deliveryIds.push(deliveryId);
      }
      return {
        id: incidentId,
        applied: true,
        revision,
        runId,
        sequence,
        deliveryIds,
      };
    });
  }

  async incidentEvents(incidentId) {
    const rows = (
      await this.db
        .prepare(
          "SELECT sequence, type, created_at, payload FROM alert_events WHERE incident_id = ? ORDER BY sequence",
        )
        .bind(incidentId)
        .all()
    ).results;
    return rows.map((row) => ({
      sequence: row.sequence,
      type: row.type,
      createdAt: row.created_at,
      payload: JSON.parse(row.payload),
    }));
  }

  // ---------- 发送队列（§5.4）：租约领取、有界重试、退避在服务层计算 ----------
  // 领取有期限租约：PENDING 到期项，或租约过期的 SENDING 项（接管）。
  async claimDeliveries({ now, leaseOwner, leaseSeconds = 60, limit = 10 }) {
    const leaseUntil = new Date(
      new Date(now).getTime() + leaseSeconds * 1000,
    ).toISOString();
    const rows = (
      await this.db
        .prepare(
          "SELECT id FROM alert_outbox WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
        )
        .bind(now, limit)
        .all()
    ).results;
    const takenOver = (
      await this.db
        .prepare(
          "SELECT id FROM alert_outbox WHERE status = 'SENDING' AND lease_until IS NOT NULL AND lease_until < ? ORDER BY next_attempt_at LIMIT ?",
        )
        .bind(now, limit)
        .all()
    ).results;
    const claimed = [];
    for (const row of [...rows, ...takenOver].slice(0, limit)) {
      const result = await this.db
        .prepare(
          "UPDATE alert_outbox SET status = 'SENDING', lease_until = ?, lease_owner = ?, updated_at = ? WHERE id = ? AND (status = 'PENDING' OR (status = 'SENDING' AND lease_until < ?))",
        )
        .bind(leaseUntil, leaseOwner, now, row.id, now)
        .run();
      if (result.meta.changes === 1) claimed.push(row.id);
    }
    const deliveries = [];
    for (const id of claimed) {
      const outbox = await this.db
        .prepare("SELECT * FROM alert_outbox WHERE id = ?")
        .bind(id)
        .first();
      if (outbox) deliveries.push(this.rowToDelivery(outbox));
    }
    return deliveries;
  }

  rowToDelivery(row) {
    return {
      id: row.id,
      incidentId: row.incident_id,
      eventSequence: row.event_sequence,
      channelRef: row.channel_ref,
      status: row.status,
      attempt: row.attempt,
      nextAttemptAt: row.next_attempt_at,
      leaseUntil: row.lease_until,
      leaseOwner: row.lease_owner,
      providerRef: row.provider_ref,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // 结果写入一律带租约 CAS：租约被接管后，迟到执行器写不进任何终态，
  // 避免旧执行器覆盖新执行器的 SENT / PENDING / EXPIRED 结果。
  async completeDelivery({ id, leaseOwner, leaseUntil, providerRef, now }) {
    const result = await this.db
      .prepare(
        "UPDATE alert_outbox SET status = 'SENT', provider_ref = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'SENDING' AND lease_owner = ? AND lease_until = ?",
      )
      .bind(providerRef ?? null, now, id, leaseOwner, leaseUntil)
      .run();
    return result.meta.changes === 1;
  }

  async retryDelivery({ id, leaseOwner, leaseUntil, nextAttemptAt, now }) {
    const result = await this.db
      .prepare(
        "UPDATE alert_outbox SET status = 'PENDING', attempt = attempt + 1, next_attempt_at = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'SENDING' AND lease_owner = ? AND lease_until = ?",
      )
      .bind(nextAttemptAt, now, id, leaseOwner, leaseUntil)
      .run();
    return result.meta.changes === 1;
  }

  async expireDelivery({ id, leaseOwner, leaseUntil, now }) {
    const result = await this.db
      .prepare(
        "UPDATE alert_outbox SET status = 'EXPIRED', lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'SENDING' AND lease_owner = ? AND lease_until = ?",
      )
      .bind(now, id, leaseOwner, leaseUntil)
      .run();
    return result.meta.changes === 1;
  }

  // 重试耗尽（EXPIRED）意味着关键通知已丢失：健康信号必须持续上报不健康，
  // 直到所有者确认过该实例（ACK 表示"已知悉这次丢失"），否则一次瞬时故障
  // 会让管道永远红着、或者（放宽阈值后）把丢失悄悄当成健康。
  async dismissExpiredDeliveries({ incidentId, now }) {
    const result = await this.db
      .prepare(
        "UPDATE alert_outbox SET status = 'DISMISSED', updated_at = ? WHERE incident_id = ? AND status = 'EXPIRED'",
      )
      .bind(now, incidentId)
      .run();
    return result.meta.changes;
  }

  // 队列健康：overdue 是"现在就该发却没人领"的项，是分发器停滞的直接证据；
  // 只看 pending 总量会把空闲队列当成健康（分发器已死时队列恰好是空的）。
  // longPending: 入队（created_at）后超过 2 分钟仍未送达的项——计时基准必须
  // 是入队时刻而不是 updated_at：每次失败重试都会刷新 updated_at，靠它计时
  // 时"等了 150 秒还没发出去"的通知会被刚发生的重试重置成健康（P1-3）。
  async outboxHealth({ now = new Date().toISOString() } = {}) {
    const twoMinutesAgo = new Date(
      new Date(now).getTime() - 2 * 60 * 1000,
    ).toISOString();
    const row = await this.db
      .prepare(
        "SELECT SUM(CASE WHEN status IN ('PENDING','SENDING') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'PENDING' AND next_attempt_at > ? THEN 1 ELSE 0 END) AS scheduled, SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired, SUM(CASE WHEN (status = 'PENDING' AND next_attempt_at <= ?) OR (status = 'SENDING' AND lease_until < ?) THEN 1 ELSE 0 END) AS overdue, SUM(CASE WHEN status IN ('PENDING','SENDING') AND created_at <= ? THEN 1 ELSE 0 END) AS long_pending FROM alert_outbox",
      )
      .bind(now, now, now, twoMinutesAgo)
      .first();
    return {
      pending: Number(row?.pending ?? 0),
      scheduled: Number(row?.scheduled ?? 0),
      sent: Number(row?.sent ?? 0),
      expired: Number(row?.expired ?? 0),
      overdue: Number(row?.overdue ?? 0),
      longPending: Number(row?.long_pending ?? 0),
    };
  }

  // ---------- 分发器游标与进度（外部监测依据，§4） ----------
  async processorState(id = "dispatcher") {
    const row = await this.db
      .prepare("SELECT * FROM alert_processor_state WHERE id = ?")
      .bind(id)
      .first();
    return row
      ? {
          id: row.id,
          revision: row.revision,
          lastEventCursor: await this.resolveCursor(row.last_event_cursor),
          lastProgressAt: row.last_progress_at,
          lastRunId: row.last_run_id,
        }
      : null;
  }

  // 旧格式游标（按发生时间 {occurredAt, id}）折算为摄取序号。
  // 旧方案按 (occurred_at, id) 分页消费，游标是"已消费的最大键"，因此
  // "未消费"集合 = 键大于游标的事件 ∪ 键不大于游标但在游标写入之后才入库的事件。
  // 后者里可能存在 ingest_seq 比游标行更小的事件（例如键更大的事件先入库），
  // 直接把游标折算成那一行的 ingest_seq 会永久跳过它们；因此取
  // min(键大于游标的最小 ingest_seq - 1, 游标行的 ingest_seq)：宁可重放少量
  // 已消费事件（状态机与入队对重放幂等），也绝不跳过未消费事件。
  async resolveCursor(raw) {
    if (!raw) return null;
    let cursor = null;
    try {
      cursor = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
    if (!cursor) return null;
    if (Number.isInteger(cursor.ingestSeq))
      return { ingestSeq: cursor.ingestSeq };
    if (!cursor.occurredAt || !cursor.id) return null;
    const row = await this.db
      .prepare("SELECT ingest_seq FROM operation_events WHERE id = ?")
      .bind(cursor.id)
      .first();
    if (!row) return { ingestSeq: 0 };
    const cursorSeq = Number(row.ingest_seq);
    const after = await this.db
      .prepare(
        "SELECT MIN(ingest_seq) AS n FROM operation_events WHERE (occurred_at > ?) OR (occurred_at = ? AND id > ?)",
      )
      .bind(cursor.occurredAt, cursor.occurredAt, cursor.id)
      .first();
    if (after?.n == null) return { ingestSeq: cursorSeq };
    return { ingestSeq: Math.min(Number(after.n) - 1, cursorSeq) };
  }

  // 游标只能前进，且写入必须携带调用方读到的 revision：只对比事务内的新
  // revision 挡不住"基于旧快照的评估"——它会把已经推进的游标写回旧位置，
  // 造成事件重复消费（甚至漏读）。
  async advanceProcessorState({
    id = "dispatcher",
    lastEventCursor,
    now,
    expectedRevision = null,
  }) {
    const current = await this.processorState(id);
    const runId = crypto.randomUUID();
    if (!current) {
      // 首次启动：先尝试插入，若并发已插入则重读其游标而非回退到 null。
      const created = await this.db
        .prepare(
          "INSERT OR IGNORE INTO alert_processor_state (id, revision, last_event_cursor, last_progress_at, last_run_id) VALUES (?, 1, ?, ?, ?)",
        )
        .bind(id, JSON.stringify(lastEventCursor ?? null), now, runId)
        .run();
      if (created.meta.changes === 1)
        return { applied: true, revision: 1, runId };
      // 并发插入：读取胜出者的状态，用其游标避免回退。
      const winner = await this.processorState(id);
      return {
        applied: false,
        reason: "CONTENTION",
        revision: winner?.revision ?? null,
        // 不回退游标：返回胜出者的游标供调用方保留。
        winnerCursor: winner?.lastEventCursor ?? lastEventCursor,
      };
    }
    if (expectedRevision !== null && expectedRevision !== current.revision)
      return {
        applied: false,
        reason: "CONTENTION",
        revision: current.revision,
        winnerCursor: current.lastEventCursor,
      };
    // 游标单调保护：无论什么路径（并发评估、首次启动读到已存在的行），
    // proposed 都不得小于库中已推进的位置——写回旧游标就是永久漏读。
    const proposed = lastEventCursor ?? current.lastEventCursor;
    const proposedSeq = Number.isInteger(proposed?.ingestSeq)
      ? proposed.ingestSeq
      : null;
    const currentSeq = Number.isInteger(current.lastEventCursor?.ingestSeq)
      ? current.lastEventCursor.ingestSeq
      : null;
    const finalCursor =
      proposedSeq != null && currentSeq != null && proposedSeq < currentSeq
        ? current.lastEventCursor
        : proposed;
    const result = await this.db
      .prepare(
        "UPDATE alert_processor_state SET revision = revision + 1, last_event_cursor = ?, last_progress_at = ?, last_run_id = ? WHERE id = ? AND revision = ?",
      )
      .bind(JSON.stringify(finalCursor), now, runId, id, current.revision)
      .run();
    if (result.meta.changes !== 1)
      return {
        applied: false,
        reason: "CONTENTION",
        revision: current.revision,
        winnerCursor: current.lastEventCursor,
      };
    return { applied: true, revision: current.revision + 1, runId };
  }
}
