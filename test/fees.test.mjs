import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FEES,
  LEGACY_FEES,
  validFees,
  normalizeFees,
} from "../shared/fees.js";
import {
  newBook,
  createPlan,
  executePlan,
  transactionFees,
  BASE_STRATEGY,
} from "../backend/domain/trading.js";
import { PaperRepository } from "../backend/storage/paper.js";
import {
  exportPaper,
  verifyExport,
  paperOverview,
} from "../backend/services/paper.js";
import { replayStrategy } from "../backend/domain/validation.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { api } from "../backend/routes/api.js";
import {
  dateAt,
  dataset,
  plan,
  order,
  snapshot,
  pairs,
} from "./fixtures/trading.mjs";

test("图中六项费用默认值、万分之换算及最低佣金按方向计费", () => {
  assert.equal(newBook().initialCashCents, 100000000);
  assert.equal(DEFAULT_FEES.commission_rate, 0.5 / 10000);
  assert.equal(DEFAULT_FEES.handling_fee, 0.341 / 10000);
  assert.equal(DEFAULT_FEES.regulatory_fee, 0.2 / 10000);
  assert.equal(DEFAULT_FEES.transfer_fee, 0.1 / 10000);
  assert.equal(transactionFees(10000000, "BUY").total, 1141);
  assert.deepEqual(transactionFees(10000000, "SELL"), {
    commission: 500,
    transfer: 100,
    stamp: 5000,
    handling: 341,
    regulatory: 200,
    total: 6141,
  });
  assert.equal(transactionFees(1000000, "BUY").commission, 500);
  const zero = Object.fromEntries(
    Object.keys(DEFAULT_FEES).map((key) => [key, 0]),
  );
  assert.equal(transactionFees(10000000, "SELL", zero).total, 0);
  assert.equal(
    transactionFees(10000000, "BUY", { ...DEFAULT_FEES, commission_min: 0 })
      .commission,
    500,
  );
});
test("自定义费用拒绝缺失、字符串、负数、无限值、额外字段和小于分的最低佣金", () => {
  for (const fees of [
    { ...DEFAULT_FEES, extra: 1 },
    { ...DEFAULT_FEES, stamp_tax: -0.01 },
    { ...DEFAULT_FEES, commission_rate: "0.5" },
    { ...DEFAULT_FEES, commission_min: 0.005 },
    { ...DEFAULT_FEES, handling_fee: Infinity },
    { commission_rate: 0.00005 },
  ]) {
    assert.equal(validFees(fees), false);
    assert.throws(() => normalizeFees(fees), /费用/);
  }
  assert.equal(validFees({ ...DEFAULT_FEES, commission_min: 5.01 }), true);
});
test("首次基准结算后仍可调整资金，原计划留档且后续成交采用冻结费用", async () => {
  const DB = localDatabase(),
    env = { DB },
    repository = new PaperRepository(env);
  await repository.initialize();
  await repository.configure({ initialCapital: 100000 });
  const account = await repository.account(),
    day = dataset(dateAt(0));
  await repository.settle(
    account.revision,
    executePlan(account.book, null, day),
    day,
  );
  const frozen = snapshot(dateAt(0));
  await DB.prepare(
    "INSERT INTO snapshots (trade_date,created_at,payload) VALUES (?,?,?)",
  )
    .bind(frozen.date, frozen.createdAt, JSON.stringify(frozen))
    .run();
  const priorPlan = await repository.savePlan(
    createPlan(
      frozen,
      (await repository.account()).book,
      BASE_STRATEGY,
      "baseline-v1",
      frozen.createdAt,
    ),
  );
  const now = new Date(`${dateAt(0)}T08:00:00.000Z`);
  const custom = { ...DEFAULT_FEES, commission_min: 10, handling_fee: 0.0001 };
  const changed = await repository.configure(
    { initialCapital: 1000000, fees: custom },
    now,
  );
  const currentPlan = await repository.plan(dateAt(0));
  assert.equal(changed.cashCents, 100000000);
  assert.ok(currentPlan.orders[0].quantity > priorPlan.orders[0].quantity * 9);
  assert.deepEqual(currentPlan.feeConfig, normalizeFees(custom));
  assert.equal((await verifyExport(await exportPaper(env))).passed, true);
  const revision = await repository.history("paper_plan_revisions");
  assert.deepEqual(JSON.parse(revision[0].payload), priorPlan);
  const before = await repository.account();
  const data = pairs(1)[0].dataset;
  const result = executePlan(before.book, currentPlan, data);
  await repository.settle(before.revision, result, data);
  assert.ok(result.ledger.length);
  assert.deepEqual(result.ledger[0].feeConfig, normalizeFees(custom));
  const completed = await repository.plan(dateAt(0));
  await repository.configure(
    { fees: DEFAULT_FEES },
    new Date(`${dateAt(1)}T08:00:00.000Z`),
  );
  assert.deepEqual(await repository.plan(dateAt(0)), completed);
  assert.equal((await paperOverview(env)).canEditCapital, false);
  await assert.rejects(
    () => repository.configure({ initialCapital: 500000 }),
    /冻结/,
  );
  assert.equal((await verifyExport(await exportPaper(env))).passed, true);
  DB.close();
});
test("盘中改费不重写已可执行的计划，后续新计划冻结新费用", async () => {
  const DB = localDatabase(),
    repository = new PaperRepository({ DB });
  const initial = await repository.initialize(),
    first = dataset(dateAt(0));
  await repository.settle(
    initial.revision,
    executePlan(initial.book, null, first),
    first,
  );
  const original = await repository.savePlan(plan([order()], dateAt(0)));
  const custom = { ...DEFAULT_FEES, commission_min: 100 };
  await repository.configure(
    { fees: custom },
    new Date(`${dateAt(1)}T02:00:00.000Z`),
  );
  assert.deepEqual(await repository.plan(dateAt(0)), original);
  const book = (await repository.account()).book;
  const result = executePlan(book, original, dataset(dateAt(1)));
  assert.equal(result.ledger[0].feeBreakdown.commission, 500);
  const upcoming = createPlan(
    snapshot(dateAt(1)),
    book,
    BASE_STRATEGY,
    "baseline-v1",
    `${dateAt(1)}T08:00:00.000Z`,
  );
  assert.deepEqual(upcoming.feeConfig, normalizeFees(custom));
  DB.close();
});
test("旧版无费用快照的导出继续按三项旧费用重放，不替换历史默认值", async () => {
  const DB = localDatabase(),
    repository = new PaperRepository({ DB });
  const initial = await repository.initialize(),
    first = dataset(dateAt(0));
  await repository.settle(
    initial.revision,
    executePlan(initial.book, null, first),
    first,
  );
  const legacy = plan([order()], dateAt(0));
  delete legacy.feeConfig;
  delete legacy.feeModel;
  delete legacy.feeConfigVersion;
  await repository.savePlan(legacy);
  const current = await repository.account(),
    data = dataset(dateAt(1));
  const result = executePlan(current.book, legacy, data);
  assert.deepEqual(
    result.ledger[0].feeBreakdown,
    transactionFees(
      result.ledger[0].notionalCents,
      "BUY",
      LEGACY_FEES,
      "legacy-v1",
    ),
  );
  assert.equal(Object.hasOwn(result.ledger[0], "feeConfig"), false);
  await repository.settle(current.revision, result, data);
  const bundle = await exportPaper({ DB });
  delete bundle.configurationHistory;
  delete bundle.supersededPlans;
  assert.equal((await verifyExport(bundle)).passed, true);
  DB.close();
});
test("资金调整与并发结算冲突时仅一个原子操作成功，账本仍可重放", async () => {
  const DB = localDatabase(),
    repository = new PaperRepository({ DB });
  const initial = await repository.initialize();
  await repository.configure({ initialCapital: 100000 });
  const before = await repository.account(),
    first = dataset(dateAt(0));
  await repository.settle(
    before.revision,
    executePlan(before.book, null, first),
    first,
  );
  const current = await repository.account(),
    data = dataset(dateAt(1));
  const dayPlan = await repository.savePlan(plan([order()], dateAt(0)));
  const outcome = executePlan(current.book, dayPlan, data);
  const [configured, settled] = await Promise.allSettled([
    repository.configure(
      { initialCapital: 1000000 },
      new Date(`${dateAt(0)}T08:00:00.000Z`),
    ),
    repository.settle(current.revision, outcome, data),
  ]);
  assert.ok(configured.status === "rejected" || settled.value === false);
  assert.equal((await verifyExport(await exportPaper({ DB }))).passed, true);
  DB.close();
});
test("AI 重放使用自定义费用；旧费用验证通过的候选不能在新费用下启用", async () => {
  const data = pairs(10),
    expensive = { ...DEFAULT_FEES, commission_min: 1000 };
  assert.ok(
    replayStrategy(data, BASE_STRATEGY, 100000, expensive).feesCents >
      replayStrategy(data, BASE_STRATEGY, 100000, DEFAULT_FEES).feesCents,
  );
  const DB = localDatabase(),
    repository = new PaperRepository({ DB });
  const account = await repository.initialize();
  await repository.recordVersion({
    id: "ai-2026-01-30",
    createdAt: new Date().toISOString(),
    status: "VALIDATED",
    params: BASE_STRATEGY,
    evidence: {
      feeConfigVersion: account.book.feeConfigVersion,
      initialCashCents: account.book.initialCashCents,
    },
  });
  await repository.configure({ fees: expensive });
  await assert.rejects(
    () => repository.activate("ai-2026-01-30"),
    /费用或资金已变更/,
  );
  DB.close();
});
test("设置 API 存储六项自定义费用，CSV 导出包含分项费用列", async () => {
  const DB = localDatabase(),
    env = { DB };
  const response = await api(
    new Request("https://example.test/api/paper/settings", {
      method: "POST",
      body: JSON.stringify({ initialCapital: 1000000, fees: DEFAULT_FEES }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).book.feeConfig,
    normalizeFees(DEFAULT_FEES),
  );
  const csv = await api(
    new Request("https://example.test/api/paper/export?format=csv"),
    env,
  );
  assert.match(
    await csv.text(),
    /handlingCents,regulatoryCents,transferCents,feeConfigVersion/,
  );
  DB.close();
});
