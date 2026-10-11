// 告警存储（§5.2）：事件追加、规则版本、实例 CAS、事件审计、outbox 租约。
// 事件与交易提交共用现有 CAS 守卫；通知供应商网络失败不回滚交易。
import { digestOf } from "../domain/research-lineage.js";

export class AlertRepository {
  constructor(env) {
    this.db = env.DB;
  }

  // ---------- 追加事实（源事件 ID 幂等；rule_type 随事实落库） ----------
  async recordOperationEvent(event) {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO operation_events (id, instance_id, account_id, trade_date, source_sequence, type, rule_type, reason_code, occurred_at, entity_ref, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    const rows =
      cursor === null
        ? (
            await this.db
              .prepare(
                "SELECT occurred_at, id, instance_id, account_id, trade_date, source_sequence, type, rule_type, reason_code, entity_ref, payload FROM operation_events ORDER BY occurred_at, id LIMIT ?",
              )
              .bind(limit)
              .all()
          ).results
        : (
            await this.db
              .prepare(
                "SELECT occurred_at, id, instance_id, account_id, trade_date, source_sequence, type, rule_type, reason_code, entity_ref, payload FROM operation_events WHERE (occurred_at > ?) OR (occurred_at = ? AND id > ?) ORDER BY occurred_at, id LIMIT ?",
              )
              .bind(cursor.occurredAt, cursor.occurredAt, cursor.id, limit)
              .all()
          ).results;
    return rows.map((row) => ({
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
      .prepare(
        "SELECT occurred_at, id FROM operation_events ORDER BY occurred_at DESC, id DESC LIMIT 1",
      )
      .first();
    return row ? { occurredAt: row.occurred_at, id: row.id } : null;
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
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      generation: row.generation,
      status: row.status,
      severity: row.severity,
      ruleType: row.rule_type,
      entityRef: row.payload
        ? (JSON.parse(row.payload).entityRef ?? null)
        : null,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      ackUntil: row.ack_until,
      resolvedAt: row.resolved_at,
      ruleVersion: row.rule_version,
      revision: row.revision,
      notifiedOnce: Boolean(JSON.parse(row.payload).notifiedOnce),
      payload: JSON.parse(row.payload),
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

  // 实例迁移：事件 INSERT 只在本次 UPDATE 生效时写入（runId 锚，§7.2 同构）。
  async transitionIncident({ id = null, create = null, patch = null, now }) {
    const runId = crypto.randomUUID();
    if (create) {
      const incidentId = `inc-${now}-${crypto.randomUUID().slice(0, 8)}`;
      const generation = create.generation ?? 1;
      const payload = JSON.stringify(create.payload ?? {});
      const statements = [
        this.db
          .prepare(
            "INSERT INTO alert_incidents (id, fingerprint, generation, status, severity, rule_type, first_seen, last_seen, ack_until, resolved_at, rule_version, revision, last_run_id, payload) VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, NULL, NULL, ?, 1, ?, ?)",
          )
          .bind(
            incidentId,
            create.fingerprint,
            generation,
            create.severity,
            create.ruleType,
            now,
            now,
            create.ruleVersion,
            runId,
            payload,
          ),
        this.db
          .prepare(
            "INSERT INTO alert_events (incident_id, sequence, type, created_at, payload) VALUES (?, 1, 'OPEN', ?, ?)",
          )
          .bind(incidentId, now, payload),
      ];
      await this.db.batch(statements);
      return { id: incidentId, revision: 1, runId };
    }
    const current = await this.getIncident(id);
    if (!current) throw new Error("告警实例不存在");
    const nextPayload = {
      ...current.payload,
      ...(patch?.payload ?? {}),
      notifiedOnce: patch?.notifiedOnce ?? current.notifiedOnce,
    };
    const result = await this.db
      .prepare(
        "UPDATE alert_incidents SET status = ?, severity = ?, last_seen = ?, ack_until = ?, resolved_at = ?, revision = revision + 1, last_run_id = ?, payload = ? WHERE id = ? AND revision = ?",
      )
      .bind(
        patch.status ?? current.status,
        patch.severity ?? current.severity,
        patch.lastSeen ?? current.lastSeen,
        patch.ackUntil ?? current.ackUntil,
        patch.resolvedAt ?? current.resolvedAt,
        runId,
        JSON.stringify(nextPayload),
        id,
        current.revision,
      )
      .run();
    if (result.meta.changes !== 1)
      throw new Error("告警实例正在被其他流程更新");
    const updated = await this.getIncident(id);
    return { id, revision: updated.revision, runId, incident: updated };
  }

  async appendAlertEvent(incidentId, type, payload, now) {
    const row = await this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS n FROM alert_events WHERE incident_id = ?",
      )
      .bind(incidentId)
      .first();
    const sequence = Number(row?.n ?? 0) + 1;
    await this.db
      .prepare(
        "INSERT INTO alert_events (incident_id, sequence, type, created_at, payload) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(incidentId, sequence, type, now, JSON.stringify(payload ?? {}))
      .run();
    return sequence;
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
  async enqueueDelivery({ incidentId, eventSequence, channelRef, now }) {
    const id = `out-${now}-${crypto.randomUUID().slice(0, 8)}`;
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO alert_outbox (id, incident_id, event_sequence, channel_ref, status, attempt, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)",
      )
      .bind(id, incidentId, eventSequence, channelRef, now, now, now)
      .run();
    return id;
  }

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

  async completeDelivery(id, providerRef, now) {
    await this.db
      .prepare(
        "UPDATE alert_outbox SET status = 'SENT', provider_ref = ?, lease_until = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(providerRef ?? null, now, id)
      .run();
  }

  async retryDelivery({ id, nextAttemptAt, now }) {
    await this.db
      .prepare(
        "UPDATE alert_outbox SET status = 'PENDING', attempt = attempt + 1, next_attempt_at = ?, lease_until = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(nextAttemptAt, now, id)
      .run();
  }

  async expireDelivery(id, now) {
    await this.db
      .prepare(
        "UPDATE alert_outbox SET status = 'EXPIRED', lease_until = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(now, id)
      .run();
  }

  async outboxHealth() {
    const row = await this.db
      .prepare(
        "SELECT SUM(CASE WHEN status IN ('PENDING','SENDING') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'PENDING' AND next_attempt_at > ? THEN 1 ELSE 0 END) AS scheduled, SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN status IN ('EXPIRED') THEN 1 ELSE 0 END) AS expired FROM alert_outbox",
      )
      .bind(new Date().toISOString())
      .first();
    return {
      pending: Number(row?.pending ?? 0),
      scheduled: Number(row?.scheduled ?? 0),
      sent: Number(row?.sent ?? 0),
      expired: Number(row?.expired ?? 0),
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
          lastEventCursor: row.last_event_cursor
            ? JSON.parse(row.last_event_cursor)
            : null,
          lastProgressAt: row.last_progress_at,
          lastRunId: row.last_run_id,
        }
      : null;
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
