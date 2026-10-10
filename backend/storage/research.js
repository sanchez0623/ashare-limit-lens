import { database } from "./database.js";
import {
  digestOf,
  eventDigest,
  sampleKey,
} from "../domain/research-lineage.js";
import {
  DEFAULT_RESEARCH_POLICY,
  validateResearchPolicy,
} from "../domain/research-policy.js";
import { RESEARCH_TERMINAL_STAGES } from "../../shared/research-status.js";

export const RESEARCH_NAMESPACE = "main";
const mapRow = (row) =>
  row
    ? {
        id: row.id,
        namespace: row.namespace,
        parentVersion: row.parent_version,
        candidateVersion: row.candidate_version,
        policyId: row.policy_id,
        stage: row.stage,
        revision: row.revision,
        frozenAt: row.frozen_at,
        reservationPayload: JSON.parse(row.reservation_payload || "{}"),
        proposalManifest: row.proposal_manifest
          ? JSON.parse(row.proposal_manifest)
          : null,
        proposalDigest: row.proposal_digest,
        createdAt: row.created_at,
      }
    : null;
export class ResearchRepository {
  constructor(env) {
    this.db = database(env);
    this.namespace = RESEARCH_NAMESPACE;
  }
  async ensureRegistry() {
    let row = await this.db
      .prepare("SELECT * FROM research_registry WHERE namespace = ?")
      .bind(this.namespace)
      .first();
    if (row) return this.mapRegistry(row);
    const versionCount = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM strategy_versions WHERE id <> 'baseline-v1'",
      )
      .first();
    const cutoff = await this.db
      .prepare(
        `SELECT MAX(d) AS cutoff FROM (
        SELECT MAX(trade_date) AS d FROM snapshots
        UNION ALL SELECT MAX(trade_date) FROM paper_market_days
        UNION ALL SELECT MAX(trade_date) FROM reviews
        UNION ALL SELECT MAX(snapshot_date) FROM reviews
      )`,
      )
      .first();
    const payload = {
      legacyIncomplete: true,
      backfilledAt: new Date().toISOString(),
      note: "旧流程未记录逐次尝试与测试日期；以已知数据日期建立保守截止线，尝试次数为已知下界",
    };
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO research_registry (namespace, revision, attempt_sequence, legacy_cutoff, payload) VALUES (?, 0, ?, ?, ?)",
      )
      .bind(
        this.namespace,
        versionCount.n,
        cutoff.cutoff ?? null,
        JSON.stringify(payload),
      )
      .run();
    row = await this.db
      .prepare("SELECT * FROM research_registry WHERE namespace = ?")
      .bind(this.namespace)
      .first();
    return this.mapRegistry(row);
  }
  mapRegistry(row) {
    return {
      namespace: row.namespace,
      revision: row.revision,
      attemptSequence: row.attempt_sequence,
      legacyCutoff: row.legacy_cutoff,
      selectionCutoff: row.selection_cutoff,
      lastRunId: row.last_run_id,
      payload: JSON.parse(row.payload || "{}"),
    };
  }
  async getPolicy() {
    const row = await this.db
      .prepare(
        "SELECT * FROM research_policy_versions ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .first();
    if (row)
      return {
        id: row.id,
        createdAt: row.created_at,
        effectiveAt: row.effective_at,
        payload: validateResearchPolicy(JSON.parse(row.payload)),
        digest: row.digest,
      };
    return this.savePolicy(DEFAULT_RESEARCH_POLICY, "policy-default-v1");
  }
  async savePolicy(input, id = `policy-${crypto.randomUUID()}`) {
    const payload = validateResearchPolicy(input);
    const now = new Date().toISOString();
    const digest = await digestOf(payload);
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO research_policy_versions (id, created_at, effective_at, payload, digest) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(id, now, now, JSON.stringify(payload), digest)
      .run();
    const row = await this.db
      .prepare("SELECT * FROM research_policy_versions WHERE id = ?")
      .bind(id)
      .first();
    return {
      id: row.id,
      createdAt: row.created_at,
      effectiveAt: row.effective_at,
      payload: validateResearchPolicy(JSON.parse(row.payload)),
      digest: row.digest,
    };
  }
  async activeExperiment() {
    const slot = await this.db
      .prepare("SELECT * FROM research_active_slots WHERE namespace = ?")
      .bind(this.namespace)
      .first();
    if (!slot) return null;
    const experiment = mapRow(
      await this.db
        .prepare("SELECT * FROM research_experiments WHERE id = ?")
        .bind(slot.experiment_id)
        .first(),
    );
    return {
      experimentId: slot.experiment_id,
      windowPayload: JSON.parse(slot.window_payload),
      createdAt: slot.created_at,
      experiment,
    };
  }
  async monthUsage(month) {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM research_budget_slots WHERE namespace = ? AND month = ?",
      )
      .bind(this.namespace, month)
      .first();
    return row.n;
  }
  async assertFreshOutcomeDates(dates) {
    if (!Array.isArray(dates) || !dates.length)
      throw new Error("测试日期清单为空");
    const registry = await this.ensureRegistry();
    for (const date of dates) {
      if (registry.legacyCutoff && date <= registry.legacyCutoff)
        throw new Error(
          `日期 ${date} 不晚于迁移前保守截止线 ${registry.legacyCutoff}，不能重新登记为新测试数据`,
        );
      const used = await this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM research_sample_uses WHERE namespace = ? AND outcome_date = ?",
        )
        .bind(this.namespace, date)
        .first();
      if (used.n)
        throw new Error(
          `日期 ${date} 已被历史训练、测试或参数选择占用，不能作为新测试数据`,
        );
      const claimed = await this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM research_test_claims WHERE namespace = ? AND outcome_date = ?",
        )
        .bind(this.namespace, date)
        .first();
      if (claimed.n)
        throw new Error(`日期 ${date} 已作为测试数据一次性登记，不能复用`);
    }
    return { registry, fresh: true };
  }
  async reserveAttempt({
    policy,
    month,
    trainingDates,
    testDates,
    parentVersion,
    windowPayload,
  }) {
    const registry = await this.ensureRegistry();
    const now = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const experimentId = `exp-${crypto.randomUUID()}`;
    const attemptSequence = registry.attemptSequence + 1;
    const reservation = {
      experimentId,
      namespace: this.namespace,
      attemptSequence,
      parentVersion,
      trainingDates,
      testDates,
      policyId: policy.id,
      policyDigest: policy.digest,
      legacyCutoff: registry.legacyCutoff,
      reservedAt: now,
    };
    const reservationDigest = await digestOf(reservation);
    const guardArgs = [this.namespace, registry.revision + 1, nonce];
    const guarded = (sql, args) =>
      this.db
        .prepare(
          `${sql} WHERE EXISTS (SELECT 1 FROM research_registry WHERE namespace = ? AND revision = ? AND last_run_id = ?)`,
        )
        .bind(...args, ...guardArgs);
    const event = {
      sequence: 1,
      eventType: "RESERVED",
      createdAt: now,
      payload: { reservation, reservationDigest },
      previousDigest: null,
    };
    const statements = [
      this.db
        .prepare(
          "UPDATE research_registry SET revision = revision + 1, attempt_sequence = attempt_sequence + 1, last_run_id = ? WHERE namespace = ? AND revision = ?",
        )
        .bind(nonce, this.namespace, registry.revision),
      guarded(
        "INSERT INTO research_active_slots (namespace, experiment_id, window_payload, created_at) SELECT ?, ?, ?, ?",
        [
          this.namespace,
          experimentId,
          JSON.stringify({ ...windowPayload, policyId: policy.id }),
          now,
        ],
      ),
      guarded(
        "INSERT INTO research_budget_slots (namespace, month, slot, experiment_id, created_at) SELECT ?, ?, 1, ?, ?",
        [this.namespace, month, experimentId, now],
      ),
      ...testDates.map((date) =>
        guarded(
          "INSERT INTO research_test_claims (namespace, outcome_date, experiment_id, role, reserved_at) SELECT ?, ?, ?, 'HISTORICAL_TEST', ?",
          [this.namespace, date, experimentId, now],
        ),
      ),
      ...[
        ...trainingDates.map((date) => ({ date, role: "TRAIN" })),
        ...testDates.map((date) => ({ date, role: "HISTORICAL_TEST" })),
      ].map(({ date, role }) =>
        guarded(
          "INSERT INTO research_sample_uses (namespace, experiment_id, role, outcome_date, sample_key, payload, digest) SELECT ?, ?, ?, ?, ?, ?, ?",
          [
            this.namespace,
            experimentId,
            role,
            date,
            sampleKey({
              namespace: this.namespace,
              experimentId,
              role,
              outcomeDate: date,
            }),
            JSON.stringify({ decisionDate: null, tradeDate: date, role }),
            reservationDigest,
          ],
        ),
      ),
      guarded(
        "INSERT INTO research_experiments (id, namespace, parent_version, candidate_version, policy_id, stage, revision, frozen_at, reservation_payload, proposal_manifest, proposal_digest, created_at) SELECT ?, ?, ?, NULL, ?, 'PROPOSING', 0, NULL, ?, NULL, NULL, ?",
        [
          experimentId,
          this.namespace,
          parentVersion,
          policy.id,
          JSON.stringify(reservation),
          now,
        ],
      ),
      guarded(
        "INSERT INTO research_events (experiment_id, sequence, event_type, created_at, payload, previous_digest, digest) SELECT ?, ?, ?, ?, ?, ?, ?",
        [
          experimentId,
          event.sequence,
          event.eventType,
          event.createdAt,
          JSON.stringify(event.payload),
          event.previousDigest,
          await eventDigest(event),
        ],
      ),
    ];
    await this.db.batch(statements);
    const after = await this.db
      .prepare(
        "SELECT revision, last_run_id FROM research_registry WHERE namespace = ?",
      )
      .bind(this.namespace)
      .first();
    if (after.revision !== registry.revision + 1 || after.last_run_id !== nonce)
      return null;
    return { experimentId, reservation, reservationDigest, attemptSequence };
  }
  async lastEvent(experimentId) {
    const row = await this.db
      .prepare(
        "SELECT * FROM research_events WHERE experiment_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .bind(experimentId)
      .first();
    return row
      ? {
          sequence: row.sequence,
          digest: row.digest,
          previousDigest: row.previous_digest,
        }
      : null;
  }
  async appendEvent(experimentId, eventType, payload) {
    const previous = await this.lastEvent(experimentId);
    const now = new Date().toISOString();
    const event = {
      sequence: (previous?.sequence ?? 0) + 1,
      eventType,
      createdAt: now,
      payload,
      previousDigest: previous?.digest ?? null,
    };
    await this.db
      .prepare(
        "INSERT INTO research_events (experiment_id, sequence, event_type, created_at, payload, previous_digest, digest) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        experimentId,
        event.sequence,
        eventType,
        now,
        JSON.stringify(payload),
        event.previousDigest,
        await eventDigest(event),
      )
      .run();
    return event;
  }
  async freezeCandidate(
    experimentId,
    {
      versionId,
      params,
      patch,
      rationale,
      policyId,
      modelAlias,
      modelVersionReported,
      promptDigest,
      output,
      trainingDates,
      parentVersion,
    },
  ) {
    const now = new Date().toISOString();
    const manifest = {
      experimentId,
      versionId,
      candidateParams: params,
      patch,
      rationale,
      policyId,
      modelAlias,
      modelVersionReported,
      promptDigest,
      validatedResponse: output,
      trainingDates,
      parentVersion,
      frozenAt: now,
      note: "模型输出与最终参数在历史测试前冻结；真实模型版本无法获得时记录为未知",
    };
    const manifestDigest = await digestOf(manifest);
    const previous = await this.lastEvent(experimentId);
    const event = {
      sequence: (previous?.sequence ?? 0) + 1,
      eventType: "CANDIDATE_FROZEN",
      createdAt: now,
      payload: { manifestDigest, patch },
      previousDigest: previous?.digest ?? null,
    };
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE research_experiments SET candidate_version = ?, frozen_at = ?, stage = 'HISTORICAL_CHECK', revision = revision + 1, proposal_manifest = ?, proposal_digest = ? WHERE id = ? AND stage = 'PROPOSING'",
        )
        .bind(
          versionId,
          now,
          JSON.stringify(manifest),
          manifestDigest,
          experimentId,
        ),
      this.db
        .prepare(
          "INSERT INTO strategy_versions (id, created_at, status, params, evidence) SELECT ?, ?, 'PROPOSING', ?, ? WHERE EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = 'HISTORICAL_CHECK')",
        )
        .bind(
          versionId,
          now,
          JSON.stringify(params),
          JSON.stringify({
            type: "research-candidate",
            experimentId,
            rationale,
            parentVersion,
          }),
          experimentId,
        ),
      this.db
        .prepare(
          "INSERT INTO research_events (experiment_id, sequence, event_type, created_at, payload, previous_digest, digest) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = 'HISTORICAL_CHECK')",
        )
        .bind(
          experimentId,
          event.sequence,
          event.eventType,
          event.createdAt,
          JSON.stringify(event.payload),
          event.previousDigest,
          await eventDigest(event),
          experimentId,
        ),
    ]);
    const row = mapRow(
      await this.db
        .prepare("SELECT * FROM research_experiments WHERE id = ?")
        .bind(experimentId)
        .first(),
    );
    if (row?.stage !== "HISTORICAL_CHECK")
      throw new Error("候选冻结失败：实验状态已变化");
    return { manifest, manifestDigest };
  }
  async concludeHistorical(
    experimentId,
    versionId,
    { passed, report, reason },
  ) {
    const experiment = mapRow(
      await this.db
        .prepare("SELECT * FROM research_experiments WHERE id = ?")
        .bind(experimentId)
        .first(),
    );
    if (!experiment || experiment.stage !== "HISTORICAL_CHECK")
      throw new Error("实验不在历史筛查阶段");
    const stage = passed ? "AWAITING_SHADOW" : "REJECTED";
    const versionStatus = passed ? "SHADOW_PENDING" : "REJECTED";
    const now = new Date().toISOString();
    const reportDigest = await digestOf(report);
    const previous = await this.lastEvent(experimentId);
    const event = {
      sequence: (previous?.sequence ?? 0) + 1,
      eventType: passed ? "HISTORICAL_PASSED" : "HISTORICAL_REJECTED",
      createdAt: now,
      payload: { reportDigest, reason },
      previousDigest: previous?.digest ?? null,
    };
    const statements = [
      this.db
        .prepare(
          "INSERT OR IGNORE INTO research_reports (experiment_id, stage, payload, digest, created_at) VALUES (?, 'historical', ?, ?, ?)",
        )
        .bind(experimentId, JSON.stringify(report), reportDigest, now),
      this.db
        .prepare(
          "UPDATE research_experiments SET stage = ?, revision = revision + 1 WHERE id = ? AND stage = 'HISTORICAL_CHECK'",
        )
        .bind(stage, experimentId),
      this.db
        .prepare(
          "UPDATE strategy_versions SET status = ? WHERE id = ? AND status = 'PROPOSING'",
        )
        .bind(versionStatus, versionId),
      this.db
        .prepare(
          "INSERT INTO research_events (experiment_id, sequence, event_type, created_at, payload, previous_digest, digest) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = ?)",
        )
        .bind(
          experimentId,
          event.sequence,
          event.eventType,
          event.createdAt,
          JSON.stringify(event.payload),
          event.previousDigest,
          await eventDigest(event),
          experimentId,
          stage,
        ),
    ];
    if (!passed)
      statements.push(
        this.db
          .prepare(
            "DELETE FROM research_active_slots WHERE namespace = ? AND experiment_id = ?",
          )
          .bind(this.namespace, experimentId),
      );
    await this.db.batch(statements);
    const after = mapRow(
      await this.db
        .prepare("SELECT * FROM research_experiments WHERE id = ?")
        .bind(experimentId)
        .first(),
    );
    if (after?.stage !== stage)
      throw new Error("实验状态推进失败：状态已被其他流程改变");
    return { stage, reportDigest };
  }
  async recordError(experimentId, versionId, reason) {
    const experiment = mapRow(
      await this.db
        .prepare("SELECT * FROM research_experiments WHERE id = ?")
        .bind(experimentId)
        .first(),
    );
    if (!experiment) return;
    if (RESEARCH_TERMINAL_STAGES.has(experiment.stage)) return;
    const now = new Date().toISOString();
    const previous = await this.lastEvent(experimentId);
    const event = {
      sequence: (previous?.sequence ?? 0) + 1,
      eventType: "ERROR",
      createdAt: now,
      payload: { reason },
      previousDigest: previous?.digest ?? null,
    };
    const statements = [
      this.db
        .prepare(
          "UPDATE research_experiments SET stage = 'ERROR', revision = revision + 1 WHERE id = ? AND stage NOT IN ('REJECTED','ERROR','INCONCLUSIVE','INVALIDATED','PROMOTED')",
        )
        .bind(experimentId),
      this.db
        .prepare(
          "INSERT INTO research_events (experiment_id, sequence, event_type, created_at, payload, previous_digest, digest) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = 'ERROR')",
        )
        .bind(
          experimentId,
          event.sequence,
          event.eventType,
          event.createdAt,
          JSON.stringify(event.payload),
          event.previousDigest,
          await eventDigest(event),
          experimentId,
        ),
      this.db
        .prepare(
          "DELETE FROM research_active_slots WHERE namespace = ? AND experiment_id = ?",
        )
        .bind(this.namespace, experimentId),
    ];
    if (versionId)
      statements.push(
        this.db
          .prepare(
            "UPDATE strategy_versions SET status = 'ERROR' WHERE id = ? AND status = 'PROPOSING'",
          )
          .bind(versionId),
      );
    await this.db.batch(statements);
  }
  async getExperiment(id) {
    return mapRow(
      await this.db
        .prepare("SELECT * FROM research_experiments WHERE id = ?")
        .bind(id)
        .first(),
    );
  }
  async listExperiments(limit = 20) {
    const result = await this.db
      .prepare(
        "SELECT * FROM research_experiments WHERE namespace = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .bind(this.namespace, limit)
      .all();
    return result.results.map(mapRow);
  }
  async experimentEvents(id) {
    const result = await this.db
      .prepare(
        "SELECT sequence, event_type, created_at, payload, previous_digest, digest FROM research_events WHERE experiment_id = ? ORDER BY sequence",
      )
      .bind(id)
      .all();
    return result.results.map((row) => ({
      sequence: row.sequence,
      eventType: row.event_type,
      createdAt: row.created_at,
      payload: JSON.parse(row.payload),
      previousDigest: row.previous_digest,
      digest: row.digest,
    }));
  }
  async experimentReports(id) {
    const result = await this.db
      .prepare(
        "SELECT stage, payload, digest, created_at FROM research_reports WHERE experiment_id = ?",
      )
      .bind(id)
      .all();
    return result.results.map((row) => ({
      stage: row.stage,
      payload: JSON.parse(row.payload),
      digest: row.digest,
      createdAt: row.created_at,
    }));
  }
}
