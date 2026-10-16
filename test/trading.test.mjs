import test from "node:test";
import assert from "node:assert/strict";
import {
  newBook,
  createPlan,
  defensivePlan,
  executePlan,
  auditLedger,
  availableQuantity,
  totalQuantity,
  protectivePyramidReduce,
  BASE_STRATEGY,
  transactionFees,
} from "../backend/domain/trading.js";
import {
  replayStrategy,
  validateProposal,
  validateCandidate,
} from "../backend/domain/validation.js";
import {
  loadOrBuildExitContext,
  loadPersistedExitInputs,
} from "../backend/services/exit-context.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../backend/domain/realtime.js";
import {
  EXPOSURE_TIERS_DEFAULTS,
  STRATEGY_DEFAULTS,
  normalizeStrategyParams,
} from "../shared/strategy-params.js";
import {
  PaperRepository,
  buildOriginalScoreLookup,
} from "../backend/storage/paper.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import { requestProposal } from "../backend/services/improvement.js";
import { proposeImprovement as improveStrategy } from "../backend/services/research.js";
import { aiConfig } from "../backend/services/review.js";
import { api } from "../backend/routes/api.js";
import { localDatabase } from "../scripts/local-db.mjs";
import {
  bars,
  dataset,
  order,
  plan,
  snapshot,
  pairs,
  dateAt,
} from "./fixtures/trading.mjs";

function entered() {
  return executePlan(newBook(100000), plan([order()]), dataset(dateAt(1)));
}
test("交易费用使用分为单位，买卖印花税方向正确", () => {
  assert.deepEqual(transactionFees(1000000, "BUY"), {
    commission: 500,
    transfer: 10,
    stamp: 0,
    handling: 34,
    regulatory: 20,
    total: 564,
  });
  assert.equal(transactionFees(1000000, "SELL").total, 1064);
});
test("建仓、加仓、减仓、清仓可核对现金与已实现盈亏", () => {
  let result = entered(),
    fills = [...result.ledger];
  assert.equal(totalQuantity(result.book.positions[0]), 1000);
  assert.equal(availableQuantity(result.book.positions[0], dateAt(1)), 0);
  result = executePlan(
    result.book,
    plan([order("ADD", 200)], dateAt(1)),
    dataset(dateAt(2)),
  );
  fills.push(...result.ledger);
  assert.equal(totalQuantity(result.book.positions[0]), 1200);
  result = executePlan(
    result.book,
    plan([order("REDUCE", 600)], dateAt(2)),
    dataset(dateAt(3), "600001", { open: 1050, close: 1050 }),
  );
  fills.push(...result.ledger);
  assert.equal(
    result.ledger[0].basisCents,
    Math.round(fills[0].notionalCents * 0.6 + fills[0].feeCents * 0.6),
  );
  result = executePlan(
    result.book,
    plan([order("EXIT", 600, { referenceCents: 1050 })], dateAt(3)),
    dataset(dateAt(4), "600001", { previous: 1050, open: 1060, close: 1060 }),
  );
  fills.push(...result.ledger);
  assert.equal(result.book.positions.length, 0);
  assert.equal(
    result.book.cashCents - result.book.initialCashCents,
    result.book.realizedPnlCents,
  );
  assert.equal(
    auditLedger(
      result.book.initialCashCents,
      fills,
      result.equity,
      result.book.positions,
    ).passed,
    true,
  );
});
test("T+1 不允许卖出当天买入份额；整手和现金约束有效", () => {
  const bought = entered();
  const same = executePlan(
    bought.book,
    plan([order("EXIT", 1000)]),
    dataset(dateAt(1)),
  );
  assert.equal(same.ledger.length, 0);
  const small = executePlan(
    newBook(10000),
    plan([order("OPEN", 99999)]),
    dataset(dateAt(1)),
  );
  assert.ok(small.ledger[0].quantity <= 100);
  assert.equal(small.ledger[0].quantity % 100, 0);
  assert.ok(small.book.cashCents >= 0);
});
test("日内高低价不能推断做 T；完整分钟数据遵守正向和反向先后顺序", () => {
  for (const action of ["T_FORWARD", "T_REVERSE"]) {
    const book = entered().book;
    const moves =
      action === "T_FORWARD"
        ? { "10:00": 970, "11:00": 1030 }
        : { "10:00": 1030, "11:00": 970 };
    const result = executePlan(
      book,
      plan([order(action, 200)], dateAt(1)),
      dataset(dateAt(2), "600001", { minutes: bars(1000, moves) }),
    );
    assert.deepEqual(
      result.ledger.map((fill) => fill.side),
      action === "T_FORWARD" ? ["BUY", "SELL"] : ["SELL", "BUY"],
    );
    assert.equal(totalQuantity(result.book.positions[0]), 1000);
    const old = result.book.positions[0].lots.find(
      (lot) => lot.acquiredDate === dateAt(1),
    );
    assert.equal(old.quantity, 800);
    assert.equal(result.outcomes[0].status, "FILLED");
  }
  const skipped = executePlan(
    entered().book,
    plan([order("T_FORWARD", 200)], dateAt(1)),
    dataset(dateAt(2), "600001", { minutes: [] }),
  );
  assert.equal(skipped.ledger.length, 0);
  assert.equal(skipped.equity.missingMinuteOrders, 1);
});
test("做 T 第二腿未触发时保留真实敞口，不虚构完成收益", () => {
  const result = executePlan(
    entered().book,
    plan([order("T_FORWARD", 200)], dateAt(1)),
    dataset(dateAt(2), "600001", { minutes: bars(1000, { "10:00": 970 }) }),
  );
  assert.equal(result.ledger.length, 1);
  assert.equal(totalQuantity(result.book.positions[0]), 1200);
  assert.equal(result.outcomes[0].status, "PARTIAL");
});
test("涨停不买、跌停不卖；不满足价格或成交量时跳过或部分成交", () => {
  const up = executePlan(
    newBook(100000),
    plan([order("OPEN", 1000, { maxPriceCents: 1200 })]),
    dataset(dateAt(1), "600001", { open: 1100 }),
  );
  assert.equal(up.ledger.length, 0);
  const down = executePlan(
    entered().book,
    plan([order("EXIT", 1000)], dateAt(1)),
    dataset(dateAt(2), "600001", { open: 900 }),
  );
  assert.equal(down.ledger.length, 0);
  const limited = bars();
  limited.forEach((bar) => (bar.volumeShares = 10000));
  const partial = executePlan(
    newBook(100000),
    plan([order()]),
    dataset(dateAt(1), "600001", { minutes: limited }),
  );
  assert.equal(partial.ledger[0].quantity, 100);
  assert.equal(partial.outcomes[0].status, "PARTIAL");
});
test("事前保护订单只卖旧仓，触发后取消做 T", () => {
  const result = executePlan(
    entered().book,
    plan([order("T_FORWARD", 200)], dateAt(1)),
    dataset(dateAt(2), "600001", {
      close: 930,
      minutes: bars(1000, { "10:00": 930 }),
    }),
  );
  assert.equal(result.ledger[0].action, "EXIT");
  assert.equal(result.book.positions.length, 0);
  assert.ok(result.outcomes.some((outcome) => outcome.reason.includes("保护")));
});
test("禁止用当日评分或晚于开盘的计划；缺失持仓价与除权暂停结算", () => {
  assert.throws(
    () =>
      executePlan(
        newBook(100000),
        plan([order()], dateAt(1)),
        dataset(dateAt(1)),
      ),
    /开盘前/,
  );
  assert.throws(
    () =>
      executePlan(
        newBook(100000),
        { ...plan([order()]), createdAt: `${dateAt(1)}T01:15:00.000Z` },
        dataset(dateAt(1)),
      ),
    /开盘前/,
  );
  assert.throws(
    () =>
      executePlan(entered().book, plan([], dateAt(1)), {
        ...dataset(dateAt(2)),
        quotes: {},
      }),
    /缺少当天/,
  );
  assert.throws(
    () =>
      executePlan(
        entered().book,
        plan([], dateAt(1)),
        dataset(dateAt(2), "600001", { previous: 500 }),
      ),
    /除权/,
  );
});
test("规划覆盖建仓、加仓、减仓、清仓与双向 T，低情绪不强行建仓", () => {
  assert.equal(
    createPlan(snapshot(dateAt(0)), newBook(100000), BASE_STRATEGY, "v", "now")
      .orders[0].action,
    "OPEN",
  );
  const book = entered().book;
  assert.equal(
    createPlan(snapshot(dateAt(1)), book, BASE_STRATEGY, "v", "now").orders[0]
      .action,
    "ADD",
  );
  const bigger = structuredClone(book);
  bigger.positions[0].lots[0].quantity = 1300;
  bigger.positions[0].lots[0].costCents = 1300000;
  bigger.cashCents = 8700000;
  assert.equal(
    createPlan(snapshot(dateAt(1)), bigger, BASE_STRATEGY, "v", "now").orders[0]
      .action,
    "T_FORWARD",
  );
  const reverse = snapshot(dateAt(1));
  reverse.stocks[0].factors.forEach((factor) => (factor.value = 75));
  assert.equal(
    createPlan(reverse, bigger, BASE_STRATEGY, "v", "now").orders[0].action,
    "T_REVERSE",
  );
  assert.equal(
    createPlan({ ...reverse, emotion: 20 }, bigger, BASE_STRATEGY, "v", "now")
      .orders[0].action,
    "REDUCE",
  );
  bigger.positions[0].heldDays = 5;
  assert.equal(
    createPlan(reverse, bigger, BASE_STRATEGY, "v", "now").orders[0].action,
    "EXIT",
  );
  assert.equal(
    createPlan(
      { ...reverse, emotion: 20 },
      newBook(100000),
      BASE_STRATEGY,
      "v",
      "now",
    ).orders.length,
    0,
  );
});
test("情绪档位可配置：目标敞口与开新仓闸门随版本参数变化", () => {
  // 情绪 70：默认高档 0.55；高档阈值抬到 75 后落入中档 0.35，建仓预算缩小
  const relaxed = {
    ...BASE_STRATEGY,
    exposureTiers: { ...EXPOSURE_TIERS_DEFAULTS, highEmotion: 75, high: 0.4 },
  };
  const baseline = createPlan(
    snapshot(dateAt(0)),
    newBook(100000),
    BASE_STRATEGY,
    "v",
    "now",
  );
  const adjusted = createPlan(
    snapshot(dateAt(0)),
    newBook(100000),
    relaxed,
    "v",
    "now",
  );
  assert.equal(baseline.targetExposure, 0.55);
  assert.equal(adjusted.targetExposure, 0.35);
  assert.ok(adjusted.orders[0].quantity < baseline.orders[0].quantity);
  // 低档阈值抬升：情绪 45 原本可开仓，阈值提到 50 后停止开新仓
  const defensive = {
    ...BASE_STRATEGY,
    exposureTiers: { ...EXPOSURE_TIERS_DEFAULTS, midEmotion: 50 },
  };
  assert.equal(
    createPlan(
      { ...snapshot(dateAt(0)), emotion: 45 },
      newBook(100000),
      BASE_STRATEGY,
      "v",
      "now",
    ).orders[0].action,
    "OPEN",
  );
  assert.equal(
    createPlan(
      { ...snapshot(dateAt(0)), emotion: 45 },
      newBook(100000),
      defensive,
      "v",
      "now",
    ).orders.length,
    0,
  );
  // 旧策略版本缺 exposureTiers 时回退默认档位，重放语义不变
  const legacy = { ...BASE_STRATEGY };
  delete legacy.exposureTiers;
  assert.equal(
    createPlan(snapshot(dateAt(0)), newBook(100000), legacy, "v", "now")
      .targetExposure,
    0.55,
  );
});
test("情绪周期闸门：冰点期禁止开新仓、退潮期压缩敞口", () => {
  // 冰点期：即使情绪档位判定为可开仓，cycle.phase=freezing 也硬阻塞
  const freezing = {
    ...snapshot(dateAt(0)),
    cycle: {
      phase: "freezing",
      label: "冰点",
      score: 0.1,
      maxGrossExposure: 0.0,
      subscores: {},
      reason: "冰点测试",
    },
  };
  const freezingPlan = createPlan(
    freezing,
    newBook(100000),
    BASE_STRATEGY,
    "v",
    "now",
  );
  assert.equal(freezingPlan.orders.length, 0, "冰点期禁止开新仓");
  assert.equal(freezingPlan.cycle.phase, "freezing");
  assert.equal(freezingPlan.maxExposure, 0);
  const skip = freezingPlan.selectionAudit.candidates.find((c) =>
    c.reason.includes("冰点"),
  );
  assert.ok(skip, "候选审计应说明冰点期原因");

  // 退潮期：maxGrossExposure=0.2，targetExposure 被压缩到 0.2
  const ebbing = {
    ...snapshot(dateAt(0)),
    cycle: {
      phase: "ebbing",
      label: "退潮",
      score: 0.4,
      maxGrossExposure: 0.2,
      subscores: {},
      reason: "退潮测试",
    },
  };
  const ebbingPlan = createPlan(
    ebbing,
    newBook(100000),
    BASE_STRATEGY,
    "v",
    "now",
  );
  assert.ok(ebbingPlan.orders.length > 0, "退潮期仍允许开新仓");
  assert.equal(ebbingPlan.targetExposure, 0.2);
  assert.equal(ebbingPlan.maxExposure, 0.2);

  // 无 cycle 字段（旧快照）行为不变
  const legacyPlan = createPlan(
    snapshot(dateAt(0)),
    newBook(100000),
    BASE_STRATEGY,
    "v",
    "now",
  );
  assert.equal(legacyPlan.cycle, null);
  assert.equal(legacyPlan.maxExposure, 0.6);

  // 真实快照结构：cycle / emotion 嵌套在 marketSummary 下，同样要被闸门识别。
  const fromMarketSummary = {
    ...snapshot(dateAt(0)),
    emotion: undefined,
    marketSummary: {
      cycle: {
        phase: "ebbing",
        label: "退潮",
        score: 0.4,
        maxGrossExposure: 0.2,
        subscores: {},
        reason: "退潮",
      },
      emotion: 70,
    },
  };
  const summaryPlan = createPlan(
    fromMarketSummary,
    newBook(100000),
    BASE_STRATEGY,
    "v",
    "now",
  );
  assert.equal(summaryPlan.cycle.phase, "ebbing");
  assert.equal(summaryPlan.targetExposure, 0.2);
  // 计划冻结账户原始 5 字段 riskLimits（严格风控 schema 兼容），
  // 周期上限单独冻结在 cycle，成交求解与家族核验用 resolveExposureCap
  // 统一读取，实际敞口上限 = min(0.6, 0.2) = 0.2。
  assert.equal(summaryPlan.riskLimits.maxGrossExposure, 0.6);
  assert.equal(summaryPlan.riskLimits.effectiveExposureCap, undefined);
  assert.equal(summaryPlan.cycle.maxGrossExposure, 0.2);
  assert.equal(summaryPlan.maxExposure, 0.2);
});
test("手动策略参数校验拒绝越界、缺字段与档位倒挂", () => {
  assert.deepEqual(normalizeStrategyParams(STRATEGY_DEFAULTS), {
    ...STRATEGY_DEFAULTS,
    exposureTiers: { ...EXPOSURE_TIERS_DEFAULTS },
  });
  for (const bad of [
    { ...STRATEGY_DEFAULTS, extra: 1 },
    { ...STRATEGY_DEFAULTS, weights: [0, 0, 0, 0, 0, 0] },
    { ...STRATEGY_DEFAULTS, weights: [30, 20, 15, 15, 15] },
    { ...STRATEGY_DEFAULTS, maxPositions: 6 },
    { ...STRATEGY_DEFAULTS, maxPositions: 3.5 },
    { ...STRATEGY_DEFAULTS, stopLoss: 0.1 },
    {
      ...STRATEGY_DEFAULTS,
      exposureTiers: { ...EXPOSURE_TIERS_DEFAULTS, highEmotion: 30 },
    },
    {
      ...STRATEGY_DEFAULTS,
      exposureTiers: { ...EXPOSURE_TIERS_DEFAULTS, highEmotion: 65.5 },
    },
    {
      ...STRATEGY_DEFAULTS,
      exposureTiers: { ...EXPOSURE_TIERS_DEFAULTS, high: 0.1, mid: 0.35 },
    },
  ])
    assert.throws(() => normalizeStrategyParams(bad), /策略参数/);
});
test("手动策略参数登记为新版本并驱动后续计划", async () => {
  const DB = localDatabase(),
    repository = new PaperRepository({ DB });
  await repository.initialize();
  const edited = normalizeStrategyParams({
    ...STRATEGY_DEFAULTS,
    maxPositions: 5,
    stopLoss: 0.05,
  });
  const book = await repository.configure({ strategyParams: edited });
  assert.equal(book.activeStrategy, "manual-v1");
  assert.deepEqual(await repository.strategy(book), edited);
  const versions = await repository.versions();
  const manual = versions.find((version) => version.id === "manual-v1");
  assert.equal(manual.status, "ACTIVE");
  assert.equal(manual.evidence.type, "manual");
  assert.deepEqual(manual.evidence.changedKeys.sort(), [
    "maxPositions",
    "stopLoss",
  ]);
  assert.equal(
    versions.find((version) => version.id === "baseline-v1").status,
    "RETIRED",
  );
  // 相同参数重复保存不再新开版本
  const again = await repository.configure({ strategyParams: edited });
  assert.equal(again.activeStrategy, "manual-v1");
  assert.equal(
    (await repository.versions()).filter((version) =>
      version.id.startsWith("manual-"),
    ).length,
    1,
  );
  await assert.rejects(
    () => repository.configure({ strategyParams: { ...edited, minScore: 60 } }),
    /策略参数/,
  );
  DB.close();
});
test("原子账本并发结算只有一次；完整导出重放及篡改检测", async () => {
  const DB = localDatabase();
  const env = { DB };
  const repository = new PaperRepository(env);
  const account = await repository.initialize();
  const firstData = dataset(dateAt(0));
  const first = executePlan(account.book, null, firstData);
  const saved = await Promise.all([
    repository.settle(account.revision, first, firstData),
    repository.settle(account.revision, first, firstData),
  ]);
  assert.equal(saved.filter(Boolean).length, 1);
  const frozen = await repository.savePlan(plan([order()], dateAt(0)));
  const updated = await repository.account();
  const day = dataset(dateAt(1));
  const second = executePlan(updated.book, frozen, day);
  await repository.settle(updated.revision, second, day);
  const bundle = await exportPaper(env);
  assert.equal((await verifyExport(bundle)).passed, true);
  const changed = structuredClone(bundle);
  changed.ledger[0].feeCents++;
  assert.equal((await verifyExport(changed)).passed, false);
  const tampered = structuredClone(bundle);
  tampered.datasets[1].payload.quotes["600001"].closeCents++;
  assert.equal((await verifyExport(tampered)).checks.hashes, false);
  await assert.rejects(
    () => repository.configure({ initialCapital: 500000 }),
    /冻结/,
  );
  DB.close();
});
test("AI 参数禁止代码、资金和风险上限修改；无改进或覆盖不足拒绝启用", () => {
  assert.throws(
    () =>
      validateProposal({ rationale: "test", patch: { maxGrossExposure: 1 } }),
    /未授权/,
  );
  assert.throws(
    () => validateProposal({ rationale: "test", patch: { stopLoss: 0.5 } }),
    /越界/,
  );
  const all = pairs();
  const train = all.slice(0, 20),
    holdout = all.slice(20, 30);
  const candidate = validateProposal({
    rationale: "测试候选",
    patch: { minScore: 85 },
  }).params;
  const good = validateCandidate(
    train,
    holdout,
    BASE_STRATEGY,
    candidate,
    100000,
  );
  assert.equal(good.passed, true, JSON.stringify(good.checks));
  assert.equal(
    validateCandidate(train, holdout, BASE_STRATEGY, BASE_STRATEGY, 100000)
      .passed,
    false,
  );
  const missing = structuredClone(holdout);
  missing[0].dataset.quotes = {};
  assert.equal(
    validateCandidate(train, missing, BASE_STRATEGY, candidate, 100000).passed,
    false,
  );
});
test("研究闸门下数据不足不发起提案，历史通过不再自动启用", async () => {
  const DB = localDatabase(),
    env = {
      DB,
      AI_API_KEY: "test-only-secret",
      AI_BASE_URL: "https://api.deepseek.com/v1",
    };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const all = pairs(30);
  for (const pair of all) {
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
  let calls = 0;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              rationale: "基于训练数据过滤较弱评分",
              patch: { minScore: 85 },
            }),
          },
        },
      ],
    });
  };
  try {
    const result = await improveStrategy(repository, env, requestProposal);
    assert.equal(result.status, "COLLECTING");
    assert.deepEqual(result.required, { trainDays: 60, histTestDays: 20 });
    assert.equal(calls, 0);
    assert.equal(
      (await repository.account()).book.activeStrategy,
      "baseline-v1",
    );
  } finally {
    globalThis.fetch = fetchBefore;
    DB.close();
  }
});
test("API 阻止跨站写入、错误方法和未验证版本；密钥不进入响应", async () => {
  const DB = localDatabase(),
    env = { DB, AI_API_KEY: "test-only-secret" };
  const make = (path, method = "GET", headers = {}, body) =>
    new Request(`https://example.test${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal(
    (
      await api(
        make(
          "/api/paper/settings",
          "POST",
          { Origin: "https://evil.test" },
          {},
        ),
        env,
      )
    ).status,
    403,
  );
  assert.equal((await api(make("/api/paper", "POST"), env)).status, 405);
  assert.equal((await api(make("/api/settings"), env)).status, 200);
  const config = await api(make("/api/settings"), env);
  assert.ok(!(await config.text()).includes(env.AI_API_KEY));
  // 设置接口支持 weights 与 buyPointParams 部分保存；GET 回读买点参数
  const savedParams = await api(
    make(
      "/api/settings",
      "POST",
      { "Content-Type": "application/json" },
      {
        weights: [10, 10, 10, 10, 10, 10],
        buyPointParams: { firstNegMinPrevHeight: 2 },
      },
    ),
    env,
  );
  assert.equal(savedParams.status, 200);
  const cfg = await (await api(make("/api/settings"), env)).json();
  assert.equal(cfg.buyPointParams.firstNegMinPrevHeight, 2);
  const badParams = await api(
    make(
      "/api/settings",
      "POST",
      { "Content-Type": "application/json" },
      { buyPointParams: { firstNegMinPrevHeight: 11 } },
    ),
    env,
  );
  assert.equal(badParams.status, 400);
  const partial = await api(
    make(
      "/api/settings",
      "POST",
      { "Content-Type": "application/json" },
      { buyPointParams: { firstNegMinPrevHeight: 3 } },
    ),
    env,
  );
  assert.equal(partial.status, 200);
  // 原子保存：合法权重 + 非法买点参数 → 整体 400，权重不得被半提交改动
  await api(
    make(
      "/api/settings",
      "POST",
      { "Content-Type": "application/json" },
      { weights: [1, 1, 1, 1, 1, 1] },
    ),
    env,
  );
  const atomic = await api(
    make(
      "/api/settings",
      "POST",
      { "Content-Type": "application/json" },
      {
        weights: [9, 9, 9, 9, 9, 9],
        buyPointParams: { firstNegMinPrevHeight: 11 },
      },
    ),
    env,
  );
  assert.equal(atomic.status, 400);
  const afterAtomic = await (await api(make("/api/settings"), env)).json();
  assert.deepEqual(afterAtomic.weights, [1, 1, 1, 1, 1, 1]);
  // 白名单：禁止借 buyPointParams 注入 ma5ByCode 等行情输入
  const extraField = await api(
    make(
      "/api/settings",
      "POST",
      { "Content-Type": "application/json" },
      {
        buyPointParams: { firstNegMinPrevHeight: 2, ma5ByCode: { 600001: 99 } },
      },
    ),
    env,
  );
  assert.equal(extraField.status, 400);
  const afterExtra = await (await api(make("/api/settings"), env)).json();
  assert.equal(afterExtra.buyPointParams.ma5ByCode, undefined);
  const bad = await api(
    make("/api/paper/activate", "POST", {}, { id: "ai-2026-01-30" }),
    env,
  );
  assert.equal(bad.status, 503);
  assert.equal(
    aiConfig({ ...env, AI_BASE_URL: "https://evil.volces.com/v1" }).configured,
    false,
  );
  assert.equal(
    aiConfig({ ...env, AI_BASE_URL: "https://api.openai.com/v1?key=secret" })
      .base,
    null,
  );
  DB.close();
});

test("设置保存原子性：batch 内第二条写入失败时第一条一并回滚", async () => {
  const real = localDatabase();
  const make = (path, method = "GET", body) =>
    new Request(`https://example.test${path}`, {
      method,
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
  // 注入：两段同提交时，batch 的第二条（buyPointParams）在事务内抛错
  //（两条 SQL 文本相同，key 是绑定参数，只能按位置区分）
  const env = {
    DB: {
      prepare: (sql) => real.prepare(sql),
      batch(statements) {
        if (statements.length === 2) {
          const [first] = statements;
          return real.batch([
            first,
            {
              _run() {
                throw new Error("注入的买点参数写入失败");
              },
            },
          ]);
        }
        return real.batch(statements);
      },
    },
  };
  // 基线：单段 POST 走同一 batch 路径，正常成功
  await api(
    make("/api/settings", "POST", { weights: [1, 1, 1, 1, 1, 1] }),
    env,
  );
  // 两段同提交、第二条注入失败 → 外层 503，且第一条（权重）必须随事务回滚
  const response = await api(
    make("/api/settings", "POST", {
      weights: [9, 9, 9, 9, 9, 9],
      buyPointParams: { firstNegMinPrevHeight: 2 },
    }),
    env,
  );
  assert.equal(response.status, 503);
  // 用真实库读回：权重保持基线 [1×6]，买点参数未被写入（读回默认 3）
  const after = await (await api(make("/api/settings"), { DB: real })).json();
  assert.deepEqual(after.weights, [1, 1, 1, 1, 1, 1]);
  assert.equal(after.buyPointParams.firstNegMinPrevHeight, 3);
  real.close();
});

test("评分源缺失时只冻结防守计划，完整多日账本可以独立重放", async () => {
  const DB = localDatabase(),
    env = { DB },
    repository = new PaperRepository(env);
  const account = await repository.initialize();
  const first = dataset(dateAt(0));
  await repository.settle(
    account.revision,
    executePlan(account.book, null, first),
    first,
  );
  for (const pair of pairs(35)) {
    const current = await repository.account();
    const frozen = await repository.savePlan(
      createPlan(
        pair.snapshot,
        current.book,
        BASE_STRATEGY,
        "baseline-v1",
        pair.snapshot.createdAt,
      ),
    );
    const result = executePlan(current.book, frozen, pair.dataset);
    await repository.settle(current.revision, result, pair.dataset);
  }
  const bundle = await exportPaper(env);
  const audit = await verifyExport(bundle);
  assert.equal(audit.passed, true, JSON.stringify(audit));
  assert.equal(audit.days, 36);
  assert.ok(audit.fills > 10);
  const fallback = defensivePlan(
    dateAt(36),
    entered().book,
    BASE_STRATEGY,
    "baseline-v1",
    `${dateAt(36)}T07:10:00.000Z`,
  );
  assert.equal(fallback.sourceSnapshotMissing, true);
  assert.ok(
    fallback.orders.every(
      (order) =>
        ["HOLD", "EXIT"].includes(order.action) && order.score === null,
    ),
  );
  DB.close();
});

test("持仓掉出当日评分池时，原始分按最近快照归档回查", () => {
  const book = entered().book;
  const snap = snapshot(dateAt(2));
  snap.stocks = snap.stocks.filter((stock) => stock.code !== "600001");
  const missing = createPlan(snap, book, BASE_STRATEGY, "v", "now");
  assert.equal(missing.orders[0].action, "T_FORWARD");
  assert.equal(missing.orders[0].score, 90);
  assert.equal(missing.orders[0].originalScore, null);
  const backfilled = createPlan(snap, book, BASE_STRATEGY, "v", "now", {
    originalScoreLookup: (code) => (code === "600001" ? 88 : null),
  });
  assert.equal(backfilled.orders[0].action, "T_FORWARD");
  assert.equal(backfilled.orders[0].originalScore, 88);
});

test("结转单与防御计划的原始分同样按归档回查", () => {
  const lookup = (code) => (code === "600001" ? 88 : null);
  const book = entered().book;
  book.pendingExits = [
    { code: "600001", name: "合成样本", sector: "测试行业" },
  ];
  const snap = snapshot(dateAt(2));
  snap.stocks = snap.stocks.filter((stock) => stock.code !== "600001");
  const carriedPlan = createPlan(snap, book, BASE_STRATEGY, "v", "now", {
    originalScoreLookup: lookup,
  });
  const carriedOrder = carriedPlan.orders.find((order) => order.carried);
  assert.equal(carriedOrder.action, "EXIT");
  assert.equal(carriedOrder.originalScore, 88);
  const defensive = defensivePlan(
    dateAt(2),
    entered().book,
    BASE_STRATEGY,
    "v",
    "now",
    { originalScoreLookup: lookup },
  );
  assert.equal(defensive.orders[0].score, null);
  assert.equal(defensive.orders[0].originalScore, 88);
});

test("原始分回查只读归档，最近一次有效评分胜出", async () => {
  const DB = localDatabase();
  try {
    const write = (date, stocks) =>
      DB.prepare(
        "INSERT INTO snapshots (trade_date, created_at, payload) VALUES (?, ?, ?)",
      )
        .bind(date, `${date}T07:10:00.000Z`, JSON.stringify({ date, stocks }))
        .run();
    await write(dateAt(0), [
      { code: "600001", score: 70 },
      { code: "600002", score: null },
    ]);
    await write(dateAt(1), [
      { code: "600002", score: 83 },
      { code: "600003", score: 91 },
    ]);
    await write(dateAt(2), [{ code: "600001", score: null }]);
    const lookup = await buildOriginalScoreLookup(DB, dateAt(2), [
      "600001",
      "600002",
      "600003",
      "699999",
    ]);
    assert.equal(lookup("600001"), 70);
    assert.equal(lookup("600002"), 83);
    assert.equal(lookup("600003"), 91);
    assert.equal(lookup("699999"), null);
    const none = await buildOriginalScoreLookup(DB, dateAt(2), []);
    assert.equal(none("600001"), null);
  } finally {
    DB.close();
  }
});

// P1-1：持仓股跌出当日涨停池时，仍要通过日线 EOD 行补齐卖出信号。
// 复现用户验收用例：持仓收盘 10（元）、MA5=10.8，原实现只从评分池取行，
// 跌出池后 row=null，跌破 MA5 信号被跳过，仍按做 T 走。
test("P1-1：跌出涨停池的持仓由 EOD 行补齐，跌破 MA5 触发清仓而非做 T", () => {
  const book = newBook(100000);
  book.positions = [
    {
      code: "600099", // 不在 snapshot.stocks（合成池只有 600001/600002）
      name: "跌出池样本",
      sector: "测试行业",
      heldDays: 0,
      markCents: 1000, // 收盘 10 元 = 1000 分
      lots: [
        {
          acquiredDate: dateAt(0),
          quantity: 1000,
          costCents: 1000000,
          priceCents: 1000,
        },
      ],
    },
  ];
  book.cashCents = book.initialCashCents - 1000000;
  book.equityCents = book.initialCashCents;
  book.peakEquityCents = book.equityCents;
  const eodRowsByCode = new Map([
    [
      "600099",
      {
        close: 10, // 元
        open: 10.2,
        high: 10.3,
        change: -3.0,
        volume: null,
        limitUpPct: 10,
      },
    ],
  ]);
  const featuresByCode = new Map([
    // ma5 > close → 跌破 5 日均线（用户复现：收盘 10、MA5=10.8）
    [
      "600099",
      { ma5: 10.8, vol20Avg: null, todayVolume: null, high20Prev: null },
    ],
  ]);
  const snap = snapshot(dateAt(1));
  const plan1 = createPlan(snap, book, BASE_STRATEGY, "v", "now", {
    exitEodRowsByCode: eodRowsByCode,
    exitFeaturesByCode: featuresByCode,
  });
  const exitOrder = plan1.orders.find((o) => o.code === "600099");
  assert.ok(exitOrder, "应生成卖出订单");
  assert.equal(exitOrder.action, "EXIT");
  assert.match(exitOrder.reason, /主动卖出信号/);
  assert.match(exitOrder.reason, /5\s*日均线/);
  // 上下文冻结写入 payload，供重算/影子/回测共用
  assert.ok(plan1.exitContext, "计划应冻结 exitContext");
  assert.ok(plan1.exitContext.features["600099"]);
  assert.ok(plan1.exitContext.eodRows["600099"]);
});

// P1-2：冻结上下文复算必须得到同一决策（用户复现：仅改手续费后 EXIT 变 ADD）。
test("P1-2：exitContextFrozen 反序列化复现同一决策；缺失上下文时不写空壳", () => {
  const book = newBook(100000);
  book.positions = [
    {
      code: "600099",
      name: "跌出池样本",
      sector: "测试行业",
      heldDays: 0,
      markCents: 1000,
      lots: [
        {
          acquiredDate: dateAt(0),
          quantity: 1000,
          costCents: 1000000,
          priceCents: 1000,
        },
      ],
    },
  ];
  book.cashCents = book.initialCashCents - 1000000;
  book.equityCents = book.initialCashCents;
  book.peakEquityCents = book.equityCents;
  const eodRowsByCode = new Map([
    [
      "600099",
      {
        close: 10,
        open: 10.2,
        high: 10.3,
        change: -3.0,
        volume: null,
        limitUpPct: 10,
      },
    ],
  ]);
  const featuresByCode = new Map([["600099", { ma5: 10.8 }]]);
  const snap = snapshot(dateAt(1));
  const original = createPlan(snap, book, BASE_STRATEGY, "v", "now", {
    exitEodRowsByCode: eodRowsByCode,
    exitFeaturesByCode: featuresByCode,
  });
  const originalAction = original.orders.find(
    (o) => o.code === "600099",
  ).action;
  assert.equal(originalAction, "EXIT");
  // 重算：不传原始 Map，只传从 payload 反序列化的 exitContextFrozen。
  const recalculated = createPlan(snap, book, BASE_STRATEGY, "v", "now", {
    exitContextFrozen: original.exitContext,
  });
  const recalcAction = recalculated.orders.find(
    (o) => o.code === "600099",
  ).action;
  assert.equal(
    recalcAction,
    "EXIT",
    "仅重放冻结上下文必须得到同一卖出决策（不得退回 ADD/REDUCE）",
  );
  // 无任何上下文时 exitContext 置 null，不写空壳对象。
  const plain = createPlan(
    snapshot(dateAt(0)),
    newBook(100000),
    BASE_STRATEGY,
    "v",
    "now",
  );
  assert.equal(plain.exitContext, null);
  // 序列化往返安全（JSON.stringify）：plan 直接入库时不能因 Map/undefined 崩。
  assert.doesNotThrow(() => JSON.stringify(original));
});

// P1-1（第二轮）：出池持仓的炸板次数接入真实炸板池记录，炸板不回封
// 信号不再漏检。复现用户验收用例：炸板 3 次、收盘涨 5%（未回封），
// 原实现 breaks 固定 null → 信号跳过，仍生成正向做 T。
test("P1-1：出池持仓接入炸板池记录，炸板 3 次未回封触发清仓", () => {
  const book = newBook(100000);
  book.positions = [
    {
      code: "600099", // 不在 snapshot.stocks，但在当日炸板池
      name: "炸板样本",
      sector: "测试行业",
      heldDays: 0,
      markCents: 1050, // 收盘 10.5 元，涨 5%
      lots: [
        {
          acquiredDate: dateAt(0),
          quantity: 1000,
          costCents: 1000000,
          priceCents: 1000,
        },
      ],
    },
  ];
  book.cashCents = book.initialCashCents - 1000000;
  book.equityCents = book.initialCashCents;
  book.peakEquityCents = book.equityCents;
  const snap = snapshot(dateAt(1));
  const plan = createPlan(snap, book, BASE_STRATEGY, "v", "now", {
    exitEodRowsByCode: new Map([
      [
        "600099",
        {
          close: 10.5,
          open: 10.4,
          high: 11.0, // 盘中触及涨停但收盘未回封
          change: 5.0,
          volume: null,
          limitUpPct: 10,
        },
      ],
    ]),
    exitBreaksByCode: new Map([["600099", 3]]),
  });
  const order = plan.orders.find((o) => o.code === "600099");
  assert.ok(order, "应生成卖出订单");
  assert.equal(order.action, "EXIT");
  assert.match(order.reason, /炸板/);
  assert.match(order.reason, /3 次/);
  // 炸板记录随上下文冻结，重算可复现同一决策
  assert.equal(plan.exitContext?.breaks?.["600099"], 3);
  // 不在炸板池的出池持仓：炸板次数保持未知（不猜 0），信号跳过
  const noBreaks = createPlan(snap, book, BASE_STRATEGY, "v", "now", {
    exitEodRowsByCode: new Map([
      [
        "600099",
        {
          close: 10.5,
          open: 10.4,
          high: 11.0,
          change: 5.0,
          volume: null,
          limitUpPct: 10,
        },
      ],
    ]),
  });
  const holdOrder = noBreaks.orders.find((o) => o.code === "600099");
  assert.notEqual(holdOrder?.action, "EXIT");
  assert.equal(noBreaks.exitContext?.breaks, undefined);
});

// 出池持仓测试夹具：1000 股、成本 10 元，可按 markCents 调整现价、
// pyramidStage 指定已执行的金字塔档位。
function outOfPoolBook(markCents = 1000, pyramidStage = 0) {
  const book = newBook(100000);
  book.positions = [
    {
      code: "600099", // 不在 snapshot.stocks（合成池只有 600001/600002）
      name: "跌出池样本",
      sector: "测试行业",
      heldDays: 0,
      markCents,
      ...(pyramidStage ? { pyramidStage } : {}),
      lots: [
        {
          acquiredDate: dateAt(0),
          quantity: 1000,
          costCents: 1000000,
          priceCents: 1000,
        },
      ],
    },
  ];
  book.cashCents = book.initialCashCents - 1000000;
  book.equityCents = book.initialCashCents;
  book.peakEquityCents = book.equityCents;
  return book;
}

// P1-1（第三轮）：日线缺失时炸板池记录单独触发炸板不回封清仓。
test("P1-1：日线缺失时炸板池记录单独触发炸板不回封清仓", () => {
  const plan = createPlan(
    snapshot(dateAt(1)),
    outOfPoolBook(),
    BASE_STRATEGY,
    "v",
    "now",
    {
      // 无 exitEodRowsByCode：当日日线缺失
      exitBreaksByCode: new Map([["600099", 3]]),
    },
  );
  const order = plan.orders.find((o) => o.code === "600099");
  assert.equal(order?.action, "EXIT");
  assert.match(order.reason, /炸板 3 次/);
  assert.equal(plan.exitContext?.breaks?.["600099"], 3);
});

// P1-1（第三轮）：炸板池明确的未封板状态优先于涨幅推断——收涨 9.8%
// 会被阈值推断误判为封板而漏检，炸板池记录是权威事实。
test("P1-1：炸板池明确未封板优先于涨幅推断（收涨 9.8% 不误判为封板）", () => {
  const plan = createPlan(
    snapshot(dateAt(1)),
    outOfPoolBook(1098),
    BASE_STRATEGY,
    "v",
    "now",
    {
      exitEodRowsByCode: new Map([
        [
          "600099",
          {
            close: 10.98,
            open: 10.0,
            high: 11.0,
            change: 9.8, // ≥ 10-0.3，按涨幅推断会误判为封板
            volume: null,
            limitUpPct: 10,
          },
        ],
      ]),
      exitBreaksByCode: new Map([["600099", 3]]),
    },
  );
  const order = plan.orders.find((o) => o.code === "600099");
  assert.equal(order?.action, "EXIT");
  assert.match(order.reason, /炸板/);
});

// P1（第三轮）：研究重放读取 pair 携带的固化卖出上下文，与主账户同日
// 决策一致。复现用户验收用例：同一策略/快照/初始持仓，主账户清仓 1000
// 股，重放缺上下文却生成买入。
test("P1：研究重放读取 pair 固化卖出上下文，与主账户同日决策一致", () => {
  const day = dataset(dateAt(1), "600099");
  day.previousTradingDate = dateAt(0);
  // 池内候选同样给足行情：缺少行情会被判为"缺少日期"破坏覆盖声明。
  for (const code of ["600001", "600002"]) {
    day.quotes[code] = {
      date: dateAt(1),
      previousCloseCents: 1000,
      openCents: 1000,
      closeCents: 1000,
      limitUpCents: 1100,
      limitDownCents: 900,
    };
    day.minutes[code] = bars(1000);
  }
  const context = {
    features: { 600099: { ma5: 10.8 } },
    eodRows: {
      600099: {
        close: 10,
        open: 10.2,
        high: 10.3,
        change: -3.0,
        volume: null,
        limitUpPct: 10,
      },
    },
  };
  const withContext = replayStrategy(
    [{ snapshot: snapshot(dateAt(0)), dataset: day, exitContext: context }],
    BASE_STRATEGY,
    100000,
    undefined,
    outOfPoolBook(),
    null,
    {},
  );
  assert.ok(
    withContext.fills.some((f) => f.side === "SELL" && f.quantity === 1000),
    "重放应按固化上下文清仓全部 1000 股",
  );
  assert.equal(withContext.covered, true);
  // 对照：无上下文时同一持仓不得触发清仓（做 T 腿或 HOLD，量 < 1000）。
  const without = replayStrategy(
    [{ snapshot: snapshot(dateAt(0)), dataset: day }],
    BASE_STRATEGY,
    100000,
    undefined,
    outOfPoolBook(),
    null,
    {},
  );
  assert.ok(
    !without.fills.some((f) => f.side === "SELL" && f.quantity === 1000),
  );
});

// P2（第三轮）：卖出上下文输入按日期固化并绑定摘要——主账户冻结后日线
// Parquet 补齐，影子/研究重放重读仍得到首写版本，决策不漂移。
test("P2：卖出上下文输入按日期固化并绑定摘要，重读不随输入漂移", async () => {
  const DB = localDatabase();
  try {
    const snapA = snapshot(dateAt(1));
    snapA.market = { brokenRows: [{ c: "600099", n: "炸板样本", zbc: 3 }] };
    const first = await loadOrBuildExitContext({
      env: {},
      db: DB,
      snapshot: snapA,
      date: dateAt(1),
    });
    assert.equal(first.persisted, true, "落盘后回读固化版本");
    assert.equal(first.exitBreaksByCode.get("600099"), 3);
    const persisted = await loadPersistedExitInputs(DB, dateAt(1));
    assert.ok(persisted?.breaks?.["600099"] === 3, "输入已持久化");
    const snapB = snapshot(dateAt(1));
    snapB.market = { brokenRows: [{ c: "600099", n: "炸板样本", zbc: 9 }] };
    const second = await loadOrBuildExitContext({
      env: {},
      db: DB,
      snapshot: snapB,
      date: dateAt(1),
    });
    assert.equal(second.persisted, true, "重读引用固化版本");
    assert.equal(
      second.exitBreaksByCode.get("600099"),
      3,
      "固化后不随输入漂移",
    );
    // 摘要损坏 → 视为缺失，按当前输入重新计算（不静默使用损坏数据）。
    await DB.prepare(
      "UPDATE exit_context_inputs SET digest='deadbeef' WHERE trade_date=?",
    )
      .bind(dateAt(1))
      .run();
    assert.equal(await loadPersistedExitInputs(DB, dateAt(1)), null);
    const third = await loadOrBuildExitContext({
      env: {},
      db: DB,
      snapshot: snapB,
      date: dateAt(1),
    });
    assert.equal(third.persisted, false);
    assert.equal(third.exitBreaksByCode.get("600099"), 9);
  } finally {
    DB.close();
  }
});

// P2（第四轮）：并发首写收敛——两条链路在空表上交错执行时都不得各自
// 采用本地计算结果，必须回读并采用实际落盘的固化版本。
test("P2：并发首写收敛，两条链路都采用实际落盘的固化版本", async () => {
  const DB = localDatabase();
  try {
    const date = dateAt(2);
    const snapA = snapshot(date);
    snapA.market = { brokenRows: [{ c: "600099", n: "炸板样本", zbc: 3 }] };
    const snapB = snapshot(date);
    snapB.market = { brokenRows: [{ c: "600099", n: "炸板样本", zbc: 9 }] };
    const [a, b] = await Promise.all([
      loadOrBuildExitContext({ env: {}, db: DB, snapshot: snapA, date }),
      loadOrBuildExitContext({ env: {}, db: DB, snapshot: snapB, date }),
    ]);
    assert.equal(a.persisted, true, "链路 A 采用落盘版本");
    assert.equal(b.persisted, true, "链路 B 采用落盘版本");
    assert.deepEqual(
      Object.fromEntries(a.exitBreaksByCode),
      Object.fromEntries(b.exitBreaksByCode),
      "并发链路收敛到同一条固化输入（不允许 ADD vs EXIT 分裂）",
    );
  } finally {
    DB.close();
  }
});

// ---------- 方案 4：金字塔减仓参数化 ----------

test("金字塔减仓：里程碑按序触发、档位只执行一次、比例向量可配置", () => {
  const snap = snapshot(dateAt(1));
  // 第 1 档：+10% 减 3 成（skill 默认 [0.3, 0.2, 0.1]）
  const first = createPlan(
    snap,
    outOfPoolBook(1100),
    BASE_STRATEGY,
    "v",
    "now",
  ).orders.find((o) => o.code === "600099");
  assert.equal(first.action, "REDUCE");
  assert.equal(first.quantity, 300);
  assert.equal(first.pyramidRung, 1);
  assert.match(first.reason, /金字塔减仓第 1 档/);
  assert.match(first.reason, /3 成/);
  // 档位已执行且未到下一里程碑：不再减仓（回落到持有）
  const holdAfterFirst = createPlan(
    snap,
    outOfPoolBook(1100, 1),
    BASE_STRATEGY,
    "v",
    "now",
  ).orders.find((o) => o.code === "600099");
  assert.equal(holdAfterFirst.action, "HOLD");
  // 第 2 档：+20% 减 2 成（stage=1）
  const second = createPlan(
    snap,
    outOfPoolBook(1200, 1),
    BASE_STRATEGY,
    "v",
    "now",
  ).orders.find((o) => o.code === "600099");
  assert.equal(second.action, "REDUCE");
  assert.equal(second.quantity, 200);
  assert.equal(second.pyramidRung, 2);
  // 第 3 档：+30% 减 1 成（stage=2）；档位用尽后不再触发
  const third = createPlan(
    snap,
    outOfPoolBook(1300, 2),
    BASE_STRATEGY,
    "v",
    "now",
  ).orders.find((o) => o.code === "600099");
  assert.equal(third.pyramidRung, 3);
  assert.equal(third.quantity, 100);
  const exhausted = createPlan(
    snap,
    outOfPoolBook(1300, 3),
    BASE_STRATEGY,
    "v",
    "now",
  ).orders.find((o) => o.code === "600099");
  assert.equal(exhausted.action, "HOLD");
  // 自定义向量生效：第一档改减 5 成
  const custom = createPlan(
    snap,
    outOfPoolBook(1100),
    { ...BASE_STRATEGY, pyramidReduce: [0.5, 0.2, 0.1] },
    "v",
    "now",
  ).orders.find((o) => o.code === "600099");
  assert.equal(custom.quantity, 500);
  // 比例为 0 的档位跳过（不产生减仓订单，档位不消费）
  const zero = createPlan(
    snap,
    outOfPoolBook(1100),
    { ...BASE_STRATEGY, pyramidReduce: [0, 0.2, 0.1] },
    "v",
    "now",
  ).orders.find((o) => o.code === "600099");
  assert.equal(zero.action, "HOLD");
  // 盈利 25% 直接落到第 2 档（第 1 档为零比例，透明跳过不阻断）
  const zeroSkip = createPlan(
    snap,
    outOfPoolBook(1250),
    { ...BASE_STRATEGY, pyramidReduce: [0, 0.2, 0.1] },
    "v",
    "now",
  ).orders.find((o) => o.code === "600099");
  assert.equal(zeroSkip.action, "REDUCE");
  assert.equal(zeroSkip.quantity, 200);
  assert.equal(zeroSkip.pyramidRung, 2);
  // 旧版本策略缺向量字段：不启用金字塔（+10% 未到旧止盈阈值 12%），
  // 且旧止盈减半语义原样保留——重算与核验不因新规则漂移。
  const legacy = { ...structuredClone(BASE_STRATEGY) };
  delete legacy.pyramidReduce;
  const legacyHold = createPlan(
    snap,
    outOfPoolBook(1100),
    legacy,
    "v",
    "now",
  ).orders.find((o) => o.code === "600099");
  assert.equal(legacyHold.action, "HOLD");
  const legacyReduce = createPlan(
    snap,
    outOfPoolBook(1150),
    legacy,
    "v",
    "now",
  ).orders.find((o) => o.code === "600099");
  assert.equal(legacyReduce.action, "REDUCE");
  assert.equal(legacyReduce.quantity, 500);
  assert.equal(legacyReduce.pyramidRung, undefined);
  assert.match(legacyReduce.reason, /分批兑现达到止盈阈值的仓位/);
});

test("金字塔减仓：保护止盈 helper 按价格触达的下一未执行档执行", () => {
  const position = {
    code: "600099",
    lots: [{ acquiredDate: "2026-01-01", quantity: 1000, costCents: 1000000 }],
  };
  // 价格 +13%、stage 0：触达第 1 档里程碑（+10%）→ 按比例减仓
  const first = protectivePyramidReduce(position, 1130, [0.3, 0.2, 0.1]);
  assert.deepEqual(
    { rung: first.rung, ratio: first.ratio },
    { rung: 1, ratio: 0.3 },
  );
  // 价格 +13%、stage 1：未触达第 2 档里程碑（+20%）→ 待命
  assert.equal(
    protectivePyramidReduce(
      { ...position, pyramidStage: 1 },
      1130,
      [0.3, 0.2, 0.1],
    ),
    null,
  );
  // 价格 +21%、stage 1：第 2 档触发
  const second = protectivePyramidReduce(
    { ...position, pyramidStage: 1 },
    1210,
    [0.3, 0.2, 0.1],
  );
  assert.equal(second.rung, 2);
  // 档位用尽 → null
  assert.equal(
    protectivePyramidReduce(
      { ...position, pyramidStage: 3 },
      1400,
      [0.3, 0.2, 0.1],
    ),
    null,
  );
  // 旧计划无向量 → null（调用方走旧减半语义）
  assert.equal(protectivePyramidReduce(position, 1130, undefined), null);
});

test("保护止盈按金字塔档位减仓：日内冲高按档比例执行而非减半", () => {
  const book = newBook(100000);
  book.positions = [
    {
      code: "600001",
      name: "合成样本",
      sector: "测试行业",
      heldDays: 1,
      markCents: 1000, // 与执行日昨收一致（首档已执行，价格回落到成本）
      pyramidStage: 1, // 首档已在昨日执行，当前待执行第 2 档（20%）
      lots: [
        {
          acquiredDate: dateAt(0),
          quantity: 1000,
          costCents: 1000000,
          priceCents: 1000,
        },
      ],
    },
  ];
  book.cashCents = book.initialCashCents - 1000000;
  book.equityCents = book.initialCashCents;
  book.peakEquityCents = book.equityCents;
  // 计划只含做 T（无减仓）→ 持仓存在保护单；stage 1、第二档配置 20%
  // 时冲高触达 +20% 里程碑按 200 股执行（复现用户验收：不再卖 500）。
  const tPlan = plan(
    [order("T_FORWARD", 200, { takeProfitCents: 1120 })],
    dateAt(0),
  );
  const day = dataset(dateAt(1), "600001", {
    minutes: bars(1000, { "10:00": 1210, "10:01": 1210 }),
  });
  const result = executePlan(
    book,
    {
      ...tPlan,
      strategy: { ...BASE_STRATEGY, pyramidReduce: [0.3, 0.2, 0.1] },
    },
    day,
  );
  assert.ok(
    result.ledger.find((fill) => fill.side === "SELL" && fill.quantity === 200),
    "保护止盈应按第 2 档比例卖出 200 股（而非减半 500）",
  );
  const position = result.book.positions.find((p) => p.code === "600001");
  assert.equal(position.pyramidStage, 2, "保护止盈成交推进档位");
  // 旧计划（无向量）同一场景保持旧减半语义
  const legacy = executePlan(book, tPlan, day);
  assert.ok(
    legacy.ledger.find((f) => f.side === "SELL" && f.quantity === 500),
    "旧计划保护止盈保持减半",
  );
});

test("金字塔减仓：跨日续单保留档位，成交后不重复减仓", async () => {
  const strategy = { ...BASE_STRATEGY, pyramidReduce: [0.3, 0.2, 0.1] };
  const book = outOfPoolBook(1100);
  book.lastDate = dateAt(0);
  const pyramidPlan = createPlan(
    snapshot(dateAt(0)),
    book,
    strategy,
    "v",
    `${dateAt(0)}T07:10:00.000Z`,
  );
  // 首日无实时观测：减仓未成交 → 跨日续单必须保留档位声明
  let session = openSession(book, pyramidPlan, dateAt(1));
  const day1 = {
    ...dataset(dateAt(1), "600099", {
      previous: 1100,
      close: 1100,
      previousDate: dateAt(0),
    }),
    executionMode: "realtime",
  };
  const closed = closeSession(book, session, day1);
  assert.equal(closed.book.pendingOrders.length, 1);
  assert.equal(
    closed.book.pendingOrders[0].pyramidRung,
    1,
    "跨日续单保留档位（否则次日重复减仓）",
  );
  // 次日计划：续单替换新生成的同档减仓（不重复），成交推进档位
  const carried = closed.book;
  const nextPlan = createPlan(
    snapshot(dateAt(1)),
    carried,
    strategy,
    "v",
    `${dateAt(1)}T07:10:00.000Z`,
  );
  const carriedOrders = nextPlan.orders.filter((o) => o.code === "600099");
  assert.equal(carriedOrders.length, 1);
  assert.equal(carriedOrders[0].pyramidRung, 1);
  assert.equal(carriedOrders[0].quantity, 300);
  // 次日实时会话：续单成交推进档位（真实流转由实时会话消费续单；
  // 首帧为累计量基线，第二帧才供给区间成交量）。
  let session2 = openSession(carried, nextPlan, dateAt(2));
  let step;
  for (const [zTime, zVolume] of [
    ["01:31:00", 100000],
    ["01:31:05", 5000000],
  ]) {
    step = advanceSession(structuredClone(carried), session2, {
      observedAt: `${dateAt(2)}T${zTime}.000Z`,
      pollIntervalSeconds: 60,
      quotes: {
        600099: {
          date: dateAt(2),
          timestamp: `${dateAt(2)}T09:31:${zTime.slice(-2)}+08:00`,
          closeCents: 1100,
          openCents: 1100,
          previousCloseCents: 1100,
          volumeShares: zVolume,
          limitUpCents: 1210,
          limitDownCents: 990,
        },
      },
    });
    session2 = step.session;
  }
  const day2 = {
    ...dataset(dateAt(2), "600099", {
      previous: 1100,
      close: 1100,
      previousDate: dateAt(1),
    }),
    executionMode: "realtime",
  };
  const result = closeSession(step.book, step.session, day2);
  const position = result.book.positions.find((p) => p.code === "600099");
  assert.equal(position.pyramidStage, 1, "续单成交推进档位");
  assert.equal(result.book.pendingOrders.length, 0, "已完成的续单不再跨日");
  // 第三日计划：同一盈利水平不再重复第 1 档
  const finalPlan = createPlan(
    snapshot(dateAt(2)),
    result.book,
    strategy,
    "v",
    "now",
  );
  assert.equal(
    finalPlan.orders.find((o) => o.code === "600099").action,
    "HOLD",
  );
});

test("金字塔减仓：成交推进档位，后续计划不重复减仓", () => {
  const snap = snapshot(dateAt(1));
  const book = outOfPoolBook(1100);
  const pyramidPlan = createPlan(
    snap,
    book,
    BASE_STRATEGY,
    "v",
    `${dateAt(1)}T07:10:00.000Z`,
  );
  const reduceOrder = pyramidPlan.orders.find((o) => o.code === "600099");
  assert.equal(reduceOrder.pyramidRung, 1);
  // 执行日行情：昨收与账面价一致，收盘仍为 +10%
  const day = dataset(dateAt(2), "600099", {
    previous: 1100,
    open: 1100,
    close: 1100,
    limitUp: 1210,
    limitDown: 990,
  });
  const result = executePlan(book, pyramidPlan, day);
  const position = result.book.positions.find((p) => p.code === "600099");
  assert.equal(position.pyramidStage, 1, "金字塔档位随成交推进");
  assert.ok(
    result.ledger.some(
      (fill) => fill.code === "600099" && fill.quantity === 300,
    ),
    "应成交 300 股的第 1 档减仓",
  );
  // 次日计划：同一盈利水平不再重复触发第 1 档
  const nextPlan = createPlan(
    { ...snap, date: dateAt(2) },
    result.book,
    BASE_STRATEGY,
    "v",
    "now",
  );
  const nextOrder = nextPlan.orders.find((o) => o.code === "600099");
  assert.equal(nextOrder.action, "HOLD");
});

test("AI 赛马候选：pyramidReduce 向量校验", () => {
  const ok = validateProposal({
    rationale: "r",
    patch: { pyramidReduce: [0.4, 0.3, 0.2] },
  });
  assert.deepEqual(ok.params.pyramidReduce, [0.4, 0.3, 0.2]);
  for (const bad of [
    [0.4, 0.3],
    [0.4, 0.3, 0.2, 0.1],
    [0.4, 0.3, 0.6],
    [0.4, 0.3, "x"],
  ])
    assert.throws(
      () => validateProposal({ rationale: "r", patch: { pyramidReduce: bad } }),
      /金字塔/,
    );
});

test("手动策略参数：pyramidReduce 可选默认、越界拒绝", () => {
  const legacyParams = structuredClone(STRATEGY_DEFAULTS);
  delete legacyParams.pyramidReduce;
  assert.deepEqual(
    normalizeStrategyParams(legacyParams).pyramidReduce,
    [0.3, 0.2, 0.1],
    "旧版本缺字段按 skill 默认档位补齐",
  );
  assert.throws(
    () =>
      normalizeStrategyParams({
        ...STRATEGY_DEFAULTS,
        pyramidReduce: [0.3, 0.2],
      }),
    /策略参数/,
  );
  assert.throws(
    () =>
      normalizeStrategyParams({
        ...STRATEGY_DEFAULTS,
        pyramidReduce: [0.3, 0.2, 0.6],
      }),
    /策略参数/,
  );
});
