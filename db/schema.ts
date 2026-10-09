import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const snapshots = sqliteTable('snapshots', {
  tradeDate: text('trade_date').primaryKey(),
  createdAt: text('created_at').notNull(),
  payload: text('payload').notNull(),
});
export const reviews = sqliteTable('reviews', {
  tradeDate: text('trade_date').primaryKey(),
  snapshotDate: text('snapshot_date').notNull(),
  createdAt: text('created_at').notNull(),
  payload: text('payload').notNull(),
  aiPayload: text('ai_payload'),
});
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
