INSERT INTO `research_registry` (`namespace`, `revision`, `attempt_sequence`, `legacy_cutoff`, `selection_cutoff`, `payload`)
SELECT
  'main',
  0,
  (SELECT COUNT(*) FROM `strategy_versions` WHERE `id` <> 'baseline-v1'),
  (
    SELECT MAX(d) FROM (
      SELECT json_extract(`evidence`, '$.validationEnd') AS d FROM `strategy_versions` WHERE `id` <> 'baseline-v1' AND json_valid(`evidence`)
      UNION ALL SELECT json_extract(`state`, '$.lastDate') AS d FROM `paper_accounts` WHERE json_valid(`state`)
    )
  ),
  NULL,
  '{"legacyIncomplete":true,"backfill":"0005-upgrade","note":"0005 升级时按旧验证窗口终点与账户结算日固定截止线；已知训练日期记为未知"}'
WHERE NOT EXISTS (SELECT 1 FROM `research_registry` WHERE `namespace` = 'main');--> statement-breakpoint
UPDATE `research_registry`
SET `legacy_cutoff` = (
  SELECT MAX(d) FROM (
    SELECT `legacy_cutoff` AS d FROM `research_registry` WHERE `namespace` = 'main'
    UNION ALL SELECT json_extract(`evidence`, '$.validationEnd') AS d FROM `strategy_versions` WHERE `id` <> 'baseline-v1' AND json_valid(`evidence`)
    UNION ALL SELECT json_extract(`state`, '$.lastDate') AS d FROM `paper_accounts` WHERE json_valid(`state`)
  )
),
`payload` = json_set(`payload`, '$.backfill', '0005-upgrade', '$.note', '0005 升级时补齐旧验证窗口终点与账户结算日；已有保守截止线只进不退')
WHERE `namespace` = 'main';--> statement-breakpoint
INSERT INTO `research_test_claims` (`namespace`, `outcome_date`, `experiment_id`, `role`, `reserved_at`)
SELECT 'main', `md`.`trade_date`, `sv`.`id`, 'HISTORICAL_TEST', `sv`.`created_at`
FROM `strategy_versions` `sv`
JOIN `paper_market_days` `md`
  ON `md`.`trade_date` >= json_extract(`sv`.`evidence`, '$.validationStart')
 AND `md`.`trade_date` <= json_extract(`sv`.`evidence`, '$.validationEnd')
WHERE `sv`.`id` <> 'baseline-v1'
  AND json_valid(`sv`.`evidence`)
  AND json_extract(`sv`.`evidence`, '$.validationStart') IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO `research_sample_uses` (`namespace`, `experiment_id`, `role`, `outcome_date`, `sample_key`, `payload`, `digest`)
SELECT
  'main',
  `sv`.`id`,
  'HISTORICAL_TEST',
  `md`.`trade_date`,
  'main:' || `sv`.`id` || ':HISTORICAL_TEST:' || `md`.`trade_date`,
  json_object(
    'legacy', 1,
    'parentVersion', json_extract(`sv`.`evidence`, '$.baseVersion'),
    'tradeDate', `md`.`trade_date`,
    'role', 'HISTORICAL_TEST',
    'note', '0005 迁移回填；对应训练日期未记录，记为未知'
  ),
  'legacy-0005-backfill'
FROM `strategy_versions` `sv`
JOIN `paper_market_days` `md`
  ON `md`.`trade_date` >= json_extract(`sv`.`evidence`, '$.validationStart')
 AND `md`.`trade_date` <= json_extract(`sv`.`evidence`, '$.validationEnd')
WHERE `sv`.`id` <> 'baseline-v1'
  AND json_valid(`sv`.`evidence`)
  AND json_extract(`sv`.`evidence`, '$.validationStart') IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE TRIGGER `research_test_claims_freshness`
BEFORE INSERT ON `research_test_claims`
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM `research_registry`
  WHERE `namespace` = NEW.`namespace`
    AND json_extract(`payload`, '$.legacyBackfillActive') = 1
)
AND (
  EXISTS (
    SELECT 1 FROM `research_sample_uses` `u`
    WHERE `u`.`namespace` = NEW.`namespace`
      AND `u`.`outcome_date` = NEW.`outcome_date`
  )
  OR EXISTS (
    SELECT 1 FROM `research_registry` `r`
    WHERE `r`.`namespace` = NEW.`namespace`
      AND `r`.`legacy_cutoff` IS NOT NULL
      AND NEW.`outcome_date` <= `r`.`legacy_cutoff`
  )
)
BEGIN
  SELECT RAISE(ABORT, 'research test date not fresh');
END;