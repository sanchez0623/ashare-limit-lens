import { database } from "./database.js";
import { digestOf, canonicalJson } from "../domain/research-lineage.js";

export async function tradingArchives(env) {
  const rows = await database(env)
    .prepare(
      "SELECT summary,digest FROM paper_trading_archives ORDER BY created_at DESC,id DESC",
    )
    .all();
  return Promise.all(
    rows.results.map(async (row) => {
      const summary = JSON.parse(row.summary);
      if ((await digestOf(summary)) !== row.digest)
        throw new Error("交易历史归档摘要不一致");
      return summary;
    }),
  );
}

export async function tradingArchive(env, id) {
  const db = database(env);
  const row = await db
    .prepare("SELECT summary,digest FROM paper_trading_archives WHERE id=?")
    .bind(id)
    .first();
  if (!row) return null;
  const summary = JSON.parse(row.summary);
  if ((await digestOf(summary)) !== row.digest)
    throw new Error("交易历史归档摘要不一致");
  const chunks = (
    await db
      .prepare(
        "SELECT table_name,chunk_index,payload,digest FROM paper_trading_archive_chunks WHERE archive_id=? ORDER BY table_name,chunk_index",
      )
      .bind(id)
      .all()
  ).results;
  const tables = Object.fromEntries(
    Object.keys(summary.tables).map((name) => [name, []]),
  );
  const manifest = [];
  for (const chunk of chunks) {
    const rows = JSON.parse(chunk.payload);
    if (
      !Array.isArray(rows) ||
      !tables[chunk.table_name] ||
      (await digestOf(rows)) !== chunk.digest
    )
      throw new Error("交易历史归档内容摘要不一致");
    tables[chunk.table_name].push(...rows);
    manifest.push({
      table: chunk.table_name,
      index: chunk.chunk_index,
      digest: chunk.digest,
    });
  }
  if (
    canonicalJson(manifest) !== canonicalJson(summary.chunks) ||
    Object.entries(tables).some(
      ([name, rows]) => rows.length !== summary.tables[name],
    )
  )
    throw new Error("交易历史归档不完整");
  return { summary, digest: row.digest, tables };
}

export function archivedLedgerCsv(archive) {
  const cell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [
    [
      "账户",
      "交易日",
      "代码",
      "名称",
      "操作",
      "方向",
      "数量",
      "成交价（分）",
      "费用（分）",
      "现金变动（分）",
    ],
  ];
  for (const table of ["paper_ledger", "shadow_ledger"])
    for (const row of archive.tables[table] ?? []) {
      const fill = JSON.parse(row.payload);
      rows.push([
        row.account_id ?? "primary",
        row.trade_date,
        fill.code,
        fill.name,
        fill.action,
        fill.side,
        fill.quantity,
        fill.priceCents,
        fill.feesCents,
        fill.cashDeltaCents,
      ]);
    }
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
