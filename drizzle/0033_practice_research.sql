CREATE TABLE dragon_pattern_batches (
  id text PRIMARY KEY NOT NULL,
  stage text NOT NULL,
  manifest text NOT NULL,
  manifest_digest text NOT NULL,
  report text,
  report_digest text,
  revision integer NOT NULL DEFAULT 0,
  comparison_end integer NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  lease_owner text,
  lease_until text
);
CREATE UNIQUE INDEX dragon_pattern_active ON dragon_pattern_batches((1))
WHERE stage IN ('REQUESTING','HISTORICAL','FORWARD','READY');
CREATE TRIGGER dragon_pattern_manifest_immutable BEFORE UPDATE OF manifest ON dragon_pattern_batches
WHEN OLD.stage <> 'REQUESTING' AND NEW.manifest IS NOT OLD.manifest
BEGIN SELECT RAISE(ABORT, '练习研究清单不可改写'); END;
CREATE TABLE practice_weekly_reports (
  week_end text PRIMARY KEY NOT NULL,
  payload text NOT NULL,
  digest text NOT NULL,
  status text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  next_attempt_at text,
  lease_owner text,
  lease_until text,
  provider_ref text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
