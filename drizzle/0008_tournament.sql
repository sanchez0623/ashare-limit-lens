-- 多策略赛马（multi-strategy-tournament）第 1 批迁移：
-- 统一活动窗口与生成预算、行情帧、影子账户体系、cohort 编排与研究任务。
-- 旧 research_active_slots / research_budget_slots 停止写入，由本迁移搬入统一表；
-- 旧表保留只读，兼容适配器改为读取新表。

-- 统一活动窗口所有者：单候选实验与赛马批次共用唯一活动窗口锁（namespace 主键）。
CREATE TABLE `research_window_owners` (
	`namespace` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`window_payload` text NOT NULL,
	`lease_until` text,
	`last_run_id` text,
	`created_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `research_window_owners` (`namespace`, `owner_type`, `owner_id`, `window_payload`, `created_at`)
SELECT `namespace`, 'EXPERIMENT', `experiment_id`, `window_payload`, `created_at`
FROM `research_active_slots`;--> statement-breakpoint

-- 统一生成批次预算：人工与 AI、单候选与 cohort 共用同一月份名额池。
CREATE TABLE `research_generation_slots` (
	`namespace` text NOT NULL,
	`month` text NOT NULL,
	`slot` integer NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`reserved_at` text NOT NULL,
	PRIMARY KEY(`namespace`, `month`, `slot`)
);--> statement-breakpoint
INSERT INTO `research_generation_slots` (`namespace`, `month`, `slot`, `owner_type`, `owner_id`, `reserved_at`)
SELECT `namespace`, `month`, `slot`, 'EXPERIMENT', `experiment_id`, `created_at`
FROM `research_budget_slots`;--> statement-breakpoint

-- 测试日期占用者扩展：单候选属于一个实验，赛马属于一个冻结 cohort。
ALTER TABLE `research_test_claims` ADD COLUMN `owner_type` text;--> statement-breakpoint
ALTER TABLE `research_test_claims` ADD COLUMN `owner_id` text;--> statement-breakpoint
UPDATE `research_test_claims` SET `owner_type` = 'EXPERIMENT', `owner_id` = `experiment_id`
WHERE `owner_type` IS NULL;--> statement-breakpoint

-- 联合行情帧：一次采集、多账本独立消费；帧按 (trade_date, sequence) 不可变落盘。
CREATE TABLE `quote_frames` (
	`trade_date` text NOT NULL,
	`sequence` integer NOT NULL,
	`observed_at` text NOT NULL,
	`pool_digest` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`trade_date`, `sequence`)
);--> statement-breakpoint
CREATE INDEX `idx_quote_frames_date` ON `quote_frames` (`trade_date`, `created_at`);--> statement-breakpoint

-- 影子账户体系：所有账本、会话、计划、成交、净值均含 account_id；主账户 CAS 形态与 paper_accounts 一致。
CREATE TABLE `shadow_accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`cohort_id` text,
	`member_id` text,
	`status` text NOT NULL DEFAULT 'ACTIVE',
	`revision` integer NOT NULL DEFAULT 0,
	`state` text NOT NULL,
	`cursor_date` text,
	`cursor_sequence` integer NOT NULL DEFAULT 0,
	`last_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_shadow_accounts_cohort` ON `shadow_accounts` (`cohort_id`);--> statement-breakpoint
CREATE TABLE `shadow_sessions` (
	`account_id` text NOT NULL,
	`trade_date` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`account_id`, `trade_date`)
);--> statement-breakpoint
CREATE TABLE `shadow_ledger` (
	`account_id` text NOT NULL,
	`id` text NOT NULL,
	`trade_date` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`account_id`, `id`)
);--> statement-breakpoint
CREATE INDEX `idx_shadow_ledger_day` ON `shadow_ledger` (`account_id`, `trade_date`);--> statement-breakpoint
CREATE TABLE `shadow_equity` (
	`account_id` text NOT NULL,
	`trade_date` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`account_id`, `trade_date`)
);--> statement-breakpoint
CREATE TABLE `shadow_plans` (
	`account_id` text NOT NULL,
	`signal_date` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `signal_date`)
);--> statement-breakpoint

-- 赛马批次：冻结清单、三个阶段清单与报告引用；批次状态与成员状态分开。
CREATE TABLE `strategy_cohorts` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`revision` integer NOT NULL DEFAULT 0,
	`parent_version` text NOT NULL,
	`policy_id` text NOT NULL,
	`policy_digest` text NOT NULL,
	`research_policy_id` text NOT NULL,
	`research_policy_digest` text NOT NULL,
	`mode` text NOT NULL DEFAULT 'TOURNAMENT',
	`stage` text NOT NULL,
	`max_candidates` integer NOT NULL,
	`forward_days` integer NOT NULL,
	`reservation_manifest` text NOT NULL,
	`proposal_manifest` text,
	`forward_manifest` text,
	`evaluation_manifest` text,
	`promotion_digest` text,
	`effective_trade_date` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_strategy_cohorts_ns` ON `strategy_cohorts` (`namespace`, `created_at`);--> statement-breakpoint
CREATE TABLE `strategy_cohort_members` (
	`cohort_id` text NOT NULL,
	`member_id` text NOT NULL,
	`slot_index` integer NOT NULL,
	`experiment_id` text NOT NULL,
	`strategy_version` text,
	`k` integer NOT NULL,
	`family_id` text NOT NULL DEFAULT 'limit-momentum-v1',
	`family_version` integer NOT NULL DEFAULT 1,
	`params` text,
	`params_digest` text,
	`params_distance` real,
	`stage` text NOT NULL,
	`failure_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`cohort_id`, `member_id`)
);--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_cohort_members_experiment_id_unique` ON `strategy_cohort_members` (`experiment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_cohort_members_k_unique` ON `strategy_cohort_members` (`k`);--> statement-breakpoint
CREATE TABLE `cohort_events` (
	`cohort_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	`previous_digest` text,
	`digest` text NOT NULL,
	PRIMARY KEY(`cohort_id`, `sequence`)
);--> statement-breakpoint
CREATE TABLE `cohort_reports` (
	`cohort_id` text NOT NULL,
	`stage` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`cohort_id`, `stage`)
);--> statement-breakpoint

-- 赛马政策版本：仅允许所有者在无活动研究窗口时保存。
CREATE TABLE `tournament_policy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`effective_at` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL
);--> statement-breakpoint

-- 研究任务：租约、检查点与幂等结果（统计分片、恢复）。
CREATE TABLE `research_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`task_type` text NOT NULL,
	`input_digest` text NOT NULL,
	`stage` text NOT NULL,
	`lease_until` text,
	`lease_owner` text,
	`cursor` integer NOT NULL DEFAULT 0,
	`output_digest` text,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_research_tasks_owner` ON `research_tasks` (`owner_id`, `task_type`, `stage`);
