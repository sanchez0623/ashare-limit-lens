import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_STRATEGY,
  newBook,
  scoreSignals,
  createPlan,
  defensivePlan,
  executePlan,
  transactionFees,
} from "../backend/domain/trading.js";
import {
  selectionPolicy,
  selectionPolicyDigest,
  selectionPolicyForBook,
  selectionPolicyFields,
  frozenSelectionPolicy,
  selectionSnapshotDigest,
  liquidityAmountCents,
  LEGACY_SELECTION_VERSION,
  SELECTION_VERSION_V2,
  SELECTION_VERSION_V3,
  SELECTION_VERSION_V4,
  SELECTION_VERSION_V5,
  buyPointGateForPolicy,
  DEFAULT_SELECTION_VERSION,
} from "../backend/domain/signal-selection.js";
import { BUY_POINT_TYPES } from "../shared/buy-point-type.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import {
  buildTQualityEvidence,
  summarizeTQuality,
} from "../backend/domain/t-quality.js";
import { PaperRepository, digest } from "../backend/storage/paper.js";
import { ShadowAccountRepository } from "../backend/storage/shadow.js";
import {
  freezePortfolioPlan,
  portfolioSelectionMatches,
} from "../backend/services/portfolio-runner.js";
import {
  replayStrategy,
  validateCandidate,
} from "../backend/domain/validation.js";
import { openSession, advanceSession } from "../backend/domain/realtime.js";
import { verifyExport } from "../backend/services/paper.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { snapshot, dateAt, dataset, bars } from "./fixtures/trading.mjs";

const strategy = { ...BASE_STRATEGY, maxPositions: 1 };
function tiedSnapshot(date = dateAt(0)) {
  const snap = snapshot(date);
  // 方案 7：评分管线在新快照上写做T质量规则标记，影子冻结路径据此
  // 携带质量摘要与证据。
  snap.tQualityRulesVersion = 1;
  snap.stocks = [
    {
      ...snap.stocks[0],
      code: "002343",
      name: "合成慈文样本",
      amount: 189_000_000,
    },
    {
      ...snap.stocks[1],
      code: "002692",
      name: "合成远程样本",
      amount: 266_000_000,
    },
  ].map((s) => ({
    ...s,
    rawScore: 0,
    factors: [100, 100, 95, 100, 69, 100].map((value) => ({ value })),
    // v5 默认设买点闸门：fixture stocks 默认带合格买点（打板），
    // 避免每个测试都要显式传 v3 政策。需要测试"无买点被拒"的用例
    // 显式清空 buyPoint.labels。
    buyPoint: {
      primary: { type: BUY_POINT_TYPES.LIMIT_UP_MOMENTUM },
      all: [{ type: BUY_POINT_TYPES.LIMIT_UP_MOMENTUM }],
      labels: [BUY_POINT_TYPES.LIMIT_UP_MOMENTUM],
    },
  }));
  return snap;
}
// 方案 7：快照带规则标记的计划必须携带质量摘要与证据（空历史口径）
const emptyTQualityInputs = (date) => ({
  tQuality: summarizeTQuality([], { signalDate: date, tradingDates: [] }),
  tQualityEvidence: buildTQualityEvidence([], []),
});
const makePlan = (snap = tiedSnapshot(), book = newBook(), opts = {}) => {
  // 方案 7：影子冻结路径始终携带做T质量摘要与证据（空历史为无闸门
  // 口径），期望计划同口径保持字段一致。
  return createPlan(snap, book, strategy, "fixture-v", snap.createdAt, {
    ...emptyTQualityInputs(snap.date),
    ...opts,
  });
};
async function withDB(fn) {
  const DB = localDatabase();
  try {
    return await fn({ DB }, DB);
  } finally {
    DB.close();
  }
}
async function saveSnapshot(DB, snap) {
  await DB.prepare(
    "INSERT INTO snapshots (trade_date,created_at,payload) VALUES (?,?,?)",
  )
    .bind(snap.date, snap.createdAt, JSON.stringify(snap))
    .run();
}
async function oldAccount(repository, DB) {
  await repository.initialize();
  const account = await repository.account();
  delete account.book.selectionPolicyVersion;
  await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
    .bind(JSON.stringify(account.book))
    .run();
  return account.book;
}
async function ownWindow(DB, id = "fixture-owner") {
  await DB.prepare(
    "INSERT INTO research_window_owners (namespace,owner_type,owner_id,window_payload,created_at) VALUES ('main','COHORT',?,'{}',?)",
  )
    .bind(id, dateAt(0))
    .run();
}

test("v4 政策摘要独立重算一致；字段缺失、改值或跨版本冒充均拒绝", async () => {
  const v4 = selectionPolicy(SELECTION_VERSION_V4);
  assert.equal(v4.brokenCandidateSource, true, "v4 启用炸板候选来源");
  assert.equal(v4.stockClassRouting, true, "v4 继承 v3 的股票分类路由");
  assert.equal(v4.scorePrecision, 6);
  assert.equal(v4.liquiditySource, "signal-day-turnover-cny");
  assert.equal(selectionPolicyDigest(v4), await digestOf(v4));
  assert.deepEqual(frozenSelectionPolicy(selectionPolicyFields(v4)), v4);
  assert.throws(
    () => selectionPolicyDigest({ ...v4, brokenCandidateSource: undefined }),
    /内容与声明版本不一致/,
  );
  assert.throws(
    () => selectionPolicyDigest({ ...v4, brokenCandidateSource: false }),
    /内容与声明版本不一致/,
  );
  // v3 内容改挂 v4 版本：字段集合不同，必须拒绝
  assert.throws(
    () =>
      selectionPolicyDigest({
        ...selectionPolicy(SELECTION_VERSION_V3),
        version: SELECTION_VERSION_V4,
      }),
    /内容与声明版本不一致/,
  );
});

test("v1 显式重跑仍沿用原有缺失覆盖字段判定，v2 从严筛选", () => {
  const snap = tiedSnapshot();
  snap.stocks.forEach((s) => delete s.coverage);
  assert.equal(
    makePlan(snap, newBook(), {
      selectionPolicy: selectionPolicy(LEGACY_SELECTION_VERSION),
    }).orders[0].code,
    "002343",
  );
  assert.equal(makePlan(snap).orders.length, 0);
});

test("炸板候选不进入候选池与建仓：即使分数达标也不产生订单", () => {
  const snap = tiedSnapshot();
  const codes = snap.stocks.map((s, i) => `6000${90 + i}`);
  snap.brokenStocks = codes.map((code, i) => ({
    ...snap.stocks[0],
    code,
    name: `炸板样本${i + 1}`,
    score: 100,
    coverage: 100,
    candidateSource: "broken",
  }));
  // v3 不并入炸板候选——v4/v5 才把 brokenStocks 纳入 candidateRows
  const v3Policy = selectionPolicy(SELECTION_VERSION_V3);
  const plan = makePlan(snap, newBook(), { selectionPolicy: v3Policy });
  assert.ok(plan.orders.length > 0, "涨停池照常建仓");
  assert.ok(
    plan.orders.every((order) => !codes.includes(order.code)),
    "不产生任何炸板来源订单",
  );
  assert.equal(
    plan.selectionAudit.candidates.some((c) => codes.includes(c.code)),
    false,
    "炸板候选不进入选股审计",
  );
  const signals = scoreSignals(
    snap,
    { ...BASE_STRATEGY, maxPositions: 1 },
    v3Policy,
  );
  assert.equal(signals.length, snap.stocks.length);
  assert.ok(
    signals.every((s) => !codes.includes(s.code)),
    "评分信号只来自涨停池",
  );
});

test("选股政策版本切换不触发当日计划重冻；无效版本拒绝", async () =>
  withDB(async (env, DB) => {
    const repo = new PaperRepository(env);
    await repo.initialize();
    // 无效版本拒绝
    await assert.rejects(
      () => repo.configure({ selectionPolicyVersion: "signal-ranking-v99" }),
      /选股政策版本无效/,
    );
    // 旧版本也拒绝（只允许 v3 / v4 / v5）
    await assert.rejects(
      () =>
        repo.configure({ selectionPolicyVersion: LEGACY_SELECTION_VERSION }),
      /选股政策版本无效/,
    );
    // 切回 v3 成功
    const v4Book = await repo.configure({
      selectionPolicyVersion: SELECTION_VERSION_V4,
    });
    assert.equal(v4Book.selectionPolicyVersion, SELECTION_VERSION_V4);
    const v3Book = await repo.configure({
      selectionPolicyVersion: SELECTION_VERSION_V3,
    });
    assert.equal(v3Book.selectionPolicyVersion, SELECTION_VERSION_V3);
    assert.equal(
      (await repo.initialize()).book.selectionPolicyVersion,
      SELECTION_VERSION_V3,
      "手动回退到 v3 后，重新初始化不能再次升级",
    );
    const next = makePlan(tiedSnapshot(), (await repo.account()).book);
    assert.equal(next.selectionPolicy.version, SELECTION_VERSION_V3);
    // 配置历史记录了变更
    const history = await repo.history("paper_configuration_history");
    assert.equal(history.length, 2);
    const changes = history.map((row) => JSON.parse(row.payload));
    const v4Change = changes.find(
      (c) => c.after.selectionPolicyVersion === SELECTION_VERSION_V4,
    );
    const v3Change = changes.find(
      (c) => c.after.selectionPolicyVersion === SELECTION_VERSION_V3,
    );
    assert.ok(v4Change, "应记录 v4 切换");
    assert.ok(v3Change, "应记录 v3 切回");
    assert.equal(
      v4Change.before.selectionPolicyVersion,
      DEFAULT_SELECTION_VERSION,
    );
    assert.equal(v3Change.before.selectionPolicyVersion, SELECTION_VERSION_V4);
  }));

test("v4 计划冻结摘要与版本一致；旧快照无 brokenStocks 时 v4 行为与 v3 一致", async () =>
  withDB(async (env, DB) => {
    const repo = new PaperRepository(env);
    const book = await repo.configure({
      selectionPolicyVersion: SELECTION_VERSION_V4,
    });
    // 旧快照（无 brokenStocks）：v4 与 v3 产出相同的信号列表
    const snap = tiedSnapshot();
    const v4Signals = scoreSignals(
      snap,
      strategy,
      selectionPolicy(SELECTION_VERSION_V4),
    );
    const v3Signals = scoreSignals(
      snap,
      strategy,
      selectionPolicy(SELECTION_VERSION_V3),
    );
    assert.deepEqual(
      v4Signals.map((s) => s.code),
      v3Signals.map((s) => s.code),
    );
    // v4 计划摘要独立重算一致
    const v4Plan = makePlan(snap, book, {
      selectionPolicy: selectionPolicy(SELECTION_VERSION_V4),
      snapshotDigest: await selectionSnapshotDigest(snap),
    });
    assert.equal(v4Plan.selectionPolicy.version, SELECTION_VERSION_V4);
    assert.equal(
      v4Plan.selectionPolicyDigest,
      selectionPolicyDigest(selectionPolicy(SELECTION_VERSION_V4)),
    );
  }));
