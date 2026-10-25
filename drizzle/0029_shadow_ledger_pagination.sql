CREATE INDEX IF NOT EXISTS idx_shadow_ledger_page
ON shadow_ledger (
  account_id,
  trade_date DESC,
  COALESCE(CAST(json_extract(payload, '$.sequence') AS INTEGER), 0) DESC,
  id DESC
);
