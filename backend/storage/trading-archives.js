import { database } from "./database.js";
import { digestOf, canonicalJson } from "../domain/research-lineage.js";

export async function tradingArchives(env) {
  const rows = await database(env)
    .prepare(
      "SELECT summary,digest FROM (SELECT id,created_at,summary,digest FROM paper_trading_archives UNION ALL SELECT id,created_at,summary,digest FROM industry_repair_archives) ORDER BY created_at DESC,id DESC",
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
  const repair = id.startsWith("industry-repair-");
  const archiveTable = repair
    ? "industry_repair_archives"
    : "paper_trading_archives";
  const chunkTable = repair
    ? "industry_repair_archive_chunks"
    : "paper_trading_archive_chunks";
  const row = await db
    .prepare(`SELECT summary,digest FROM ${archiveTable} WHERE id=?`)
    .bind(id)
    .first();
  if (!row) return null;
  const summary = JSON.parse(row.summary);
  if ((await digestOf(summary)) !== row.digest)
    throw new Error("交易历史归档摘要不一致");
  const chunks = (
    await db
      .prepare(
        `SELECT table_name,chunk_index,payload,digest FROM ${chunkTable} WHERE archive_id=? ORDER BY table_name,chunk_index`,
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

// Read only the review chunks; browsing history must not restore old-cycle
// records into the active ledger or load every archived quote into memory.
export async function archivedReviews(
  env,
  { date = null, minimumDate = "0000-01-01", limit = 20 } = {},
) {
  const db = database(env);
  const archives = (
    await db
      .prepare(
        "SELECT id,created_at,summary,digest FROM paper_trading_archives WHERE trade_date>=? ORDER BY created_at DESC,id DESC",
      )
      .bind(date ?? minimumDate)
      .all()
  ).results;
  const found = new Map();
  for (const archive of archives) {
    const summary = JSON.parse(archive.summary);
    if ((await digestOf(summary)) !== archive.digest)
      throw new Error("交易历史归档摘要不一致");
    const chunks = (
      await db
        .prepare(
          "SELECT chunk_index,payload,digest FROM paper_trading_archive_chunks WHERE archive_id=? AND table_name='reviews' ORDER BY chunk_index",
        )
        .bind(archive.id)
        .all()
    ).results;
    const rows = [],
      manifest = [];
    for (const chunk of chunks) {
      const values = JSON.parse(chunk.payload);
      if (!Array.isArray(values) || (await digestOf(values)) !== chunk.digest)
        throw new Error("历史复盘归档内容摘要不一致");
      rows.push(...values);
      manifest.push({
        table: "reviews",
        index: chunk.chunk_index,
        digest: chunk.digest,
      });
    }
    if (
      rows.length !== (summary.tables.reviews ?? 0) ||
      canonicalJson(manifest) !==
        canonicalJson(
          summary.chunks.filter((chunk) => chunk.table === "reviews"),
        )
    )
      throw new Error("历史复盘归档不完整");
    for (const row of rows) {
      if (
        row.trade_date < minimumDate ||
        (date && row.trade_date !== date) ||
        found.has(row.trade_date)
      )
        continue;
      if (JSON.parse(row.payload).date !== row.trade_date)
        throw new Error("历史复盘归档日期不一致");
      found.set(row.trade_date, {
        ...row,
        archived: true,
        archiveId: archive.id,
        archivedAt: archive.created_at,
      });
    }
    if (date && found.has(date)) break;
  }
  return [...found.values()]
    .sort((a, b) => b.trade_date.localeCompare(a.trade_date))
    .slice(0, limit);
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
        fill.feeCents ?? fill.feesCents,
        fill.cashDeltaCents,
      ]);
    }
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
