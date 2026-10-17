-- 做T记录补了结序号（方案 7 第二轮）：连续亏损统计按实际了结先后
-- 排序（completed_date + completed_sequence），同日多笔不按代码字典序
-- 打乱。独立迁移：已执行初版 0023 的数据库据此升级，不回改历史迁移。
ALTER TABLE paper_t_trades
  ADD COLUMN completed_sequence INTEGER NOT NULL DEFAULT 0;
