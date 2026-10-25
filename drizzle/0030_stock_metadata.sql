CREATE TABLE data_update_jobs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '等待执行',
  progress TEXT NOT NULL DEFAULT '{}',
  results TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX idx_data_update_active ON data_update_jobs ((1))
  WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX idx_data_update_history ON data_update_jobs (created_at DESC, id DESC);

CREATE TABLE metadata_snapshots (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'STAGED',
  fetched_at TEXT NOT NULL,
  digest TEXT NOT NULL,
  stats TEXT NOT NULL
);
CREATE TABLE metadata_records (
  snapshot_id TEXT NOT NULL,
  code TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, code)
);
CREATE TABLE metadata_current (
  kind TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL
);
CREATE TABLE data_update_worker (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner TEXT,
  heartbeat_at TEXT NOT NULL
);
INSERT INTO data_update_worker (singleton, owner, heartbeat_at) VALUES (1, NULL, '1970-01-01T00:00:00.000Z');
