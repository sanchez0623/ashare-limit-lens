CREATE TABLE dragon_config_versions (
  id text PRIMARY KEY NOT NULL,
  payload text NOT NULL,
  digest text NOT NULL,
  engine_build text NOT NULL,
  base_id text,
  created_at text NOT NULL
);
CREATE TRIGGER dragon_config_immutable_update BEFORE UPDATE ON dragon_config_versions
BEGIN SELECT RAISE(ABORT, '新交易配置版本不可修改'); END;
CREATE TRIGGER dragon_config_immutable_delete BEFORE DELETE ON dragon_config_versions
BEGIN SELECT RAISE(ABORT, '新交易配置版本不可删除'); END;
CREATE TABLE dragon_plan_bindings (
  scope text NOT NULL,
  signal_date text NOT NULL,
  config_id text NOT NULL,
  plan_digest text NOT NULL,
  PRIMARY KEY(scope, signal_date)
);
CREATE TABLE dragon_observation_reports (
  config_id text NOT NULL,
  trade_date text NOT NULL,
  payload text NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY(config_id, trade_date)
);
CREATE TRIGGER dragon_report_immutable_update BEFORE UPDATE ON dragon_observation_reports
BEGIN SELECT RAISE(ABORT, '影子核验报告不可修改'); END;
CREATE TRIGGER dragon_report_immutable_delete BEFORE DELETE ON dragon_observation_reports
BEGIN SELECT RAISE(ABORT, '影子核验报告不可删除'); END;
