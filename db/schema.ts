import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
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
