-- 做T质量摘要冻结副本（方案 7 第三轮）：计划冻结时把质量摘要与证据
-- 固化一份到账户作用域存储（首写固化，同日重冻不覆盖）。执行前核验
-- 回读副本与计划比对——保留规则标记、把记录与证据一起改成空历史的
-- 伪装计划在执行入口即被拦截，不必等到导出核验。
-- scope：main = 主账户；shadow:<accountId> = 赛马影子账户。
CREATE TABLE frozen_t_quality (
  scope TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  payload TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, signal_date)
);
