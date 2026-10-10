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
        kind: row.kind ?? "ROLLING",
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
    if (!row) {
      const versionCount = await this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM strategy_versions WHERE id <> 'baseline-v1'",
        )
        .first();
      const cutoff = await this.db
        .prepare(
          `SELECT MAX(d) AS cutoff FROM (
        SELECT json_extract(evidence, '$.validationEnd') AS d FROM strategy_versions WHERE id <> 'baseline-v1' AND json_valid(evidence)
        UNION ALL SELECT json_extract(state, '$.lastDate') AS d FROM paper_accounts WHERE json_valid(state)
      )`,
        )
        .first();
      const payload = {
        legacyIncomplete: true,
        backfilledAt: new Date().toISOString(),
        note: "迁移未初始化时的兜底路径；截止线由旧验证窗口终点与账户结算日构成，已知训练日期记为未知",
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
    }
    const registry = this.mapRegistry(row);
    const updated = await this.backfillLegacyVersions(registry);
    return updated ?? registry;
  }
  async backfillLegacyVersions(registry) {
    const rows = (
      await this.db
        .prepare(
          "SELECT id, created_at, evidence FROM strategy_versions WHERE id <> 'baseline-v1' AND json_valid(evidence) AND json_extract(evidence, '$.validationStart') IS NOT NULL AND json_extract(evidence, '$.validationEnd') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM research_test_claims WHERE namespace = ? AND experiment_id = strategy_versions.id)",
        )
        .bind(this.namespace)
        .all()
    ).results;
    if (!rows.length) return null;
    await this.db
      .prepare(
        "UPDATE research_registry SET payload = json_set(payload, '$.legacyBackfillActive', 1) WHERE namespace = ?",
      )
      .bind(this.namespace)
      .run();
    for (const row of rows) {
      const evidence = JSON.parse(row.evidence);
      const days = (
        await this.db
          .prepare(
            "SELECT trade_date FROM paper_market_days WHERE trade_date >= ? AND trade_date <= ? ORDER BY trade_date",
          )
          .bind(evidence.validationStart, evidence.validationEnd)
          .all()
      ).results;
      for (const day of days) {
        const payload = {
          legacy: true,
          parentVersion: evidence.baseVersion ?? null,
          decisionDate: null,
          tradeDate: day.trade_date,
          role: "HISTORICAL_TEST",
          note: "旧流程验证窗口回填；对应训练日期未记录，记为未知",
        };
        await this.db
          .prepare(
            "INSERT OR IGNORE INTO research_test_claims (namespace, outcome_date, experiment_id, role, reserved_at) VALUES (?, ?, ?, 'HISTORICAL_TEST', ?)",
          )
          .bind(this.namespace, day.trade_date, row.id, row.created_at)
          .run();
        await this.db
          .prepare(
            "INSERT OR IGNORE INTO research_sample_uses (namespace, experiment_id, role, outcome_date, sample_key, payload, digest) VALUES (?, ?, 'HISTORICAL_TEST', ?, ?, ?, ?)",
          )
          .bind(
            this.namespace,
            row.id,
            day.trade_date,
            sampleKey({
              namespace: this.namespace,
              experimentId: row.id,
              role: "HISTORICAL_TEST",
              outcomeDate: day.trade_date,
            }),
            JSON.stringify(payload),
            await digestOf(payload),
          )
          .run();
      }
    }
    const legacyEnds = rows
      .map((row) => {
        try {
          return JSON.parse(row.evidence)?.validationEnd ?? null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort();
    const legacyCutoff =
      [registry.legacyCutoff, ...legacyEnds].filter(Boolean).sort().at(-1) ??
      null;
    await this.db
      .prepare(
        "UPDATE research_registry SET payload = ?, legacy_cutoff = ? WHERE namespace = ?",
      )
      .bind(
        JSON.stringify({
          ...registry.payload,
          legacyBackfillActive: 0,
          legacyBackfillDone: true,
          backfilledLegacyVersions: rows.length,
        }),
        legacyCutoff,
        this.namespace,
      )
      .run();
    return {
      ...registry,
      legacyCutoff,
      payload: {
        ...registry.payload,
        legacyBackfillDone: true,
        backfilledLegacyVersions: rows.length,
      },
    };
  }
  mapRegistry(row) {
    return {
      namespace: row.namespace,
      revision: row.revision,
      attemptSequence: row.attempt_sequence,
      legacyCutoff: row.legacy_cutoff,
      selectionCutoff: row.selection_cutoff,
      lastRunId: row.last_run_id,
      bootstrapDone: (row.bootstrap_done ?? 0) === 1,
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
  async assertReservationFreshness(testDates) {
    if (!Array.isArray(testDates) || !testDates.length)
      throw new Error("测试日期清单为空");
    const registry = await this.ensureRegistry();
    for (const date of testDates) {
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
    return registry;
  }
  async assertFreshOutcomeDates(dates) {
    return this.assertReservationFreshness(dates);
  }
  async reserveAttempt({
    policy,
    month,
    parentVersion,
    windowPayload,
    testDates,
    samples,
  }) {
    const attempt = async () => {
      const registry = await this.assertReservationFreshness(testDates);
      const now = new Date().toISOString();
      const nonce = crypto.randomUUID();
      const experimentId = `exp-${crypto.randomUUID()}`;
      const attemptSequence = registry.attemptSequence + 1;
      const reservation = {
        experimentId,
        namespace: this.namespace,
        attemptSequence,
        parentVersion,
        trainingDates: samples
          .filter((sample) => sample.role === "TRAIN")
          .map((sample) => sample.date),
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
          this.db
            .prepare(
              `INSERT INTO research_test_claims (namespace, outcome_date, experiment_id, role, reserved_at) SELECT ?, ?, ?, 'HISTORICAL_TEST', ? WHERE EXISTS (SELECT 1 FROM research_registry WHERE namespace = ? AND revision = ? AND last_run_id = ?)`,
            )
            .bind(this.namespace, date, experimentId, now, ...guardArgs),
        ),
        ...samples.map((sample) =>
          guarded(
            "INSERT INTO research_sample_uses (namespace, experiment_id, role, outcome_date, sample_key, payload, digest) SELECT ?, ?, ?, ?, ?, ?, ?",
            [
              this.namespace,
              experimentId,
              sample.role,
              sample.date,
              sampleKey({
                namespace: this.namespace,
                experimentId,
                role: sample.role,
                outcomeDate: sample.date,
              }),
              JSON.stringify(sample.payload),
              sample.digest,
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
      await this.executeReservation(statements);
      const claimCount = (
        await this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM research_test_claims WHERE experiment_id = ?",
          )
          .bind(experimentId)
          .first()
      ).n;
      if (claimCount !== testDates.length)
        throw new Error(
          "测试日期登记不完整（研究触发器缺失或迁移未完成），预留已终止",
        );
      const after = await this.db
        .prepare(
          "SELECT revision, last_run_id FROM research_registry WHERE namespace = ?",
        )
        .bind(this.namespace)
        .first();
      if (
        after.revision !== registry.revision + 1 ||
        after.last_run_id !== nonce
      )
        return null;
      return { experimentId, reservation, reservationDigest, attemptSequence };
    };
    if (typeof this.db.transaction === "function")
      return this.db.transaction(async () => {
        this.inTransaction = true;
        try {
          return await attempt();
        } finally {
          this.inTransaction = false;
        }
      });
    return attempt();
  }
  async reserveBootstrapAttempt({
    policy,
    month,
    parentVersion,
    windowPayload,
    trainingDates,
    samples,
    datasetId,
    datasetManifestDigest,
  }) {
    const attempt = async () => {
      await this.assertReservationFreshness(trainingDates);
      const registryRow = await this.db
        .prepare(
          "SELECT revision, attempt_sequence, bootstrap_done FROM research_registry WHERE namespace = ?",
        )
        .bind(this.namespace)
        .first();
      if (!registryRow || registryRow.bootstrap_done === 1) return null;
      const now = new Date().toISOString();
      const nonce = crypto.randomUUID();
      const experimentId = `exp-${crypto.randomUUID()}`;
      const attemptSequence = registryRow.attempt_sequence + 1;
      const reservation = {
        experimentId,
        namespace: this.namespace,
        kind: "BOOTSTRAP",
        attemptSequence,
        parentVersion,
        trainingDates,
        testDates: [],
        datasetId,
        datasetManifestDigest,
        policyId: policy.id,
        policyDigest: policy.digest,
        reservedAt: now,
      };
      const reservationDigest = await digestOf(reservation);
      const guardArgs = [this.namespace, registryRow.revision + 1, nonce];
      const guarded = (sql, args) =>
        this.db
          .prepare(
            `${sql} WHERE EXISTS (SELECT 1 FROM research_registry WHERE namespace = ? AND revision = ? AND last_run_id = ?)`,
          )
          .bind(...args, ...guardArgs);
      const event = {
        sequence: 1,
        eventType: "BOOTSTRAP_RESERVED",
        createdAt: now,
        payload: { reservation, reservationDigest },
        previousDigest: null,
      };
      const statements = [
        this.db
          .prepare(
            "UPDATE research_registry SET revision = revision + 1, attempt_sequence = attempt_sequence + 1, bootstrap_done = 1, last_run_id = ? WHERE namespace = ? AND revision = ? AND bootstrap_done = 0",
          )
          .bind(nonce, this.namespace, registryRow.revision),
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
        ...samples.map((sample) =>
          guarded(
            "INSERT INTO research_sample_uses (namespace, experiment_id, role, outcome_date, sample_key, payload, digest) SELECT ?, ?, 'HISTORICAL_TRAIN', ?, ?, ?, ?",
            [
              this.namespace,
              experimentId,
              sample.date,
              sampleKey({
                namespace: this.namespace,
                experimentId,
                role: "HISTORICAL_TRAIN",
                outcomeDate: sample.date,
              }),
              JSON.stringify(sample.payload),
              sample.digest,
            ],
          ),
        ),
        guarded(
          "INSERT INTO research_experiments (id, namespace, parent_version, candidate_version, policy_id, kind, stage, revision, frozen_at, reservation_payload, proposal_manifest, proposal_digest, created_at) SELECT ?, ?, ?, NULL, ?, 'BOOTSTRAP', 'PROPOSING', 0, NULL, ?, NULL, NULL, ?",
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
      await this.executeReservation(statements);
      const trainCount = (
        await this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM research_sample_uses WHERE experiment_id = ?",
          )
          .bind(experimentId)
          .first()
      ).n;
      if (trainCount !== samples.length)
        throw new Error(
          "冷启动训练样本登记不完整（预留守卫未生效），预留已终止",
        );
      const after = await this.db
        .prepare(
          "SELECT revision, last_run_id, bootstrap_done FROM research_registry WHERE namespace = ?",
        )
        .bind(this.namespace)
        .first();
      if (
        after.revision !== registryRow.revision + 1 ||
        after.last_run_id !== nonce ||
        after.bootstrap_done !== 1
      )
        return null;
      return { experimentId, reservation, reservationDigest, attemptSequence };
    };
    if (typeof this.db.transaction === "function")
      return this.db.transaction(async () => {
        this.inTransaction = true;
        try {
          return await attempt();
        } finally {
          this.inTransaction = false;
        }
      });
    return attempt();
  }
  async concludeBootstrap(experimentId, versionId, { report, reason }) {
    const experiment = mapRow(
      await this.db
        .prepare("SELECT * FROM research_experiments WHERE id = ?")
        .bind(experimentId)
        .first(),
    );
    if (!experiment || experiment.stage !== "PROPOSING")
      throw new Error("实验不在提案阶段");
    const stage = "AWAITING_SHADOW";
    const now = new Date().toISOString();
    const reportDigest = await digestOf(report);
    const previous = await this.lastEvent(experimentId);
    const event = {
      sequence: (previous?.sequence ?? 0) + 1,
      eventType: "BOOTSTRAP_SCREENED",
      createdAt: now,
      payload: { reportDigest, reason },
      previousDigest: previous?.digest ?? null,
    };
    const statements = [
      this.db
        .prepare(
          "INSERT OR IGNORE INTO research_reports (experiment_id, stage, payload, digest, created_at) VALUES (?, 'dev_screen', ?, ?, ?)",
        )
        .bind(experimentId, JSON.stringify(report), reportDigest, now),
      this.db
        .prepare(
          "UPDATE research_experiments SET stage = ?, revision = revision + 1 WHERE id = ? AND stage = 'PROPOSING'",
        )
        .bind(stage, experimentId),
      this.db
        .prepare(
          "UPDATE strategy_versions SET status = 'SHADOW_PENDING' WHERE id = ? AND status = 'PROPOSING'",
        )
        .bind(versionId),
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
      this.db
        .prepare(
          "DELETE FROM research_active_slots WHERE namespace = ? AND experiment_id = ? AND EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = ?)",
        )
        .bind(this.namespace, experimentId, experimentId, stage),
    ];
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
  async executeReservation(statements) {
    if (this.inTransaction) {
      for (const statement of statements) await statement.run();
      return;
    }
    await this.db.batch(statements);
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
      testDates,
      parentVersion,
      parentParamsDigest,
      feeConfig,
      feeConfigDigest,
      initialCashCents,
      executionVersion,
      scoringVersion,
    },
    targetStage = "HISTORICAL_CHECK",
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
      testDates,
      parentVersion,
      parentParamsDigest,
      feeConfig,
      feeConfigDigest,
      initialCashCents,
      executionVersion,
      scoringVersion,
      frozenAt: now,
      note: "模型输出、最终参数与执行环境指纹在历史测试前冻结；真实模型版本无法获得时记录为未知",
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
          "UPDATE research_experiments SET candidate_version = ?, frozen_at = ?, stage = ?, revision = revision + 1, proposal_manifest = ?, proposal_digest = ? WHERE id = ? AND stage = 'PROPOSING'",
        )
        .bind(
          versionId,
          now,
          targetStage,
          JSON.stringify(manifest),
          manifestDigest,
          experimentId,
        ),
      this.db
        .prepare(
          "INSERT INTO strategy_versions (id, created_at, status, params, evidence) SELECT ?, ?, 'PROPOSING', ?, ? WHERE EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = ?)",
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
          targetStage,
        ),
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
          targetStage,
        ),
    ]);
    const row = mapRow(
      await this.db
        .prepare("SELECT * FROM research_experiments WHERE id = ?")
        .bind(experimentId)
        .first(),
    );
    if (row?.stage !== targetStage)
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
  async recordError(experimentId, versionId, reason, expectedRevision = null) {
    return this.recordTerminal(experimentId, {
      stage: "ERROR",
      eventType: "ERROR",
      versionId,
      versionStatus: "ERROR",
      reason,
      expectedRevision,
    });
  }
  async recordInvalidated(
    experimentId,
    versionId,
    reason,
    expectedRevision = null,
  ) {
    return this.recordTerminal(experimentId, {
      stage: "INVALIDATED",
      eventType: "INVALIDATED",
      versionId,
      versionStatus: "INVALIDATED",
      reason,
      expectedRevision,
    });
  }
  async recordTerminal(
    experimentId,
    {
      stage,
      eventType,
      versionId,
      versionStatus,
      reason,
      expectedRevision = null,
    },
  ) {
    const experiment = mapRow(
      await this.db
        .prepare("SELECT * FROM research_experiments WHERE id = ?")
        .bind(experimentId)
        .first(),
    );
    if (!experiment) return false;
    if (RESEARCH_TERMINAL_STAGES.has(experiment.stage)) return false;
    const now = new Date().toISOString();
    const previous = await this.lastEvent(experimentId);
    const event = {
      sequence: (previous?.sequence ?? 0) + 1,
      eventType,
      createdAt: now,
      payload: { reason },
      previousDigest: previous?.digest ?? null,
    };
    const revisionGuard =
      expectedRevision === null
        ? "AND stage NOT IN ('REJECTED','ERROR','INCONCLUSIVE','INVALIDATED','PROMOTED')"
        : "AND revision = ?";
    const revisionArgs = expectedRevision === null ? [] : [expectedRevision];
    const adoptedRevision = experiment.revision + 1;
    const adopted =
      expectedRevision === null
        ? `EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = ?)`
        : `EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = ? AND revision = ?)`;
    const adoptedArgs =
      expectedRevision === null
        ? [experimentId, stage]
        : [experimentId, stage, adoptedRevision];
    const adoptedEventArgs =
      expectedRevision === null
        ? [experimentId, stage, experiment.revision + 1]
        : [experimentId, stage, adoptedRevision];
    const statements = [
      this.db
        .prepare(
          `UPDATE research_experiments SET stage = ?, revision = revision + 1 WHERE id = ? ${revisionGuard}`,
        )
        .bind(stage, experimentId, ...revisionArgs),
      this.db
        .prepare(
          "INSERT INTO research_events (experiment_id, sequence, event_type, created_at, payload, previous_digest, digest) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = ? AND revision = ?)",
        )
        .bind(
          experimentId,
          event.sequence,
          event.eventType,
          event.createdAt,
          JSON.stringify(event.payload),
          event.previousDigest,
          await eventDigest(event),
          ...adoptedEventArgs,
        ),
      this.db
        .prepare(
          "DELETE FROM research_active_slots WHERE namespace = ? AND experiment_id = ? AND EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = ? AND revision = ?)",
        )
        .bind(this.namespace, experimentId, ...adoptedEventArgs),
    ];
    if (versionId)
      statements.push(
        this.db
          .prepare(
            "UPDATE strategy_versions SET status = ? WHERE id = ? AND status = 'PROPOSING' AND EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = ? AND revision = ?)",
          )
          .bind(versionStatus, versionId, ...adoptedEventArgs),
      );
    await this.db.batch(statements);
    const after = mapRow(
      await this.db
        .prepare("SELECT * FROM research_experiments WHERE id = ?")
        .bind(experimentId)
        .first(),
    );
    if (after?.stage !== stage)
      throw new Error("终态写入失败：实验状态已被其他流程改变");
    return true;
  }
  async getExperiment(id) {
    return mapRow(
      await this.db
        .prepare("SELECT * FROM research_experiments WHERE id = ?")
        .bind(id)
        .first(),
    );
  }
  async parentParams(versionId) {
    const row = await this.db
      .prepare("SELECT params FROM strategy_versions WHERE id = ?")
      .bind(versionId)
      .first();
    return row ? JSON.parse(row.params) : null;
  }
  async experimentSamples(experimentId) {
    const result = await this.db
      .prepare(
        "SELECT role, outcome_date, payload, digest FROM research_sample_uses WHERE experiment_id = ? ORDER BY outcome_date, role",
      )
      .bind(experimentId)
      .all();
    return result.results.map((row) => ({
      role: row.role,
      outcomeDate: row.outcome_date,
      payload: JSON.parse(row.payload),
      digest: row.digest,
    }));
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
