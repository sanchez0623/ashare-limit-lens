import test from "node:test";
import assert from "node:assert/strict";
import {
  newBook,
  createPlan,
  BASE_STRATEGY,
  executePlan,
  assertProgramSnapshot,
} from "../backend/domain/trading.js";
import { openSession, advanceSession } from "../backend/domain/realtime.js";
import { snapshot, dateAt, dataset } from "./fixtures/trading.mjs";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import { pollTrading } from "../backend/services/realtime.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import { INTRADAY_ENTRY_VERSION } from "../backend/domain/intraday-entry.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import {
  ShadowAccountRepository,
  SHADOW_ACCOUNT_KINDS,
} from "../backend/storage/shadow.js";
import { QuoteFrameRepository } from "../backend/storage/quotes.js";
import { runTournamentPoll } from "../backend/services/strategy-tournament.js";
import {
  consumePortfolioFrame,
  settlePortfolioDay,
  freezePortfolioPlan,
} from "../backend/services/portfolio-runner.js";
import {
  ENTRY_OBSERVER_ID,
  requestEntryObservation,
  entryObservationStatus,
  verifyEntryObservation,
  maintainEntryObservation,
} from "../backend/services/entry-observation.js";

const signalDate = dateAt(0),
  date = dateAt(1);
function fixture(overrides = {}) {
  const source = snapshot(signalDate, [1000]);
  source.stocks = source.stocks.slice(0, 1);
  source.intradayEntryContext = {
    version: INTRADAY_ENTRY_VERSION,
    asOf: signalDate,
    firstNegMinPrevHeight: 3,
    history: {
      600001: {
        name: "合成龙头",
        sector: "测试行业",
        stockClass: "relay-leader",
        amount: 500000000,
        recentLimitUp: true,
        previousCloseCents: 1000,
        previousOpenCents: 950,
        previousChange: 10,
        previousHeight: 3,
        previousTouchedLimit: true,
        lastFourCloseSumCents: 3600,
        previousVolumeShares: null,
        ...overrides,
      },
    },
  };
  const book = {
    ...newBook(),
    lastDate: signalDate,
    entryExecutionMode: "intraday-conditional",
  };
  const plan = createPlan(
    source,
    book,
    BASE_STRATEGY,
    "baseline-v1",
    `${signalDate}T08:00:00.000Z`,
  );
  return { source, book, plan, session: openSession(book, plan, date) };
}
function frame(
  time,
  price,
  volume,
  { open = 1000, high = 1000, auction = false, ...rest } = {},
) {
  const timestamp = `${date}T${time}+08:00`;
  return {
    observedAt: new Date(timestamp).toISOString(),
    pollIntervalSeconds: 10,
    quotes: {
      600001: {
        date,
        timestamp,
        closeCents: price,
        previousCloseCents: 1000,
        openCents: open,
        highCents: high,
        lowCents: Math.min(open, price),
        volumeShares: volume,
        limitUpCents: 1100,
        limitDownCents: 900,
        bid1Cents: price - 1,
        ask1Cents: price + 1,
        ask1Shares: 100000,
        bid1Shares: 100000,
        orderBookQuality: "OK",
        orderBookTimestamp: timestamp,
        ...rest,
      },
    },
    entryInputs: {
      market: {
        date,
        observedAt: new Date(timestamp).toISOString(),
        emotion: 75,
        cycle: { maxGrossExposure: 0.6 },
        sectors: [{ name: "测试行业", score: 85 }],
        discoveries: [],
      },
      auction: auction
        ? {
            600001: {
              date,
              final: true,
              openCents: open,
              previousCloseCents: 1000,
            },
          }
        : {},
    },
  };
}
function run(f, frames) {
  const ledger = [];
  for (const observation of frames) {
    const result = advanceSession(f.book, f.session, observation);
    f.book = result.book;
    f.session = result.session;
    ledger.push(...result.ledger);
  }
  return ledger;
}
test("盘中规则与源快照冻结，旧 V5 计划保持开盘执行", () => {
  const f = fixture();
  assert.equal(f.plan.entryExecutionPolicy.version, INTRADAY_ENTRY_VERSION);
  assert.ok(f.plan.orders.every((o) => !["OPEN", "ADD"].includes(o.action)));
  assert.doesNotThrow(() => assertProgramSnapshot(f.plan, f.source, f.book));
  const stripped = structuredClone(f.plan);
  delete stripped.entryExecutionPolicy;
  assert.throws(
    () => assertProgramSnapshot(stripped, f.source, f.book),
    /规则声明/,
  );
  assert.throws(() => executePlan(f.book, f.plan, { date }), /持久行情帧/);
  const old = createPlan(
    snapshot(signalDate),
    newBook(),
    BASE_STRATEGY,
    "baseline-v1",
    `${signalDate}T08:00:00.000Z`,
  );
  assert.equal(old.entryExecutionPolicy, undefined);
  assert.ok(old.orders.some((o) => o.action === "OPEN"));
});
for (const [name, overrides, frames, type] of [
  [
    "竞价低吸",
    {},
    [
      frame("09:31:00", 950, 100000, { open: 940, auction: true }),
      frame("09:31:10", 951, 2000000, { open: 940, auction: true }),
    ],
    "auction-dip",
  ],
  [
    "假阴跌停低吸",
    { previousOpenCents: 1050, previousChange: 1 },
    [
      frame("09:31:00", 920, 100000, { open: 910, auction: true }),
      frame("09:31:10", 921, 2000000, { open: 910, auction: true }),
    ],
    "fake-neg-limit-dip",
  ],
  [
    "炸板低吸",
    {},
    [
      frame("10:45:00", 1040, 100000, { high: 1100 }),
      frame("10:45:10", 1041, 2000000, { high: 1100 }),
    ],
    "broken-board-dip",
  ],
  [
    "首阴当天尾盘预确认",
    {},
    [frame("14:31:00", 970, 100000), frame("14:31:10", 971, 2000000)],
    "first-neg-dip",
  ],
  [
    "尾盘跳水",
    { previousHeight: 1 },
    [
      frame("14:30:00", 1000, 100000),
      frame("14:31:00", 960, 300000),
      frame("14:31:10", 961, 2000000),
    ],
    "late-dip",
  ],
  [
    "打板触发后可成交盘口",
    {},
    [
      frame("09:45:00", 1100, 100000, { high: 1100 }),
      frame("09:45:10", 1090, 200000, { high: 1100 }),
      frame("09:45:20", 1090, 2000000, { high: 1100 }),
    ],
    "limit-up-momentum",
  ],
])
  test(`${name}：按当时的证据生成买入与成交`, () => {
    const f = fixture(overrides);
    const fills = run(f, frames);
    assert.ok(fills.length > 0, JSON.stringify(f.session.orders));
    assert.equal(fills[0].buyPoint, type);
    assert.equal(fills[0].entryEvidence.version, INTRADAY_ENTRY_VERSION);
    assert.equal(fills[0].entryEvidence.observedAt, frames.at(-1).observedAt);
    assert.equal(f.session.entryState.openedCodes.length, 1);
  });
test("封死涨停不虚构成交，上午高点不能伪装成尾盘跳水", () => {
  const locked = fixture();
  assert.equal(
    run(locked, [
      frame("09:45:00", 1100, 100000),
      frame("09:45:10", 1100, 2000000),
    ]).length,
    0,
  );
  const late = fixture({ previousHeight: 1 });
  assert.equal(
    run(late, [
      frame("14:31:00", 960, 100000, { high: 1100 }),
      frame("14:31:10", 961, 2000000, { high: 1100 }),
    ]).length,
    0,
  );
});
test("竞价证据、盘口、连续价量或市场数据缺失时不入场", () => {
  for (const mutate of [
    (x) => delete x.entryInputs.auction["600001"],
    (x) => {
      x.quotes["600001"].ask1Shares = 0;
    },
    (x) => {
      x.entryInputs.market.observedAt = `${date}T09:00:00+08:00`;
    },
    (x) => {
      x.quotes["600001"].volumeShares = 50000;
    },
  ]) {
    const f = fixture();
    const frames = [
      frame("09:31:00", 950, 100000, { open: 940, auction: true }),
      frame("09:31:10", 951, 2000000, { open: 940, auction: true }),
    ];
    mutate(frames[1]);
    assert.equal(run(f, frames).length, 0);
  }
});
test("过期、重启、重复帧和资金上限", () => {
  const f = fixture();
  const frames = [
    frame("09:31:00", 950, 100000, { open: 940, auction: true }),
    frame("09:31:10", 951, 2000000, { open: 940, auction: true }),
  ];
  const fills = run(f, frames);
  assert.ok(fills.length);
  const state = JSON.parse(JSON.stringify(f));
  assert.equal(run(state, [frames[1]]).length, 0);
  assert.equal(
    run(state, [frame("10:00:01", 951, 4000000, { open: 940, auction: true })])
      .length,
    0,
  );
  assert.ok(state.book.cashCents >= 0);
  const positionValue = state.book.positions.reduce(
    (n, p) => n + p.lots.reduce((a, l) => a + l.quantity, 0) * p.markCents,
    0,
  );
  assert.ok(
    positionValue <= state.book.equityCents * state.plan.targetExposure,
  );
});
test("盘中补入必须属于冻结的历史准入范围，补入首帧不提供历史流动性", () => {
  const f = fixture();
  f.plan.entryExecutionPolicy.candidates = [];
  f.session = openSession(f.book, f.plan, date);
  const observation = frame("10:45:00", 1040, 100000, { high: 1100 });
  observation.entryInputs.market.discoveries = [
    { code: "600001", amount: 600000000 },
    { code: "600999", amount: 600000000 },
  ];
  assert.equal(run(f, [observation]).length, 0);
  assert.deepEqual(Object.keys(f.session.entryState.admissions), ["600001"]);
  assert.equal(
    f.session.entryState.admissions["600001"].source,
    "INTRADAY_POOL",
  );
});

test("V5盘中计划09:26可冻结执行，09:30起拒绝；影子核验17:00前不写结果", async (t) => {
  const f = fixture();
  for (const time of ["09:26:00", "09:29:59"]) {
    const plan = { ...f.plan, createdAt: `${date}T${time}+08:00` };
    assert.equal(openSession(f.book, plan, date).status, "OPEN");
  }
  assert.throws(
    () =>
      openSession(
        f.book,
        { ...f.plan, createdAt: `${date}T09:30:00+08:00` },
        date,
      ),
    /执行日前冻结/,
  );
  const DB = localDatabase(),
    env = { DB };
  t.after(() => DB.close());
  for (const time of ["15:05:00", "16:59:59"]) {
    const now = new Date(`${date}T${time}+08:00`);
    assert.equal(
      (await verifyEntryObservation(env, date, { date, quotes: {} }, now))
        .status,
      "WAITING_VERIFICATION",
    );
    assert.equal(await maintainEntryObservation(env, date, now), null);
  }
  assert.equal(
    (
      await DB.prepare(
        "SELECT COUNT(*) AS n FROM settings WHERE key='intraday-entry-readiness'",
      ).first()
    ).n,
    0,
  );
});

test("V5 可直接选择盘中条件执行；影子核验独立保留，不允许无效模式或非V5", async () => {
  const db = localDatabase();
  const env = { DB: db };
  const repo = new PaperRepository(env);
  try {
    await repo.initialize();
    const configured = await repo.configure({
      entryExecutionMode: "intraday-conditional",
    });
    assert.equal(configured.entryExecutionMode, "intraday-conditional");
    assert.equal((await entryObservationStatus(env)).ready, false);
    await requestEntryObservation(env);
    assert.equal((await entryObservationStatus(env)).requested, true);
    assert.deepEqual((await repo.account()).book, configured);
    await assert.rejects(
      () => repo.configure({ selectionPolicyVersion: "signal-ranking-v3" }),
      /需要 V5/,
    );
    await assert.rejects(
      () => repo.configure({ entryExecutionMode: "arbitrary" }),
      /执行方式无效/,
    );
  } finally {
    db.close();
  }
});

test("旧快照补齐历史后冻结影子计划，保留补齐版本而不回读旧归档", async () => {
  const DB = localDatabase();
  const env = { DB };
  try {
    const f = fixture();
    const old = structuredClone(f.source);
    old.intradayEntryContext.history = {};
    await DB.prepare(
      "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
    )
      .bind(signalDate, old.createdAt, JSON.stringify(old))
      .run();
    const shadows = new ShadowAccountRepository(env);
    await shadows.ensureAccount(ENTRY_OBSERVER_ID, {
      kind: SHADOW_ACCOUNT_KINDS.INTRADAY_OBSERVATION,
      book: f.book,
    });
    const saved = await freezePortfolioPlan(env, ENTRY_OBSERVER_ID, {
      snapshot: f.source,
      strategy: BASE_STRATEGY,
      strategyVersion: "baseline-v1",
      now: `${signalDate}T08:00:00.000Z`,
    });
    const signal = await DB.prepare(
      "SELECT payload FROM strategy_signal_snapshots WHERE digest=?",
    )
      .bind(saved.selectionAudit.snapshotDigest)
      .first();
    assert.equal(
      JSON.parse(signal.payload).intradayEntryContext.history["600001"]
        .previousCloseCents,
      1000,
    );
    const original = await DB.prepare(
      "SELECT payload FROM snapshots WHERE trade_date=?",
    )
      .bind(signalDate)
      .first();
    assert.deepEqual(JSON.parse(original.payload), old);
    assert.equal(saved.entryExecutionPolicy.candidates.length, 1);
  } finally {
    DB.close();
  }
});

test("独立影子观察周末不采集空帧、不创建会话，也不消费已有周末帧", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const env = { DB };
  const shadows = new ShadowAccountRepository(env);
  const original = await shadows.ensureAccount(ENTRY_OBSERVER_ID, {
    kind: SHADOW_ACCOUNT_KINDS.INTRADAY_OBSERVATION,
    book: fixture().book,
  });
  let calls = 0;
  for (const date of ["2026-10-24", "2026-10-25"]) {
    const poll = await runTournamentPoll(
      env,
      new Date(`${date}T09:31:00+08:00`),
      {
        providers: {
          quotes: async () => {
            calls++;
            throw new Error("周末不应请求行情");
          },
        },
      },
    );
    assert.equal(poll, null);
    const consumed = await consumePortfolioFrame(env, ENTRY_OBSERVER_ID, {
      tradeDate: date,
      sequence: 1,
      observedAt: `${date}T09:31:00+08:00`,
      payload: { quotes: {} },
    });
    assert.equal(consumed.status, "NON_TRADING_DAY");
    assert.equal(consumed.skipped, true);
    assert.equal(await shadows.session(ENTRY_OBSERVER_ID, date), null);
    assert.equal(
      (await new QuoteFrameRepository(env).framesForDate(date)).length,
      0,
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(await shadows.account(ENTRY_OBSERVER_ID), original);
  assert.equal((await shadows.ledger(ENTRY_OBSERVER_ID)).length, 0);
});

test("合成整日影子流水：同帧消费、原子幂等、重放核验与启用闸门", async () => {
  const db = localDatabase();
  const env = { DB: db };
  const repo = new PaperRepository(env);
  try {
    await repo.initialize();
    const f = fixture();
    await db
      .prepare(
        "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
      )
      .bind(signalDate, f.source.createdAt, JSON.stringify(f.source))
      .run();
    const shadows = new ShadowAccountRepository(env);
    await shadows.ensureAccount(ENTRY_OBSERVER_ID, {
      kind: SHADOW_ACCOUNT_KINDS.INTRADAY_OBSERVATION,
      book: f.book,
    });
    await shadows.savePlan(ENTRY_OBSERVER_ID, f.plan);
    const frames = new QuoteFrameRepository(env);
    let count = 0;
    for (const [start, end] of [
      ["09:30:00", "11:30:00"],
      ["13:00:00", "14:55:00"],
    ]) {
      for (
        let ms = Date.parse(`${date}T${start}+08:00`);
        ms <= Date.parse(`${date}T${end}+08:00`);
        ms += 10000
      ) {
        const time = new Date(ms + 8 * 3600000).toISOString().slice(11, 19);
        const obs = frame(time, 1000, 100000 + ++count * 1000, {
          auction: true,
        });
        const saved = await frames.appendFrame({
          tradeDate: date,
          observedAt: obs.observedAt,
          quotes: obs.quotes,
          pollIntervalSeconds: 10,
          pool: {
            codes: ["600001"],
            sources: { researchPoolDate: signalDate },
          },
          entryInputs: obs.entryInputs,
        });
        const loaded = await frames.loadFrame(date, saved.sequence);
        assert.equal(
          (await consumePortfolioFrame(env, ENTRY_OBSERVER_ID, loaded)).applied,
          true,
        );
        assert.equal(
          (await consumePortfolioFrame(env, ENTRY_OBSERVER_ID, loaded))
            .consumed,
          true,
        );
      }
    }
    const closing = { date, quotes: {}, source: "synthetic-test-fixture" };
    assert.equal(
      (await settlePortfolioDay(env, ENTRY_OBSERVER_ID, date, closing)).applied,
      true,
    );
    const report = await verifyEntryObservation(env, date, closing);
    assert.equal(report.coverage, true);
    assert.equal(report.replayPassed, true);
    assert.equal(report.passed, true);
    assert.equal((await entryObservationStatus(env)).ready, true);
    assert.equal(
      (await repo.configure({ entryExecutionMode: "intraday-conditional" }))
        .entryExecutionMode,
      "intraday-conditional",
    );
    await db
      .prepare(
        "UPDATE quote_frames SET digest='tampered' WHERE sequence=1 AND trade_date=?",
      )
      .bind(date)
      .run();
    assert.equal(
      (await verifyEntryObservation(env, date, closing)).passed,
      false,
    );
    assert.equal((await entryObservationStatus(env)).ready, false);
  } finally {
    db.close();
  }
});

test("主账户盘中数据接入、成交证据持久化与完整导出重放", async () => {
  const db = localDatabase(),
    env = { DB: db },
    repo = new RealtimeRepository(env);
  try {
    let account = await repo.initialize();
    const initialDay = dataset(signalDate);
    await repo.settle(
      account.revision,
      executePlan(account.book, null, initialDay),
      initialDay,
    );
    account = await repo.account();
    const book = {
      ...account.book,
      entryExecutionMode: "intraday-conditional",
    };
    await db
      .prepare(
        "UPDATE paper_accounts SET state=?,revision=revision+1 WHERE id='primary'",
      )
      .bind(JSON.stringify(book))
      .run();
    const f = fixture();
    await db
      .prepare(
        "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
      )
      .bind(signalDate, f.source.createdAt, JSON.stringify(f.source))
      .run();
    const intent = createPlan(
      f.source,
      book,
      BASE_STRATEGY,
      "baseline-v1",
      `${signalDate}T08:00:00.000Z`,
    );
    await repo.savePlan(intent);
    for (const obs of [
      frame("09:31:00", 950, 100000, { open: 940, auction: true }),
      frame("09:31:10", 951, 2000000, { open: 940, auction: true }),
    ]) {
      const result = await pollTrading(env, new Date(obs.observedAt), {
        calendar: async () => ({ dates: [signalDate, date] }),
        quotes: async () => obs.quotes,
        entryInputs: obs.entryInputs,
        observedAt: obs.observedAt,
      });
      assert.equal(result.status, "RUNNING", JSON.stringify(result));
    }
    const ledger = await repo.ledgerRowsForDate(date);
    assert.equal(ledger[0].buyPoint, "auction-dip");
    assert.equal(ledger[0].entryEvidence.version, INTRADAY_ENTRY_VERSION);
    const check = await verifyExport(await exportPaper(env));
    assert.equal(check.passed, true, JSON.stringify(check));
  } finally {
    db.close();
  }
});
