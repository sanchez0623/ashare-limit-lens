-- 做T质量追踪（方案 7）：每笔做T一条记录——T买入价 / T卖出价 /
-- 当日T盈亏 / 是否当日了结。记录是 paper_ledger 成交流水的派生投影，
-- 随结算同一 CAS 批写入（幂等 INSERT OR REPLACE，按 id 覆盖）；
-- 跨日恢复腿了结时更新原记录（completed_date 晚于 trade_date）。
CREATE TABLE paper_t_trades (
  id TEXT PRIMARY KEY NOT NULL,
  trade_date TEXT NOT NULL,
  code TEXT NOT NULL,
  action TEXT NOT NULL,
  buy_price_cents INTEGER,
  sell_price_cents INTEGER,
  buy_quantity INTEGER,
  sell_quantity INTEGER,
  day_pnl_cents INTEGER NOT NULL DEFAULT 0,
  total_pnl_cents INTEGER,
  completed_same_day INTEGER NOT NULL DEFAULT 0,
  completed_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_paper_t_trades_completed ON paper_t_trades (completed_date);
CREATE INDEX idx_paper_t_trades_code ON paper_t_trades (code);
