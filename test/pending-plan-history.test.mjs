import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { newBook } from "../backend/domain/trading.js";
import {
  createDragonPlan,
  openDragonSession,
} from "../backend/domain/dragon-risk.js";
import {
  registerDragonConfig,
  dragonBookFields,
} from "../backend/storage/dragon-risk.js";
import { defaultDragonConfig } from "../shared/dragon-risk-config.js";
import { latestPolicyBundle } from "../backend/storage/execution-cost.js";
import { resolveDailyPriceInputs } from "../backend/services/price-history.js";
import { buildSnapshotPayload } from "../backend/services/review.js";
import { repairPendingPlanHistory } from "../backend/services/pending-plan-history.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import { selectionSnapshotDigest } from "../backend/domain/signal-selection.js";
import { canonicalJson } from "../backend/domain/research-lineage.js";

const date = "2026-10-22",
  now = new Date(`${date}T16:15:00+08:00`);
const codes = ["600001", "600002", "600003"];
const rows = codes.map((c) => ({
  c,
  n: `合成${c}`,
  hybk: "合成行业",
  p: 11000,
  zdp: 10,
  amount: 550000000,
  hs: 5,
  lbc: 3,
  fbt: 93000,
  lbt: 93000,
  zbc: 1,
}));
const bars = [];
for (let i = 44; i >= 0; i--) {
  const d = new Date(now.getTime() - i * 86400000);
  if ([0, 6].includes(d.getUTCDay())) continue;
  const close = i === 0 ? 11 : 10;
  bars.push({
    date_ms: Date.parse(`${d.toISOString().slice(0, 10)}T00:00:00+08:00`),
    open_price: close,
    high_price: close,
    low_price: close,
    close_price: close,
    volume: 50000000,
    turnover: close * 50000000,
  });
}
const history = async (thscode, options) => ({
  thscode,
  interval: "1d",
  adjust: options.adjust,
  item: bars,
});

async function fixture(t) {
  const DB = localDatabase();
  t.after(() => DB.close());
  const env = { DB },
    papers = new PaperRepository(env);
  await papers.initialize();
  const config = await registerDragonConfig(DB, defaultDragonConfig(), null, {
    origin: "MANUAL",
    validationMode: "MANUAL_UNVERIFIED",
  });
  const book = { ...newBook(), ...dragonBookFields(config), lastDate: date };
  await DB.prepare(
    "UPDATE paper_accounts SET state=?,revision=revision+1 WHERE id='primary'",
  )
    .bind(JSON.stringify(book))
    .run();
  const partial = await resolveDailyPriceInputs(env, date, {
    codes,
    localDataset: null,
    history,
    now,
    maxCodes: 2,
  });
  // Reproduce a plan frozen before the pending-code guard existed.
  delete partial.status.pendingCodes;
  delete partial.status.complete;
  const source = await buildSnapshotPayload(
    env,
    { date, rows, previous: [], source: "synthetic" },
    undefined,
    partial,
    { createdAt: `${date}T08:00:00.000Z`, firstNegMinPrevHeight: 3 },
  );
  await DB.prepare(
    "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
  )
    .bind(date, source.createdAt, JSON.stringify(source))
    .run();
  const plan = createDragonPlan(source, book, source.createdAt, {
    executionCostPolicy: await latestPolicyBundle(DB),
    snapshotDigest: await selectionSnapshotDigest(source),
  });
  await papers.savePlan(plan);
  assert.equal(plan.entryExecutionPolicy.candidates.length, 2);
  assert.equal((await verifyExport(await exportPaper(env))).passed, true);
  const complete = await resolveDailyPriceInputs(env, date, {
    codes,
    localDataset: null,
    history,
    now,
  });
  return { DB, env, papers, book, source, plan, partial, complete };
}

test("盘前补齐漏股并保留原计划与输入；账户和历史观测不改，重复执行幂等", async (t) => {
  const f = await fixture(t),
    before = await exportPaper(f.env);
  const result = await repairPendingPlanHistory(f.env, {
    now,
    dailyInputs: f.complete,
  });
  assert.equal(result.changed, true);
  assert.equal(result.originalCandidates, 2);
  assert.equal(result.candidates, 3);
  const plan = await f.papers.plan(date),
    after = await exportPaper(f.env);
  assert.deepEqual(plan.entryExecutionPolicy.candidates, codes);
  assert.equal(plan.engineBuild, f.plan.engineBuild);
  const { environmentCohort: revisedCohort, ...revisedPolicy } =
    plan.dragonPolicy;
  const { environmentCohort: originalCohort, ...originalPolicy } =
    f.plan.dragonPolicy;
  assert.deepEqual(revisedPolicy, originalPolicy);
  assert.deepEqual(revisedCohort.members, originalCohort.members);
  assert.equal(revisedCohort.knownAt, now.toISOString());
  assert.deepEqual(plan.executionCostPolicy, f.plan.executionCostPolicy);
  assert.equal(openDragonSession(f.book, plan, "2026-10-23").status, "OPEN");
  for (const key of [
    "book",
    "ledger",
    "datasets",
    "realtimeSessions",
    "realtimeObservations",
  ])
    assert.equal(canonicalJson(after[key]), canonicalJson(before[key]));
  assert.equal(after.supersededPlans.length, 1);
  const original = await f.DB.prepare(
    "SELECT payload FROM strategy_signal_snapshots WHERE digest=?",
  )
    .bind(f.plan.selectionAudit.snapshotDigest)
    .first();
  assert.equal(
    canonicalJson(JSON.parse(original.payload)),
    canonicalJson(f.source),
  );
  assert.equal((await verifyExport(after)).passed, true);
  assert.equal(
    (await repairPendingPlanHistory(f.env, { now, dailyInputs: f.complete }))
      .status,
    "ALREADY_COMPLETE",
  );
});

test("尚有未回补日线时不替换计划、不伪装成资格不足", async (t) => {
  const f = await fixture(t);
  const pending = structuredClone(f.partial);
  pending.status.pendingCodes = ["600003"];
  const before = await f.papers.plan(date);
  const result = await repairPendingPlanHistory(f.env, {
    now,
    dailyInputs: pending,
  });
  assert.equal(result.status, "WAITING_PRICE_HISTORY");
  assert.deepEqual(await f.papers.plan(date), before);
  assert.equal((await f.papers.history("paper_plan_revisions")).length, 0);
});

test("计划一旦被交易会话使用或过了开盘窗口就拒绝修订", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    repairPendingPlanHistory(f.env, {
      now: new Date("2026-10-23T09:30:00+08:00"),
      dailyInputs: f.complete,
    }),
    /仅可在盘后或开盘前/,
  );
  await f.DB.prepare(
    "INSERT INTO paper_live_sessions(trade_date,payload,digest) VALUES(?,?,?)",
  )
    .bind("2026-10-23", JSON.stringify({ plan: f.plan }), "synthetic")
    .run();
  await assert.rejects(
    repairPendingPlanHistory(f.env, { now, dailyInputs: f.complete }),
    /计划已开始执行/,
  );
  assert.equal((await f.papers.history("paper_plan_revisions")).length, 0);
});
