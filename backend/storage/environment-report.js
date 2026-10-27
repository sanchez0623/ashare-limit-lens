import { digestOf, canonicalJson } from "../domain/research-lineage.js";
import {
  verifyEnvironmentRow,
  verifyEnvironmentOrigin,
} from "./market-environment.js";

export async function environmentLedger(db, date, accountId = null) {
  return (
    await db
      .prepare(
        accountId
          ? "SELECT payload FROM shadow_ledger WHERE account_id=? AND trade_date<=? ORDER BY trade_date,json_extract(payload,'$.sequence'),id"
          : "SELECT payload FROM paper_ledger WHERE trade_date<=? ORDER BY trade_date,json_extract(payload,'$.sequence'),id",
      )
      .bind(...(accountId ? [accountId] : []), date)
      .all()
  ).results.map((r) => JSON.parse(r.payload));
}
// Compact immutable references; future frames are outside the published prefix.
export async function environmentDayReferences(
  db,
  manifest,
  date,
  prefix = {},
) {
  const list = async (sql, args) =>
    (
      await db
        .prepare(sql)
        .bind(...args)
        .all()
    ).results;
  const frames = await list(
    "SELECT sequence,digest FROM quote_frames WHERE trade_date=? AND sequence<=? ORDER BY sequence",
    [date, prefix.frameSequence ?? Number.MAX_SAFE_INTEGER],
  );
  const ticks = await list(
    "SELECT sequence,digest FROM paper_live_ticks WHERE trade_date=? AND sequence<=? ORDER BY sequence",
    [date, prefix.tickSequence ?? Number.MAX_SAFE_INTEGER],
  );
  const day = await db
    .prepare("SELECT payload,digest FROM paper_market_days WHERE trade_date=?")
    .bind(date)
    .first();
  const session = await db
    .prepare(
      "SELECT payload,digest FROM paper_live_sessions WHERE trade_date=?",
    )
    .bind(date)
    .first();
  if (day) await verifyEnvironmentRow(day);
  if (session) await verifyEnvironmentRow(session);
  const arms = {};
  for (const [role, id] of Object.entries(manifest.accounts)) {
    const s = await db
      .prepare(
        "SELECT payload,digest FROM shadow_sessions WHERE account_id=? AND trade_date=?",
      )
      .bind(id, date)
      .first();
    const e = await db
      .prepare(
        "SELECT payload,digest FROM shadow_equity WHERE account_id=? AND trade_date=?",
      )
      .bind(id, date)
      .first();
    if (s) await verifyEnvironmentRow(s);
    if (e) await verifyEnvironmentRow(e);
    arms[role] = {
      sessionDigest: s?.digest ?? null,
      equityDigest: e?.digest ?? null,
      ledgerDigest: await digestOf(await environmentLedger(db, date, id)),
    };
  }
  return {
    date,
    frameSequence: frames.at(-1)?.sequence ?? 0,
    frameRefsDigest: await digestOf(frames),
    tickSequence: ticks.at(-1)?.sequence ?? 0,
    tickRefsDigest: await digestOf(ticks),
    datasetDigest: day?.digest ?? null,
    sessionDigest: session?.digest ?? null,
    arms,
  };
}
export async function verifyReportInputs(db, trial, report) {
  const input = report.inputManifest,
    m = JSON.parse(trial.manifest);
  if (!input || input.manifestDigest !== trial.manifest_digest)
    throw new Error("环境报告实验来源不一致");
  if (
    (await digestOf(await environmentLedger(db, report.asOf))) !==
    input.ledgerDigest
  )
    throw new Error("环境报告原始账本已改变");
  const events = (
    await db
      .prepare(
        "SELECT * FROM market_environment_opportunities WHERE cycle_id=? AND trade_date<=? ORDER BY as_of,id",
      )
      .bind(m.cycleId, report.asOf)
      .all()
  ).results;
  if (
    canonicalJson(events.map((r) => ({ id: r.id, digest: r.digest }))) !==
    canonicalJson(input.events)
  )
    throw new Error("环境报告机会来源已改变");
  const verified = new Set();
  for (const row of events) {
    const event = await verifyEnvironmentRow(row);
    const key = `${row.scope}:${row.trade_date}:${event.source.sequence}`;
    if (!verified.has(key)) {
      await verifyEnvironmentOrigin(db, row);
      verified.add(key);
    }
  }
  for (const ref of input.days) {
    if (
      canonicalJson(await environmentDayReferences(db, m, ref.date, ref)) !==
      canonicalJson(ref)
    )
      throw new Error("环境报告行情、会话或影子账本来源已改变");
  }
}
