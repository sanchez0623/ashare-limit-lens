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
  BASE_STRATEGY,
  transactionFees,
} from "../backend/domain/trading.js";
import {
  validateProposal,
  validateCandidate,
} from "../backend/domain/validation.js";
import { PaperRepository } from "../backend/storage/paper.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import {
  improveStrategy,
  requestProposal,
} from "../backend/services/improvement.js";
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
  return executePlan(newBook(), plan([order()]), dataset(dateAt(1)));
}
test("交易费用使用分为单位，买卖印花税方向正确", () => {
  assert.deepEqual(transactionFees(1000000, "BUY"), {
    commission: 500,
    transfer: 10,
    stamp: 0,
    total: 510,
  });
  assert.equal(transactionFees(1000000, "SELL").total, 1010);
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
    newBook(),
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
    newBook(),
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
      executePlan(newBook(), plan([order()], dateAt(1)), dataset(dateAt(1))),
    /开盘前/,
  );
  assert.throws(
    () =>
      executePlan(
        newBook(),
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
    createPlan(snapshot(dateAt(0)), newBook(), BASE_STRATEGY, "v", "now")
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
      newBook(),
      BASE_STRATEGY,
      "v",
      "now",
    ).orders.length,
    0,
  );
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
test("真实 AI 适配器只发送训练窗口；版本通过后启用且禁止同窗口重复调参", async () => {
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
  let received = null,
    calls = 0;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls++;
    received = JSON.parse(options.body);
    assert.equal(options.redirect, "error");
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
    assert.equal(result.status, "ACTIVE");
    assert.equal(
      (await repository.account()).book.activeStrategy,
      result.version,
    );
    const sent = JSON.parse(received.messages[1].content);
    assert.equal(sent.dailySignals.length, 20);
    assert.equal(sent.dailySignals.at(-1).date, dateAt(19));
    assert.ok(!JSON.stringify(sent).includes(dateAt(30)));
    await improveStrategy(repository, env, requestProposal);
    assert.equal(calls, 1);
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
  const config = await api(make("/api/settings"), env);
  assert.ok(!(await config.text()).includes(env.AI_API_KEY));
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
