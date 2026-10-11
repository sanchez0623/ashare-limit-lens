-- 运维告警游标修正（§5.2）：按"摄取顺序"而非"发生时间"推进。
-- 事件的发生时间来自各执行器时钟，晚入库的迟到事件（occurred_at 早于已消费
-- 游标）用发生时间做游标会被永久漏读；新增单调递增的 ingest_seq 作为唯一游标，
-- 与 VACUUM 无关（rowid 会被 VACUUM 重排，不能当持久游标）。
ALTER TABLE `operation_events` ADD COLUMN `ingest_seq` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `operation_events` SET `ingest_seq` = `rowid`;
--> statement-breakpoint
CREATE INDEX `operation_events_ingest_idx` ON `operation_events` (`ingest_seq`);
