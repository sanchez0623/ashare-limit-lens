CREATE TABLE `research_active_slots` (
	`namespace` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`window_payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_active_slots_experiment_id_unique` ON `research_active_slots` (`experiment_id`);--> statement-breakpoint
CREATE TABLE `research_budget_slots` (
	`namespace` text NOT NULL,
	`month` text NOT NULL,
	`slot` integer NOT NULL,
	`experiment_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`namespace`, `month`, `slot`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_budget_slots_experiment_id_unique` ON `research_budget_slots` (`experiment_id`);--> statement-breakpoint
CREATE TABLE `research_events` (
	`experiment_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	`previous_digest` text,
	`digest` text NOT NULL,
	PRIMARY KEY(`experiment_id`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `research_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`parent_version` text NOT NULL,
	`candidate_version` text,
	`policy_id` text NOT NULL,
	`stage` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`frozen_at` text,
	`reservation_payload` text NOT NULL,
	`proposal_manifest` text,
	`proposal_digest` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_research_experiments_ns` ON `research_experiments` (`namespace`,`created_at`);--> statement-breakpoint
CREATE TABLE `research_policy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`effective_at` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `research_registry` (
	`namespace` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`attempt_sequence` integer DEFAULT 0 NOT NULL,
	`legacy_cutoff` text,
	`selection_cutoff` text,
	`last_run_id` text,
	`payload` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `research_reports` (
	`experiment_id` text NOT NULL,
	`stage` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`experiment_id`, `stage`)
);
--> statement-breakpoint
CREATE TABLE `research_sample_uses` (
	`namespace` text NOT NULL,
	`experiment_id` text NOT NULL,
	`role` text NOT NULL,
	`outcome_date` text NOT NULL,
	`sample_key` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_research_sample_unique` ON `research_sample_uses` (`namespace`,`experiment_id`,`role`,`outcome_date`);--> statement-breakpoint
CREATE INDEX `idx_research_sample_date` ON `research_sample_uses` (`namespace`,`outcome_date`,`role`);--> statement-breakpoint
CREATE TABLE `research_test_claims` (
	`namespace` text NOT NULL,
	`outcome_date` text NOT NULL,
	`experiment_id` text NOT NULL,
	`role` text NOT NULL,
	`reserved_at` text NOT NULL,
	PRIMARY KEY(`namespace`, `outcome_date`)
);--> statement-breakpoint
UPDATE `strategy_versions` SET `status` = 'LEGACY_VALIDATED' WHERE `status` = 'VALIDATED' AND `id` <> 'baseline-v1';--> statement-breakpoint
INSERT INTO `research_registry` (`namespace`, `revision`, `attempt_sequence`, `legacy_cutoff`, `selection_cutoff`, `payload`)
SELECT
  'main',
  0,
  (SELECT COUNT(*) FROM `strategy_versions` WHERE `id` <> 'baseline-v1'),
  (
    SELECT MAX(d) FROM (
      SELECT MAX(`trade_date`) AS d FROM `snapshots`
      UNION ALL SELECT MAX(`trade_date`) FROM `paper_market_days`
      UNION ALL SELECT MAX(`trade_date`) FROM `reviews`
      UNION ALL SELECT MAX(`snapshot_date`) FROM `reviews`
      UNION ALL SELECT MAX(`trade_date`) FROM `paper_runs`
      UNION ALL SELECT MAX(substr(`created_at`, 1, 10)) FROM `strategy_versions`
      UNION ALL SELECT MAX(json_extract(`evidence`, '$.validationEnd')) FROM `strategy_versions` WHERE json_valid(`evidence`)
    )
  ),
  NULL,
  '{"legacyIncomplete":true,"backfill":"migration","note":"旧流程未记录逐次尝试；截止线在迁移时由已知数据日期、旧验证窗口终点与结算日固定；训练日期未记录记为未知"}'
WHERE NOT EXISTS (SELECT 1 FROM `research_registry` WHERE `namespace` = 'main')
