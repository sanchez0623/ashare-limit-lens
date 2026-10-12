-- 统计证据输入冻结（docs/design/statistical-evidence.md §8.2）：
-- 报告发布时把参与计算的每日指标连同摘要固化进输入 manifest，
-- 来源修订后旧报告仍可从导出独立重算（P1-5）。
ALTER TABLE `evidence_report_inputs` ADD `metrics_json` text;
