CREATE TABLE industry_repair_archives (
 id text PRIMARY KEY NOT NULL, trade_date text NOT NULL, created_at text NOT NULL,
 summary text NOT NULL, digest text NOT NULL
);
CREATE TABLE industry_repair_archive_chunks (
 archive_id text NOT NULL, table_name text NOT NULL, chunk_index integer NOT NULL,
 payload text NOT NULL, digest text NOT NULL,
 PRIMARY KEY (archive_id, table_name, chunk_index),
 FOREIGN KEY (archive_id) REFERENCES industry_repair_archives(id)
);
CREATE TRIGGER industry_repair_archive_immutable BEFORE UPDATE ON industry_repair_archives
BEGIN SELECT RAISE(ABORT, '行业修复原始归档不可改写'); END;
CREATE TRIGGER industry_repair_chunk_immutable BEFORE UPDATE ON industry_repair_archive_chunks
BEGIN SELECT RAISE(ABORT, '行业修复原始分块不可改写'); END;
