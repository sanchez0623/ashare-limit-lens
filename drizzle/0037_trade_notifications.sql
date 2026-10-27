CREATE TABLE paper_trade_notifications (
  id text PRIMARY KEY NOT NULL,
  kind text NOT NULL,
  cycle_id text NOT NULL,
  source_ref text NOT NULL,
  trade_date text NOT NULL,
  part integer NOT NULL DEFAULT 0,
  payload text NOT NULL,
  digest text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  attempt integer NOT NULL DEFAULT 0,
  next_attempt_at text NOT NULL,
  lease_owner text,
  lease_until text,
  provider_ref text,
  last_error text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX paper_trade_notification_source
ON paper_trade_notifications(kind, cycle_id, source_ref, part);
CREATE INDEX paper_trade_notification_pending
ON paper_trade_notifications(status, next_attempt_at);
CREATE TRIGGER paper_trade_notification_payload_immutable
BEFORE UPDATE OF payload, digest ON paper_trade_notifications
BEGIN SELECT RAISE(ABORT, '交易通知事实不可改写'); END;
