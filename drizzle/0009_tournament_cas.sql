-- 赛马状态迁移的执行锚（§7.2）：状态 UPDATE 与事件 INSERT 在同一事务内
-- 通过 last_run_id 绑定，CAS 失败时事件零行写入，不留下孤儿事件。
ALTER TABLE `strategy_cohorts` ADD COLUMN `last_run_id` text;--> statement-breakpoint
ALTER TABLE `research_experiments` ADD COLUMN `last_run_id` text;
