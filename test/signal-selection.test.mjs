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
  DEFAULT_SELECTION_VERSION,
} from "../backend/domain/signal-selection.js";
import { digestOf } from "../backend/domain/research-lineage.js";
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
  }));
  return snap;
}
const makePlan = (snap = tiedSnapshot(), book = newBook(), opts = {}) =>
  createPlan(snap, book, strategy, "fixture-v", snap.createdAt, opts);
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

test("v3 股票分类路由：按类别切换权重预设，平庸型被排除出候选池", () => {
  const snap = tiedSnapshot();
  // 002343 连板龙头（relay 权重）；002692 未分类（策略权重）；300001 平庸
  snap.stocks[0].stockClass = "relay-leader";
  delete snap.stocks[1].stockClass;
  snap.stocks.push({
    ...snap.stocks[0],
    code: "300001",
    stockClass: "mediocre",
  });
  // v2：无路由、无排除 → 三只全部参与，统一策略权重
  const v2 = scoreSignals(snap, strategy, selectionPolicy(SELECTION_VERSION_V2));
  assert.equal(v2.length, 3);
  // v3：平庸股仍保留在信号列表（持仓股依赖当日信号触发风险动作），
  // 但按策略权重评分；龙头按 relay 权重重算（[30,20,10,10,20,10] → 93.3 分），
  // 未分类的 002692 保持策略权重（balanced → 94.6 分）并反超龙头居首
  const v3 = scoreSignals(snap, strategy, selectionPolicy(DEFAULT_SELECTION_VERSION));
  assert.deepEqual(
    v3.map((s) => [s.code, s.score]),
    [
      ["002692", 95],
      ["300001", 95],
      ["002343", 93],
    ],
  );
  // 计划层（新账户默认 v3）：平庸股不出现在新增买入订单中
  const plan = makePlan(snap);
  assert.equal(
    plan.selectionAudit.candidates.find((c) => c.code === "300001").reason,
    "平庸型不进入新增候选池",
  );
  assert.equal(plan.orders.some((o) => o.code === "300001"), false);
});

test("v3 平庸剔除不影响持仓风险信号：持仓股当日走弱仍减仓，与 v2 一致", () => {
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
  const v2 = makePlan(snap, book, {
    selectionPolicy: selectionPolicy(SELECTION_VERSION_V2),
  });
  const v3 = makePlan(snap, book); // 默认 v3
  const v2Action = v2.orders.find((o) => o.code === "002343")?.action;
  const v3Action = v3.orders.find((o) => o.code === "002343")?.action;
  // 当日评分 40 < 65 → 走弱减仓；v3 不因剔除平庸而沿用旧评分做正向 T
  assert.equal(v3Action, v2Action);
  assert.equal(v3Action, "REDUCE");
});

test("v3 未持仓的平庸股：保留在候选审计中但标注不进入候选池", () => {
  const snap = tiedSnapshot();
  snap.stocks[0].stockClass = "mediocre";
  const plan = makePlan(snap); // 无持仓 → 全部为新增候选
  const audit = plan.selectionAudit.candidates.find(
    (c) => c.code === "002343",
  );
  assert.equal(audit.stockClass, "mediocre");
  assert.equal(audit.reason, "平庸型不进入新增候选池");
  assert.equal(plan.orders.some((o) => o.code === "002343"), false);
  // 未分类的另一只不受影响：排序在前，通过资格与资金检查入选
  const other = plan.selectionAudit.candidates.find(
    (c) => c.code === "002692",
  );
  assert.match(other.reason, /通过资格与资金检查/);
});

test("v2 模拟账户在窗口释放后升级到 v3，启用股票分类路由", async () =>
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
test("真实同因子并列：v2 选成交额较大者；v1 保留整数分及代码顺序", () => {
  const snap = tiedSnapshot();
  const modern = makePlan(snap);
  const legacy = makePlan(snap, newBook(), {
    selectionPolicy: selectionPolicy(LEGACY_SELECTION_VERSION),
  });
  assert.deepEqual(
    scoreSignals(snap, strategy).map((s) => [s.code, s.score, s.scoreValue]),
    [
      ["002692", 95, 94.6],
      ["002343", 95, 94.6],
    ],
  );
  assert.equal(modern.orders[0].code, "002692");
  assert.equal(modern.orders[0].liquidityAmountCents, 26_600_000_000);
  assert.equal(legacy.orders[0].code, "002343");
  assert.equal(Object.hasOwn(legacy.orders[0], "scoreValue"), false);
  assert.equal(modern.selectionAudit.candidates[1].reason, "建仓名额已用完");
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
test("政策摘要独立 SHA-256 重算一致；未知版本与同版本改内容拒绝", async () => {
  for (const version of [
    LEGACY_SELECTION_VERSION,
    SELECTION_VERSION_V2,
    DEFAULT_SELECTION_VERSION,
  ]) {
    const p = selectionPolicy(version);
    assert.equal(selectionPolicyDigest(p), await digestOf(p));
    assert.deepEqual(frozenSelectionPolicy(selectionPolicyFields(p)), p);
  }
  assert.equal(frozenSelectionPolicy({}).version, LEGACY_SELECTION_VERSION);
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
test("旧账户有活动窗口时保持 v1；释放后仅升级未来政策且留审计记录", async () =>
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
test("旧账户升级与窗口领取并发时，SQL 守卫阻止改参及伪审计写入", async () =>
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
  }));
test("盘后改费用重冻计划仍保留旧选股版本", async () =>
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
      selectionPolicy: selectionPolicy(LEGACY_SELECTION_VERSION),
    });
    await repo.savePlan(old);
    await repo.configure(
      { fees: { ...account.book.feeConfig, commission_min: 6 } },
      new Date(`${dateAt(0)}T08:00:00Z`),
    );
    assert.equal(
      (await repo.plan(dateAt(0))).selectionPolicy.version,
      LEGACY_SELECTION_VERSION,
    );
    assert.equal((await repo.plan(dateAt(0))).orders[0].code, "002343");
    assert.equal((await repo.history("paper_plan_revisions")).length, 1);
  }));
test("旧版收益回放显式选择 v1；候选与对照共享冻结政策", () => {
  const snap = tiedSnapshot();
  const day = dataset(dateAt(1), "002343");
  day.quotes["002692"] = { ...day.quotes["002343"] };
  day.minutes["002692"] = bars();
  const pairs = [{ snapshot: snap, dataset: day }];
  const legacy = replayStrategy(
    pairs,
    strategy,
    1_000_000,
    undefined,
    null,
    null,
    { selectionPolicy: selectionPolicy(LEGACY_SELECTION_VERSION) },
  );
  const modern = replayStrategy(pairs, strategy, 1_000_000);
  assert.equal(legacy.fills[0].code, "002343");
  assert.equal(modern.fills[0].code, "002692");
  const validation = validateCandidate(
    [],
    pairs,
    strategy,
    strategy,
    1_000_000,
    undefined,
    null,
    null,
    { selectionPolicy: selectionPolicy(LEGACY_SELECTION_VERSION) },
  );
  assert.equal(
    validation.baseline.selectionPolicyDigest,
    validation.candidate.selectionPolicyDigest,
  );
  assert.equal(validation.selectionPolicy.version, LEGACY_SELECTION_VERSION);
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
      { snapshotDigest: await selectionSnapshotDigest(snap) },
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
