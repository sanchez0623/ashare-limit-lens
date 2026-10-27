-- A continuation may leave the active cycle only after its exact original row
-- has been preserved in the immutable trading archive. Updates stay forbidden.
DROP TRIGGER industry_continuation_immutable_delete;
CREATE TRIGGER industry_continuation_immutable_delete
BEFORE DELETE ON paper_configuration_history
WHEN json_extract(OLD.payload, '$.type')='DRAGON_INDUSTRY_RUNTIME_CONTINUED'
  AND NOT EXISTS (
    SELECT 1 FROM paper_trading_archive_chunks AS chunk
    JOIN paper_trading_archives AS archive ON archive.id=chunk.archive_id,
      json_each(chunk.payload) AS archived
    WHERE chunk.table_name='paper_configuration_history'
      AND json_extract(archived.value, '$.id')=OLD.id
      AND json_extract(archived.value, '$.created_at')=OLD.created_at
      AND json_extract(archived.value, '$.payload')=OLD.payload
      AND json_extract(archived.value, '$.digest')=OLD.digest
  )
BEGIN SELECT RAISE(ABORT, '行业续跑证明不可删除，须先完整归档'); END;
