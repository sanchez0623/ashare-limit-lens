-- 统计证据（docs/design/statistical-evidence.md §8.2）：政策版本、每日指标、
-- 不可变报告与输入 manifest。同输入/政策/方法唯一发布；输入修订生成
-- 新报告 id，原证据不覆写。
CREATE TABLE `evidence_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	`effective_from` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_policies_version_idx` ON `evidence_policies` (`version`);
--> statement-breakpoint
CREATE TABLE `evidence_daily_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`series_id` text NOT NULL,
	`outcome_date` text NOT NULL,
	`context_digest` text NOT NULL,
	`source_digest` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evidence_daily_metrics_series_idx` ON `evidence_daily_metrics` (`series_id`,`outcome_date`);
--> statement-breakpoint
CREATE TABLE `evidence_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`series_id` text NOT NULL,
	`as_of` text NOT NULL,
	`horizon` integer NOT NULL,
	`purpose` text NOT NULL,
	`input_digest` text NOT NULL,
	`policy_digest` text NOT NULL,
	`method_version` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_reports_unique` ON `evidence_reports` (`series_id`,`as_of`,`horizon`,`purpose`,`input_digest`,`policy_digest`,`method_version`);
--> statement-breakpoint
CREATE INDEX `evidence_reports_series_idx` ON `evidence_reports` (`series_id`,`as_of`);
--> statement-breakpoint
CREATE TABLE `evidence_report_inputs` (
	`report_id` text PRIMARY KEY NOT NULL,
	`ordered_dates` text NOT NULL,
	`source_refs` text NOT NULL,
	`source_digests` text NOT NULL,
	`manifest_digest` text NOT NULL
);
