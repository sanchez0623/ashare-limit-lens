-- 运维告警（§5.2）：追加事实、不可变规则版本、告警实例 CAS、实例事件审计、
-- 有界重试发送队列与分发器游标。heartbeat 仍只保留最新状态，历史事实入事件表。
CREATE TABLE `operation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`account_id` text NOT NULL,
	`trade_date` text,
	`source_sequence` integer,
	`type` text NOT NULL,
	`rule_type` text,
	`reason_code` text,
	`occurred_at` text NOT NULL,
	`entity_ref` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `operation_events_occurred_idx` ON `operation_events` (`occurred_at`);
--> statement-breakpoint
CREATE TABLE `alert_rule_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alert_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`generation` integer NOT NULL DEFAULT 1,
	`status` text NOT NULL,
	`severity` text NOT NULL,
	`rule_type` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	`ack_until` text,
	`resolved_at` text,
	`rule_version` text NOT NULL,
	`revision` integer NOT NULL DEFAULT 0,
	`last_run_id` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_incidents_active_fp` ON `alert_incidents` (`fingerprint`) WHERE `resolved_at` IS NULL;
--> statement-breakpoint
CREATE TABLE `alert_events` (
	`incident_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY (`incident_id`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `alert_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`event_sequence` integer NOT NULL,
	`channel_ref` text NOT NULL,
	`status` text NOT NULL DEFAULT 'PENDING',
	`attempt` integer NOT NULL DEFAULT 0,
	`next_attempt_at` text NOT NULL,
	`lease_until` text,
	`lease_owner` text,
	`provider_ref` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	UNIQUE (`incident_id`, `event_sequence`, `channel_ref`)
);
--> statement-breakpoint
CREATE TABLE `alert_processor_state` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL DEFAULT 0,
	`last_event_cursor` text,
	`last_progress_at` text,
	`last_run_id` text
);
