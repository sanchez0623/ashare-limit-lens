// 交付验证（docs/design/opening-execution-cost.md §7）：npm run verify:execution-cost
// 检查政策/输入摘要、成本分解与价格、资金/持仓守恒、共享容量、版本分派与压力结果。
// 全部通过退出码 0；任一失败退出码 1。使用合成边界样本，不发起网络请求。
import assert from "node:assert/strict";
import {
  defaultExecutionCostPolicy,
  normalizeExecutionCostPayload,
  executionPeriod,
  DEFAULT_EXECUTION_COST_PAYLOAD,
  EXECUTION_COST_MODEL,
} from "../shared/execution-cost.js";
import {
  buildExecutionContext,
  estimateExecutionCost,
} from "../backend/domain/execution-cost.js";
import {
  newBook,
  createPlan,
  executePlan,
  totalQuantity,
  BASE_STRATEGY,
} from "../backend/domain/trading.js";
import { PaperRepository, digest } from "../backend/storage/paper.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import {
  runExecutionSensitivity,
  scenarioPolicyBundles,
} from "../backend/services/execution-sensitivity.js";
import { localDatabase } from "./local-db.mjs";
import {
  order,
  snapshot,
  dataset,
  pairs,
  dateAt,
} from "../test/fixtures/trading.mjs";

const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({
      name,
      passed: false,
      error: String(error?.message ?? error),
    });
  }
};
const event = (time, overrides = {}) => ({
  time,
  priceCents: 1000,
  volumeShares: 10_000_000,
  quality: "realtime_poll",
  intervalKey: `2026-01-02:${time}`,
  ...overrides,
});
const context = (overrides = {}) =>
  buildExecutionContext({
    plan: { previousLimitUpCodes: [], previousLimitUpKnown: true },
    code: "600001",
    event: event("10:00:00"),
    quote: {},
    ...overrides,
  });
const estimate = (overrides = {}) =>
  estimateExecutionCost({
    policy: defaultExecutionCostPolicy(),
    context: context(),
    side: "BUY",
    quantity: 1000,
    ...overrides,
  });
const legacyPlan = () => ({
  signalDate: dateAt(0),
  createdAt: `${dateAt(0)}T07:10:00.000Z`,
  strategyVersion: "v",
  orders: [order()],
});

await check(
  "政策摘要：默认 payload 规范化后摘要与常量一致（内容寻址）",
  async () => {
    const normalized = normalizeExecutionCostPayload({
      ...DEFAULT_EXECUTION_COST_PAYLOAD,
    });
    assert.equal(
      await digest(normalized),
      defaultExecutionCostPolicy().payloadDigest,
    );
  },
);

await check(
  "版本分派：旧计划走 10bps 旧执行器；新版本计划缺摘要暂停执行",
  async () => {
    const legacy = executePlan(
      newBook(100000),
      legacyPlan(),
      dataset(dateAt(1)),
    );
    assert.equal(legacy.ledger.length, 1);
    assert.equal(legacy.ledger[0].executionCost, undefined);
    assert.throws(
      () =>
        executePlan(
          newBook(100000),
          { ...legacyPlan(), executionCostModel: EXECUTION_COST_MODEL },
          dataset(dateAt(1)),
        ),
      /缺少政策或摘要/,
    );
  },
);

await check(
  "成本分解与价格：时段分段、买入向上/卖出向下、隐含成本守恒",
  async () => {
    assert.equal(executionPeriod("09:35:00"), "earlySession");
    const open = estimate({ context: context({ event: event("09:30:10") }) });
    assert.equal(open.costBreakdown.residualBps, 35);
    const buy = estimate();
    const sell = estimateExecutionCost({
      policy: defaultExecutionCostPolicy(),
      context: context(),
      side: "SELL",
      quantity: 1000,
    });
    assert.ok(buy.fillPriceCents > 1000);
    assert.ok(sell.fillPriceCents < 1000);
    for (const side of [buy, sell]) {
      const b = side.costBreakdown;
      assert.equal(
        b.impliedCostCents,
        b.spreadCostCents +
          b.residualCostCents +
          b.impactCostCents +
          b.roundingCostCents,
      );
      assert.ok(b.impliedCostCents > 0);
    }
  },
);

await check("共享容量：同区间拆单累计冲击一致且容量只推进一次", async () => {
  const policy = defaultExecutionCostPolicy();
  const ctx = context();
  const single = estimateExecutionCost({
    policy,
    context: ctx,
    side: "BUY",
    quantity: 5000,
  });
  const first = estimateExecutionCost({
    policy,
    context: ctx,
    side: "BUY",
    quantity: 2000,
  });
  const second = estimateExecutionCost({
    policy,
    context: context({ intervalState: first.nextIntervalState }),
    side: "BUY",
    quantity: 3000,
  });
  assert.equal(
    first.costBreakdown.impactCostCents + second.costBreakdown.impactCostCents,
    single.costBreakdown.impactCostCents,
  );
  assert.equal(second.nextIntervalState.consumedShares, 5000);
});

await check("资金/持仓守恒：新模型账本权益 = 现金 + 市值，无透支", async () => {
  const frozen = createPlan(
    snapshot(dateAt(0)),
    newBook(100000),
    BASE_STRATEGY,
    "baseline-v1",
    `${dateAt(0)}T07:10:00.000Z`,
  );
  const result = executePlan(newBook(100000), frozen, dataset(dateAt(1)));
  assert.ok(result.ledger.length >= 1);
  const marketValue = result.book.positions.reduce(
    (sum, position) => sum + totalQuantity(position) * position.markCents,
    0,
  );
  assert.equal(result.book.cashCents + marketValue, result.equity.equityCents);
  assert.ok(result.book.cashCents >= 0);
  assert.equal(
    result.equity.equityCents - result.book.initialCashCents,
    result.book.realizedPnlCents + result.equity.unrealizedPnlCents,
  );
});

await check("压力结果：三情景完整重放可独立复核，单笔成本单调", async () => {
  const DB = localDatabase(),
    env = { DB },
    repository = new PaperRepository(env);
  try {
    await repository.initialize();
    for (const pair of pairs(12)) {
      await DB.prepare(
        "INSERT OR IGNORE INTO snapshots (trade_date,created_at,payload) VALUES (?,?,?)",
      )
        .bind(
          pair.snapshot.date,
          pair.snapshot.createdAt,
          JSON.stringify(pair.snapshot),
        )
        .run();
      await DB.prepare(
        "INSERT INTO paper_market_days (trade_date,payload,digest) VALUES (?,?,?)",
      )
        .bind(pair.dataset.date, JSON.stringify(pair.dataset), "fixture")
        .run();
    }
    const bundles = await scenarioPolicyBundles(defaultExecutionCostPolicy());
    assert.deepEqual(
      bundles.map((bundle) => bundle.payload.executionStressMultiplier),
      [1, 1.5, 2],
    );
    const run = await runExecutionSensitivity(env, { days: 10 });
    const [baseline, mid, stress] = run.payload.results;
    assert.ok(baseline.fillCount > 0);
    assert.ok(mid.impliedCostCents > baseline.impliedCostCents);
    assert.ok(stress.impliedCostCents > mid.impliedCostCents);
    assert.ok(
      run.manifest.scenarios.every((scenario) => scenario.payloadDigest),
    );
  } finally {
    DB.close();
  }
});

await check(
  "完整导出重放：新模型账本 verifyExport 通过，篡改成本被检测",
  async () => {
    const DB = localDatabase(),
      env = { DB },
      repository = new PaperRepository(env);
    try {
      const account = await repository.initialize();
      const firstData = dataset(dateAt(0));
      await repository.settle(
        account.revision,
        executePlan(account.book, null, firstData),
        firstData,
      );
      const current = await repository.account();
      const frozen = await repository.savePlan(
        createPlan(
          snapshot(dateAt(0)),
          current.book,
          BASE_STRATEGY,
          "baseline-v1",
          `${dateAt(0)}T07:10:00.000Z`,
        ),
      );
      const day = dataset(dateAt(1));
      const settled = executePlan(current.book, frozen, day);
      await repository.settle(current.revision, settled, day);
      const bundle = await exportPaper(env);
      const audit = await verifyExport(bundle);
      assert.equal(audit.passed, true, JSON.stringify(audit.checks));
      const tampered = structuredClone(bundle);
      tampered.ledger[0].executionCost.totalBps += 1;
      assert.equal((await verifyExport(tampered)).passed, false);
    } finally {
      DB.close();
    }
  },
);

const failed = checks.filter((entry) => !entry.passed);
console.log(
  JSON.stringify(
    {
      modelVersion: EXECUTION_COST_MODEL,
      passed: failed.length === 0,
      total: checks.length,
      failed: failed.length,
      checks,
    },
    null,
    2,
  ),
);
process.exitCode = failed.length ? 1 : 0;
