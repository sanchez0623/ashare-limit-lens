import test from "node:test";
import assert from "node:assert/strict";
import { snapshot, dataset, bars, dateAt } from "./fixtures/trading.mjs";
import {
  BASE_STRATEGY,
  newBook,
  createPlan,
  executePlan,
  totalQuantity,
  assertProgramSnapshot,
} from "../backend/domain/trading.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../backend/domain/realtime.js";
import {
  familyEligibility,
  assertProgramPlan,
} from "../backend/domain/strategy-program.js";
import {
  familyProgram,
  normalizeStrategyProgram,
  STRATEGY_SPACE_VERSION,
} from "../shared/strategy-program.js";
import {
  validateStrategyCandidate,
  programTemplates,
} from "../backend/domain/strategy-catalog.js";
import { DEFAULT_RESEARCH_POLICY } from "../backend/domain/research-policy.js";
import { normalizeStrategyParams } from "../shared/strategy-params.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { assertStoredProgramPlan } from "../backend/services/strategy-program-evidence.js";
import {
  frozenProgramSignal,
  exportProgramSignals,
} from "../backend/storage/strategy-signals.js";

test("冻结信号独立于展示归档；同日重算后可继续原计划，程序降级与版本混用被拒", async () => {
  const { book, source, strategy, plan } = fixture(allocation());
  const DB = localDatabase();
  try {
    const papers = new PaperRepository({ DB });
    await papers.initialize();
    await DB.prepare(
      "INSERT INTO strategy_versions(id,created_at,status,params,evidence) VALUES(?,?,'SHADOW_PENDING',?,'{}')",
    )
      .bind(plan.strategyVersion, plan.createdAt, JSON.stringify(strategy))
      .run();
    await DB.prepare(
      "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
    )
      .bind(source.date, source.createdAt, JSON.stringify(source))
      .run();
    const saved = await papers.savePlan(plan);
    await assertStoredProgramPlan({ DB }, saved, book);
    const recomputed = { ...source, emotion: 20 };
    await DB.prepare("UPDATE snapshots SET payload=? WHERE trade_date=?")
      .bind(JSON.stringify(recomputed), source.date)
      .run();
    await assertStoredProgramPlan({ DB }, saved, book);
    assert.deepEqual(await frozenProgramSignal(DB, saved), source);
    assert.deepEqual(await papers.savePlan(saved), saved);
    assert.equal((await exportProgramSignals(DB, [saved, saved])).length, 1);
    await assert.rejects(
      () =>
        DB.prepare("UPDATE strategy_signal_snapshots SET payload='{}'").run(),
      /不可修改/,
    );
    await assert.rejects(
      () => DB.prepare("DELETE FROM strategy_signal_snapshots").run(),
      /不可删除/,
    );
    const downgraded = structuredClone(saved);
    delete downgraded.strategy.program;
    delete downgraded.strategyProgram;
    await assert.rejects(
      () => assertStoredProgramPlan({ DB }, downgraded, book),
      /登记策略版本/,
    );
    const mutated = structuredClone(saved);
    mutated.strategy.minScore += 2;
    await assert.rejects(
      () => assertStoredProgramPlan({ DB }, mutated, book),
      /登记策略版本/,
    );
  } finally {
    DB.close();
  }
});

const ref = (familyId) => ({ familyId, familyVersion: 1 });
function sample() {
  const input = snapshot(dateAt(0));
  input.stocks.push({
    ...structuredClone(input.stocks[0]),
    code: "600003",
    height: 3,
    consecutiveBoards: 3,
  });
  input.stocks.forEach((stock, index) => {
    stock.turnover = index === 1 ? 15 : 5;
    stock.consecutiveBoards ??= stock.height;
  });
  return input;
}
const allocation = () =>
  normalizeStrategyProgram({
    version: 1,
    kind: "ALLOCATION",
    components: [
      { id: "first", weightBps: 5000, family: ref("first-board-v1") },
      { id: "sector", weightBps: 3000, family: ref("sector-resonance-v1") },
      { id: "low", weightBps: 2000, family: ref("low-turnover-v1") },
    ],
  });
function fixture(program) {
  const book = newBook();
  book.lastDate = dateAt(0);
  const source = sample();
  const strategy = { ...structuredClone(BASE_STRATEGY), program };
  const plan = createPlan(
    source,
    book,
    strategy,
    "test-program",
    `${dateAt(0)}T07:10:00.000Z`,
  );
  return { book, source, strategy, plan };
}

test("家族实际筛选：连续板数不使用几天几板，空换手不当零，板块数量取信号日", () => {
  const source = sample();
  const first = source.stocks[0],
    relay = source.stocks[2];
  assert.equal(
    familyEligibility("first-board-v1", first, source).eligible,
    true,
  );
  assert.equal(
    familyEligibility("relay-board-v1", relay, source).eligible,
    true,
  );
  assert.equal(
    familyEligibility(
      "relay-board-v1",
      { ...first, consecutiveBoards: null, limitUpDays: 5, limitUpCount: 3 },
      source,
    ).eligible,
    false,
  );
  assert.equal(
    familyEligibility("low-turnover-v1", { ...first, turnover: null }, source)
      .eligible,
    false,
  );
  assert.equal(
    familyEligibility(
      "sector-resonance-v1",
      { ...first, sectorScore: 75 },
      source,
    ).eligible,
    true,
  );
  assert.equal(
    familyEligibility(
      "sector-resonance-v1",
      { ...first, sectorScore: 75 },
      { ...source, stocks: source.stocks.slice(0, 2) },
    ).eligible,
    false,
  );
  assert.equal(
    fixture(familyProgram("relay-board-v1"))
      .plan.orders.filter((order) => order.action === "OPEN")
      .map((order) => order.code)
      .join(","),
    "600003",
  );
});

test("情绪选择器冻结上一信号日选择，不读执行日情绪；缺失情绪防守", () => {
  const program = {
    version: 1,
    kind: "EMOTION_SELECTOR",
    regimes: {
      high: ref("relay-board-v1"),
      mid: ref("first-board-v1"),
      low: ref("cash-v1"),
    },
  };
  const f = fixture(program);
  assert.equal(f.plan.strategyProgram.regime, "high");
  assert.equal(
    f.plan.strategyProgram.components[0].family.familyId,
    "relay-board-v1",
  );
  const changed = { ...f.source, emotion: 50 };
  const next = createPlan(
    changed,
    f.book,
    f.strategy,
    "next",
    f.plan.createdAt,
  );
  assert.equal(
    next.strategyProgram.components[0].family.familyId,
    "first-board-v1",
  );
  for (const emotion of [null, undefined, NaN]) {
    const missing = createPlan(
      { ...f.source, emotion },
      f.book,
      f.strategy,
      "missing",
      f.plan.createdAt,
    );
    assert.equal(missing.orders.length, 0);
    assertProgramPlan(missing, f.book);
  }
  const fake = structuredClone(f.plan);
  fake.strategyProgram.regime = "mid";
  assert.throws(() => openSession(f.book, fake, dateAt(1)), /冻结的情绪/);
});

test("共享分配：同股只有一个订单、按固定权重归属，资金和总仓位没有复制", () => {
  const f = fixture(allocation());
  assertProgramPlan(f.plan, f.book);
  assert.equal(
    new Set(f.plan.orders.map((order) => order.code)).size,
    f.plan.orders.length,
  );
  const overlaps = f.plan.orders.find((order) => order.code === "600001");
  assert.equal(overlaps.strategyAllocations.length, 3);
  assert.equal(
    overlaps.strategyAllocations.reduce((n, row) => n + row.quantity, 0),
    overlaps.quantity,
  );
  const total = f.plan.orders.reduce(
    (n, order) => n + order.quantity * order.referenceCents,
    0,
  );
  assert.ok(total <= f.book.equityCents * f.plan.targetExposure);
  for (const component of f.plan.strategyProgram.resources.components) {
    const used = f.plan.orders.reduce(
      (n, order) =>
        n +
        (order.strategyAllocations?.find(
          (row) => row.componentId === component.id,
        )?.quantity ?? 0) *
          order.referenceCents,
      0,
    );
    assert.ok(used <= component.capCents);
  }
  const reordered = { ...f.source, stocks: [...f.source.stocks].reverse() };
  assert.deepEqual(
    createPlan(reordered, f.book, f.strategy, "test-program", f.plan.createdAt)
      .orders,
    f.plan.orders,
  );
  const fake = structuredClone(f.plan);
  fake.strategyProgram.resources.initialEquityCents *= 3;
  assert.throws(() => openSession(f.book, fake, dateAt(1)), /实际期初账本/);
  const limited = {
    ...structuredClone(f.book),
    riskLimits: { ...f.book.riskLimits, maxGrossExposure: 0.2 },
  };
  const capped = createPlan(
    f.source,
    limited,
    f.strategy,
    "limited",
    f.plan.createdAt,
  );
  assert.equal(capped.targetExposure, 0.2);
  assert.equal(
    capped.strategyProgram.resources.components.reduce(
      (n, row) => n + row.capCents,
      0,
    ),
    limited.equityCents * 0.2,
  );
  assertProgramPlan(capped, limited);
});

test("统一实时成交：重试与恢复不重复，费用分配守恒、T+1 与区间容量合并", () => {
  const f = fixture(allocation());
  let book = f.book,
    session = openSession(book, f.plan, dateAt(1)),
    ledger = [];
  for (const [time, volume] of [
    ["01:31:00", 8000000],
    ["01:31:10", 9000000],
    ["01:31:20", 10000000],
  ]) {
    const quotes = Object.fromEntries(
      f.source.stocks.map((stock) => [
        stock.code,
        {
          date: dateAt(1),
          previousCloseCents: 1000,
          closeCents: 1000,
          limitUpCents: 1100,
          limitDownCents: 900,
          volumeShares: volume,
          timestamp: `${dateAt(1)}T${time}.000Z`,
        },
      ]),
    );
    const observation = {
      observedAt: `${dateAt(1)}T${time}.000Z`,
      quotes,
      pollIntervalSeconds: 10,
    };
    const result = advanceSession(book, session, observation);
    const duplicate = advanceSession(result.book, result.session, observation);
    assert.equal(duplicate.ledger.length, 0);
    book = structuredClone(result.book);
    session = structuredClone(result.session);
    ledger.push(...result.ledger);
  }
  assert.ok(ledger.length > 0);
  for (const row of ledger) {
    assert.equal(
      row.strategyAllocations.reduce((n, part) => n + part.quantity, 0),
      row.quantity,
    );
    assert.equal(
      row.strategyAllocations.reduce((n, part) => n + part.feeCents, 0),
      row.feeCents,
    );
    assert.equal(
      row.strategyAllocations.reduce((n, part) => n + part.notionalCents, 0),
      row.notionalCents,
    );
  }
  for (const position of book.positions)
    for (const lot of position.lots)
      assert.equal(
        lot.strategyAllocations.reduce((n, part) => n + part.quantity, 0),
        lot.quantity,
      );
  assert.ok(book.cashCents >= 0);
  const costs = ledger.reduce((n, row) => n - row.cashDeltaCents, 0);
  assert.equal(book.cashCents, f.book.cashCents - costs);
  const fake = structuredClone(session);
  fake.plan.strategyProgram.components[0].weightBps += 1000;
  assert.throws(
    () =>
      advanceSession(book, fake, {
        observedAt: `${dateAt(1)}T01:31:30.000Z`,
        quotes: {},
      }),
    /冻结的情绪/,
  );
});

test("策略声明与研究授权：拒绝代码、重复成员、权重伪造与 v1 离散变更", () => {
  const program = allocation();
  assert.throws(
    () => normalizeStrategyProgram({ ...program, code: "eval()" }),
    /字段无效/,
  );
  assert.throws(
    () =>
      normalizeStrategyProgram({
        ...program,
        components: program.components.map((row, index) => ({
          ...row,
          id: index === 0 ? "constructor" : row.id,
        })),
      }),
    /id 无效/,
  );
  assert.throws(
    () =>
      normalizeStrategyProgram({
        ...program,
        components: [program.components[0], program.components[0]],
      }),
    /重复/,
  );
  assert.throws(
    () =>
      normalizeStrategyProgram({
        ...program,
        components: program.components.map((row) => ({
          ...row,
          weightBps: 5000,
        })),
      }),
    /合计/,
  );
  assert.deepEqual(
    normalizeStrategyParams({ ...BASE_STRATEGY, program }).program,
    program,
  );
  const args = {
    proposal: { patch: { program }, rationale: "冻结配置" },
    parentParams: BASE_STRATEGY,
    frozenPolicy: DEFAULT_RESEARCH_POLICY,
  };
  assert.throws(
    () => validateStrategyCandidate({ ...args, cohortPolicy: { version: 1 } }),
    /未获得/,
  );
  const candidate = validateStrategyCandidate({
    ...args,
    cohortPolicy: { version: 2, strategySpaceVersion: STRATEGY_SPACE_VERSION },
  });
  assert.equal(candidate.changedGroups, 1);
  assert.deepEqual(candidate.params.program, program);
  assert.equal(programTemplates("ALLOCATIONS", 4).candidates.length, 4);
});

test("重新计算选择声明不能伪造信号日情绪或把连板订单移交首板家族", () => {
  const f = fixture(familyProgram("relay-board-v1"));
  assertProgramSnapshot(f.plan, f.source, f.book);
  const fake = structuredClone(f.plan);
  fake.strategy.program = familyProgram("first-board-v1");
  const freshly = createPlan(
    f.source,
    f.book,
    fake.strategy,
    "test-program",
    fake.createdAt,
  );
  fake.strategyProgram = freshly.strategyProgram;
  fake.orders[0].strategyAllocations = [
    {
      componentId: "first-board-v1",
      familyId: "first-board-v1",
      quantity: fake.orders[0].quantity,
    },
  ];
  assertProgramPlan(fake, f.book);
  assert.throws(
    () => assertProgramSnapshot(fake, f.source, f.book),
    /原始快照/,
  );
  assert.throws(
    () =>
      assertProgramSnapshot(
        f.plan,
        { ...f.source, createdAt: `${dateAt(1)}T07:30:00.000Z` },
        f.book,
      ),
    /未来信息/,
  );
  const afterOpen = structuredClone(f.plan);
  afterOpen.createdAt = `${dateAt(1)}T00:30:00-04:00`;
  assert.throws(
    () => openSession(f.book, afterOpen, dateAt(1)),
    /实际冻结时间/,
  );
});
