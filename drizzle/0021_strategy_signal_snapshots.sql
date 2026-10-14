-- 信号快照按内容寻址冻结一次，所有策略计划共享；不依赖可重算的展示归档。
CREATE TABLE strategy_signal_snapshots (
  digest text PRIMARY KEY NOT NULL,
  signal_date text NOT NULL,
  payload text NOT NULL
);--> statement-breakpoint
CREATE TRIGGER strategy_signal_snapshot_immutable_update BEFORE UPDATE ON strategy_signal_snapshots
BEGIN SELECT RAISE(ABORT, '策略信号快照不可修改'); END;--> statement-breakpoint
CREATE TRIGGER strategy_signal_snapshot_immutable_delete BEFORE DELETE ON strategy_signal_snapshots
BEGIN SELECT RAISE(ABORT, '策略信号快照不可删除'); END;
