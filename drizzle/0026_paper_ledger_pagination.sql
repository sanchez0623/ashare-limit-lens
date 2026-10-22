CREATE INDEX IF NOT EXISTS idx_paper_ledger_page
ON paper_ledger (
  trade_date DESC,
  COALESCE(CAST(json_extract(payload, '$.sequence') AS INTEGER), 0) DESC,
  id DESC
);
