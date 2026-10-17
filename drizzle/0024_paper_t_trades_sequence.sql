-- guard-if-column: paper_t_trades.completed_sequence
-- 做T记录补了结序号（方案 7 第二轮）：连续亏损统计按实际了结先后
-- 排序（completed_date + completed_sequence），同日多笔不按代码字典序
-- 打乱。守卫声明列已存在（中间版本新建的库）则整条迁移按已应用记账
-- 跳过，兼容初版与中间版两种旧库；无该列的初版库正常加列。
ALTER TABLE paper_t_trades
  ADD COLUMN completed_sequence INTEGER NOT NULL DEFAULT 0;
