-- 格式版本与完整成本指纹属于冻结输入，进入 manifest/inputDigest。
-- 历史行保留 NULL，以旧版输入摘要核验，不回填或改写原报告。
ALTER TABLE `evidence_report_inputs` ADD `schema_version` integer;
ALTER TABLE `evidence_report_inputs` ADD `cost_json` text;
