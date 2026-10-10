import {
  sqliteTable,
  text,
  integer,
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

export const paperAccounts = sqliteTable("paper_accounts", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull().default(0),
  state: text("state").notNull(),
  lastRunId: text("last_run_id"),
  updatedAt: text("updated_at").notNull(),
});
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
  (table) => [index("idx_paper_ledger_trade_date").on(table.tradeDate)],
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
