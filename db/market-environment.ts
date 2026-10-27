import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const marketEnvironmentPolicies = sqliteTable(
  "market_environment_policies",
  {
    version: text("version").primaryKey(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
    publishedAt: text("published_at").notNull(),
  },
);
export const marketEnvironmentSnapshots = sqliteTable(
  "market_environment_snapshots",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    cycleId: text("cycle_id").notNull(),
    tradeDate: text("trade_date").notNull(),
    sequence: integer("sequence").notNull(),
    asOf: text("as_of").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
  },
  (t) => [index("market_environment_at").on(t.scope, t.tradeDate, t.asOf)],
);
export const marketEnvironmentOpportunities = sqliteTable(
  "market_environment_opportunities",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    cycleId: text("cycle_id").notNull(),
    tradeDate: text("trade_date").notNull(),
    code: text("code").notNull(),
    buyPoint: text("buy_point"),
    kind: text("kind").notNull(),
    asOf: text("as_of").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
  },
  (t) => [
    index("market_environment_opportunity_date").on(
      t.cycleId,
      t.tradeDate,
      t.scope,
    ),
  ],
);
export const marketEnvironmentTrials = sqliteTable(
  "market_environment_trials",
  {
    id: text("id").primaryKey(),
    cycleId: text("cycle_id").notNull(),
    manifest: text("manifest").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseUntil: text("lease_until"),
  },
  (t) => [
    uniqueIndex("market_environment_active_trial")
      .on(t.cycleId)
      .where(sql`${t.status}='ACTIVE'`),
  ],
);
export const marketEnvironmentReports = sqliteTable(
  "market_environment_reports",
  {
    id: text("id").primaryKey(),
    trialId: text("trial_id").notNull(),
    asOf: text("as_of").notNull(),
    payload: text("payload").notNull(),
    digest: text("digest").notNull(),
    createdAt: text("created_at").notNull(),
  },
);
