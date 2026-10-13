CREATE TABLE execution_stress_reports (
 id TEXT PRIMARY KEY NOT NULL,
 cohort_id TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 payload TEXT NOT NULL,
 digest TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX execution_stress_cohort_input ON execution_stress_reports(cohort_id,input_digest);
CREATE TABLE execution_stress_paths (
 input_digest TEXT NOT NULL,
 multiplier REAL NOT NULL,
 strategy_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 digest TEXT NOT NULL,
 PRIMARY KEY(input_digest,multiplier,strategy_id)
);
CREATE TABLE execution_calibration_inputs (
 id TEXT PRIMARY KEY NOT NULL,
 payload TEXT NOT NULL,
 digest TEXT NOT NULL,
 raw_digest TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL
);
ALTER TABLE execution_cost_policies ADD COLUMN calibration_id TEXT;
