-- 原历史数据集 manifest 固定评分日期与评分摘要；旧样本行无需重写。
CREATE TABLE research_training_sources (
  experiment_id text PRIMARY KEY NOT NULL,
  payload text NOT NULL,
  digest text NOT NULL,
  created_at text NOT NULL
);--> statement-breakpoint
CREATE TRIGGER research_training_source_immutable_update BEFORE UPDATE ON research_training_sources
BEGIN SELECT RAISE(ABORT, '冷启动训练来源不可修改'); END;--> statement-breakpoint
CREATE TRIGGER research_training_source_immutable_delete BEFORE DELETE ON research_training_sources
BEGIN SELECT RAISE(ABORT, '冷启动训练来源不可删除'); END;
