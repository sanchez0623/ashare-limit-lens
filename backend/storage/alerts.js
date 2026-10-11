// 告警存储（§5.2）：事件追加、规则版本、实例 CAS、事件审计、outbox 租约。
// 事件与交易提交共用现有 CAS 守卫；通知供应商网络失败不回滚交易。
import { digestOf } from "../domain/research-lineage.js";

// 实例 payload 合并：notifiedOnce 只能由显式字段推进，绝不能被"当前值"
// 回写覆盖——否则成功发送后的标记会立刻被打回 false，告警反复重发。
function mergedIncidentPayload(current, patch) {
  const next = { ...current.payload, ...(patch?.payload ?? {}) };
  if (patch?.notifiedOnce !== undefined)
    next.notifiedOnce = Boolean(patch.notifiedOnce);
  else next.notifiedOnce = Boolean(next.notifiedOnce);
  if (patch?.lastNotifiedAt !== undefined)
    next.lastNotifiedAt = patch.lastNotifiedAt;
  return next;
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

  // 所有未恢复实例：规则推进用来发现"本批没有新事件"的实例，
  // 否则恢复判定只在有事件的指纹上运行，实例永远不会 RESOLVED。
  async activeIncidents(limit = 200) {
    const rows = (
      await this.db
        .prepare(
          "SELECT * FROM alert_incidents WHERE resolved_at IS NULL ORDER BY last_seen LIMIT ?",
        )
        .bind(limit)
        .all()
    ).results;
    return rows.map((row) => this.rowToIncident(row));
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
  }) {
    return this.db.transaction(async () => {
      const runId = crypto.randomUUID();
      let incidentId = id;
      let revision;
      if (create) {
        incidentId = `inc-${now}-${crypto.randomUUID().slice(0, 8)}`;
        revision = 1;
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
      } else {
        const current = await this.getIncident(id);
        if (!current) throw new Error("告警实例不存在");
        revision = current.revision + 1;
        const result = await this.db
          .prepare(
            "UPDATE alert_incidents SET status = ?, severity = ?, last_seen = ?, ack_until = ?, resolved_at = ?, revision = revision + 1, last_run_id = ?, payload = ? WHERE id = ? AND revision = ?",
          )
          .bind(
            patch?.status ?? current.status,
            patch?.severity ?? current.severity,
            patch?.lastSeen ?? current.lastSeen,
            patch?.ackUntil ?? current.ackUntil,
            patch?.resolvedAt ?? current.resolvedAt,
            runId,
            JSON.stringify(mergedIncidentPayload(current, patch)),
            id,
            current.revision,
          )
          .run();
        if (result.meta.changes !== 1)
          throw new Error("告警实例正在被其他流程更新");
      }
      if (!eventType)
        return { id: incidentId, revision, runId, sequence: null };
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
      return { id: incidentId, revision, runId, sequence, deliveryIds };
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

  // 队列健康：overdue 是"现在就该发却没人领"的项，是分发器停滞的直接证据；
  // 只看 pending 总量会把空闲队列当成健康（分发器已死时队列恰好是空的）。
  async outboxHealth({ now = new Date().toISOString() } = {}) {
    const row = await this.db
      .prepare(
        "SELECT SUM(CASE WHEN status IN ('PENDING','SENDING') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'PENDING' AND next_attempt_at > ? THEN 1 ELSE 0 END) AS scheduled, SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired, SUM(CASE WHEN (status = 'PENDING' AND next_attempt_at <= ?) OR (status = 'SENDING' AND lease_until < ?) THEN 1 ELSE 0 END) AS overdue FROM alert_outbox",
      )
      .bind(now, now, now)
      .first();
    return {
      pending: Number(row?.pending ?? 0),
      scheduled: Number(row?.scheduled ?? 0),
      sent: Number(row?.sent ?? 0),
      expired: Number(row?.expired ?? 0),
      overdue: Number(row?.overdue ?? 0),
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

  // 旧格式游标（按发生时间 {occurredAt, id}）折算为摄取序号：升级后既不重放
  // 历史事件（会误报已恢复的问题），也不把游标丢掉导致漏读。
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
    if (!cursor.id) return null;
    const row = await this.db
      .prepare("SELECT ingest_seq FROM operation_events WHERE id = ?")
      .bind(cursor.id)
      .first();
    return { ingestSeq: Number(row?.ingest_seq ?? 0) };
  }

  async advanceProcessorState({ id = "dispatcher", lastEventCursor, now }) {
    const current = await this.processorState(id);
    const runId = crypto.randomUUID();
    if (!current) {
      await this.db
        .prepare(
          "INSERT INTO alert_processor_state (id, revision, last_event_cursor, last_progress_at, last_run_id) VALUES (?, 1, ?, ?, ?)",
        )
        .bind(id, JSON.stringify(lastEventCursor ?? null), now, runId)
        .run();
      return { revision: 1, runId };
    }
    const result = await this.db
      .prepare(
        "UPDATE alert_processor_state SET revision = revision + 1, last_event_cursor = ?, last_progress_at = ?, last_run_id = ? WHERE id = ? AND revision = ?",
      )
      .bind(
        JSON.stringify(lastEventCursor ?? current.lastEventCursor),
        now,
        runId,
        id,
        current.revision,
      )
      .run();
    if (result.meta.changes !== 1) throw new Error("分发器状态正在被并发更新");
    return { revision: current.revision + 1, runId };
  }
}
