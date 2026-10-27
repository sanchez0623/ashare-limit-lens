-- Runtime continuation evidence is append-only, independently of the frozen
-- plan and the original execution configuration.
CREATE TRIGGER industry_continuation_immutable_update
BEFORE UPDATE ON paper_configuration_history
WHEN json_extract(OLD.payload, '$.type')='DRAGON_INDUSTRY_RUNTIME_CONTINUED'
  OR json_extract(NEW.payload, '$.type')='DRAGON_INDUSTRY_RUNTIME_CONTINUED'
BEGIN SELECT RAISE(ABORT, '行业续跑证明不可改写'); END;
CREATE TRIGGER industry_continuation_immutable_delete
BEFORE DELETE ON paper_configuration_history
WHEN json_extract(OLD.payload, '$.type')='DRAGON_INDUSTRY_RUNTIME_CONTINUED'
BEGIN SELECT RAISE(ABORT, '行业续跑证明不可删除'); END;
