-- 前瞻晋级和人工回退与主账户 CAS 一起提交，供重试和独立审计读取。
CREATE TABLE strategy_switch_events (
  id text PRIMARY KEY NOT NULL,
  cohort_id text NOT NULL,
  experiment_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('PROMOTE', 'ROLLBACK')),
  from_version text NOT NULL,
  to_version text NOT NULL,
  account_revision integer NOT NULL,
  payload text NOT NULL,
  digest text NOT NULL,
  created_at text NOT NULL,
  UNIQUE(cohort_id, event_type)
);--> statement-breakpoint
CREATE TRIGGER strategy_switch_immutable_update BEFORE UPDATE ON strategy_switch_events
BEGIN SELECT RAISE(ABORT, '策略切换事件不可修改'); END;--> statement-breakpoint
CREATE TRIGGER strategy_switch_immutable_delete BEFORE DELETE ON strategy_switch_events
BEGIN SELECT RAISE(ABORT, '策略切换事件不可删除'); END;
