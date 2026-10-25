CREATE TABLE paper_trading_archives (
  id text PRIMARY KEY NOT NULL,
  trade_date text NOT NULL UNIQUE,
  created_at text NOT NULL,
  summary text NOT NULL,
  digest text NOT NULL
);
CREATE TABLE paper_trading_archive_chunks (
  archive_id text NOT NULL,
  table_name text NOT NULL,
  chunk_index integer NOT NULL,
  payload text NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY (archive_id, table_name, chunk_index)
);
CREATE TRIGGER paper_archive_immutable_update BEFORE UPDATE ON paper_trading_archives
BEGIN SELECT RAISE(ABORT, '交易历史归档不可修改'); END;
CREATE TRIGGER paper_archive_immutable_delete BEFORE DELETE ON paper_trading_archives
BEGIN SELECT RAISE(ABORT, '交易历史归档不可删除'); END;
CREATE TRIGGER paper_archive_chunk_immutable_update BEFORE UPDATE ON paper_trading_archive_chunks
BEGIN SELECT RAISE(ABORT, '交易历史归档不可修改'); END;
CREATE TRIGGER paper_archive_chunk_immutable_delete BEFORE DELETE ON paper_trading_archive_chunks
BEGIN SELECT RAISE(ABORT, '交易历史归档不可删除'); END;
