ALTER TABLE `research_registry` ADD COLUMN `bootstrap_done` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `research_experiments` ADD COLUMN `kind` text NOT NULL DEFAULT 'ROLLING';--> statement-breakpoint
UPDATE `research_registry` SET `payload` = json_set(`payload`, '$.bootstrapNote', 'AI 冷启动一次性初始化：消费预算与序号，训练日期登记为 HISTORICAL_TRAIN，候选直接进入前瞻影子队列') WHERE `namespace` = 'main' AND json_valid(`payload`);
