CREATE TABLE `paper_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`last_run_id` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_equity` (
	`trade_date` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`trade_date` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_paper_ledger_trade_date` ON `paper_ledger` (`trade_date`);--> statement-breakpoint
CREATE TABLE `paper_market_days` (
	`trade_date` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_plans` (
	`signal_date` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_runs` (
	`trade_date` text PRIMARY KEY NOT NULL,
	`updated_at` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `strategy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`status` text NOT NULL,
	`params` text NOT NULL,
	`evidence` text NOT NULL
);
