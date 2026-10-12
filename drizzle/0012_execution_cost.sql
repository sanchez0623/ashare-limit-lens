-- 执行成本政策与压力重放（docs/design/opening-execution-cost.md §5.4）：
-- 政策版本追加不可变；校准报告与输入摘要分离；敏感性运行落在独立研究
-- namespace，不写主账户，也不占用正式前瞻窗口。
CREATE TABLE `execution_cost_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`model_version` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	`calibration_status` text NOT NULL DEFAULT 'PRIOR_UNCALIBRATED',
	`calibration_cutoff` text,
	`effective_from` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_cost_policies_model_version` ON `execution_cost_policies` (`model_version`,`version`);
--> statement-breakpoint
CREATE TABLE `execution_cost_calibrations` (
	`id` text PRIMARY KEY NOT NULL,
	`input_digest` text NOT NULL,
	`cutoff` text NOT NULL,
	`report` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `execution_sensitivity_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`manifest` text NOT NULL,
	`status` text NOT NULL,
	`result_digest` text,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `execution_sensitivity_runs_created_idx` ON `execution_sensitivity_runs` (`created_at`);
