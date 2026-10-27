import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import { api } from "../backend/routes/api.js";
import { historyList, loadReview } from "../backend/services/review.js";
import { archivedReviews } from "../backend/storage/trading-archives.js";

const date = "2026-10-26",
  archiveId = "v5-2026-10-27-review-test";
async function fixture(t) {
  const DB = localDatabase(),
    env = { DB },
    papers = new PaperRepository(env);
  t.after(() => DB.close());
  await papers.initialize();
  const review = {
    reviewKind: "DRAGON_PRACTICE",
    date,
    snapshotDate: "2026-10-23",
    createdAt: `${date}T09:00:00Z`,
    status: "COMPLETE",
    systemScore: null,
    coverage: 1,
    summary: { fillCount: 1, dailyPnlCents: 3367, feeCents: 533 },
  };
  const ai = { score: 65, summary: "原周期真实冻结评价" };
  const row = {
    trade_date: date,
    snapshot_date: review.snapshotDate,
    created_at: review.createdAt,
    payload: JSON.stringify(review),
    ai_payload: JSON.stringify(ai),
  };
  const rows = [row],
    chunkDigest = await digestOf(rows);
  const summary = {
    id: archiveId,
    tradeDate: "2026-10-27",
    signalDate: date,
    tables: { reviews: 1 },
    chunks: [{ table: "reviews", index: 0, digest: chunkDigest }],
  };
  await DB.prepare(
    "INSERT INTO paper_trading_archives(id,trade_date,created_at,summary,digest) VALUES(?,?,?,?,?)",
  )
    .bind(
      archiveId,
      "2026-10-27",
      `${date}T12:00:00Z`,
      JSON.stringify(summary),
      await digestOf(summary),
    )
    .run();
  await DB.prepare(
    "INSERT INTO paper_trading_archive_chunks(archive_id,table_name,chunk_index,payload,digest) VALUES(?,'reviews',0,?,?)",
  )
    .bind(archiveId, JSON.stringify(rows), chunkDigest)
    .run();
  return { env, DB, papers, review, ai };
}
const get = (env, path) => api(new Request(`http://localhost${path}`), env);

test("周期归档后列表和日期查询仍读取原复盘与AI，不恢复旧记录到新账本", async (t) => {
  const f = await fixture(t),
    before = await f.papers.account();
  const response = await get(f.env, `/api/review?date=${date}`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.review, f.review);
  assert.deepEqual(payload.ai, f.ai);
  assert.equal(payload.archived, true);
  assert.equal(payload.archiveId, archiveId);
  assert.match(payload.reason, /不计入当前周期/);
  const history = await (await get(f.env, "/api/history")).json();
  assert.equal(history.reviews.length, 1);
  assert.equal(history.reviews[0].date, date);
  assert.equal(history.reviews[0].archived, true);
  assert.equal(history.reviews[0].reviewKind, "DRAGON_PRACTICE");
  assert.equal((await loadReview(f.env, date)).archived, true);
  assert.deepEqual(await f.papers.account(), before);
  for (const table of ["reviews", "paper_ledger", "paper_equity"])
    assert.equal(
      (await f.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n,
      0,
    );
});

test("当前周期同日复盘优先，历史列表去重，保留原周期归档", async (t) => {
  const f = await fixture(t),
    current = { ...f.review, summary: { fillCount: 0, dailyPnlCents: 0 } };
  await f.DB.prepare(
    "INSERT INTO reviews(trade_date,snapshot_date,created_at,payload) VALUES(?,?,?,?)",
  )
    .bind(
      date,
      current.snapshotDate,
      current.createdAt,
      JSON.stringify(current),
    )
    .run();
  const payload = await (await get(f.env, `/api/review?date=${date}`)).json();
  assert.deepEqual(payload.review, current);
  assert.notEqual(payload.archived, true);
  const history = await historyList(f.env);
  assert.equal(history.reviews.length, 1);
  assert.equal(history.reviews[0].summary.fillCount, 0);
  assert.deepEqual(
    JSON.parse((await archivedReviews(f.env, { date }))[0].payload),
    f.review,
  );
});

test("历史复盘分块被改写时拒绝展示，不把异常当作没有归档", async (t) => {
  const f = await fixture(t);
  f.DB.exec("DROP TRIGGER paper_archive_chunk_immutable_update");
  await f.DB.prepare(
    "UPDATE paper_trading_archive_chunks SET payload='[]' WHERE archive_id=?",
  )
    .bind(archiveId)
    .run();
  const response = await get(f.env, `/api/review?date=${date}`);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /摘要不一致/);
});

test("历史复盘分块缺失时阻断列表，不能静默隐藏已保存反馈", async (t) => {
  const f = await fixture(t);
  f.DB.exec("DROP TRIGGER paper_archive_chunk_immutable_delete");
  await f.DB.prepare(
    "DELETE FROM paper_trading_archive_chunks WHERE archive_id=?",
  )
    .bind(archiveId)
    .run();
  await assert.rejects(historyList(f.env), /不完整/);
});
