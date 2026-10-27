CREATE TABLE paper_manual_exit_requests (
  id text PRIMARY KEY NOT NULL,
  cycle_id text NOT NULL,
  position_id text NOT NULL,
  trade_date text NOT NULL,
  payload text NOT NULL,
  digest text NOT NULL,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX paper_manual_exit_position
ON paper_manual_exit_requests(cycle_id,position_id,trade_date);
CREATE TRIGGER paper_manual_exit_immutable_update BEFORE UPDATE ON paper_manual_exit_requests
BEGIN SELECT RAISE(ABORT, '用户清仓指令不可改写'); END;
CREATE TRIGGER paper_manual_exit_immutable_delete BEFORE DELETE ON paper_manual_exit_requests
BEGIN SELECT RAISE(ABORT, '用户清仓指令不可删除'); END;
