import { database } from "./database.js";
import { digestOf, eventDigest } from "../domain/research-lineage.js";
import { selectionPolicyFields } from "../domain/signal-selection.js";
import { latestPolicyBundle } from "./execution-cost.js";
import { freezeExecutionStress } from "../domain/execution-stress.js";
import { strategySpaceManifest } from "../domain/strategy-catalog.js";
import {
  validateCohortPolicy,
  DEFAULT_COHORT_POLICY,
} from "../domain/cohort-policy.js";
import {
  RESEARCH_TERMINAL_STAGES,
  COHORT_ACTIVE_STAGES,
} from "../../shared/research-status.js";

export const RESEARCH_NAMESPACE = "main";

const mapCohort = (row) =>
  row
    ? {
        id: row.id,
        namespace: row.namespace,
        revision: row.revision,
        parentVersion: row.parent_version,
        policyId: row.policy_id,
        policyDigest: row.policy_digest,
        researchPolicyId: row.research_policy_id,
        researchPolicyDigest: row.research_policy_digest,
        mode: row.mode,
        stage: row.stage,
        maxCandidates: row.max_candidates,
        forwardDays: row.forward_days,
        reservationManifest: JSON.parse(row.reservation_manifest || "{}"),
        proposalManifest: row.proposal_manifest
          ? JSON.parse(row.proposal_manifest)
          : null,
        forwardManifest: row.forward_manifest
          ? JSON.parse(row.forward_manifest)
          : null,
        evaluationManifest: row.evaluation_manifest
          ? JSON.parse(row.evaluation_manifest)
          : null,
        promotionDigest: row.promotion_digest,
        effectiveTradeDate: row.effective_trade_date,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const mapMember = (row) =>
  row
    ? {
        cohortId: row.cohort_id,
        memberId: row.member_id,
        slotIndex: row.slot_index,
        experimentId: row.experiment_id,
        strategyVersion: row.strategy_version,
        k: row.k,
        familyId: row.family_id,
        familyVersion: row.family_version,
        params: row.params ? JSON.parse(row.params) : null,
        paramsDigest: row.params_digest,
        paramsDistance: row.params_distance,
        stage: row.stage,
        failureReason: row.failure_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

export class CohortRepository {
  constructor(env) {
    this.db = database(env);
    this.namespace = RESEARCH_NAMESPACE;
  }

  // ---------- 赛马政策 ----------
  async saveTournamentPolicy(input) {
    const payload = validateCohortPolicy(input);
    const id = `cohort-policy-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const digest = await digestOf(payload);
    await this.db
      .prepare(
        "INSERT INTO tournament_policy_versions (id, created_at, effective_at, payload, digest) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS(SELECT 1 FROM research_window_owners WHERE namespace='main')",
      )
      .bind(id, now, now, JSON.stringify(payload), digest)
      .run();
    if (
      !(await this.db
        .prepare("SELECT id FROM tournament_policy_versions WHERE id=?")
        .bind(id)
        .first())
    )
      throw new Error("活动研究窗口内不能修改赛马政策");
    return { id, payload, digest };
  }
  async getTournamentPolicy() {
    const row = await this.db
      .prepare(
        "SELECT * FROM tournament_policy_versions ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .first();
    if (row)
      return {
        id: row.id,
        payload: JSON.parse(row.payload),
        digest: row.digest,
      };
    const payload = validateCohortPolicy(DEFAULT_COHORT_POLICY);
    const id = "cohort-policy-default-v1";
    const now = new Date().toISOString();
    const digest = await digestOf(payload);
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO tournament_policy_versions (id, created_at, effective_at, payload, digest) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(id, now, now, JSON.stringify(payload), digest)
      .run();
    const saved = await this.db
      .prepare("SELECT * FROM tournament_policy_versions WHERE id = ?")
      .bind(id)
      .first();
    return {
      id: saved.id,
      payload: JSON.parse(saved.payload),
      digest: saved.digest,
    };
  }

  // ---------- 活动窗口所有者（统一锁） ----------
  async windowOwner() {
    const row = await this.db
      .prepare("SELECT * FROM research_window_owners WHERE namespace = ?")
      .bind(this.namespace)
      .first();
    return row
      ? {
          namespace: row.namespace,
          ownerType: row.owner_type,
          ownerId: row.owner_id,
          windowPayload: JSON.parse(row.window_payload || "{}"),
          leaseUntil: row.lease_until,
          createdAt: row.created_at,
        }
      : null;
  }
  async releaseWindowOwner(ownerType, ownerId) {
    await this.db
      .prepare(
        "DELETE FROM research_window_owners WHERE namespace = ? AND owner_type = ? AND owner_id = ?",
      )
      .bind(this.namespace, ownerType, ownerId)
      .run();
  }

  // ---------- 原子批次预留（§9.1） ----------
  // 任一步冲突整批失败：注册表 CAS、窗口锁、生成名额、测试日期、成员实验与首事件一次提交。
  async reserveCohort({
    cohortPolicy,
    researchPolicy,
    month,
    parentVersion,
    windowPayload,
    testDates,
    samples,
    forwardDays,
    cohortPolicyPayload = null,
    statisticsBudget = null,
    feeConfig = null,
    feeConfigDigest = null,
    selectionPolicy,
  }) {
    const memberCount = Number(
      cohortPolicy.payload?.maxCandidates ?? cohortPolicy.maxCandidates,
    );
    const attempt = async () => {
      const registryRow = await this.db
        .prepare(
          "SELECT revision, attempt_sequence FROM research_registry WHERE namespace = ?",
        )
        .bind(this.namespace)
        .first();
      if (!registryRow) throw new Error("研究注册表未初始化，无法预留赛马批次");
      const now = new Date().toISOString();
      const nonce = crypto.randomUUID();
      const cohortId = `cohort-${crypto.randomUUID()}`;
      const baseAttempt = Number(registryRow.attempt_sequence);
      const members = Array.from({ length: memberCount }, (_, index) => ({
        memberId: `m${index + 1}`,
        slotIndex: index + 1,
        experimentId: `exp-${crypto.randomUUID()}`,
        k: baseAttempt + index + 1,
      }));
      const slotRow = await this.db
        .prepare(
          "SELECT COALESCE(MAX(slot), 0) AS max_slot FROM research_generation_slots WHERE namespace = ? AND month = ?",
        )
        .bind(this.namespace, month)
        .first();
      const startSlot = Number(slotRow?.max_slot ?? 0);
      const parentRow = await this.db
        .prepare("SELECT params FROM strategy_versions WHERE id=?")
        .bind(parentVersion)
        .first();
      if (!parentRow) throw new Error("成本压力冻结缺少父策略版本");
      const executionStress = await freezeExecutionStress(
        await latestPolicyBundle(this.db),
        JSON.parse(parentRow.params),
      );
      const reservation = {
        cohortId,
        namespace: this.namespace,
        attemptSequences: members.map((member) => member.k),
        parentVersion,
        trainingDates: samples
          .filter((sample) => sample.role === "TRAIN")
          .map((sample) => sample.date),
        testDates,
        cohortPolicyId: cohortPolicy.id,
        cohortPolicyDigest: cohortPolicy.digest,
        researchPolicyId: researchPolicy.id,
        researchPolicyDigest: researchPolicy.digest,
        forwardDays,
        cohortPolicy: cohortPolicyPayload,
        ...(cohortPolicyPayload?.version === 2
          ? { strategySpace: await strategySpaceManifest() }
          : {}),
        statisticsBudget,
        feeConfig,
        feeConfigDigest,
        executionStress,
        ...(selectionPolicy ? selectionPolicyFields(selectionPolicy) : {}),
        reservedAt: now,
      };
      const reservationDigest = await digestOf(reservation);
      const guardArgs = [
        this.namespace,
        Number(registryRow.revision) + 1,
        nonce,
      ];
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
            "UPDATE research_registry SET revision = revision + 1, attempt_sequence = attempt_sequence + ?, last_run_id = ? WHERE namespace = ? AND revision = ?",
          )
          .bind(memberCount, nonce, this.namespace, registryRow.revision),
        guarded(
          "INSERT INTO research_window_owners (namespace, owner_type, owner_id, window_payload, created_at) SELECT ?, 'COHORT', ?, ?, ?",
          [
            this.namespace,
            cohortId,
            JSON.stringify({
              ...windowPayload,
              cohortPolicyId: cohortPolicy.id,
            }),
            now,
          ],
        ),
        ...members.map((member, index) =>
          guarded(
            "INSERT INTO research_generation_slots (namespace, month, slot, owner_type, owner_id, reserved_at) SELECT ?, ?, ?, 'COHORT', ?, ?",
            [this.namespace, month, startSlot + index + 1, cohortId, now],
          ),
        ),
        ...testDates.map((date) =>
          this.db
            .prepare(
              "INSERT INTO research_test_claims (namespace, outcome_date, experiment_id, role, reserved_at, owner_type, owner_id) SELECT ?, ?, ?, 'HISTORICAL_TEST', ?, 'COHORT', ? WHERE EXISTS (SELECT 1 FROM research_registry WHERE namespace = ? AND revision = ? AND last_run_id = ?)",
            )
            .bind(this.namespace, date, cohortId, now, cohortId, ...guardArgs),
        ),
        ...members.flatMap((member) =>
          samples.map((sample) =>
            guarded(
              "INSERT INTO research_sample_uses (namespace, experiment_id, role, outcome_date, sample_key, payload, digest) SELECT ?, ?, ?, ?, ?, ?, ?",
              [
                this.namespace,
                member.experimentId,
                sample.role,
                sample.date,
                `${this.namespace}:${member.experimentId}:${sample.role}:${sample.date}`,
                JSON.stringify(sample.payload),
                sample.digest,
              ],
            ),
          ),
        ),
        ...members.map((member) =>
          guarded(
            "INSERT INTO research_experiments (id, namespace, parent_version, candidate_version, policy_id, kind, stage, revision, frozen_at, reservation_payload, proposal_manifest, proposal_digest, created_at) SELECT ?, ?, ?, NULL, ?, 'COHORT_MEMBER', 'PROPOSING', 0, NULL, ?, NULL, NULL, ?",
            [
              member.experimentId,
              this.namespace,
              parentVersion,
              cohortPolicy.id,
              JSON.stringify({
                ...reservation,
                memberId: member.memberId,
                k: member.k,
              }),
              now,
            ],
          ),
        ),
        guarded(
          "INSERT INTO strategy_cohorts (id, namespace, revision, parent_version, policy_id, policy_digest, research_policy_id, research_policy_digest, mode, stage, max_candidates, forward_days, reservation_manifest, created_at, updated_at) SELECT ?, ?, 0, ?, ?, ?, ?, ?, 'TOURNAMENT', 'PROPOSING', ?, ?, ?, ?, ?",
          [
            cohortId,
            this.namespace,
            parentVersion,
            cohortPolicy.id,
            cohortPolicy.digest,
            researchPolicy.id,
            researchPolicy.digest,
            memberCount,
            forwardDays,
            JSON.stringify({ ...reservation, reservationDigest }),
            now,
            now,
          ],
        ),
        ...members.map((member) =>
          guarded(
            "INSERT INTO strategy_cohort_members (cohort_id, member_id, slot_index, experiment_id, k, stage, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 'PROPOSING', ?, ?",
            [
              cohortId,
              member.memberId,
              member.slotIndex,
              member.experimentId,
              member.k,
              now,
              now,
            ],
          ),
        ),
        guarded(
          "INSERT INTO cohort_events (cohort_id, sequence, event_type, created_at, payload, previous_digest, digest) SELECT ?, ?, ?, ?, ?, ?, ?",
          [
            cohortId,
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
            "SELECT COUNT(*) AS n FROM research_test_claims WHERE owner_type = 'COHORT' AND owner_id = ?",
          )
          .bind(cohortId)
          .first()
      ).n;
      if (claimCount !== testDates.length)
        throw new Error(
          "测试日期登记不完整（研究触发器缺失或迁移未完成），预留已终止",
        );
      const memberCountCheck = (
        await this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM strategy_cohort_members WHERE cohort_id = ?",
          )
          .bind(cohortId)
          .first()
      ).n;
      if (memberCountCheck !== memberCount) return null;
      const after = await this.db
        .prepare(
          "SELECT revision, last_run_id, attempt_sequence FROM research_registry WHERE namespace = ?",
        )
        .bind(this.namespace)
        .first();
      if (
        Number(after.revision) !== Number(registryRow.revision) + 1 ||
        after.last_run_id !== nonce
      )
        return null;
      return { cohortId, members, reservation, reservationDigest };
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
  async executeReservation(statements) {
    if (this.inTransaction) {
      for (const statement of statements) await statement.run();
      return;
    }
    await this.db.batch(statements);
  }

  // ---------- 批次与成员读写 ----------
  async getCohort(id) {
    return mapCohort(
      await this.db
        .prepare("SELECT * FROM strategy_cohorts WHERE id = ?")
        .bind(id)
        .first(),
    );
  }
  async listCohorts({ limit = 20, offset = 0 } = {}) {
    const rows = (
      await this.db
        .prepare(
          "SELECT id FROM strategy_cohorts ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
        )
        .bind(limit, offset)
        .all()
    ).results;
    const cohorts = [];
    for (const row of rows) cohorts.push(await this.getCohort(row.id));
    const total = (
      await this.db
        .prepare("SELECT COUNT(*) AS n FROM strategy_cohorts")
        .first()
    ).n;
    return { cohorts, total };
  }
  async activeCohort() {
    const rows = (
      await this.db
        .prepare("SELECT id FROM strategy_cohorts ORDER BY created_at DESC")
        .all()
    ).results;
    for (const row of rows) {
      const cohort = await this.getCohort(row.id);
      if (cohort && COHORT_ACTIVE_STAGES.has(cohort.stage)) return cohort;
    }
    return null;
  }
  async members(cohortId) {
    const rows = (
      await this.db
        .prepare(
          "SELECT * FROM strategy_cohort_members WHERE cohort_id = ? ORDER BY slot_index",
        )
        .bind(cohortId)
        .all()
    ).results;
    return rows.map((row) => mapMember(row));
  }
  async member(cohortId, memberId) {
    return mapMember(
      await this.db
        .prepare(
          "SELECT * FROM strategy_cohort_members WHERE cohort_id = ? AND member_id = ?",
        )
        .bind(cohortId, memberId)
        .first(),
    );
  }
  async memberByExperiment(experimentId) {
    return mapMember(
      await this.db
        .prepare(
          "SELECT * FROM strategy_cohort_members WHERE experiment_id = ?",
        )
        .bind(experimentId)
        .first(),
    );
  }

  // ---------- 批次状态迁移（revision CAS + 事件链原子追加） ----------
  async transitionCohort(id, { from, to, eventType, payload = {}, set = {} }) {
    const cohort = await this.getCohort(id);
    if (!cohort) throw new Error("赛马批次不存在");
    if (cohort.stage !== from)
      throw new Error(
        `批次状态已变化（${cohort.stage}），不能从 ${from} 迁移到 ${to}`,
      );
    const now = new Date().toISOString();
    const previous = await this.lastEvent(id);
    const event = {
      sequence: (previous?.sequence ?? 0) + 1,
      eventType,
      createdAt: now,
      payload: { from, to, ...payload },
      previousDigest: previous?.digest ?? null,
    };
    const setKeys = Object.keys(set);
    const setSql = setKeys.length
      ? `, ${setKeys.map((key) => `${key} = ?`).join(", ")}`
      : "";
    const setArgs = setKeys.map((key) =>
      typeof set[key] === "string" || set[key] === null
        ? set[key]
        : JSON.stringify(set[key]),
    );
    const expectedRevision = cohort.revision;
    // runId 锚（§7.2）：事件 INSERT 只在**本次** UPDATE 生效时写入。
    // 仅靠 revision+1 守卫不够——并发者把 revision 推进到 expected+1 时
    // 误通过，会留下"状态未迁移、事件已提交"的孤儿事件。
    const runId = crypto.randomUUID();
    const statements = [
      this.db
        .prepare(
          `UPDATE strategy_cohorts SET stage = ?, revision = revision + 1, last_run_id = ?, updated_at = ?${setSql} WHERE id = ? AND stage = ? AND revision = ?`,
        )
        .bind(to, runId, now, ...setArgs, id, from, expectedRevision),
      this.db
        .prepare(
          "INSERT INTO cohort_events (cohort_id, sequence, event_type, created_at, payload, previous_digest, digest) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM strategy_cohorts WHERE id = ? AND revision = ? AND last_run_id = ?)",
        )
        .bind(
          id,
          event.sequence,
          event.eventType,
          event.createdAt,
          JSON.stringify(event.payload),
          event.previousDigest,
          await eventDigest(event),
          id,
          expectedRevision + 1,
          runId,
        ),
    ];
    const results = await this.db.batch(statements);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1)
      throw new Error(
        `批次状态迁移冲突：预期 revision ${expectedRevision} 已被其他流程改变`,
      );
    const after = await this.getCohort(id);
    if (after.stage !== to)
      throw new Error("批次状态写入失败：状态已被其他流程改变");
    return after;
  }
  async appendEvent(cohortId, event) {
    await this.db
      .prepare(
        "INSERT INTO cohort_events (cohort_id, sequence, event_type, created_at, payload, previous_digest, digest) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        cohortId,
        event.sequence,
        event.eventType,
        event.createdAt,
        JSON.stringify(event.payload),
        event.previousDigest,
        await eventDigest(event),
      )
      .run();
    return event;
  }
  async updateMember(cohortId, memberId, set) {
    const keys = Object.keys(set);
    const now = new Date().toISOString();
    if (keys.length) {
      const args = keys.map((key) => {
        const value = set[key];
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "number"
        )
          return value;
        return JSON.stringify(value);
      });
      await this.db
        .prepare(
          `UPDATE strategy_cohort_members SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE cohort_id = ? AND member_id = ?`,
        )
        .bind(...args, now, cohortId, memberId)
        .run();
    } else {
      await this.db
        .prepare(
          "UPDATE strategy_cohort_members SET updated_at = ? WHERE cohort_id = ? AND member_id = ?",
        )
        .bind(now, cohortId, memberId)
        .run();
    }
    return this.member(cohortId, memberId);
  }
  async lastEvent(cohortId) {
    const row = await this.db
      .prepare(
        "SELECT * FROM cohort_events WHERE cohort_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .bind(cohortId)
      .first();
    return row
      ? {
          sequence: row.sequence,
          eventType: row.event_type,
          createdAt: row.created_at,
          payload: JSON.parse(row.payload),
          previousDigest: row.previous_digest,
          digest: row.digest,
        }
      : null;
  }
  async events(cohortId) {
    const rows = (
      await this.db
        .prepare(
          "SELECT * FROM cohort_events WHERE cohort_id = ? ORDER BY sequence",
        )
        .bind(cohortId)
        .all()
    ).results;
    return rows.map((row) => ({
      sequence: row.sequence,
      eventType: row.event_type,
      createdAt: row.created_at,
      payload: JSON.parse(row.payload),
      previousDigest: row.previous_digest,
      digest: row.digest,
    }));
  }

  // ---------- 成员状态迁移（同步成员实验状态 + 研究事件） ----------
  async transitionMember(
    cohortId,
    memberId,
    {
      from,
      to,
      versionStatus = null,
      versionId = null,
      failureReason = null,
      set = {},
    },
  ) {
    const cohort = await this.getCohort(cohortId);
    const member = await this.member(cohortId, memberId);
    if (!cohort || !member) throw new Error("赛马成员不存在");
    if (member.stage !== from)
      throw new Error(
        `成员状态已变化（${member.stage}），不能从 ${from} 迁移到 ${to}`,
      );
    const now = new Date().toISOString();
    const setKeys = Object.keys(set);
    const setSql = setKeys.length
      ? `, ${setKeys.map((key) => `${key} = ?`).join(", ")}`
      : "";
    const setArgs = setKeys.map((key) =>
      typeof set[key] === "string" ||
      set[key] === null ||
      typeof set[key] === "number"
        ? set[key]
        : JSON.stringify(set[key]),
    );
    const experiment = await this.db
      .prepare("SELECT revision FROM research_experiments WHERE id = ?")
      .bind(member.experimentId)
      .first();
    const nextRevision = Number(experiment?.revision ?? 0) + 1;
    const previous = await this.lastEvent(cohortId);
    const nextCohortSequence = (previous?.sequence ?? 0) + 1;
    const experimentEvent = {
      sequence: 0,
      eventType: `MEMBER_${to}`,
      createdAt: now,
      payload: { memberId, from, to, failureReason },
      previousDigest: null,
    };
    const experimentEvents = (
      await this.db
        .prepare(
          "SELECT sequence, digest FROM research_events WHERE experiment_id = ? ORDER BY sequence DESC LIMIT 1",
        )
        .bind(member.experimentId)
        .all()
    ).results;
    const lastExperimentEvent = experimentEvents[0];
    experimentEvent.sequence = (lastExperimentEvent?.sequence ?? 0) + 1;
    experimentEvent.previousDigest = lastExperimentEvent?.digest ?? null;
    const cohortEvent = {
      sequence: nextCohortSequence,
      eventType: `MEMBER_${to}`,
      createdAt: now,
      payload: { memberId, from, to, failureReason },
      previousDigest: previous?.digest ?? null,
    };
    const expectedRevision = Number(experiment?.revision ?? 0);
    // runId 锚（§7.2）：实验 UPDATE 与两条事件在同一事务内通过
    // last_run_id 绑定，读后变交错（并发者已推进到相同 revision）时
    // 事件零行写入，不会留下孤儿事件或断裂的事件链。
    const runId = crypto.randomUUID();
    const statements = [
      this.db
        .prepare(
          "UPDATE research_experiments SET stage = ?, revision = revision + 1, last_run_id = ? WHERE id = ? AND stage = ? AND revision = ?",
        )
        .bind(to, runId, member.experimentId, from, expectedRevision),
      this.db
        .prepare(
          `UPDATE strategy_cohort_members SET stage = ?, failure_reason = ?, updated_at = ?${setSql} WHERE cohort_id = ? AND member_id = ? AND stage = ? AND EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND revision = ? AND last_run_id = ?)`,
        )
        .bind(
          to,
          failureReason,
          now,
          ...setArgs,
          cohortId,
          memberId,
          from,
          member.experimentId,
          nextRevision,
          runId,
        ),
      this.db
        .prepare(
          "INSERT INTO research_events (experiment_id, sequence, event_type, created_at, payload, previous_digest, digest) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND revision = ? AND last_run_id = ?)",
        )
        .bind(
          member.experimentId,
          experimentEvent.sequence,
          experimentEvent.eventType,
          experimentEvent.createdAt,
          JSON.stringify(experimentEvent.payload),
          experimentEvent.previousDigest,
          await eventDigest(experimentEvent),
          member.experimentId,
          nextRevision,
          runId,
        ),
      this.db
        .prepare(
          "INSERT INTO cohort_events (cohort_id, sequence, event_type, created_at, payload, previous_digest, digest) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND revision = ? AND last_run_id = ?)",
        )
        .bind(
          cohortId,
          cohortEvent.sequence,
          cohortEvent.eventType,
          cohortEvent.createdAt,
          JSON.stringify(cohortEvent.payload),
          cohortEvent.previousDigest,
          await eventDigest(cohortEvent),
          member.experimentId,
          nextRevision,
          runId,
        ),
    ];
    if (versionId && versionStatus)
      statements.push(
        this.db
          .prepare(
            "UPDATE strategy_versions SET status = ? WHERE id = ? AND EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = ? AND revision = ? AND last_run_id = ?)",
          )
          .bind(
            versionStatus,
            versionId,
            member.experimentId,
            to,
            nextRevision,
            runId,
          ),
      );
    const results = await this.db.batch(statements);
    if (
      results[0].meta.changes !== 1 ||
      results[1].meta.changes !== 1 ||
      results[2].meta.changes !== 1 ||
      results[3].meta.changes !== 1
    )
      throw new Error(
        `成员状态迁移冲突：实验 revision ${expectedRevision} 已被其他流程改变`,
      );
    const after = await this.member(cohortId, memberId);
    if (after.stage !== to)
      throw new Error("成员状态写入失败：状态已被其他流程改变");
    return after;
  }

  // ---------- 冻结成员参数（复用实验冻结清单） ----------
  async freezeMemberExperiment(experimentId, manifest) {
    const manifestDigest = await digestOf(manifest);
    const now = new Date().toISOString();
    const lastEventRow = (
      await this.db
        .prepare(
          "SELECT sequence, digest FROM research_events WHERE experiment_id = ? ORDER BY sequence DESC LIMIT 1",
        )
        .bind(experimentId)
        .all()
    ).results[0];
    const frozenEvent = {
      sequence: (lastEventRow?.sequence ?? 0) + 1,
      eventType: "CANDIDATE_FROZEN",
      createdAt: now,
      payload: { manifestDigest, memberId: manifest.memberId },
      previousDigest: lastEventRow?.digest ?? null,
    };
    // runId 锚（§7.2）：成员、版本与事件写入都绑定本次实验 UPDATE 生效。
    const runId = crypto.randomUUID();
    const statements = [
      this.db
        .prepare(
          "UPDATE research_experiments SET stage = 'HISTORICAL_CHECK', revision = revision + 1, last_run_id = ?, frozen_at = ?, proposal_manifest = ?, proposal_digest = ? WHERE id = ? AND stage = 'PROPOSING'",
        )
        .bind(
          runId,
          now,
          JSON.stringify(manifest),
          manifestDigest,
          experimentId,
        ),
      this.db
        .prepare(
          "UPDATE strategy_cohort_members SET stage = 'HISTORICAL_CHECK', updated_at = ? WHERE experiment_id = ? AND stage = 'PROPOSING' AND EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = 'HISTORICAL_CHECK' AND last_run_id = ?)",
        )
        .bind(now, experimentId, experimentId, runId),
      this.db
        .prepare(
          "INSERT INTO strategy_versions (id, created_at, status, params, evidence) SELECT ?, ?, 'PROPOSING', ?, ? WHERE EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = 'HISTORICAL_CHECK' AND last_run_id = ?)",
        )
        .bind(
          manifest.versionId,
          now,
          JSON.stringify(manifest.candidateParams),
          JSON.stringify({
            cohortId: manifest.cohortId,
            ...(manifest.selectionPolicy
              ? selectionPolicyFields(manifest.selectionPolicy)
              : {}),
            memberId: manifest.memberId,
            attemptSequence: manifest.attemptSequence,
            parentVersion: manifest.parentVersion,
            trainingStart: manifest.trainingDates?.[0] ?? null,
            trainingEnd: manifest.trainingDates?.at(-1) ?? null,
            validationStart: manifest.testDates?.[0] ?? null,
            validationEnd: manifest.testDates?.at(-1) ?? null,
          }),
          experimentId,
          runId,
        ),
      this.db
        .prepare(
          "INSERT INTO research_events (experiment_id, sequence, event_type, created_at, payload, previous_digest, digest) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM research_experiments WHERE id = ? AND stage = 'HISTORICAL_CHECK' AND last_run_id = ?)",
        )
        .bind(
          experimentId,
          frozenEvent.sequence,
          frozenEvent.eventType,
          frozenEvent.createdAt,
          JSON.stringify(frozenEvent.payload),
          frozenEvent.previousDigest,
          await eventDigest(frozenEvent),
          experimentId,
          runId,
        ),
    ];
    const results = await this.db.batch(statements);
    if (results[0].meta.changes !== 1)
      throw new Error("成员候选冻结失败：实验状态已被其他流程改变");
    return { manifestDigest };
  }
  // ---------- 测试日期与样本用途 ----------
  async claimCohortForwardDate(date, cohortId) {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO research_test_claims (namespace, outcome_date, experiment_id, role, reserved_at, owner_type, owner_id) VALUES (?, ?, ?, 'FORWARD_TEST', ?, 'COHORT', ?)",
      )
      .bind(this.namespace, date, cohortId, now, cohortId)
      .run();
    const row = await this.db
      .prepare(
        "SELECT owner_type, owner_id FROM research_test_claims WHERE namespace = ? AND outcome_date = ?",
      )
      .bind(this.namespace, date)
      .first();
    if (!row || row.owner_type !== "COHORT" || row.owner_id !== cohortId)
      throw new Error(`前瞻日期 ${date} 已被其他研究占用，批次无资格继续`);
    return true;
  }
  async recordMemberSampleUse({ experimentId, sample }) {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO research_sample_uses (namespace, experiment_id, role, outcome_date, sample_key, payload, digest) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        this.namespace,
        experimentId,
        sample.role,
        sample.date,
        `${this.namespace}:${experimentId}:${sample.role}:${sample.date}`,
        JSON.stringify(sample.payload),
        sample.digest,
      )
      .run();
  }

  // ---------- 批次报告 ----------
  async saveReport(cohortId, stage, payload) {
    const digest = await digestOf(payload);
    const existing = await this.report(cohortId, stage);
    if (existing) {
      if (existing.digest !== digest)
        throw new Error("批次报告已存在且内容不一致，不允许覆盖");
      return existing;
    }
    await this.db
      .prepare(
        "INSERT INTO cohort_reports (cohort_id, stage, payload, digest, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        cohortId,
        stage,
        JSON.stringify(payload),
        digest,
        new Date().toISOString(),
      )
      .run();
    return { payload, digest };
  }
  async report(cohortId, stage) {
    const row = await this.db
      .prepare(
        "SELECT payload, digest, created_at FROM cohort_reports WHERE cohort_id = ? AND stage = ?",
      )
      .bind(cohortId, stage)
      .first();
    return row
      ? {
          payload: JSON.parse(row.payload),
          digest: row.digest,
          createdAt: row.created_at,
        }
      : null;
  }

  // ---------- 研究任务（租约 + 幂等） ----------
  async createTask({ ownerId, taskType, inputDigest, payload }) {
    const id = `task-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT INTO research_tasks (id, owner_id, task_type, input_digest, stage, payload, created_at, updated_at) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)",
      )
      .bind(
        id,
        ownerId,
        taskType,
        inputDigest,
        JSON.stringify(payload ?? {}),
        now,
        now,
      )
      .run();
    return id;
  }
  async leaseTask(taskId, { leaseOwner, leaseMs = 120000 }) {
    const now = Date.now();
    const leaseUntil = new Date(now + leaseMs).toISOString();
    const result = await this.db
      .prepare(
        "UPDATE research_tasks SET stage = 'RUNNING', lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ? AND (stage = 'PENDING' OR (stage = 'RUNNING' AND lease_until IS NOT NULL AND lease_until <= ?))",
      )
      .bind(
        leaseOwner,
        leaseUntil,
        new Date().toISOString(),
        taskId,
        new Date(now).toISOString(),
      )
      .run();
    return result.meta.changes === 1;
  }
  async completeTask(taskId, { outputDigest, cursor = null }) {
    await this.db
      .prepare(
        "UPDATE research_tasks SET stage = 'DONE', output_digest = ?, cursor = COALESCE(?, cursor), updated_at = ? WHERE id = ?",
      )
      .bind(outputDigest, cursor, new Date().toISOString(), taskId)
      .run();
  }
  async failTask(taskId, reason) {
    await this.db
      .prepare(
        "UPDATE research_tasks SET stage = 'ERROR', payload = json_set(payload, '$.lastError', ?), lease_until = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(String(reason).slice(0, 500), new Date().toISOString(), taskId)
      .run();
  }
  async task(taskId) {
    const row = await this.db
      .prepare("SELECT * FROM research_tasks WHERE id = ?")
      .bind(taskId)
      .first();
    return row
      ? {
          id: row.id,
          ownerId: row.owner_id,
          taskType: row.task_type,
          inputDigest: row.input_digest,
          stage: row.stage,
          leaseUntil: row.lease_until,
          leaseOwner: row.lease_owner,
          cursor: row.cursor,
          outputDigest: row.output_digest,
          payload: JSON.parse(row.payload || "{}"),
        }
      : null;
  }
  async tasksForOwner(ownerId, taskType) {
    const rows = (
      await this.db
        .prepare(
          "SELECT id FROM research_tasks WHERE owner_id = ? AND task_type = ? ORDER BY created_at",
        )
        .bind(ownerId, taskType)
        .all()
    ).results;
    const tasks = [];
    for (const row of rows) tasks.push(await this.task(row.id));
    return tasks;
  }
}
