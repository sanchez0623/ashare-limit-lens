import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_STRATEGY,
  newBook,
  scoreSignals,
  createPlan,
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
    // V5 合成候选默认命中打板；拒绝用例须显式清空买点。
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

test("新账户、缺省政策及无期初账本的重放统一默认 v5", () => {
  assert.equal(DEFAULT_SELECTION_VERSION, "signal-ranking-v5");
  assert.equal(newBook().selectionPolicyVersion, "signal-ranking-v5");
  assert.equal(selectionPolicy().version, "signal-ranking-v5");
  assert.equal(
    replayStrategy([], strategy).selectionPolicy.version,
    "signal-ranking-v5",
  );
});

test("V5 升级：存量账户受研究窗口保护，释放后仅升级一次", async () =>
  withDB(async (env, DB) => {
    const repo = new PaperRepository(env);
    const account = await repo.initialize();
    const original = {
      ...account.book,
      selectionPolicyVersion: SELECTION_VERSION_V3,
    };
    await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
      .bind(JSON.stringify(original))
      .run();
    await ownWindow(DB);
    assert.equal(
      (await repo.initialize()).book.selectionPolicyVersion,
      SELECTION_VERSION_V3,
    );
    assert.equal((await repo.history("paper_configuration_history")).length, 0);
    await DB.prepare("DELETE FROM research_window_owners").run();
    const upgraded = await repo.initialize();
    assert.deepEqual(upgraded.book, {
      ...original,
      selectionPolicyVersion: SELECTION_VERSION_V5,
    });
    await repo.initialize();
    const changes = await repo.history("paper_configuration_history");
    assert.equal(changes.length, 1);
    assert.equal(
      JSON.parse(changes[0].payload).before.selectionPolicy.version,
      SELECTION_VERSION_V3,
    );
    assert.equal(
      JSON.parse(changes[0].payload).after.selectionPolicy.version,
      SELECTION_VERSION_V5,
    );
  }));

test("V5 评分及覆盖门槛：仅标记 extra 而无合格 EOD 买点不能豁免", () => {
  const snap = tiedSnapshot();
  for (const stock of snap.stocks) stock.coverage = 30;
  snap.stocks[0].candidateSource = "extra";
  assert.equal(makePlan(snap).orders.length, 0);
  for (const stock of snap.stocks) {
    stock.coverage = 100;
    stock.factors = Array.from({ length: 6 }, () => ({ value: 20 }));
  }
  assert.equal(makePlan(snap).orders.length, 0);
});

test("V5 股票分类路由：按类别切换权重，平庸型禁止新增建仓", () => {
  const snap = tiedSnapshot();
  snap.stocks[0].stockClass = "relay-leader";
  delete snap.stocks[1].stockClass;
  snap.stocks.push({
    ...snap.stocks[0],
    code: "300001",
    stockClass: "mediocre",
  });
  const signals = scoreSignals(
    snap,
    strategy,
    selectionPolicy(SELECTION_VERSION_V5),
  );
  assert.deepEqual(
    signals.map((s) => [s.code, s.score]),
    [
      ["002692", 95],
      ["300001", 95],
      ["002343", 93],
    ],
  );
  const plan = makePlan(snap);
  assert.equal(plan.selectionPolicy.version, SELECTION_VERSION_V5);
  assert.equal(
    plan.selectionAudit.candidates.find((c) => c.code === "300001").reason,
    "平庸型不进入新增候选池",
  );
  assert.equal(
    plan.orders.some((o) => o.code === "300001"),
    false,
  );
});

test("V5 平庸剔除不影响持仓风险信号：当日走弱仍减仓", () => {
  const snap = tiedSnapshot();
  // 002343：已持仓且当日被判定平庸（评分 40，旧分可能很高）
  snap.stocks[0].stockClass = "mediocre";
  snap.stocks[0].factors = [40, 40, 40, 40, 40, 40].map((value) => ({
    value,
  }));
  snap.stocks[0].deduction = 0;
  const book = newBook(100000);
  book.positions = [
    {
      code: "002343",
      name: snap.stocks[0].name,
      sector: snap.stocks[0].sector,
      heldDays: 0,
      markCents: 1_000_000,
      lots: [
        {
          acquiredDate: dateAt(0),
          quantity: 1000,
          costCents: 1_000_000,
          priceCents: 1_000_000,
        },
      ],
    },
  ];
  book.cashCents = book.initialCashCents - 1_000_000;
  book.equityCents = book.initialCashCents;
  book.peakEquityCents = book.equityCents;
  const plan = makePlan(snap, book);
  assert.equal(plan.selectionPolicy.version, SELECTION_VERSION_V5);
  assert.equal(plan.orders.find((o) => o.code === "002343")?.action, "REDUCE");
});

test("V5 未持仓的平庸股：保留在候选审计中但标注不进入候选池", () => {
  const snap = tiedSnapshot();
  snap.stocks[0].stockClass = "mediocre";
  const plan = makePlan(snap); // 无持仓 → 全部为新增候选
  const audit = plan.selectionAudit.candidates.find((c) => c.code === "002343");
  assert.equal(audit.stockClass, "mediocre");
  assert.equal(audit.reason, "平庸型不进入新增候选池");
  assert.equal(
    plan.orders.some((o) => o.code === "002343"),
    false,
  );
  // 未分类的另一只不受影响：排序在前，通过资格与资金检查入选
  const other = plan.selectionAudit.candidates.find((c) => c.code === "002692");
  assert.match(other.reason, /通过资格与资金检查/);
});

test("v5 政策摘要独立重算一致；字段缺失、改值或跨版本冒充均拒绝", async () => {
  const v5 = selectionPolicy(SELECTION_VERSION_V5);
  assert.equal(v5.brokenCandidateSource, true, "V5 启用炸板候选来源");
  assert.equal(v5.extraCandidateSource, true, "v5 启用 EOD 候选来源");
  assert.equal(v5.stockClassRouting, true, "V5 启用股票分类路由");
  assert.equal(v5.scorePrecision, 6);
  assert.equal(v5.liquiditySource, "signal-day-turnover-cny");
  assert.equal(selectionPolicyDigest(v5), await digestOf(v5));
  assert.deepEqual(frozenSelectionPolicy(selectionPolicyFields(v5)), v5);
  assert.throws(
    () => selectionPolicyDigest({ ...v5, extraCandidateSource: undefined }),
    /内容与声明版本不一致/,
  );
  assert.throws(
    () => selectionPolicyDigest({ ...v5, extraCandidateSource: false }),
    /内容与声明版本不一致/,
  );
  // v4 内容改挂 v5 版本：字段集合不同，必须拒绝
  assert.throws(
    () =>
      selectionPolicyDigest({
        ...selectionPolicy(SELECTION_VERSION_V4),
        version: SELECTION_VERSION_V5,
      }),
    /内容与声明版本不一致/,
  );
});

test("V5 买点闸门放行打板和炸板低吸，EOD 买点由额外候选资格处理", () => {
  const gate = buyPointGateForPolicy(selectionPolicy(SELECTION_VERSION_V5));
  assert.ok(gate instanceof Set);
  assert.deepEqual(
    [...gate].sort(),
    [
      BUY_POINT_TYPES.LIMIT_UP_MOMENTUM,
      BUY_POINT_TYPES.BROKEN_BOARD_DIP,
    ].sort(),
  );
  assert.equal(gate.has(BUY_POINT_TYPES.FIRST_NEG_DIP), false);
  assert.equal(gate.has(BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP), false);
  assert.deepEqual(buyPointGateForPolicy(selectionPolicy()), gate);
});

test("V5 把炸板候选并入信号；缺少可选候选池时仍可评分", () => {
  const snap = tiedSnapshot();
  snap.brokenStocks = [
    {
      ...snap.stocks[1],
      code: "300999",
      name: "合成炸板样本",
      amount: 52_000_000,
      candidateSource: "broken",
    },
  ];
  const signals = scoreSignals(
    snap,
    strategy,
    selectionPolicy(SELECTION_VERSION_V5),
  );
  assert.equal(signals.length, snap.stocks.length + 1);
  assert.equal(signals.at(-1).code, "300999");
  assert.equal(signals.at(-1).candidateSource, "broken");
  const withoutPools = tiedSnapshot();
  assert.deepEqual(
    scoreSignals(withoutPools, strategy),
    scoreSignals(
      { ...withoutPools, brokenStocks: [], extraStocks: [] },
      strategy,
    ),
  );
});

test("V5 建仓闸门：无合格买点被拒并记因，炸板低吸候选放行", () => {
  const snap = tiedSnapshot();
  // 涨停池候选无买点（一字板低换手被排除、或涨停但无打板形态）
  for (const stock of snap.stocks)
    stock.buyPoint = { primary: null, all: [], labels: [] };
  // 炸板候选命中炸板低吸（回落 3–7% 安全垫）
  snap.brokenStocks = [
    {
      ...snap.stocks[1],
      code: "300999",
      name: "合成炸板样本",
      amount: 52_000_000,
      coverage: 94,
      height: 1,
      risks: [],
      candidateSource: "broken",
      buyPoint: {
        primary: { type: BUY_POINT_TYPES.BROKEN_BOARD_DIP, confidence: 0.75 },
        all: [{ type: BUY_POINT_TYPES.BROKEN_BOARD_DIP, confidence: 0.75 }],
        labels: [BUY_POINT_TYPES.BROKEN_BOARD_DIP],
      },
    },
  ];
  const v5Policy = selectionPolicy(SELECTION_VERSION_V5);
  const plan = makePlan(snap, newBook(), { selectionPolicy: v5Policy });
  assert.equal(plan.orders.length, 1);
  assert.equal(plan.orders[0].code, "300999");
  assert.equal(
    plan.selectionAudit.candidates.find((c) => c.code === "002343").reason,
    "买点未命中建仓闸门（仅放行打板 / 炸板低吸）",
  );
  assert.match(
    plan.selectionAudit.candidates.find((c) => c.code === "300999").reason,
    /通过资格与资金检查/,
  );
  // 闸门只约束新增建仓：持仓的风险保护动作不被闸门拦下
  const book = newBook(100000);
  book.positions = [
    {
      code: "002343",
      name: snap.stocks[0].name,
      sector: snap.stocks[0].sector,
      heldDays: 0,
      markCents: 1_000_000,
      lots: [
        {
          acquiredDate: dateAt(0),
          quantity: 1000,
          costCents: 1_000_000,
          priceCents: 1_000_000,
        },
      ],
    },
  ];
  book.cashCents = book.initialCashCents - 1_000_000;
  book.equityCents = book.initialCashCents;
  book.peakEquityCents = book.equityCents;
  // 002343 当日走弱（评分 40 < 65）：V5 闸门不得拦下走弱减仓
  snap.stocks[0].factors = [40, 40, 40, 40, 40, 40].map((value) => ({
    value,
  }));
  snap.stocks[0].deduction = 0;
  const gated = makePlan(snap, book, { selectionPolicy: v5Policy });
  assert.equal(
    gated.orders.find((o) => o.code === "002343")?.action,
    "REDUCE",
    "V5 闸门不改变持仓的走弱减仓",
  );
});

test("v5 把 EOD 候选并入信号；买点合格候选豁免覆盖/评分检查", () => {
  const v5Policy = selectionPolicy(SELECTION_VERSION_V5);
  const snap = tiedSnapshot();
  // EOD 候选：评分因子结构性缺失（覆盖 30 < 80），但买点合格（首阴低吸）
  snap.extraStocks = [
    {
      ...snap.stocks[1],
      code: "600999",
      name: "合成首阴样本",
      coverage: 30,
      score: 25,
      height: 0,
      amount: null,
      risks: [],
      candidateSource: "extra",
      buyPoint: {
        primary: { type: BUY_POINT_TYPES.FIRST_NEG_DIP },
        all: [{ type: BUY_POINT_TYPES.FIRST_NEG_DIP }],
        labels: [BUY_POINT_TYPES.FIRST_NEG_DIP],
      },
    },
    {
      ...snap.stocks[1],
      code: "600998",
      name: "合成假阴样本",
      coverage: 25,
      score: 20,
      height: 0,
      amount: null,
      risks: [],
      candidateSource: "extra",
      buyPoint: {
        primary: { type: BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP },
        all: [{ type: BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP }],
        labels: [BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP],
      },
    },
  ];
  // v5 把 extraStocks 并入信号
  const v5Signals = scoreSignals(snap, strategy, v5Policy);
  assert.equal(v5Signals.length, snap.stocks.length + 2);
  assert.ok(v5Signals.some((s) => s.code === "600999"));
  assert.ok(v5Signals.some((s) => s.code === "600998"));
  const withoutExtra = tiedSnapshot();
  assert.deepEqual(
    scoreSignals(withoutExtra, strategy, v5Policy),
    scoreSignals({ ...withoutExtra, extraStocks: [] }, strategy, v5Policy),
  );
});

test("v5 建仓闸门：买点合格候选豁免覆盖/评分，不合格候选仍被拦", () => {
  const snap = tiedSnapshot();
  // 涨停池候选无买点（所有 buyPoint.labels 为空）
  for (const stock of snap.stocks)
    stock.buyPoint = { primary: null, all: [], labels: [] };
  // EOD 候选 1：首阴低吸，覆盖率极低但买点合格
  snap.extraStocks = [
    {
      ...snap.stocks[1],
      code: "600999",
      name: "合成首阴样本",
      coverage: 30,
      score: 25,
      height: 0,
      amount: null,
      risks: [],
      candidateSource: "extra",
      buyPoint: {
        primary: { type: BUY_POINT_TYPES.FIRST_NEG_DIP },
        all: [{ type: BUY_POINT_TYPES.FIRST_NEG_DIP }],
        labels: [BUY_POINT_TYPES.FIRST_NEG_DIP],
      },
    },
    // EOD 候选 2：假阴跌停低吸，覆盖率低但买点合格
    {
      ...snap.stocks[1],
      code: "600998",
      name: "合成分批样本",
      coverage: 20,
      score: 15,
      height: 0,
      amount: null,
      risks: [],
      candidateSource: "extra",
      buyPoint: {
        primary: { type: BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP },
        all: [{ type: BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP }],
        labels: [BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP],
      },
    },
    // EOD 候选 3：无买点（不在闸门内），覆盖/评分达标但被闸门拦
    {
      ...snap.stocks[1],
      code: "600997",
      name: "合成无买点样本",
      coverage: 90,
      score: 85,
      height: 0,
      amount: null,
      risks: [],
      candidateSource: "extra",
      buyPoint: { primary: null, all: [], labels: [] },
    },
  ];
  const v5Policy = selectionPolicy(SELECTION_VERSION_V5);
  const v5Strategy = { ...BASE_STRATEGY, maxPositions: 4 };
  const plan = createPlan(
    snap,
    newBook(),
    v5Strategy,
    "fixture-v",
    snap.createdAt,
    {
      ...emptyTQualityInputs(snap.date),
      selectionPolicy: v5Policy,
    },
  );
  // 两种有效 EOD 买点豁免评分/覆盖，来源标记不能豁免买点检查。
  assert.ok(
    plan.orders.some((o) => o.code === "600999"),
    "首阴低吸额外候选应通过建仓",
  );
  assert.ok(
    plan.orders.some((o) => o.code === "600998"),
    "假阴跌停低吸额外候选应通过建仓",
  );
  assert.ok(
    !plan.orders.some((o) => o.code === "600997"),
    "无买点额外候选必须被闸门拦截",
  );
  // 涨停池候选（无买点）应被闸门拦
  assert.equal(
    plan.selectionAudit.candidates.find((c) => c.code === "002343").reason,
    "买点未命中建仓闸门（仅放行打板 / 炸板低吸）",
  );
});

test("V5 升级：旧账户升级后启用当前选股政策", async () =>
  withDB(async (env, DB) => {
    const repo = new PaperRepository(env);
    const book = (await repo.initialize()).book;
    book.selectionPolicyVersion = SELECTION_VERSION_V2;
    await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
      .bind(JSON.stringify(book))
      .run();
    assert.equal(
      selectionPolicyForBook((await repo.account()).book).version,
      SELECTION_VERSION_V2,
    );
    await repo.upgradeSelectionPolicy();
    assert.equal(
      selectionPolicyForBook((await repo.account()).book).version,
      DEFAULT_SELECTION_VERSION,
    );
  }));
test("V5 真实同因子并列按成交额决胜，保留输入顺序与候选跳过原因", () => {
  const snap = tiedSnapshot();
  const plan = makePlan(snap);
  assert.deepEqual(
    scoreSignals(snap, strategy).map((s) => [s.code, s.score, s.scoreValue]),
    [
      ["002692", 95, 94.6],
      ["002343", 95, 94.6],
    ],
  );
  assert.equal(plan.selectionPolicy.version, SELECTION_VERSION_V5);
  assert.equal(plan.orders[0].code, "002692");
  assert.equal(plan.orders[0].liquidityAmountCents, 26_600_000_000);
  assert.equal(plan.selectionAudit.candidates[1].reason, "建仓名额已用完");
  assert.deepEqual(snap, tiedSnapshot(), "排序不能修改归档评分或快照顺序");
});
test("整数展示并列先比较精确分，未知成交额不盖过较高分", () => {
  const snap = tiedSnapshot();
  snap.stocks[0].factors.forEach((f) => (f.value = 94.55));
  snap.stocks[1].factors.forEach((f) => (f.value = 94.64));
  snap.stocks[1].amount = null;
  assert.deepEqual(
    scoreSignals(snap, strategy).map((s) => [s.code, s.score]),
    [
      ["002692", 95],
      ["002343", 95],
    ],
  );
});
test("权重、风险扣分及缺失因子按实际策略计算，不使用快照 rawScore", () => {
  const snap = tiedSnapshot();
  snap.stocks[0].factors = [100, null, 50, null, null, null].map((value) => ({
    value,
  }));
  snap.stocks[0].deduction = 10;
  const ranked = scoreSignals(snap, {
    ...strategy,
    weights: [10, 30, 30, 10, 10, 10],
  });
  const stock = ranked.find((s) => s.code === "002343");
  assert.equal(stock.scoreValue, 52.5);
  assert.equal(stock.score, 53);
  snap.stocks[0].deduction = 100;
  assert.equal(
    scoreSignals(snap, strategy).find((s) => s.code === "002343").scoreValue,
    0,
  );
});
test("阈值仍使用整数分：79.6 满足原 80 分门槛", () => {
  const snap = tiedSnapshot();
  snap.stocks.forEach((s) => s.factors.forEach((f) => (f.value = 79.6)));
  assert.equal(makePlan(snap).orders.length, 1);
  assert.equal(makePlan(snap).orders[0].score, 80);
  snap.stocks.forEach((s) => s.factors.forEach((f) => (f.value = 79.49)));
  assert.equal(makePlan(snap).orders.length, 0);
});
test("六位比较精度固定，微差归一化后仍按成交额稳定决胜", () => {
  const snap = tiedSnapshot();
  snap.stocks[0].factors.forEach((f) => (f.value = 90.0000001));
  snap.stocks[1].factors.forEach((f) => (f.value = 90.0000002));
  const rows = scoreSignals(snap, strategy);
  assert.equal(rows[0].scoreRankKey, 90_000_000);
  assert.equal(rows[1].scoreRankKey, 90_000_000);
  assert.equal(rows[0].code, "002692");
});
test("成交额为零、负数、字符串、非有限数或溢出均按未知处理", () => {
  for (const value of [
    null,
    undefined,
    0,
    -1,
    "266000000",
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ]) {
    assert.equal(liquidityAmountCents(value), null);
    const snap = tiedSnapshot();
    snap.stocks[1].amount = value;
    assert.equal(makePlan(snap).orders[0].code, "002343");
  }
  const snap = tiedSnapshot();
  snap.stocks.forEach((s) => (s.amount = null));
  assert.equal(makePlan(snap).orders[0].code, "002343");
  snap.stocks.forEach((s) => (s.amount = 100));
  assert.equal(makePlan(snap).orders[0].code, "002343");
});
test("缺失评分或覆盖不能入选；重复股票代码拒绝生成计划", () => {
  const snap = tiedSnapshot();
  snap.stocks[1].factors.forEach((f) => (f.value = null));
  snap.stocks[0].coverage = undefined;
  assert.equal(makePlan(snap).orders.length, 0);
  assert.ok(
    makePlan(snap).selectionAudit.candidates.every(
      (c) => c.status === "SKIPPED",
    ),
  );
  snap.stocks[1].code = snap.stocks[0].code;
  assert.throws(() => makePlan(snap), /重复股票代码/);
});

test("打乱股票和板块输入不改变排序、规范化快照摘要及计划摘要", async () => {
  const snap = tiedSnapshot();
  snap.sectors.push({ name: "另一行业", score: 70 });
  const sourceDigest = await selectionSnapshotDigest(snap);
  const first = makePlan(snap, newBook(), { snapshotDigest: sourceDigest });
  const reversed = {
    ...snap,
    stocks: [...snap.stocks].reverse(),
    sectors: [...snap.sectors].reverse(),
  };
  assert.equal(await selectionSnapshotDigest(reversed), sourceDigest);
  assert.equal(
    await digest(
      makePlan(reversed, newBook(), {
        snapshotDigest: await selectionSnapshotDigest(reversed),
      }),
    ),
    await digest(first),
  );
  reversed.stocks[0] = { ...reversed.stocks[0], amount: 2 };
  assert.notEqual(await selectionSnapshotDigest(reversed), sourceDigest);
});
test("V5 涨停、炸板和 EOD 候选共同冻结摘要，乱序不改变计划", async () => {
  const snap = tiedSnapshot();
  const originalDigest = await selectionSnapshotDigest(snap);
  snap.brokenStocks = [
    {
      ...snap.stocks[0],
      code: "600999",
      name: "炸板乙",
      candidateSource: "broken",
    },
    {
      ...snap.stocks[1],
      code: "600003",
      name: "炸板甲",
      candidateSource: "broken",
    },
  ];
  snap.extraStocks = [
    {
      ...snap.stocks[0],
      code: "600998",
      candidateSource: "extra",
      buyPoint: {
        primary: { type: BUY_POINT_TYPES.FIRST_NEG_DIP },
        all: [{ type: BUY_POINT_TYPES.FIRST_NEG_DIP }],
        labels: [BUY_POINT_TYPES.FIRST_NEG_DIP],
      },
    },
  ];
  const snapshotDigest = await selectionSnapshotDigest(snap);
  assert.notEqual(snapshotDigest, originalDigest);
  const reversed = { ...snap, brokenStocks: [...snap.brokenStocks].reverse() };
  assert.equal(await selectionSnapshotDigest(reversed), snapshotDigest);
  assert.equal(
    await digest(makePlan(reversed, newBook(), { snapshotDigest })),
    await digest(makePlan(snap, newBook(), { snapshotDigest })),
  );
  const changed = structuredClone(snap);
  changed.extraStocks[0].amount = 1;
  assert.notEqual(await selectionSnapshotDigest(changed), snapshotDigest);
});

test("V5 冻结政策拒绝未知版本、缺失摘要和内容篡改", async () => {
  assert.throws(() => selectionPolicy("__proto__"), /不受支持/);
  assert.throws(
    () => frozenSelectionPolicy({ selectionPolicy: selectionPolicy() }),
    /摘要/,
  );
  assert.throws(
    () =>
      frozenSelectionPolicy({
        ...selectionPolicyFields(selectionPolicy()),
        selectionPolicyDigest: "wrong",
      }),
    /摘要/,
  );
  assert.throws(
    () => selectionPolicyDigest({ ...selectionPolicy(), scorePrecision: 2 }),
    /内容/,
  );
});
test("现金、单股及总仓位约束逐笔应用，不预支尚未成交的卖出现金", () => {
  const book = newBook();
  book.riskLimits = {
    ...book.riskLimits,
    maxPositionWeight: 0.1,
    maxGrossExposure: 0.15,
  };
  const plan = createPlan(
    tiedSnapshot(),
    book,
    { ...strategy, maxPositions: 4 },
    "v",
    dateAt(0),
    emptyTQualityInputs(dateAt(0)),
  );
  const total = plan.orders.reduce(
    (sum, o) => sum + o.quantity * o.referenceCents,
    0,
  );
  assert.ok(
    plan.orders.every(
      (o) => o.quantity * o.referenceCents <= book.equityCents * 0.1,
    ),
  );
  assert.ok(total <= book.equityCents * 0.15);
  const cash = newBook();
  cash.cashCents = 700_000;
  const limited = createPlan(
    tiedSnapshot(),
    cash,
    { ...strategy, maxPositions: 4 },
    "v",
    dateAt(0),
    emptyTQualityInputs(dateAt(0)),
  );
  const cost = limited.orders.reduce(
    (sum, o) =>
      sum +
      o.quantity * o.referenceCents +
      transactionFees(o.quantity * o.referenceCents, "BUY").total,
    0,
  );
  assert.ok(cost <= cash.cashCents);
});
test("主账户和影子计划使用同一政策与快照；重复冻结不覆盖旧计划", async () =>
  withDB(async (env, DB) => {
    const repo = new PaperRepository(env);
    const account = await repo.initialize();
    const snap = tiedSnapshot();
    await saveSnapshot(DB, snap);
    const shadows = new ShadowAccountRepository(env);
    await shadows.ensureAccount("shadow-test", {
      kind: "CANDIDATE",
      book: account.book,
    });
    const main = await repo.savePlan(
      makePlan(snap, account.book, {
        snapshotDigest: await selectionSnapshotDigest(snap),
      }),
    );
    const shadow = await freezePortfolioPlan(env, "shadow-test", {
      snapshot: snap,
      strategy,
      strategyVersion: "fixture-v",
      now: snap.createdAt,
    });
    const { digest: ignored, ...shadowPayload } = shadow;
    assert.deepEqual(shadowPayload, main);
    const again = await freezePortfolioPlan(env, "shadow-test", {
      snapshot: { ...snap, stocks: [...snap.stocks].reverse() },
      strategy,
      strategyVersion: "new",
      now: "later",
    });
    assert.equal(again.digest, ignored);
  }));
test("V5 升级保留已冻结旧计划，活动窗口释放后仅更新未来政策", async () =>
  withDB(async (env, DB) => {
    const repo = new PaperRepository(env);
    const book = await oldAccount(repo, DB);
    const old = makePlan(tiedSnapshot(), book);
    await repo.savePlan(old);
    await ownWindow(DB);
    assert.equal(
      selectionPolicyForBook((await repo.initialize()).book).version,
      LEGACY_SELECTION_VERSION,
    );
    await DB.prepare("DELETE FROM research_window_owners").run();
    assert.equal(
      (await repo.initialize()).book.selectionPolicyVersion,
      DEFAULT_SELECTION_VERSION,
    );
    assert.deepEqual(await repo.plan(old.signalDate), old);
    assert.equal((await repo.history("paper_configuration_history")).length, 1);
    await repo.initialize();
    assert.equal((await repo.history("paper_configuration_history")).length, 1);
  }));
test("V5 升级与窗口领取并发时先阻止写入，窗口释放后正常升级", async () =>
  withDB(async (env, DB) => {
    const repo = new PaperRepository(env);
    await oldAccount(repo, DB);
    const batch = DB.batch.bind(DB);
    DB.batch = async (statements) => {
      await ownWindow(DB, "concurrent");
      return batch(statements);
    };
    await repo.upgradeSelectionPolicy();
    assert.equal(
      selectionPolicyForBook((await repo.account()).book).version,
      LEGACY_SELECTION_VERSION,
    );
    assert.equal((await repo.history("paper_configuration_history")).length, 0);
    DB.batch = batch;
    await DB.prepare("DELETE FROM research_window_owners").run();
    await repo.upgradeSelectionPolicy();
    assert.equal(
      (await repo.account()).book.selectionPolicyVersion,
      SELECTION_VERSION_V5,
    );
    assert.equal((await repo.history("paper_configuration_history")).length, 1);
  }));
test("V5 盘后改费用重冻计划保留当前政策及成交额排序", async () =>
  withDB(async (env, DB) => {
    const repo = new PaperRepository(env);
    await repo.initialize();
    const account = await repo.account();
    account.book.lastDate = dateAt(0);
    await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
      .bind(JSON.stringify(account.book))
      .run();
    await saveSnapshot(DB, tiedSnapshot());
    const old = makePlan(tiedSnapshot(), account.book, {
      selectionPolicy: selectionPolicy(SELECTION_VERSION_V5),
    });
    await repo.savePlan(old);
    await repo.configure(
      { fees: { ...account.book.feeConfig, commission_min: 6 } },
      new Date(`${dateAt(0)}T08:00:00Z`),
    );
    assert.equal(
      (await repo.plan(dateAt(0))).selectionPolicy.version,
      SELECTION_VERSION_V5,
    );
    assert.equal((await repo.plan(dateAt(0))).orders[0].code, "002692");
    assert.equal((await repo.history("paper_plan_revisions")).length, 1);
  }));
test("V5 收益回放与候选验证共用冻结政策及摘要", () => {
  const snap = tiedSnapshot();
  const day = dataset(dateAt(1), "002343");
  day.quotes["002692"] = { ...day.quotes["002343"] };
  day.minutes["002692"] = bars();
  const pairs = [{ snapshot: snap, dataset: day }];
  const replay = replayStrategy(pairs, strategy, 1_000_000);
  assert.equal(replay.fills[0].code, "002692");
  assert.equal(replay.selectionPolicy.version, SELECTION_VERSION_V5);
  const validation = validateCandidate(
    [],
    pairs,
    strategy,
    strategy,
    1_000_000,
    undefined,
    null,
    null,
    {
      selectionPolicy: selectionPolicy(SELECTION_VERSION_V5),
    },
  );
  assert.equal(
    validation.baseline.selectionPolicyDigest,
    validation.candidate.selectionPolicyDigest,
  );
  assert.equal(validation.selectionPolicy.version, SELECTION_VERSION_V5);
  assert.equal(validation.selectionPolicyDigest, replay.selectionPolicyDigest);
});
test("冻结政策被篡改后日线、首次会话及后续帧均拒绝，不修改账本", () => {
  const book = newBook();
  book.lastDate = dateAt(0);
  const plan = makePlan();
  const bad = structuredClone(plan);
  bad.selectionPolicy.scorePrecision = 2;
  assert.throws(
    () => executePlan(book, bad, dataset(dateAt(1), "002692")),
    /选股政策/,
  );
  assert.throws(() => openSession(book, bad, dateAt(1)), /选股政策/);
  const session = openSession(book, plan, dateAt(1));
  session.plan.selectionPolicyDigest = "wrong";
  assert.throws(
    () =>
      advanceSession(book, session, {
        observedAt: `${dateAt(1)}T01:31:00Z`,
        quotes: {},
      }),
    /选股政策/,
  );
  assert.equal(book.positions.length, 0);
});
test("晋级核验逐日真实计划，拒绝混用排序版本或篡改计划摘要", async () =>
  withDB(async (env, DB) => {
    const shadows = new ShadowAccountRepository(env);
    const manifest = {
      captureDate: dateAt(0),
      windowDates: [dateAt(1)],
      ...selectionPolicyFields(selectionPolicy()),
    };
    assert.equal(await portfolioSelectionMatches(env, "a", manifest), false);
    const p = makePlan();
    await shadows.savePlan("a", p);
    assert.equal(await portfolioSelectionMatches(env, "a", manifest), true);
    const bad = {
      ...p,
      ...selectionPolicyFields(selectionPolicy(LEGACY_SELECTION_VERSION)),
    };
    await DB.prepare(
      "UPDATE shadow_plans SET payload=?,digest=? WHERE account_id='a'",
    )
      .bind(JSON.stringify(bad), await digest(bad))
      .run();
    assert.equal(await portfolioSelectionMatches(env, "a", manifest), false);
    await DB.prepare("UPDATE shadow_plans SET payload=? WHERE account_id='a'")
      .bind(JSON.stringify(p))
      .run();
    assert.equal(await portfolioSelectionMatches(env, "a", manifest), false);
  }));
test("模拟三轮完整建仓清仓，保存订单独立回放收益一致", async () => {
  let book = newBook();
  const opening = structuredClone(book);
  const plans = [],
    datasets = [],
    ledger = [],
    equities = [],
    snapshots = [];
  for (let index = 1; index <= 6; index++) {
    const snap = tiedSnapshot(dateAt(index - 1));
    const p = createPlan(
      snap,
      book,
      { ...strategy, maxHoldDays: 1 },
      "round-fixture",
      snap.createdAt,
      {
        snapshotDigest: await selectionSnapshotDigest(snap),
        // 方案 7：快照已启用做T质量规则，计划必须携带摘要与证据
        ...emptyTQualityInputs(snap.date),
      },
    );
    const d = dataset(dateAt(index), "002692", {
      previousDate: dateAt(index - 1),
    });
    const result = executePlan(book, p, d);
    plans.push({ payload: p, digest: await digest(p) });
    datasets.push({ payload: d, digest: await digest(d) });
    snapshots.push(snap);
    ledger.push(...result.ledger);
    equities.push(result.equity);
    book = result.book;
    assert.equal(book.positions.length, index % 2);
  }
  assert.equal(ledger.filter((f) => f.side === "BUY").length, 3);
  assert.equal(ledger.filter((f) => f.side === "SELL").length, 3);
  assert.equal(book.cashCents - book.initialCashCents, book.realizedPnlCents);
  // verifyExport 约定首日为无计划的期初结算，再依次执行冻结计划。
  const initial = executePlan(
    opening,
    null,
    dataset(dateAt(0), "002692", { previousDate: dateAt(-1) }),
  );
  const bundle = {
    initialCashCents: book.initialCashCents,
    book,
    plans,
    datasets: [
      {
        payload: dataset(dateAt(0), "002692", { previousDate: dateAt(-1) }),
        digest: await digest(
          dataset(dateAt(0), "002692", { previousDate: dateAt(-1) }),
        ),
      },
      ...datasets,
    ],
    snapshots,
    ledger,
    equities: [initial.equity, ...equities],
  };
  assert.equal((await verifyExport(bundle)).passed, true);
  const tampered = structuredClone(bundle);
  tampered.snapshots[0].stocks[1].amount = 1;
  assert.equal((await verifyExport(tampered)).passed, false);
});

test("V5 账户配置在后续计划冻结 EOD 候选及买点闸门，无效版本不改写账户", async () =>
  withDB(async (env, DB) => {
    const repo = new PaperRepository(env);
    await repo.initialize();
    // 新账户默认 v5
    assert.equal(
      (await repo.account()).book.selectionPolicyVersion,
      DEFAULT_SELECTION_VERSION,
    );
    await assert.rejects(
      () => repo.configure({ selectionPolicyVersion: "signal-ranking-v99" }),
      /选股政策版本无效/,
    );
    assert.equal(
      (await repo.account()).book.selectionPolicyVersion,
      SELECTION_VERSION_V5,
    );
    // 保存 V5 配置
    const book = await repo.configure({
      selectionPolicyVersion: SELECTION_VERSION_V5,
    });
    assert.equal(book.selectionPolicyVersion, SELECTION_VERSION_V5);
    // 下一份计划冻结 v5 政策
    const snap = tiedSnapshot();
    snap.extraStocks = [
      {
        ...snap.stocks[0],
        code: "600999",
        candidateSource: "extra",
        buyPoint: {
          primary: { type: BUY_POINT_TYPES.FIRST_NEG_DIP },
          all: [{ type: BUY_POINT_TYPES.FIRST_NEG_DIP }],
          labels: [BUY_POINT_TYPES.FIRST_NEG_DIP],
        },
      },
    ];
    const plan = await repo.savePlan(makePlan(snap, book));
    assert.equal(plan.selectionPolicy.version, SELECTION_VERSION_V5);
    assert.equal(plan.selectionPolicy.extraCandidateSource, true);
    assert.equal(plan.selectionPolicy.brokenCandidateSource, true);
  }));
