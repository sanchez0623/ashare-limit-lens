-- 卖出上下文输入按日期固化并绑定摘要（方案 5）：主账户、影子组合与
-- 研究重放引用同一版本，可变日线 Parquet 补齐后不改变已冻结的决策输入。
CREATE TABLE exit_context_inputs (
  trade_date text PRIMARY KEY NOT NULL,
  payload text NOT NULL,
  digest text NOT NULL,
  created_at text NOT NULL
);
