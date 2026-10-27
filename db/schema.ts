import { sql } from "drizzle-orm";
export * from "./market-environment";
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
export const snapshots = sqliteTable("snapshots", {
  tradeDate: text("trade_date").primaryKey(),
  createdAt: text("created_at").notNull(),
  payload: text("payload").notNull(),
});
export const reviews = sqliteTable("reviews", {
  tradeDate: text("trade_date").primaryKey(),
  snapshotDate: text("snapshot_date").notNull(),
  createdAt: text("created_at").notNull(),
  payload: text("payload").notNull(),
  aiPayload: text("ai_payload"),
});
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const dataUpdateJobs = sqliteTable(
  "data_update_jobs",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    status: text("status").notNull(),
    stage: text("stage").notNull().default("等待执行"),
    progress: text("progress").notNull().default("{}"),
    results: text("results").notNull().default("{}"),
    error: text("error"),
    cancelRequested: integer("cancel_requested").notNull().default(0),
    workerId: text("worker_id"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    uniqueIndex("idx_data_update_active")
      .on(sql`(1)`)
      .where(sql`${table.status} IN ('QUEUED','RUNNING')`),
    index("idx_data_update_history").on(
      sql`${table.createdAt} DESC`,
      sql`${table.id} DESC`,
    ),
  ],
);
export const metadataSnapshots = sqliteTable("metadata_snapshots", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  state: text("state").notNull().default("STAGED"),
  fetchedAt: text("fetched_at").notNull(),
  digest: text("digest").notNull(),
  stats: text("stats").notNull(),
});
export const metadataRecords = sqliteTable(
  "metadata_records",
  {
    snapshotId: text("snapshot_id").notNull(),
    code: text("code").notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.code] })],
);
export const metadataCurrent = sqliteTable("metadata_current", {
  kind: text("kind").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
});
export const dataUpdateWorker = sqliteTable("data_update_worker", {
  singleton: integer("singleton").primaryKey(),
  owner: text("owner"),
  heartbeatAt: text("heartbeat_at").notNull(),
});

export const paperAccounts = sqliteTable("paper_accounts", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull().default(0),
  state: text("state").notNull(),
  lastRunId: text("last_run_id"),
  updatedAt: text("updated_at").notNull(),
});
export const paperTradingArchives = sqliteTable("paper_trading_archives", {
  id: text("id").primaryKey(),
  tradeDate: text("trade_date").notNull().unique(),
  createdAt: text("created_at").notNull(),
  summary: text("summary").notNull(),
  digest: text("digest").notNull(),
});
export const paperTradingArchiveChunks = sqliteTable(
  "paper_trading_archive_chunks",
  {
    archiveId: text("archive_id").notNull(),
    tableName: text("table_name").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.archiveId, table.tableName, table.chunkIndex],
    }),
  ],
);
export const paperPlans = sqliteTable("paper_plans", {
  signalDate: text("signal_date").primaryKey(),
  createdAt: text("created_at").notNull(),
  payload: text("payload").notNull(),
  digest: text("digest").notNull(),
});
export const paperEquity = sqliteTable("paper_equity", {
  tradeDate: text("trade_date").primaryKey(),
  payload: text("payload").notNull(),
});
export const paperLedger = sqliteTable(
  "paper_ledger",
  {
    id: text("id").primaryKey(),
    tradeDate: text("trade_date").notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [
    index("idx_paper_ledger_trade_date").on(table.tradeDate),
    index("idx_paper_ledger_page").on(
      sql`${table.tradeDate} DESC`,
      sql`COALESCE(CAST(json_extract(${table.payload}, '$.sequence') AS INTEGER), 0) DESC`,
      sql`${table.id} DESC`,
    ),
  ],
);
export const paperMarketDays = sqliteTable("paper_market_days", {
  tradeDate: text("trade_date").primaryKey(),
  payload: text("payload").notNull(),
  digest: text("digest").notNull(),
});
export const strategyVersions = sqliteTable("strategy_versions", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  status: text("status").notNull(),
  params: text("params").notNull(),
  evidence: text("evidence").notNull(),
});
export const paperRuns = sqliteTable("paper_runs", {
  tradeDate: text("trade_date").primaryKey(),
  updatedAt: text("updated_at").notNull(),
  status: text("status").notNull(),
  payload: text("payload").notNull(),
});
export const paperConfigurationHistory = sqliteTable(
  "paper_configuration_history",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
  },
);
export const paperPlanRevisions = sqliteTable("paper_plan_revisions", {
  id: text("id").primaryKey(),
  signalDate: text("signal_date").notNull(),
  createdAt: text("created_at").notNull(),
  payload: text("payload").notNull(),
  digest: text("digest").notNull(),
});
export const paperLiveSessions = sqliteTable("paper_live_sessions", {
  tradeDate: text("trade_date").primaryKey(),
  payload: text("payload").notNull(),
  digest: text("digest").notNull(),
});
export const paperLiveTicks = sqliteTable(
  "paper_live_ticks",
  {
    tradeDate: text("trade_date").notNull(),
    sequence: integer("sequence").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tradeDate, table.sequence] })],
);
export const paperExecutorHealth = sqliteTable("paper_executor_health", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
});
export const researchPolicyVersions = sqliteTable("research_policy_versions", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  effectiveAt: text("effective_at").notNull(),
  payload: text("payload").notNull(),
  digest: text("digest").notNull(),
});
export const researchRegistry = sqliteTable("research_registry", {
  namespace: text("namespace").primaryKey(),
  revision: integer("revision").notNull().default(0),
  attemptSequence: integer("attempt_sequence").notNull().default(0),
  legacyCutoff: text("legacy_cutoff"),
  selectionCutoff: text("selection_cutoff"),
  lastRunId: text("last_run_id"),
  payload: text("payload").notNull().default("{}"),
});
export const researchExperiments = sqliteTable(
  "research_experiments",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    parentVersion: text("parent_version").notNull(),
    candidateVersion: text("candidate_version"),
    policyId: text("policy_id").notNull(),
    stage: text("stage").notNull(),
    revision: integer("revision").notNull().default(0),
    frozenAt: text("frozen_at"),
    reservationPayload: text("reservation_payload").notNull(),
    proposalManifest: text("proposal_manifest"),
    proposalDigest: text("proposal_digest"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_research_experiments_ns").on(table.namespace, table.createdAt),
  ],
);
export const researchBudgetSlots = sqliteTable(
  "research_budget_slots",
  {
    namespace: text("namespace").notNull(),
    month: text("month").notNull(),
    slot: integer("slot").notNull(),
    experimentId: text("experiment_id").notNull().unique(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.month, table.slot] }),
  ],
);
export const researchActiveSlots = sqliteTable("research_active_slots", {
  namespace: text("namespace").primaryKey(),
  experimentId: text("experiment_id").notNull().unique(),
  windowPayload: text("window_payload").notNull(),
  createdAt: text("created_at").notNull(),
});
export const researchSampleUses = sqliteTable(
  "research_sample_uses",
  {
    namespace: text("namespace").notNull(),
    experimentId: text("experiment_id").notNull(),
    role: text("role").notNull(),
    outcomeDate: text("outcome_date").notNull(),
    sampleKey: text("sample_key").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [
    uniqueIndex("idx_research_sample_unique").on(
      table.namespace,
      table.experimentId,
      table.role,
      table.outcomeDate,
    ),
    index("idx_research_sample_date").on(
      table.namespace,
      table.outcomeDate,
      table.role,
    ),
  ],
);
export const researchTestClaims = sqliteTable(
  "research_test_claims",
  {
    namespace: text("namespace").notNull(),
    outcomeDate: text("outcome_date").notNull(),
    experimentId: text("experiment_id").notNull(),
    role: text("role").notNull(),
    reservedAt: text("reserved_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.namespace, table.outcomeDate] })],
);
export const researchEvents = sqliteTable(
  "research_events",
  {
    experimentId: text("experiment_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    createdAt: text("created_at").notNull(),
    payload: text("payload").notNull(),
    previousDigest: text("previous_digest"),
    digest: text("digest").notNull(),
  },
  (table) => [primaryKey({ columns: [table.experimentId, table.sequence] })],
);
export const researchReports = sqliteTable(
  "research_reports",
  {
    experimentId: text("experiment_id").notNull(),
    stage: text("stage").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.experimentId, table.stage] })],
);
export const historyImportJobs = sqliteTable("history_import_jobs", {
  id: text("id").primaryKey(),
  namespace: text("namespace").notNull(),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),
  requestedStart: text("requested_start").notNull(),
  requestedEnd: text("requested_end").notNull(),
  name: text("name"),
  stage: text("stage").notNull(),
  progress: text("progress").notNull().default("{}"),
  statusPayload: text("status_payload").notNull().default("{}"),
  datasetId: text("dataset_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const executionStressReports = sqliteTable(
  "execution_stress_reports",
  {
    id: text("id").primaryKey(),
    cohortId: text("cohort_id").notNull(),
    inputDigest: text("input_digest").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("execution_stress_cohort_input").on(
      table.cohortId,
      table.inputDigest,
    ),
  ],
);

export const executionCalibrationInputs = sqliteTable(
  "execution_calibration_inputs",
  {
    id: text("id").primaryKey(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
    rawDigest: text("raw_digest").notNull().unique(),
    sampleDigest: text("sample_digest"),
    createdAt: text("created_at").notNull(),
  },
);

export const executionStressPaths = sqliteTable(
  "execution_stress_paths",
  {
    inputDigest: text("input_digest").notNull(),
    multiplier: real("multiplier").notNull(),
    strategyId: text("strategy_id").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.inputDigest, table.multiplier, table.strategyId],
    }),
  ],
);

export const executionCostPolicies = sqliteTable(
  "execution_cost_policies",
  {
    id: text("id").primaryKey(),
    version: integer("version").notNull(),
    modelVersion: text("model_version").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
    calibrationStatus: text("calibration_status")
      .notNull()
      .default("PRIOR_UNCALIBRATED"),
    calibrationCutoff: text("calibration_cutoff"),
    effectiveFrom: text("effective_from"),
    calibrationId: text("calibration_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("execution_cost_policies_model_version").on(
      table.modelVersion,
      table.version,
    ),
  ],
);

export const executionCostCalibrations = sqliteTable(
  "execution_cost_calibrations",
  {
    id: text("id").primaryKey(),
    inputDigest: text("input_digest").notNull(),
    cutoff: text("cutoff").notNull(),
    report: text("report").notNull(),
    digest: text("digest").notNull(),
    createdAt: text("created_at").notNull(),
  },
);

export const executionCalibrationSampleSets = sqliteTable(
  "execution_calibration_sample_sets",
  {
    sampleDigest: text("sample_digest").primaryKey(),
    inputId: text("input_id").notNull(),
  },
);
export const executionCalibrationSampleOwners = sqliteTable(
  "execution_calibration_sample_owners",
  {
    sampleIdentity: text("sample_identity").primaryKey(),
    inputId: text("input_id").notNull(),
  },
);
export const executionCalibrationDateUses = sqliteTable(
  "execution_calibration_date_uses",
  {
    inputId: text("input_id").notNull(),
    outcomeDate: text("outcome_date").notNull(),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.inputId, table.outcomeDate] }),
    index("execution_calibration_date_idx").on(table.outcomeDate),
  ],
);

export const strategySignalSnapshots = sqliteTable(
  "strategy_signal_snapshots",
  {
    digest: text("digest").primaryKey(),
    signalDate: text("signal_date").notNull(),
    payload: text("payload").notNull(),
  },
);

export const dragonConfigVersions = sqliteTable("dragon_config_versions", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
  digest: text("digest").notNull(),
  engineBuild: text("engine_build").notNull(),
  baseId: text("base_id"),
  createdAt: text("created_at").notNull(),
  origin: text("origin").notNull().default("LEGACY"),
  validationMode: text("validation_mode")
    .notNull()
    .default("RESEARCH_REQUIRED"),
  replacesId: text("replaces_id"),
  provenanceDigest: text("provenance_digest"),
});

export const dragonPatternBatches = sqliteTable("dragon_pattern_batches", {
  id: text("id").primaryKey(),
  stage: text("stage").notNull(),
  manifest: text("manifest").notNull(),
  manifestDigest: text("manifest_digest").notNull(),
  report: text("report"),
  reportDigest: text("report_digest"),
  revision: integer("revision").notNull().default(0),
  comparisonEnd: integer("comparison_end").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  leaseOwner: text("lease_owner"),
  leaseUntil: text("lease_until"),
});
export const practiceWeeklyReports = sqliteTable("practice_weekly_reports", {
  weekEnd: text("week_end").primaryKey(),
  payload: text("payload").notNull(),
  digest: text("digest").notNull(),
  status: text("status").notNull(),
  attempt: integer("attempt").notNull().default(0),
  nextAttemptAt: text("next_attempt_at"),
  leaseOwner: text("lease_owner"),
  leaseUntil: text("lease_until"),
  providerRef: text("provider_ref"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const observationScoreInvalidations = sqliteTable(
  "observation_score_invalidations",
  {
    tradeDate: text("trade_date").primaryKey(),
    reason: text("reason").notNull(),
  },
);

export const observationScorePolicies = sqliteTable(
  "observation_score_policies",
  {
    version: text("version").primaryKey(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
    publishedAt: text("published_at").notNull(),
  },
);
export const observationScoreCursors = sqliteTable(
  "observation_score_cursors",
  {
    tradeDate: text("trade_date").notNull(),
    version: text("version").notNull(),
    sequence: integer("sequence").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tradeDate, table.version] })],
);
export const observationScoreLatest = sqliteTable(
  "observation_score_latest",
  {
    tradeDate: text("trade_date").notNull(),
    code: text("code").notNull(),
    version: text("version").notNull(),
    sequence: integer("sequence").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tradeDate, table.code, table.version] }),
  ],
);
export const observationScoreSnapshots = sqliteTable(
  "observation_score_snapshots",
  {
    id: text("id").primaryKey(),
    tradeDate: text("trade_date").notNull(),
    code: text("code").notNull(),
    buyPoint: text("buy_point").notNull(),
    kind: text("kind").notNull(),
    cycleId: text("cycle_id"),
    version: text("version").notNull(),
    sequence: integer("sequence").notNull(),
    observedAt: text("observed_at").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [
    index("observation_score_snapshot_cycle").on(table.cycleId, table.kind),
  ],
);
export const observationScoreCalibrations = sqliteTable(
  "observation_score_calibrations",
  {
    id: text("id").primaryKey(),
    asOf: text("as_of").notNull(),
    version: text("version").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
    createdAt: text("created_at").notNull(),
  },
);

export const industryRepairArchives = sqliteTable("industry_repair_archives", {
  id: text("id").primaryKey(),
  tradeDate: text("trade_date").notNull(),
  createdAt: text("created_at").notNull(),
  summary: text("summary").notNull(),
  digest: text("digest").notNull(),
});
export const paperManualExitRequests = sqliteTable(
  "paper_manual_exit_requests",
  {
    id: text("id").primaryKey(),
    cycleId: text("cycle_id").notNull(),
    positionId: text("position_id").notNull(),
    tradeDate: text("trade_date").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("paper_manual_exit_position").on(
      table.cycleId,
      table.positionId,
      table.tradeDate,
    ),
  ],
);
export const paperTradeNotifications = sqliteTable(
  "paper_trade_notifications",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    cycleId: text("cycle_id").notNull(),
    sourceRef: text("source_ref").notNull(),
    tradeDate: text("trade_date").notNull(),
    part: integer("part").notNull().default(0),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
    status: text("status").notNull().default("PENDING"),
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseUntil: text("lease_until"),
    providerRef: text("provider_ref"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("paper_trade_notification_source").on(
      table.kind,
      table.cycleId,
      table.sourceRef,
      table.part,
    ),
    index("paper_trade_notification_pending").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);
export const industryRepairArchiveChunks = sqliteTable(
  "industry_repair_archive_chunks",
  {
    archiveId: text("archive_id")
      .notNull()
      .references(() => industryRepairArchives.id),
    tableName: text("table_name").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.archiveId, table.tableName, table.chunkIndex],
    }),
  ],
);
