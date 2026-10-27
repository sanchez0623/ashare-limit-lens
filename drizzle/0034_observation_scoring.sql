CREATE TABLE observation_score_policies (
 version text PRIMARY KEY NOT NULL, payload text NOT NULL, digest text NOT NULL, published_at text NOT NULL
);
CREATE TRIGGER observation_score_policy_immutable BEFORE UPDATE ON observation_score_policies
BEGIN SELECT RAISE(ABORT, '评分规则不可改写'); END;
CREATE TABLE observation_score_cursors (
 trade_date text NOT NULL, version text NOT NULL, sequence integer NOT NULL, payload text NOT NULL, digest text NOT NULL,
 PRIMARY KEY(trade_date,version)
);
CREATE TABLE observation_score_latest (
 trade_date text NOT NULL, code text NOT NULL, version text NOT NULL, sequence integer NOT NULL, payload text NOT NULL, digest text NOT NULL,
 PRIMARY KEY(trade_date,code,version)
);
CREATE TABLE observation_score_snapshots (
 id text PRIMARY KEY NOT NULL, trade_date text NOT NULL, code text NOT NULL, buy_point text NOT NULL,
 kind text NOT NULL, cycle_id text, version text NOT NULL, sequence integer NOT NULL, observed_at text NOT NULL,
 payload text NOT NULL, digest text NOT NULL
);
CREATE INDEX observation_score_snapshot_cycle ON observation_score_snapshots(cycle_id,kind);
CREATE TRIGGER observation_score_snapshot_immutable BEFORE UPDATE ON observation_score_snapshots
BEGIN SELECT RAISE(ABORT, '评分快照不可改写'); END;
CREATE TABLE observation_score_calibrations (
 id text PRIMARY KEY NOT NULL, as_of text NOT NULL, version text NOT NULL, payload text NOT NULL, digest text NOT NULL, created_at text NOT NULL
);
CREATE TRIGGER observation_score_calibration_immutable BEFORE UPDATE ON observation_score_calibrations
BEGIN SELECT RAISE(ABORT, '评分校准报告不可改写'); END;
CREATE TABLE observation_score_invalidations (
 trade_date text PRIMARY KEY NOT NULL, reason text NOT NULL
);
-- An earlier quote can affect confirmation and dynamic risk at a later entry.
-- Invalidating the source day avoids rereading years of raw quotes on every GET.
CREATE TRIGGER observation_score_tick_update AFTER UPDATE ON paper_live_ticks
BEGIN INSERT OR REPLACE INTO observation_score_invalidations(trade_date,reason) VALUES(OLD.trade_date,'原始观测已修改'); END;
CREATE TRIGGER observation_score_tick_delete AFTER DELETE ON paper_live_ticks
BEGIN INSERT OR REPLACE INTO observation_score_invalidations(trade_date,reason) VALUES(OLD.trade_date,'原始观测已删除或归档'); END;
