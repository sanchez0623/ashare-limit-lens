import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "cheerio";
import { localDatabase } from "../scripts/local-db.mjs";
import { newBook } from "../backend/domain/trading.js";
import { buildExecutionReview } from "../backend/domain/execution-review.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import {
  loadReview,
  gradeWithAI,
  historyList,
  reviewHistorySummary,
} from "../backend/services/review.js";
import {
  recordReviewDailyMetric,
  discoverMissingEvidenceWindows,
} from "../backend/services/evidence.js";
import { executionReviewView } from "../frontend/execution-review.js";
import { api } from "../backend/routes/api.js";

// 只用合成的归档成交与行情，不读写实际账户，不访问模型或行情服务。
const signalDate = "2026-10-23";
const date = "2026-10-26";
const code = "600001";
const stamp = `${date}T15:10:00+08:00`;
function position(options = {}) {
  return {
    code,
    name: "合成旧仓",
    sector: "冻结行业",
    markCents: 1000,
    lots: [{ acquiredDate: "2026-10-22", quantity: 1000, costCents: 900500 }],
    ...options,
  };
}
function fill(options = {}) {
  const row = {
    code,
    name: "合成成交",
    action: "OPEN",
    side: "BUY",
    quantity: 100,
    priceCents: 1000,
    feeCents: 500,
    basisCents: 0,
    orderId: "synthetic-order",
    date,
    signalDate,
    buyPoint: "first-neg-dip",
    entryEvidence: {
      quoteTimestamp: `${date}T10:00:00+08:00`,
      configId: "manual-config",
    },
    executionCost: { totalBps: 25 },
    ...options,
  };
  row.notionalCents = row.priceCents * row.quantity;
  row.cashDeltaCents =
    (row.side === "BUY" ? -row.notionalCents : row.notionalCents) -
    row.feeCents;
  row.realizedPnlCents =
    row.side === "SELL" ? row.cashDeltaCents - row.basisCents : 0;
  return row;
}
function fixture({
  positions = [],
  trades = [fill()],
  close = 1100,
  orders,
} = {}) {
  const book = newBook();
  book.lastDate = signalDate;
  book.cashCents = 10000000;
  book.positions = structuredClone(positions);
  book.equityCents =
    book.cashCents +
    positions.reduce(
      (n, p) =>
        n + p.lots.reduce((q, lot) => q + lot.quantity, 0) * p.markCents,
      0,
    );
  const fills = trades.map((trade, sequence) => ({
    ...structuredClone(trade),
    id: `${date}:live:${sequence}`,
    sequence,
  }));
  const plan = {
    signalDate,
    createdAt: `${signalDate}T07:10:00Z`,
    strategyVersion: "manual-config",
    dragonPolicy: {
      version: "dragon-risk-v1",
      configId: "manual-config",
      configDigest: "frozen-config-digest",
      provenance: { origin: "MANUAL", validationMode: "MANUAL_UNVERIFIED" },
    },
    selectionPolicyVersion: "dragon-risk-v1",
    engineBuild: "frozen-engine",
    entryExecutionPolicy: {
      history: {
        [code]: { name: "冻结股票", sector: "冻结行业" },
        600002: { name: "另一成交", sector: "另一行业" },
      },
    },
    feeModel: "itemized-v2",
    feeConfigVersion: 2,
    feeConfig: { commissionRate: 0.0003 },
    executionCostModel: "TIME_LIQUIDITY_V1",
    executionCostPolicy: { payloadDigest: "frozen-cost" },
    orders: [],
  };
  const session = {
    date,
    signalDate,
    status: "CLOSED",
    initialBook: book,
    plan,
    fillCount: fills.length,
    orders:
      orders ??
      [...new Set(fills.map((f) => f.orderId))].map((id) => ({
        id,
        code: fills.find((f) => f.orderId === id).code,
        action: fills.find((f) => f.orderId === id).action,
        status: "FILLED",
        reason: "按冻结买点及风险预算成交",
        filledQuantity: fills
          .filter((f) => f.orderId === id)
          .reduce((n, f) => n + f.quantity, 0),
      })),
  };
  const quotes = Object.fromEntries(
    [
      ...new Set([
        ...positions.map((p) => p.code),
        ...fills.map((f) => f.code),
      ]),
    ].map((c) => [
      c,
      {
        date,
        timestamp: `${date}T15:00:03+08:00`,
        previousCloseCents: 1000,
        openCents: 1010,
        lowCents: 980,
        closeCents: close,
      },
    ]),
  );
  const dataset = {
    date,
    previousTradingDate: signalDate,
    quotes,
    source: "synthetic-test-fixture",
  };
  const equity = {
    date,
    complete: true,
    cashCents: book.cashCents + fills.reduce((n, f) => n + f.cashDeltaCents, 0),
    realizedPnlCents:
      book.realizedPnlCents + fills.reduce((n, f) => n + f.realizedPnlCents, 0),
    feesCents: book.feesCents + fills.reduce((n, f) => n + f.feeCents, 0),
  };
  return { date, session, dataset, equity, fills, createdAt: stamp };
}
async function archive(DB, source) {
  for (const [table, payload] of [
    ["paper_live_sessions", source.session],
    ["paper_market_days", source.dataset],
  ])
    await DB.prepare(
      `INSERT INTO ${table}(trade_date,payload,digest) VALUES(?,?,?)`,
    )
      .bind(date, JSON.stringify(payload), await digestOf(payload))
      .run();
  await DB.prepare("INSERT INTO paper_equity(trade_date,payload) VALUES(?,?)")
    .bind(date, JSON.stringify(source.equity))
    .run();
  for (const row of source.fills)
    await DB.prepare(
      "INSERT INTO paper_ledger(id,trade_date,payload) VALUES(?,?,?)",
    )
      .bind(row.id, date, JSON.stringify(row))
      .run();
}
async function saveReview(DB, review, ai = null) {
  await DB.prepare(
    "INSERT INTO reviews(trade_date,snapshot_date,created_at,payload,ai_payload) VALUES(?,?,?,?,?)",
  )
    .bind(
      review.date,
      review.snapshotDate,
      stamp,
      JSON.stringify(review),
      ai ? JSON.stringify(ai) : null,
    )
    .run();
}
const atClose = (t) =>
  t.mock.timers.enable({ apis: ["Date"], now: new Date(stamp) });

test("新建仓：按实际成交价格和费用盯市，不再重复扣滑点或虚拟卖出费", async () => {
  const r = await buildExecutionReview(fixture());
  assert.equal(r.reviewKind, "V5_EXECUTION");
  assert.equal(r.status, "COMPLETE");
  assert.equal(r.systemScore, null);
  assert.deepEqual(
    [
      r.summary.dailyPnlCents,
      r.summary.realizedPnlCents,
      r.summary.unrealizedPnlCents,
      r.summary.feeCents,
    ],
    [9500, 0, 9500, 500],
  );
  assert.equal(r.rows[0].endingQuantity, 100);
  assert.ok(Math.abs(r.rows[0].closeReturn - 10) < 1e-9);
  assert.deepEqual(r.rows[0].buyPoints, ["first-neg-dip"]);
  assert.equal(r.policy.provenance.validationMode, "MANUAL_UNVERIFIED");
});

test("多笔部分成交按股票合并，均价按数量加权，板块与逐股金额一致", async () => {
  const r = await buildExecutionReview(
    fixture({
      trades: [
        fill(),
        fill({ quantity: 200, priceCents: 1020 }),
        fill({ code: "600002", quantity: 100, orderId: "other" }),
      ],
      close: 1050,
    }),
  );
  assert.equal(r.total, 2);
  assert.equal(r.summary.fillCount, 3);
  assert.equal(r.rows[0].fillCount, 2);
  assert.equal(r.rows[0].buy.quantity, 300);
  assert.equal(r.rows[0].buy.averagePriceCents, 304000 / 300);
  assert.equal(r.rows[0].dailyPnlCents, 10000);
  assert.equal(r.summary.dailyPnlCents, 14500);
  assert.equal(
    r.sectors.reduce((n, s) => n + s.dailyPnlCents, 0),
    14500,
  );
  assert.equal(
    r.sectors.reduce((n, s) => n + s.feeCents, 0),
    1500,
  );
});

test("旧仓部分卖出：当日损益、历史成本已实现盈亏与剩余浮盈分别计算", async () => {
  const r = await buildExecutionReview(
    fixture({
      positions: [position()],
      close: 1080,
      trades: [
        fill({
          action: "REDUCE",
          side: "SELL",
          quantity: 400,
          priceCents: 1100,
          feeCents: 600,
          basisCents: 360200,
          buyPoint: null,
        }),
      ],
    }),
  );
  assert.deepEqual(
    [
      r.rows[0].dailyPnlCents,
      r.rows[0].realizedPnlCents,
      r.rows[0].unrealizedPnlCents,
    ],
    [87400, 79200, 107700],
  );
  assert.equal(r.rows[0].endingQuantity, 600);
  assert.equal(
    r.summary.dailyPnlCents,
    r.summary.realizedPnlCents + r.summary.unrealizedPnlCents - 99500,
  );
});

test("全卖出的旧仓仍评价今日表现，未成交持仓不混入反馈样本或合计", async () => {
  const source = fixture({
    positions: [position(), position({ code: "600003", sector: "未成交行业" })],
    trades: [
      fill({
        action: "EXIT",
        side: "SELL",
        quantity: 1000,
        priceCents: 1100,
        feeCents: 1600,
        basisCents: 900500,
        buyPoint: null,
      }),
    ],
  });
  const r = await buildExecutionReview(source);
  assert.equal(r.total, 1);
  assert.equal(r.sectors.length, 1);
  assert.equal(r.summary.dailyPnlCents, 98400);
  assert.equal(r.summary.realizedPnlCents, 197900);
  assert.equal(r.summary.unrealizedPnlCents, 0);
  assert.ok(r.rows[0].closeReturn > 9.99);
  assert.equal(r.rows[0].endingQuantity, 0);
});

test("加仓与减仓共存时，只使用流水记录的现金额与卖出成本", async () => {
  const r = await buildExecutionReview(
    fixture({
      positions: [position()],
      close: 1020,
      trades: [
        fill({ action: "ADD_PROFIT", quantity: 200, priceCents: 980 }),
        fill({
          action: "REDUCE",
          side: "SELL",
          quantity: 400,
          priceCents: 1100,
          feeCents: 600,
          basisCents: 360200,
        }),
      ],
    }),
  );
  assert.equal(r.rows[0].endingQuantity, 800);
  assert.deepEqual(
    [
      r.summary.dailyPnlCents,
      r.summary.realizedPnlCents,
      r.summary.unrealizedPnlCents,
    ],
    [58900, 79200, 79200],
  );
});

for (const action of ["T_FORWARD", "T_REVERSE"]) {
  test(`${action}：做 T 两腿已入账，不把旧仓 FIFO 收益当成做 T 价差`, async () => {
    const buys = fill({
      action,
      quantity: 200,
      priceCents: 980,
      buyPoint: null,
    });
    const sells = fill({
      action,
      side: "SELL",
      quantity: 200,
      priceCents: 1020,
      feeCents: 700,
      basisCents: 180100,
      buyPoint: null,
    });
    const r = await buildExecutionReview(
      fixture({
        positions: [position()],
        close: 1000,
        trades: action === "T_FORWARD" ? [buys, sells] : [sells, buys],
      }),
    );
    assert.equal(r.summary.dailyPnlCents, 6800);
    assert.equal(r.summary.realizedPnlCents, 23200);
    assert.equal(r.rows[0].endingQuantity, 1000);
  });
}

test("未完成做 T 保留真实仓位及未完成状态；跨日恢复只计算今日成交贡献", async () => {
  const partial = await buildExecutionReview(
    fixture({
      positions: [position()],
      close: 1000,
      trades: [
        fill({
          action: "T_FORWARD",
          quantity: 200,
          priceCents: 980,
          buyPoint: null,
        }),
      ],
      orders: [
        {
          id: "synthetic-order",
          code,
          action: "T_FORWARD",
          status: "INCOMPLETE_T",
          firstFilled: 200,
          secondFilled: 0,
        },
      ],
    }),
  );
  assert.equal(partial.rows[0].endingQuantity, 1200);
  assert.equal(partial.rows[0].tStatus, "INCOMPLETE");
  assert.equal(partial.summary.dailyPnlCents, 3500);
  const recovery = await buildExecutionReview(
    fixture({
      positions: [
        position({
          lots: [
            { acquiredDate: signalDate, quantity: 1200, costCents: 1097000 },
          ],
        }),
      ],
      close: 1000,
      trades: [
        fill({
          action: "REDUCE",
          intent: "T_RECOVERY",
          side: "SELL",
          quantity: 200,
          priceCents: 1020,
          feeCents: 700,
          basisCents: 180100,
          buyPoint: null,
          orderId: "prior:recovery",
        }),
      ],
    }),
  );
  assert.equal(recovery.rows[0].tStatus, "RECOVERY");
  assert.equal(recovery.summary.dailyPnlCents, 3300);
});

test("缺最终收盘价或仅有帧末价时不把收益补成零，不阻止保存缺项反馈", async () => {
  for (const mutate of [
    (q) => {
      q.closeCents = null;
    },
    (q) => {
      q.closingSource = "FRAME_LAST_OBSERVED";
    },
    (q) => {
      q.timestamp = `${date}T14:59:59+08:00`;
    },
    (q) => {
      q.date = signalDate;
    },
  ]) {
    const source = fixture();
    mutate(source.dataset.quotes[code]);
    const r = await buildExecutionReview(source);
    assert.equal(r.status, "PARTIAL");
    assert.equal(r.validCount, 0);
    assert.equal(r.rows[0].dailyPnlCents, null);
    assert.equal(r.summary.unrealizedPnlCents, null);
    assert.equal(r.rows[0].closeReturn, null);
    assert.match(r.rows[0].reasons.join("；"), /最终收盘/);
  }
});

test("缺买点凭证只标记资料不足，不重算买点、不改变已知含费损益", async () => {
  const source = fixture();
  delete source.fills[0].entryEvidence;
  delete source.fills[0].buyPoint;
  const r = await buildExecutionReview(source);
  assert.equal(r.validCount, 0);
  assert.equal(r.summary.dailyPnlCents, 9500);
  assert.deepEqual(r.rows[0].buyPoints, []);
  assert.match(r.rows[0].reasons.join("；"), /触发凭证/);
});

test("兼容原 V5 盘中条件成交的 entryEvidence.type，不把已有买点误判为缺失", async () => {
  const source = fixture();
  delete source.session.plan.dragonPolicy;
  delete source.fills[0].buyPoint;
  source.fills[0].entryEvidence = {
    type: "broken-board-dip",
    quoteTimestamp: `${date}T10:00:00+08:00`,
  };
  const r = await buildExecutionReview(source);
  assert.equal(r.status, "COMPLETE");
  assert.deepEqual(r.rows[0].buyPoints, ["broken-board-dip"]);
  assert.match(executionReviewView(r).rows, /炸板低吸/);
});

test("零成交保存中性记录，流水遗漏或结算不一致不得伪装成零收益", async () => {
  const none = fixture({ trades: [] });
  const r = await buildExecutionReview(none);
  assert.equal(r.status, "NO_TRADES");
  assert.equal(r.coverage, null);
  assert.equal(r.summary.dailyPnlCents, 0);
  none.session.fillCount = 1;
  const corrupt = await buildExecutionReview(none);
  assert.equal(corrupt.status, "PARTIAL");
  assert.equal(corrupt.summary.dailyPnlCents, null);
  assert.equal(corrupt.summary.feeCents, null);
  const other = fixture();
  other.equity.cashCents++;
  const bad = await buildExecutionReview(other);
  assert.equal(bad.validCount, 0);
  assert.equal(bad.summary.dailyPnlCents, null);
});

test("周五计划对应周一；跨日错配和未结算会话拒绝生成，旧仓结算冻结原政策", async () => {
  const source = fixture();
  delete source.session.plan.dragonPolicy;
  source.session.plan.strategyVersion = "baseline-v1";
  source.session.initialBook.dragonTransition = { state: "DRAINING" };
  delete source.fills[0].entryEvidence.configId;
  const r = await buildExecutionReview(source);
  assert.equal(r.snapshotDate, "2026-10-23");
  assert.equal(r.date, "2026-10-26");
  assert.equal(r.policy.tradingPolicyVersion, "legacy");
  assert.equal(r.policy.transitionState, "DRAINING");
  source.dataset.previousTradingDate = "2026-10-22";
  await assert.rejects(buildExecutionReview(source), /相邻交易日/);
  source.dataset.previousTradingDate = signalDate;
  source.session.status = "OPEN";
  await assert.rejects(buildExecutionReview(source), /收盘结算/);
});

test("新反馈只读归档、并发生成幂等，当前配置和后续来源变化不改写冻结结果", async (t) => {
  atClose(t);
  const DB = localDatabase();
  t.after(() => DB.close());
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("成交反馈不得临时调用外部行情");
  });
  const source = fixture();
  await archive(DB, source);
  const results = await Promise.all([
    loadReview({ DB }, date),
    loadReview({ DB }, date),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].review.status, "COMPLETE");
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS n FROM reviews").first()).n,
    1,
  );
  await DB.prepare(
    "INSERT INTO settings(key,value) VALUES('weights','[1,2,3,4,5,6]')",
  ).run();
  await DB.prepare(
    "UPDATE paper_market_days SET payload='{}' WHERE trade_date=?",
  )
    .bind(date)
    .run();
  assert.deepEqual(await loadReview({ DB }, date), results[0]);
  const response = await api(
    new Request(`http://localhost/api/review?date=${date}`),
    { DB },
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).review, results[0].review);
});

test("盘中、缺结算、历史无归档时不落库；损坏来源摘要不生成反馈", async (t) => {
  atClose(t);
  const DB = localDatabase();
  t.after(() => DB.close());
  assert.equal((await loadReview({ DB }, date)).review, null);
  assert.equal((await loadReview({ DB }, signalDate)).review, null);
  await archive(DB, fixture());
  t.mock.timers.setTime(new Date(`${date}T14:00:00+08:00`).getTime());
  assert.equal((await loadReview({ DB }, date)).review, null);
  t.mock.timers.setTime(new Date(stamp).getTime());
  await DB.prepare(
    "UPDATE paper_live_sessions SET digest='invalid' WHERE trade_date=?",
  )
    .bind(date)
    .run();
  assert.match((await loadReview({ DB }, date)).reason, /摘要不一致/);
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS n FROM reviews").first()).n,
    0,
  );
});

test("历史评分及 AI 原样保留，复盘档案仅展示10月26日起的快照和反馈", async (t) => {
  atClose(t);
  const DB = localDatabase();
  t.after(() => DB.close());
  const legacy = {
    date: signalDate,
    snapshotDate: "2026-10-22",
    systemScore: 64,
    rho: 0.1,
    rows: [],
    sectors: [],
  };
  const ai = { score: 71, summary: "原始历史评价" };
  await saveReview(DB, legacy, ai);
  await archive(DB, fixture());
  await loadReview({ DB }, date);
  const old = await loadReview({ DB }, signalDate);
  assert.deepEqual(old.review, legacy);
  assert.deepEqual(old.ai, ai);
  await saveReview(DB, { ...legacy, date: "2026-10-27", snapshotDate: date });
  for (const day of [signalDate, date, "2026-10-27"])
    await DB.prepare(
      "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
    )
      .bind(day, stamp, "{}")
      .run();
  const history = await historyList({ DB });
  assert.deepEqual(
    history.snapshots.map((s) => s.trade_date),
    ["2026-10-27", date],
  );
  assert.deepEqual(
    history.reviews.map((r) => r.date),
    ["2026-10-27", date],
  );
  assert.equal(history.reviews[0].systemScore, 64);
  assert.equal(history.reviews[0].reviewKind, undefined);
  assert.equal(history.reviews[1].reviewKind, "V5_EXECUTION");
  assert.equal(history.reviews[1].summary.stockCount, 1);
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS n FROM snapshots").first()).n,
    3,
  );
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS n FROM reviews").first()).n,
    3,
  );
});

test("新成交反馈不登记旧评分 IC，也不被旧评分 worker 当作新来源日", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const review = await buildExecutionReview(fixture());
  await saveReview(DB, review);
  const result = await recordReviewDailyMetric({ DB }, date);
  assert.equal(result.recorded, false);
  assert.equal(result.skipped, true);
  assert.deepEqual(await discoverMissingEvidenceWindows({ DB }), []);
});

test("AI 仅使用同口径、同政策配置的历史客观指标", async () => {
  const r = await buildExecutionReview(fixture());
  const raw = (payload, day = signalDate) => ({
    trade_date: day,
    payload: JSON.stringify(payload),
  });
  const rows = [
    raw({ systemScore: 99, rho: 0.99 }),
    raw({ ...r, policy: { ...r.policy, configId: "other" } }),
    raw({ ...r, summary: { ...r.summary, stockCount: 2 }, aiScore: 100 }),
    raw(r, "2026-10-22"),
  ];
  const summary = reviewHistorySummary(rows, r);
  assert.equal(summary.length, 2);
  assert.equal(summary[0].summary.stockCount, 2);
  assert.equal(summary[0].aiScore, undefined);
  assert.equal(reviewHistorySummary(rows).length, 1);
});

test("单只可核验成交允许 AI 描述性复盘；不含旧评分指标且不会改写未验证状态", async (t) => {
  atClose(t);
  const DB = localDatabase();
  t.after(() => DB.close());
  const r = await buildExecutionReview(fixture());
  await saveReview(DB, r);
  await saveReview(DB, {
    date: signalDate,
    snapshotDate: "2026-10-22",
    systemScore: 99,
    rho: 1,
  });
  const env = {
    DB,
    AI_API_KEY: "synthetic-test-only",
    AI_MODEL: "synthetic-model",
    AI_BASE_URL: "https://api.deepseek.com/v1",
  };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
    const request = JSON.parse(options.body);
    assert.match(request.messages[0].content, /不能证明/);
    const evidence = JSON.parse(request.messages[1].content);
    assert.equal(evidence.stocks.length, 1);
    assert.equal(evidence.summary.dailyPnlCents, 9500);
    assert.equal(
      evidence.policy.provenance.validationMode,
      "MANUAL_UNVERIFIED",
    );
    for (const field of [
      "weights",
      "objectiveScore",
      "rankingCorrelation",
      "topMean",
      "rollingEvidence",
      "history",
    ])
      assert.equal(evidence[field], undefined);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 65,
              confidence: "low",
              summary: "合成测试评价",
              evidence: ["1只成交", "含费95元", "样本仅1日"],
              failures: [],
              suggestions: [],
            }),
          },
        },
      ],
    });
  });
  const response = await api(
    new Request("http://localhost/api/ai-grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const ai = (await response.json()).ai;
  assert.equal(ai.reviewKind, "V5_EXECUTION");
  assert.equal(ai.sourceDigest, r.sourceDigest);
  assert.equal(ai.objectiveScore, null);
  assert.equal((await gradeWithAI(env, { review: r, ai })).score, 65);
  assert.equal(calls, 1);
  assert.deepEqual(
    JSON.parse(
      (
        await DB.prepare("SELECT payload FROM reviews WHERE trade_date=?")
          .bind(date)
          .first()
      ).payload,
    ),
    r,
  );
});

test("V5 零成交与不可核验反馈不调用 AI", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const env = { DB, AI_API_KEY: "synthetic-test-only" };
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("不可核验样本不调用 AI");
  });
  const none = await buildExecutionReview(fixture({ trades: [] }));
  const incomplete = fixture();
  delete incomplete.dataset.quotes[code];
  for (const r of [none, await buildExecutionReview(incomplete)])
    await assert.rejects(gradeWithAI(env, { review: r }), /可核验样本不足/);
});

test("AI 生成期间反馈被归档或替换时，不把旧评价附到新反馈，也不虚报保存成功", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const r = await buildExecutionReview(fixture());
  const nextSource = fixture();
  nextSource.session.plan.engineBuild = "next-engine";
  const replacement = await buildExecutionReview(nextSource);
  const env = { DB, AI_API_KEY: "synthetic-test-only" };
  let nextReview = null;
  t.mock.method(globalThis, "fetch", async () => {
    await DB.prepare("DELETE FROM reviews WHERE trade_date=?").bind(date).run();
    if (nextReview) await saveReview(DB, nextReview);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 60,
              confidence: "low",
              summary: "合成评价",
              evidence: ["1只成交"],
              failures: [],
              suggestions: [],
            }),
          },
        },
      ],
    });
  });
  for (const newer of [null, replacement]) {
    nextReview = newer;
    await saveReview(DB, r);
    await assert.rejects(
      gradeWithAI(env, { review: r }),
      /反馈归档在评价期间已变化/,
    );
    const stored = await DB.prepare(
      "SELECT ai_payload FROM reviews WHERE trade_date=?",
    )
      .bind(date)
      .first();
    assert.equal(stored?.ai_payload ?? null, null);
  }
});

test("页面使用实际指标、冻结买点、明确的市场表现与损益，资料缺项显示为未知", async () => {
  const source = fixture();
  source.session.plan.entryExecutionPolicy.history[code].name =
    '<img src=x onerror="alert(1)">';
  const view = executionReviewView(await buildExecutionReview(source));
  assert.equal(view.metrics.length, 4);
  assert.match(view.dateLabel, /计划.*成交与表现/);
  assert.match(view.conclusion, /人工指定 · 未验证/);
  const $ = load(`<table>${view.rows}</table>`);
  assert.equal($("td").length, 6);
  assert.equal($("img").length, 0);
  assert.match($("table").text(), /首阴低吸/);
  assert.match($("table").text(), /开盘.*收盘.*最低/s);
  assert.match($("table").text(), /当日.*已实现.*收盘浮盈亏/s);
  assert.doesNotMatch(JSON.stringify(view), /高分组|Spearman|系统客观反馈分/);
  delete source.dataset.quotes[code];
  const missing = executionReviewView(await buildExecutionReview(source));
  assert.equal(missing.metrics[1].value, "—");
  assert.match(missing.rows, /资料缺项/);
  const document = load(readFileSync("frontend/index.html", "utf8"));
  for (const id of [
    "review-stock-title",
    "review-stock-headers",
    "review-sector-headers",
    "review-footnote",
    "review-ai-description",
  ])
    assert.equal(document(`#${id}`).length, 1);
});
