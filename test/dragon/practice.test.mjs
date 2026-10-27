import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../../scripts/local-db.mjs";
import { newBook } from "../../backend/domain/trading.js";
import {
  buildPracticeReview,
  practiceFeatures,
  completedPracticeCycles,
} from "../../backend/domain/practice-review.js";
import { practiceCoverage } from "../../backend/domain/practice-coverage.js";
import { recordPracticeDecision } from "../../backend/domain/practice-trace.js";
import {
  patternPatch,
  fixedPatternConfig,
  patternEconomicPass,
  patternMetrics,
  rankPatterns,
  comparePatternWindow,
} from "../../backend/domain/dragon-patterns.js";
import { defaultDragonConfig } from "../../shared/dragon-risk-config.js";
import { digestOf } from "../../backend/domain/research-lineage.js";
import {
  loadReview,
  gradeWithAI,
  reviewHistorySummary,
} from "../../backend/services/review.js";
import {
  processPracticeWeekly,
  practiceWeek,
} from "../../backend/services/practice-weekly.js";
import { captureQuoteFrame } from "../../backend/services/quote-stream.js";
import { QuoteFrameRepository } from "../../backend/storage/quotes.js";
import { PaperRepository } from "../../backend/storage/paper.js";
import {
  proposePatternResearch,
  maintainPatternResearch,
} from "../../backend/services/dragon-pattern-research.js";
import { executionReviewView } from "../../frontend/execution-review.js";
import { parseTencentQuotes } from "../../backend/services/market.js";

const date = "2026-10-26",
  signalDate = "2026-10-23";
const dayAt = (time) => `${date}T${time}+08:00`;
function closedDay({ held = true, buy = false, noTrace = false } = {}) {
  const opening = { ...newBook(), lastDate: signalDate };
  if (held) {
    opening.cashCents = 99000000;
    opening.positions = [
      {
        code: "600001",
        name: "旧仓",
        sector: "行业",
        markCents: 1000,
        lots: [
          { acquiredDate: "2026-10-22", quantity: 1000, costCents: 900500 },
        ],
        heldDays: 1,
        dragon: {
          p0Cents: 900,
          r0Cents: 40,
          stopCents: 950,
          stage: 1,
          t: null,
        },
      },
    ];
  }
  const closing = structuredClone(opening);
  for (const p of closing.positions) p.markCents = 1100;
  const fills = buy
    ? [
        {
          id: "fill-0",
          sequence: 0,
          code: "600002",
          name: "新仓",
          date,
          signalDate,
          side: "BUY",
          intent: "OPEN",
          action: "OPEN",
          orderId: "entry-1",
          quantity: 100,
          priceCents: 1000,
          notionalCents: 100000,
          feeCents: 500,
          cashDeltaCents: -100500,
          basisCents: 0,
          realizedPnlCents: 0,
          buyPoint: "auction-dip",
          cycleId: `${date}:600002`,
          entryEvidence: {
            quoteTimestamp: dayAt("09:31:00"),
            observedAt: dayAt("09:31:00"),
            configId: "frozen",
            phase: "rising",
          },
        },
      ]
    : [];
  if (buy) {
    closing.cashCents -= 100500;
    closing.feesCents += 500;
    closing.positions.push({
      code: "600002",
      name: "新仓",
      sector: "行业",
      markCents: 1100,
      lots: [{ acquiredDate: date, quantity: 100, costCents: 100500 }],
    });
  }
  closing.equityCents =
    closing.cashCents +
    closing.positions.reduce(
      (n, p) => n + p.markCents * p.lots.reduce((q, l) => q + l.quantity, 0),
      0,
    );
  const plan = {
    signalDate,
    createdAt: `${signalDate}T17:00:00+08:00`,
    strategyVersion: "frozen",
    dragonPolicy: {
      version: "dragon-risk-v1",
      configId: "frozen",
      config: defaultDragonConfig(),
    },
    entryExecutionPolicy: {
      candidates: ["600003"],
      history: {
        600001: { name: "旧仓", sector: "行业" },
        600002: { name: "新仓", sector: "行业" },
        600003: { name: "候选", sector: "行业" },
      },
    },
    orders: [],
  };
  const session = {
    date,
    status: "CLOSED",
    initialBook: opening,
    closingBook: closing,
    plan,
    fillCount: fills.length,
    sequence: 2,
    orders: buy
      ? [
          {
            id: "entry-1",
            code: "600002",
            action: "OPEN",
            filledQuantity: 100,
            quantity: 100,
            status: "FILLED",
          },
        ]
      : [],
    lastObservedAt: dayAt("14:56:50"),
    regime: { phase: "ebbing" },
    entryState: {
      admissions: {
        600003: { code: "600003", admittedAt: `${signalDate}T17:00:00+08:00` },
      },
    },
    practice: { version: 1, startedSequence: 0, decisions: {} },
  };
  if (noTrace) delete session.practice;
  else recordPracticeDecision(session, "600003", "MARKET_RESTRICTED");
  const dataset = {
    date,
    previousTradingDate: signalDate,
    source: "SYNTHETIC",
    quotes: Object.fromEntries(
      ["600001", "600002"].map((code) => [
        code,
        {
          date,
          timestamp: dayAt("15:00:05"),
          previousCloseCents: 1000,
          openCents: 1000,
          lowCents: 950,
          closeCents: 1100,
        },
      ]),
    ),
  };
  const equity = {
    date,
    complete: true,
    cashCents: closing.cashCents,
    equityCents: closing.equityCents,
    realizedPnlCents: closing.realizedPnlCents,
    feesCents: closing.feesCents,
    unrealizedPnlCents: closing.positions.reduce(
      (n, p) =>
        n +
        p.markCents * p.lots.reduce((q, l) => q + l.quantity, 0) -
        p.lots.reduce((q, l) => q + l.costCents, 0),
      0,
    ),
    drawdown: 0,
  };
  return {
    date,
    session,
    fills,
    dataset,
    equity,
    coverage: { complete: false, frameCount: 2, gaps: [{ field: "session" }] },
  };
}

test("无成交持仓仍计入全账户损益；候选和未成交原因完整保留", async () => {
  const r = await buildPracticeReview(closedDay());
  assert.equal(r.reviewKind, "DRAGON_PRACTICE");
  assert.equal(r.schemaVersion, 3);
  assert.equal(r.status, "NO_TRADES");
  assert.equal(r.account.dailyPnlCents, 100000);
  assert.equal(r.summary.dailyPnlCents, 100000);
  assert.equal(r.summary.fillCount, 0);
  assert.equal(r.aiEligible, true);
  assert.equal(r.researchEligible, false);
  assert.equal(
    r.rows.find((p) => p.code === "600003").decisions[0].reasonCode,
    "MARKET_RESTRICTED",
  );
  const view = executionReviewView(r);
  assert.match(view.rows, /旧仓/);
  assert.match(view.conclusion, /全账户/);
});
test("新仓含费9500分加旧仓100000分，与账户权益变化及行业汇总一致", async () => {
  const r = await buildPracticeReview(closedDay({ buy: true }));
  assert.equal(r.account.dailyPnlCents, 109500);
  assert.equal(
    r.rows.reduce((n, p) => n + p.dailyPnlCents, 0),
    109500,
  );
  assert.equal(r.summary.feeCents, 500);
  assert.equal(r.sectors[0].dailyPnlCents, 109500);
});
test("空仓零成交可作运行复盘，未知期末状态或不守恒不能补零", async () => {
  const empty = await buildPracticeReview(closedDay({ held: false }));
  assert.equal(empty.account.dailyPnlCents, 0);
  assert.equal(empty.aiEligible, true);
  const missing = closedDay();
  delete missing.session.closingBook;
  const r = await buildPracticeReview(missing);
  assert.equal(r.account.dailyPnlCents, null);
  assert.equal(r.researchEligible, false);
  assert.equal(r.status, "PARTIAL");
  const corrupt = closedDay();
  corrupt.session.closingBook.equityCents++;
  assert.equal(
    (await buildPracticeReview(corrupt)).account.dailyPnlCents,
    null,
  );
});
test("已完成T价差只作收益组成解释，不重复加到账户损益", async () => {
  const source = closedDay();
  source.session.closingBook.dragonTRecords = [
    { completedDate: date, status: "COMPLETED", netPnlCents: 500 },
  ];
  const r = await buildPracticeReview(source);
  assert.equal(r.summary.completedTNetPnlCents, 500);
  assert.equal(r.account.dailyPnlCents, 100000);
});
test("部分成交和T腿按完整建仓周期计一次；缺开仓历史不冒充完整周期", () => {
  const rows = [
    {
      date,
      sequence: 0,
      cycleId: "one",
      code: "600001",
      intent: "OPEN",
      buyPoint: "auction-dip",
      entryEvidence: { phase: "rising" },
      side: "BUY",
      quantity: 100,
      cashDeltaCents: -100500,
      feeCents: 500,
    },
    {
      date: "2026-10-27",
      sequence: 0,
      cycleId: "one",
      side: "BUY",
      quantity: 100,
      cashDeltaCents: -90500,
      feeCents: 500,
    },
    {
      date: "2026-10-27",
      sequence: 1,
      cycleId: "one",
      side: "SELL",
      quantity: 100,
      cashDeltaCents: 99500,
      feeCents: 500,
    },
    {
      date: "2026-10-28",
      sequence: 0,
      cycleId: "one",
      side: "SELL",
      quantity: 100,
      cashDeltaCents: 109500,
      feeCents: 500,
    },
  ];
  const cycles = completedPracticeCycles(rows);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].netPnlCents, 18000);
  assert.equal(completedPracticeCycles(rows.slice(1)).length, 0);
});
test("重复决策聚合观测次数，冻结输入不随调用方后续变化而改变", async () => {
  const source = closedDay();
  recordPracticeDecision(source.session, "600003", "MARKET_RESTRICTED");
  const r = await buildPracticeReview(source);
  assert.equal(r.decisions[0].observations, 2);
  const digest = r.sourceDigest;
  source.session.closingBook.cashCents++;
  assert.equal(r.sourceDigest, digest);
  assert.equal(r.account.dailyPnlCents, 100000);
  const features = practiceFeatures({ ...r, ai: { summary: "NEVER_INCLUDE" } });
  assert.doesNotMatch(JSON.stringify(features), /NEVER_INCLUDE/);
});

function fullFrames() {
  const out = [];
  for (const [start, end] of [
    ["09:30:00", "11:30:00"],
    ["13:00:00", "14:56:50"],
  ]) {
    for (
      let t = Date.parse(dayAt(start));
      t <= Date.parse(dayAt(end));
      t += 10000
    ) {
      const observedAt = new Date(t).toISOString();
      out.push({
        observedAt,
        pollIntervalSeconds: 10,
        quotes: {
          600003: {
            date,
            timestamp: observedAt,
            closeCents: 1000,
            previousCloseCents: 1000,
            openCents: 990,
            highCents: 1010,
            lowCents: 980,
            limitUpCents: 1100,
            limitDownCents: 900,
            volumeShares: out.length * 100,
            orderBookQuality: "OK",
            orderBookTimestamp: observedAt,
            bid1Cents: 999,
            ask1Cents: 1001,
            bid1Shares: 10000,
            ask1Shares: 10000,
          },
        },
        entryInputs: {
          market: {
            date,
            observedAt,
            cycle: { phase: "rising" },
            sectors: [{ name: "行业", score: 65 }],
          },
        },
      });
    }
  }
  return out;
}
test("研究覆盖要求两个连续时段、逐股盘口和真实收盘；零挂单与未知盘口区分", () => {
  const source = closedDay({ held: false }),
    frames = fullFrames();
  const closing = {
    observedAt: dayAt("15:00:10"),
    quotes: {
      600003: { date, timestamp: dayAt("15:00:05"), closeCents: 1000 },
    },
  };
  const check = () =>
    practiceCoverage({
      date,
      session: source.session,
      frames,
      closingFrames: [closing],
    });
  assert.equal(check().complete, true);
  frames[10].quotes["600003"].ask1Shares = 0;
  assert.equal(check().complete, true);
  delete frames[10].quotes["600003"].ask1Shares;
  assert.equal(check().complete, false);
  frames[10].quotes["600003"].ask1Shares = 10000;
  frames.splice(20, 2);
  assert.equal(check().complete, false);
  assert.equal(
    practiceCoverage({ date, session: source.session, frames: fullFrames() })
      .complete,
    false,
  );
});

test("组合候选只改白名单两项，账户风险、费用与未知字段拒绝注入", () => {
  const base = defaultDragonConfig();
  const candidate = patternPatch(base, {
    rationale: "对照验证T和补仓组合",
    patch: { "operations.lossAdd": false, "operations.tForward": false },
  });
  assert.equal(candidate.config.operations.lossAdd, false);
  assert.deepEqual(candidate.config.risk, base.risk);
  assert.equal(candidate.distance, 2);
  for (const patch of [
    { "risk.grossWeight": 1 },
    { "operations.tForward": 0 },
    { stopLoss: 0.08 },
    {
      "operations.lossAdd": false,
      "operations.tForward": false,
      "operations.tReverse": false,
    },
  ])
    assert.throws(() => patternPatch(base, { rationale: "非法", patch }));
  const fixed = fixedPatternConfig({
    ...base,
    advanced: { stopLoss: 0.08, tFraction: 0.2, tSpread: 0.03 },
  });
  assert.equal(fixed.advanced.stopLoss, 0.04);
  assert.ok(Object.values(fixed.buyPoints).every(Boolean));
});
test("亏得更少也不能晋级，成交笔数不能替代10个完整周期", async () => {
  const risk = { drawdown: 0.12 },
    candidate = {
      netReturn: -0.01,
      maxDrawdown: 0.02,
      completedRounds: 20,
      fills: 1000,
    };
  assert.equal(
    patternEconomicPass(
      candidate,
      { netReturn: -0.02, maxDrawdown: 0.03 },
      risk,
    ),
    false,
  );
  assert.equal(
    patternEconomicPass(
      { ...candidate, netReturn: 0.02, completedRounds: 9 },
      { netReturn: 0, maxDrawdown: 0.03 },
      risk,
    ),
    false,
  );
  const dates = Array.from({ length: 20 }, (_, i) => `d${i}`);
  const result = await comparePatternWindow({
    dates,
    candidate: {
      netReturn: 0.02,
      maxDrawdown: 0,
      completedRounds: 10,
      returns: dates.map(() => 0.001),
    },
    parent: { netReturn: 0, maxDrawdown: 0, returns: dates.map(() => 0) },
    baseline: { netReturn: 0, maxDrawdown: 0, returns: dates.map(() => 0) },
    risk,
    k: 1,
    seed: "fixed",
  });
  assert.equal(result.passed, true);
  assert.ok(result.againstParent.lowerBound > 0);
  assert.equal(
    rankPatterns([
      { id: "b", metrics: { netReturn: 0.02, maxDrawdown: 0.01 }, distance: 1 },
      { id: "a", metrics: { netReturn: 0.02, maxDrawdown: 0.01 }, distance: 1 },
    ])[0].id,
    "a",
  );
});

async function saveSource(DB, source) {
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
}
test("新模式沿用原反馈接口，零成交有AI复盘且只发送客观事实", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  t.mock.timers.enable({ apis: ["Date"], now: new Date(dayAt("17:10:00")) });
  await saveSource(DB, closedDay());
  const result = await loadReview({ DB }, date);
  assert.equal(result.review.reviewKind, "DRAGON_PRACTICE");
  let request;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    request = JSON.parse(init.body);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 50,
              confidence: "low",
              summary: "全账户持仓盈利1000元，观测不足。",
              evidence: ["含费1000元", "0笔成交", "研究覆盖不足"],
              failures: [],
              suggestions: [],
              hypotheses: [
                {
                  statement: "继续观察空仓阶段",
                  evidenceRefs: ["account", "coverage"],
                  requiredValidation: "独立对照验证",
                },
              ],
            }),
          },
        },
      ],
    });
  });
  const ai = await gradeWithAI(
    { DB, AI_API_KEY: "test", AI_BASE_URL: "https://api.deepseek.com/v1" },
    result,
  );
  const evidence = JSON.parse(request.messages[1].content);
  assert.equal(evidence.account.dailyPnlCents, 100000);
  assert.equal(ai.hypotheses.length, 1);
  assert.equal(
    (await loadReview({ DB }, date)).ai.sourceDigest,
    result.review.sourceDigest,
  );
  const history = reviewHistorySummary(
    [
      {
        trade_date: date,
        payload: JSON.stringify(result.review),
        ai_payload: "SECRET_AI",
      },
    ],
    result.review,
  );
  assert.doesNotMatch(JSON.stringify(history), /SECRET_AI/);
});
test("训练样本不足不调用模型、不占研究预算、不修改实际账户", async (t) => {
  const DB = localDatabase(),
    papers = new PaperRepository({ DB });
  t.after(() => DB.close());
  await papers.initialize();
  const account = await papers.account();
  account.book.tradingPolicyVersion = "dragon-risk-v1";
  await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
    .bind(JSON.stringify(account.book))
    .run();
  const before = await papers.account();
  const result = await proposePatternResearch(
    { DB },
    { propose: () => assert.fail("不得调用模型") },
  );
  assert.equal(result.status, "COLLECTING");
  assert.deepEqual(await papers.account(), before);
  assert.equal(
    (
      await DB.prepare(
        "SELECT COUNT(*) AS n FROM dragon_pattern_batches",
      ).first()
    ).n,
    0,
  );
});

test("周报只在周五17:15后冻结；并发与重启不重复发送，纯周末无交易不发送", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const r = await buildPracticeReview(closedDay());
  await DB.prepare(
    "INSERT INTO reviews(trade_date,snapshot_date,created_at,payload) VALUES(?,?,?,?)",
  )
    .bind(date, signalDate, dayAt("17:00:00"), JSON.stringify(r))
    .run();
  const env = {
    DB,
    ALERTS_ENABLED: "true",
    FEISHU_WEBHOOK_URL: "https://test.invalid/webhook",
  };
  let sent = 0;
  const send = async ({ safeMessage }) => {
    sent++;
    assert.match(safeMessage.text, /1000.00/);
    return { ok: true, providerRef: "one" };
  };
  const early = new Date("2026-10-30T17:14:59+08:00"),
    ready = new Date("2026-10-30T17:15:00+08:00");
  await processPracticeWeekly(env, { now: early, send });
  assert.equal(sent, 0);
  await Promise.all([
    processPracticeWeekly(env, { now: ready, send }),
    processPracticeWeekly(env, { now: ready, send }),
  ]);
  assert.equal(sent, 1);
  await processPracticeWeekly(env, {
    now: new Date("2026-10-31T12:00:00+08:00"),
    send,
  });
  assert.equal(sent, 1);
  assert.equal(practiceWeek(ready).end, "2026-10-30");
  const none = await processPracticeWeekly(env, {
    now: new Date("2026-11-06T17:15:00+08:00"),
    send,
  });
  assert.equal(none.status, "NO_PRACTICE_DAYS");
});
test("周报发送状态不明时保留UNCERTAIN，避免重启后盲目重复推送", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const r = await buildPracticeReview(closedDay());
  await DB.prepare(
    "INSERT INTO reviews(trade_date,snapshot_date,created_at,payload) VALUES(?,?,?,?)",
  )
    .bind(date, signalDate, dayAt("17:00:00"), JSON.stringify(r))
    .run();
  const env = { DB, FEISHU_WEBHOOK_URL: "https://test.invalid/webhook" };
  let count = 0;
  const send = async () => {
    count++;
    throw new Error("timeout");
  };
  const now = new Date("2026-10-30T17:15:00+08:00");
  assert.equal(
    (await processPracticeWeekly(env, { now, send })).status,
    "UNCERTAIN",
  );
  await processPracticeWeekly(env, { now, send });
  assert.equal(count, 1);
});
test("真实收盘帧单独归档，不提交或推进交易账户；重复采集幂等", async (t) => {
  const DB = localDatabase(),
    env = { DB },
    papers = new PaperRepository(env);
  t.after(() => DB.close());
  await papers.initialize();
  const source = closedDay();
  await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
    .bind(
      JSON.stringify({
        ...source.session.initialBook,
        tradingPolicyVersion: "dragon-risk-v1",
      }),
    )
    .run();
  await DB.prepare(
    "INSERT INTO paper_plans(signal_date,created_at,payload,digest) VALUES(?,?,?,?)",
  )
    .bind(
      signalDate,
      source.session.plan.createdAt,
      JSON.stringify(source.session.plan),
      await digestOf(source.session.plan),
    )
    .run();
  const before = await papers.account();
  let calls = 0;
  const now = new Date(dayAt("15:00:10"));
  const providers = {
    quotes: async (codes) => {
      calls++;
      return Object.fromEntries(
        codes.map((c) => [
          c,
          { date, timestamp: dayAt("15:00:05"), closeCents: 1100 },
        ]),
      );
    },
  };
  assert.ok(await captureQuoteFrame(env, now, { providers }));
  assert.equal(await captureQuoteFrame(env, now, { providers }), null);
  assert.equal(calls, 1);
  assert.deepEqual(await papers.account(), before);
  assert.equal(
    (await new QuoteFrameRepository(env).framesForDate(date)).length,
    1,
  );
});
test("研究清单不可变；中断请求不重发模型，预算及测试占用保留", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const m = { candidates: [], accounts: [] },
    id = "interrupted";
  await DB.prepare(
    "INSERT INTO dragon_pattern_batches(id,stage,manifest,manifest_digest,comparison_end,created_at,updated_at) VALUES(?,'REQUESTING',?,?,4,'2026-10-26T00:00:00Z','2026-10-26T00:00:00Z')",
  )
    .bind(id, JSON.stringify(m), await digestOf(m))
    .run();
  await DB.prepare(
    "INSERT INTO research_window_owners(namespace,owner_type,owner_id,window_payload,created_at) VALUES('main','DRAGON_PATTERN',?,'{}','2026-10-26T00:00:00Z')",
  )
    .bind(id)
    .run();
  await DB.prepare(
    "INSERT INTO research_generation_slots(namespace,month,slot,owner_type,owner_id,reserved_at) VALUES('main','2026-10',1,'DRAGON_PATTERN',?,'2026-10-26T00:00:00Z')",
  )
    .bind(id)
    .run();
  await maintainPatternResearch({ DB }, new Date(dayAt("17:00:00")));
  assert.equal(
    (
      await DB.prepare("SELECT stage FROM dragon_pattern_batches WHERE id=?")
        .bind(id)
        .first()
    ).stage,
    "FAILED",
  );
  assert.equal(
    (
      await DB.prepare(
        "SELECT COUNT(*) AS n FROM research_generation_slots",
      ).first()
    ).n,
    1,
  );
  await assert.rejects(
    DB.prepare("UPDATE dragon_pattern_batches SET manifest='{}' WHERE id=?")
      .bind(id)
      .run(),
    /不可改写/,
  );
});

test("免费源明确的零挂单保留为客观观测，缺字段仍未知且不放宽成交盘口", () => {
  const fields = Array(60).fill("");
  Object.assign(fields, {
    3: "10",
    4: "10",
    5: "10",
    6: "0",
    9: "10",
    10: "1000",
    19: "0",
    20: "0",
    30: "20261026093000",
    33: "10",
    34: "10",
    47: "11",
    48: "9",
  });
  const parsed = () =>
    parseTencentQuotes(`v_sh600003="${fields.join("~")}";`, date)["600003"];
  const q = parsed();
  assert.equal(q.orderBookQuality, "MISSING");
  assert.equal(q.ask1Cents, undefined);
  assert.equal(q.orderBookObservation.quality, "OBSERVED");
  assert.equal(q.orderBookObservation.ask1Cents, 0);
  const source = closedDay({ held: false }),
    frames = fullFrames();
  Object.assign(frames[0].quotes["600003"], q);
  const closing = {
    observedAt: dayAt("15:00:10"),
    quotes: {
      600003: { date, timestamp: dayAt("15:00:05"), closeCents: 1000 },
    },
  };
  assert.equal(
    practiceCoverage({
      date,
      session: source.session,
      frames,
      closingFrames: [closing],
    }).complete,
    true,
  );
  fields[19] = "";
  assert.equal(parsed().orderBookObservation.quality, "UNKNOWN");
  Object.assign(frames[0].quotes["600003"], parsed());
  assert.equal(
    practiceCoverage({
      date,
      session: source.session,
      frames,
      closingFrames: [closing],
    }).complete,
    false,
  );
});

test("完整周期按首次买点、阶段及互斥操作组合归因，部分成交不扩大样本", async () => {
  const source = closedDay({ held: false });
  source.historicalFills = [
    {
      date: "2026-10-21",
      sequence: 0,
      code: "600001",
      cycleId: "done",
      intent: "OPEN",
      buyPoint: "first-neg-dip",
      entryEvidence: { phase: "climax" },
      side: "BUY",
      quantity: 100,
      cashDeltaCents: -100500,
      feeCents: 500,
    },
    {
      date: "2026-10-22",
      sequence: 0,
      code: "600001",
      cycleId: "done",
      intent: "ADD_PROFIT",
      side: "BUY",
      quantity: 100,
      cashDeltaCents: -110500,
      feeCents: 500,
    },
    {
      date: "2026-10-22",
      sequence: 1,
      code: "600001",
      cycleId: "done",
      intent: "T_REVERSE",
      side: "SELL",
      quantity: 100,
      cashDeltaCents: 119500,
      feeCents: 500,
    },
    {
      date: "2026-10-22",
      sequence: 2,
      code: "600001",
      cycleId: "done",
      intent: "T_RECOVERY",
      side: "BUY",
      quantity: 100,
      cashDeltaCents: -110500,
      feeCents: 500,
    },
  ];
  // Test the completed-cycle grouping without fabricating a same-day account fill.
  const cycles = completedPracticeCycles([
    ...source.historicalFills,
    {
      date,
      sequence: 0,
      code: "600001",
      cycleId: "done",
      intent: "EXIT",
      side: "SELL",
      quantity: 200,
      cashDeltaCents: 239500,
      feeCents: 500,
    },
  ]);
  assert.equal(cycles.length, 1);
  assert.equal(
    cycles[0].operationCombination,
    "ADD_PROFIT+T_RECOVERY+T_REVERSE",
  );
  assert.equal(cycles[0].phase, "climax");
  assert.equal(cycles[0].buyPoint, "first-neg-dip");
  assert.equal(cycles[0].netPnlCents, 37500);
  assert.equal(cycles[0].protectiveExit, true);
  const r = await buildPracticeReview({
    ...source,
    historicalFills: [
      ...source.historicalFills,
      {
        date: "2026-10-23",
        sequence: 0,
        cycleId: "done",
        intent: "EXIT",
        side: "SELL",
        quantity: 200,
        cashDeltaCents: 239500,
        feeCents: 500,
      },
    ],
  });
  assert.equal(r.cycles.length, 0);
  source.session.closingBook.dragonTRecords = [
    {
      completedDate: "2026-10-23",
      startedDate: "2026-10-22",
      status: "COMPLETED",
      netPnlCents: 500,
    },
  ];
  assert.equal(
    (await buildPracticeReview(source)).summary.completedTNetPnlCents,
    0,
  );
});

test("周报剔除摘要不匹配的收益，明确数据缺口，不转发篡改的日复盘", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const r = await buildPracticeReview(closedDay());
  r.account.dailyPnlCents = 987654321;
  await DB.prepare(
    "INSERT INTO reviews(trade_date,snapshot_date,created_at,payload) VALUES(?,?,?,?)",
  )
    .bind(date, signalDate, dayAt("17:00:00"), JSON.stringify(r))
    .run();
  let text;
  await processPracticeWeekly(
    { DB, FEISHU_WEBHOOK_URL: "https://test.invalid/webhook" },
    {
      now: new Date("2026-10-30T17:15:00+08:00"),
      send: async ({ safeMessage }) => {
        text = safeMessage.text;
        return { ok: true };
      },
    },
  );
  assert.match(text, /全账户含费损益：未知/);
  assert.match(text, /2026-10-26/);
  assert.doesNotMatch(text, /9876543.21/);
});
