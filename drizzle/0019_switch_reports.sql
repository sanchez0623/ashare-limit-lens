-- 事件引用的报告独立冻结，与主账户 CAS 和切换事件在同一批提交。
CREATE TABLE strategy_switch_reports (
  digest text PRIMARY KEY NOT NULL,
  cohort_id text NOT NULL,
  payload text NOT NULL,
  created_at text NOT NULL
);--> statement-breakpoint
CREATE TRIGGER strategy_switch_report_immutable_update BEFORE UPDATE ON strategy_switch_reports
BEGIN SELECT RAISE(ABORT, '策略切换报告不可修改'); END;--> statement-breakpoint
CREATE TRIGGER strategy_switch_report_immutable_delete BEFORE DELETE ON strategy_switch_reports
BEGIN SELECT RAISE(ABORT, '策略切换报告不可删除'); END;
