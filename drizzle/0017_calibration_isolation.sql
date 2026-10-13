-- 历史输入和报告保持原 ID；新增用途登记与实际成交样本身份索引。
ALTER TABLE execution_calibration_inputs ADD COLUMN sample_digest TEXT;
CREATE TABLE execution_calibration_sample_sets (
 sample_digest TEXT PRIMARY KEY NOT NULL,
 input_id TEXT NOT NULL
);
CREATE TABLE execution_calibration_sample_owners (
 sample_identity TEXT PRIMARY KEY NOT NULL,
 input_id TEXT NOT NULL
);
CREATE TRIGGER calibration_samples_first_protocol_guard BEFORE INSERT ON execution_calibration_sample_owners
 WHEN EXISTS(SELECT 1 FROM execution_calibration_sample_owners WHERE sample_identity=NEW.sample_identity AND input_id<>NEW.input_id)
 BEGIN SELECT RAISE(ABORT,'实际委托/成交样本已归属于首次校准协议'); END;
CREATE TRIGGER calibration_samples_owner_update_guard BEFORE UPDATE ON execution_calibration_sample_owners
 WHEN OLD.input_id<>NEW.input_id OR OLD.sample_identity<>NEW.sample_identity
 BEGIN SELECT RAISE(ABORT,'校准样本首次协议不可改变'); END;
CREATE TRIGGER calibration_set_owner_update_guard BEFORE UPDATE ON execution_calibration_sample_sets
 WHEN OLD.input_id<>NEW.input_id OR OLD.sample_digest<>NEW.sample_digest
 BEGIN SELECT RAISE(ABORT,'校准样本首次协议不可改变'); END;
CREATE TABLE execution_calibration_date_uses (
 input_id TEXT NOT NULL,
 outcome_date TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('CALIBRATION_TRAIN','CALIBRATION_VALIDATION')),
 PRIMARY KEY(input_id,outcome_date)
);
CREATE INDEX execution_calibration_date_idx ON execution_calibration_date_uses(outcome_date);
-- 先回填再加守卫，兼容升级前已存在的冲突；读取会拒绝冲突证据，绝不删除历史。
INSERT INTO execution_calibration_date_uses(input_id,outcome_date,role)
 SELECT DISTINCT i.id, date(json_extract(o.value,'$.submittedAt'),'+8 hours'),
 CASE WHEN date(json_extract(o.value,'$.submittedAt'),'+8 hours')<=json_extract(i.payload,'$.input.trainingEnd')
 THEN 'CALIBRATION_TRAIN' ELSE 'CALIBRATION_VALIDATION' END
 FROM execution_calibration_inputs i, json_each(i.payload,'$.input.orders') o
 WHERE json_valid(i.payload) AND date(json_extract(o.value,'$.submittedAt'),'+8 hours') IS NOT NULL;
CREATE TRIGGER calibration_dates_research_guard BEFORE INSERT ON execution_calibration_date_uses
 WHEN EXISTS(SELECT 1 FROM research_test_claims WHERE namespace='main' AND outcome_date=NEW.outcome_date)
 OR EXISTS(SELECT 1 FROM research_sample_uses WHERE namespace='main' AND outcome_date=NEW.outcome_date AND role NOT IN ('TRAIN','HISTORICAL_TRAIN'))
 BEGIN SELECT RAISE(ABORT,'校准日期与正式研究测试/前瞻日期重叠'); END;
CREATE TRIGGER calibration_dates_research_update_guard BEFORE UPDATE ON execution_calibration_date_uses
 WHEN EXISTS(SELECT 1 FROM research_test_claims WHERE namespace='main' AND outcome_date=NEW.outcome_date)
 OR EXISTS(SELECT 1 FROM research_sample_uses WHERE namespace='main' AND outcome_date=NEW.outcome_date AND role NOT IN ('TRAIN','HISTORICAL_TRAIN'))
 BEGIN SELECT RAISE(ABORT,'校准日期与正式研究测试/前瞻日期重叠'); END;
CREATE TRIGGER research_claims_calibration_guard BEFORE INSERT ON research_test_claims
 WHEN NEW.namespace='main' AND EXISTS(SELECT 1 FROM execution_calibration_date_uses WHERE outcome_date=NEW.outcome_date)
 BEGIN SELECT RAISE(ABORT,'正式研究测试日期已登记为成本校准用途'); END;
CREATE TRIGGER research_claims_calibration_update_guard BEFORE UPDATE ON research_test_claims
 WHEN NEW.namespace='main' AND EXISTS(SELECT 1 FROM execution_calibration_date_uses WHERE outcome_date=NEW.outcome_date)
 BEGIN SELECT RAISE(ABORT,'正式研究测试日期已登记为成本校准用途'); END;
CREATE TRIGGER research_samples_calibration_guard BEFORE INSERT ON research_sample_uses
 WHEN NEW.namespace='main' AND NEW.role NOT IN ('TRAIN','HISTORICAL_TRAIN')
 AND EXISTS(SELECT 1 FROM execution_calibration_date_uses WHERE outcome_date=NEW.outcome_date)
 BEGIN SELECT RAISE(ABORT,'正式研究测试日期已登记为成本校准用途'); END;
CREATE TRIGGER research_samples_calibration_update_guard BEFORE UPDATE ON research_sample_uses
 WHEN NEW.namespace='main' AND NEW.role NOT IN ('TRAIN','HISTORICAL_TRAIN')
 AND EXISTS(SELECT 1 FROM execution_calibration_date_uses WHERE outcome_date=NEW.outcome_date)
 BEGIN SELECT RAISE(ABORT,'正式研究测试日期已登记为成本校准用途'); END;
