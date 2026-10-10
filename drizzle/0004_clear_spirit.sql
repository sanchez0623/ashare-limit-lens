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
UPDATE `strategy_versions` SET `status` = 'LEGACY_VALIDATED' WHERE `status` = 'VALIDATED' AND `id` <> 'baseline-v1'
