CREATE TABLE dragon_research_runs (
  config_id text PRIMARY KEY NOT NULL,
  base_id text NOT NULL,
  status text NOT NULL,
  manifest text,
  report text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE dragon_research_sample_uses (
  trade_date text PRIMARY KEY NOT NULL,
  config_id text NOT NULL,
  role text NOT NULL
);
CREATE TABLE dragon_ai_attempts (
  id text PRIMARY KEY NOT NULL,
  month text NOT NULL,
  payload text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX dragon_ai_month ON dragon_ai_attempts(month);
CREATE TRIGGER dragon_research_manifest_immutable BEFORE UPDATE OF manifest ON dragon_research_runs
WHEN OLD.manifest IS NOT NULL AND NEW.manifest IS NOT OLD.manifest
BEGIN SELECT RAISE(ABORT, '研究窗口清单不可改写'); END;
