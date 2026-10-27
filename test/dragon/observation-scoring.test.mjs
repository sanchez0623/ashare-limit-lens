import test from "node:test";
import assert from "node:assert/strict";
import {
  OBSERVATION_SCORE_POLICY as P,
  scoreObservation,
  observationShapeChecks,
  observationRisk,
} from "../../shared/observation-scoring.js";
import { defaultDragonConfig } from "../../shared/dragon-risk-config.js";
import { initialAdaptiveRisk } from "../../shared/adaptive-risk.js";
import {
  typesAt,
  INTRADAY_ENTRY_RULES,
} from "../../backend/domain/intraday-entry.js";
import { buildScoreCalibration } from "../../backend/domain/score-calibration.js";
import { completedPracticeCycles } from "../../backend/domain/practice-review.js";
import { localDatabase } from "../../scripts/local-db.mjs";
import { newBook } from "../../backend/domain/trading.js";
import {
  registerDragonConfig,
  dragonBookFields,
} from "../../backend/storage/dragon-risk.js";
import { createDragonPlan } from "../../backend/domain/dragon-risk.js";
import { latestPolicyBundle } from "../../backend/storage/execution-cost.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../../backend/domain/realtime.js";
import { digestOf } from "../../backend/domain/research-lineage.js";
import {
  runScoringTick,
  scoringScores,
  scoringPolicy,
  scoringCalibration,
} from "../../backend/services/observation-scoring.js";
import { api } from "../../backend/routes/api.js";

const date = "2026-10-26",
  signalDate = "2026-10-23",
  code = "600003";
const at = (time) => `${date}T${time}+08:00`;
function inputs(type, changes = {}) {
  const time = ["late-dip", "first-neg-dip"].includes(type)
    ? "14:40:00"
    : "10:00:00";
  const h = {
    name: "合成观察股",
    sector: "行业",
    stockClass: "relay-leader",
    recentLimitUp: true,
    amount: 500000000,
    previousCloseCents: 1000,
    previousOpenCents: 1010,
    previousChange: 10,
    previousHeight: 4,
    previousTouchedLimit: true,
    lastFourCloseSumCents: 3600,
  };
  const q = {
    code,
    date,
    timestamp: at(time),
    closeCents: 1090,
    previousCloseCents: 1000,
    openCents: 1000,
    limitUpCents: 1100,
    limitDownCents: 900,
    volumeShares: 10000,
  };
  if (type === "broken-board-dip") q.closeCents = 1045;
  if (type === "first-neg-dip") q.closeCents = 970;
  if (type === "fake-neg-limit-dip") {
    h.previousChange = 0;
    q.openCents = 910;
    q.closeCents = 920;
  }
  if (type === "auction-dip") {
    q.openCents = 940;
    q.closeCents = 950;
  }
  if (type === "late-dip") q.closeCents = 960;
  Object.assign(q, changes);
  const path = {
    touched: true,
    momentumAt: at(time),
    lastObservedAt: at(time),
    tailHighCents: 1000,
    stableQuotes: 5,
  };
  const auction = {
    date,
    final: true,
    openCents: q.openCents,
    previousCloseCents: 1000,
  };
  const rules = { ...INTRADAY_ENTRY_RULES, firstNegMinPrevHeight: 3 };
  return { history: h, quote: q, path, auction, date, rules, time };
}

test("六卡与执行器的结构条件一致，未知必要输入不归一化", () => {
  assert.equal(Object.isFrozen(P.weights["late-dip"]), true);
  for (const [type, weights] of Object.entries(P.weights)) {
    assert.equal(
      Object.values(weights).reduce((a, b) => a + b, 0),
      100,
    );
    const x = inputs(type);
    assert.ok(
      typesAt(
        { rules: x.rules, firstNegMinPrevHeight: 3 },
        x.history,
        x.quote,
        x.path,
        x.time,
        x.auction,
        date,
      ).includes(type),
    );
    assert.ok(observationShapeChecks(type, x).every((c) => c.passed === true));
    x.quote.closeCents = null;
    if (type === "auction-dip") x.quote.openCents = null;
    assert.ok(observationShapeChecks(type, x).some((c) => c.passed === null));
  }
  const x = inputs("auction-dip");
  delete x.auction;
  assert.equal(
    observationShapeChecks("auction-dip", x).find((c) => c.key === "auction")
      .passed,
    null,
  );
});

test("分层高分保留真实限制；计算不修改输入，也不读取未来行情", () => {
  const x = inputs("limit-up-momentum"),
    config = defaultDragonConfig();
  const input = {
    code,
    plan: {
      createdAt: at("09:00:00"),
      signalDate,
      dragonPolicy: { config },
      entryExecutionPolicy: {
        history: { [code]: x.history },
        rules: x.rules,
        firstNegMinPrevHeight: 3,
      },
    },
    session: {
      date,
      sequence: 2,
      entryState: { paths: { [code]: x.path }, admissions: { [code]: {} } },
      practice: {
        decisions: {
          blocked: {
            code,
            intent: "OPEN",
            reasonCode: "CASH_OR_EXPOSURE",
            reason: "现金限制",
            last: { observationSequence: 2 },
          },
        },
      },
    },
    observation: {
      observedAt: at(x.time),
      quotes: { [code]: x.quote },
      entryInputs: {
        market: {
          date,
          observedAt: at(x.time),
          sectors: [{ name: "行业", score: 100 }],
        },
        auction: { [code]: x.auction },
      },
    },
  };
  const before = structuredClone(input),
    profile = scoreObservation(input),
    card = profile.cards.find((c) => c.type === "limit-up-momentum");
  assert.equal(card.value, 100);
  assert.equal(card.status, "BLOCKED");
  assert.equal(profile.risk.value, null);
  assert.deepEqual(input, before);
  const tomorrow = inputs("late-dip", { closeCents: 1 });
  tomorrow.quote.closeCents = 999999;
  assert.deepEqual(scoreObservation(input), profile);
  delete input.observation.entryInputs.market.sectors;
  const missing = scoreObservation(input).cards[0];
  assert.equal(missing.value, null);
  assert.ok(missing.missing.includes("E"));
  input.plan.entryExecutionPolicy.history[code].stockClass = "__proto__";
  assert.equal(scoreObservation(input).identity, null);
});

test("风险压力复用最严格的真实系数；预热、过期均不补数值", () => {
  const state = initialAdaptiveRisk(date),
    stamp = at("10:00:00");
  state.segment = "AM";
  state.observedAt = stamp;
  const layer = (factor) => ({
    valid: true,
    ready: true,
    observedAt: stamp,
    applied: factor,
    raw: factor,
    protectionApplied: factor,
    protectionKnown: true,
    coverage: 1,
    reasons: [],
    samples: [],
  });
  state.market = layer(0.8);
  state.sectors["行业"] = layer(0.9);
  state.stocks[code] = layer(0.7);
  assert.equal(
    observationRisk(defaultDragonConfig(), state, {
      code,
      sector: "行业",
      observedAt: stamp,
    }).value,
    30,
  );
  state.stocks[code].ready = false;
  assert.equal(
    observationRisk(defaultDragonConfig(), state, {
      code,
      sector: "行业",
      observedAt: stamp,
    }).value,
    null,
  );
  state.stocks[code].ready = true;
  assert.equal(
    observationRisk(defaultDragonConfig(), state, {
      code,
      sector: "行业",
      observedAt: at("10:03:00"),
    }).value,
    null,
  );
});

test("完整周期含费R冻结，部分成交/加仓/T不扩大样本，回放及版本独立", () => {
  const rows = [
    {
      id: "a",
      cycleId: "c",
      date,
      sequence: 0,
      intent: "OPEN",
      side: "BUY",
      quantity: 100,
      cashDeltaCents: -100500,
      feeCents: 500,
      buyPoint: "late-dip",
    },
    {
      id: "b",
      cycleId: "c",
      date,
      sequence: 1,
      intent: "OPEN",
      side: "BUY",
      quantity: 100,
      cashDeltaCents: -100500,
      feeCents: 500,
    },
    {
      id: "d",
      cycleId: "c",
      date,
      sequence: 2,
      intent: "ADD_PROFIT",
      side: "BUY",
      quantity: 100,
      cashDeltaCents: -100500,
      feeCents: 500,
    },
    {
      id: "e",
      cycleId: "c",
      date: "2026-10-27",
      sequence: 0,
      intent: "EXIT",
      side: "SELL",
      quantity: 300,
      cashDeltaCents: 330000,
      feeCents: 500,
    },
  ];
  const entries = [
    {
      cycleId: "c",
      buyPoint: "late-dip",
      phase: "rising",
      prospective: true,
      initialR0Cents: 40,
      engineBuild: "build",
      configDigest: "config",
      feeDigest: "fees",
      profile: {
        version: P.version,
        stockClass: "relay-leader",
        risk: { value: 20 },
        cards: [{ type: "late-dip", value: 85 }],
      },
    },
  ];
  const report = buildScoreCalibration({
    cycles: completedPracticeCycles(rows),
    entries,
    fills: rows,
    asOf: "2026-10-27",
  });
  assert.equal(report.sampleCount, 1);
  assert.equal(report.samples[0].netPnlCents, 28500);
  assert.equal(report.samples[0].netR, 28500 / 8000);
  assert.equal(report.groups[0].direction, "INSUFFICIENT");
  assert.equal(report.eligibleForPromotion, false);
  assert.equal(
    buildScoreCalibration({
      cycles: completedPracticeCycles(rows.slice(0, 3)),
      entries,
      fills: rows,
      asOf: date,
    }).sampleCount,
    0,
  );
  const many = Array.from({ length: 30 }, (_, i) => ({
    ...entries[0],
    cycleId: `c${i}`,
    prospective: i >= 15,
    engineBuild: i % 2 ? "b2" : "b1",
  }));
  const cycles = many.map((e, i) => ({
    ...report.samples[0],
    id: e.cycleId,
    openedDate: `2026-09-${String(i + 1).padStart(2, "0")}`,
  }));
  assert.equal(
    buildScoreCalibration({
      cycles,
      entries: many,
      fills: [],
      asOf: "2026-10-27",
    }).groups.length,
    4,
  );
});

async function archive(t) {
  const DB = localDatabase(),
    env = { DB };
  t.after(() => DB.close());
  const record = await registerDragonConfig(DB, defaultDragonConfig(), null, {
    origin: "MANUAL",
    validationMode: "MANUAL_UNVERIFIED",
  });
  let book = {
    ...newBook(),
    ...dragonBookFields(record),
    lastDate: signalDate,
  };
  const x = inputs("limit-up-momentum");
  x.history.previousVolumeShares = 100000000;
  const source = {
    date: signalDate,
    stocks: [],
    cycle: { phase: "rising" },
    intradayEntryContext: {
      version: "intraday-entry-v1",
      asOf: signalDate,
      history: { [code]: x.history },
    },
  };
  const plan = createDragonPlan(source, book, `${signalDate}T17:00:00+08:00`, {
    executionCostPolicy: await latestPolicyBundle(DB),
  });
  let session = openSession(book, plan, date);
  const observations = [],
    fills = [];
  for (let i = 0; i < 22; i++) {
    const stamp = new Date(
      Date.parse(at("09:30:00")) + i * 10000,
    ).toISOString();
    const price = i === 0 || i === 13 ? 1100 : 1090;
    const quote = {
      ...x.quote,
      timestamp: stamp,
      closeCents: price,
      highCents: 1100,
      lowCents: 1090,
      volumeShares: (i + 1) * 100000,
      orderBookQuality: "OK",
      orderBookTimestamp: stamp,
      bid1Cents: price - 1,
      ask1Cents: price + 1,
      bid1Shares: 1000000,
      ask1Shares: 1000000,
    };
    const observation = {
      observedAt: stamp,
      pollIntervalSeconds: 10,
      quotes: { [code]: quote },
      entryInputs: {
        market: {
          date,
          observedAt: stamp,
          metrics: {
            limitUp: 80,
            broken: 3,
            height: 4,
            premium: 2,
            premiumCoverage: 1,
          },
          sectorsComplete: true,
          sectors: [{ name: "行业", score: 90, count: 8, broken: 0 }],
        },
      },
    };
    const result = advanceSession(book, session, observation);
    book = result.book;
    session = result.session;
    fills.push(...result.ledger);
    observations.push(observation);
    await DB.prepare(
      "INSERT INTO paper_live_ticks(trade_date,sequence,payload,digest) VALUES(?,?,?,?)",
    )
      .bind(
        date,
        session.sequence,
        JSON.stringify(observation),
        await digestOf(observation),
      )
      .run();
    for (const fill of result.ledger)
      await DB.prepare(
        "INSERT INTO paper_ledger(id,trade_date,payload) VALUES(?,?,?)",
      )
        .bind(fill.id, date, JSON.stringify(fill))
        .run();
  }
  await DB.prepare(
    "INSERT INTO paper_live_sessions(trade_date,payload,digest) VALUES(?,?,?)",
  )
    .bind(date, JSON.stringify(session), await digestOf(session))
    .run();
  return { DB, env, session, book, fills, observations, plan };
}

test("独立处理与中断重启幂等；实际交易账本不变，GET不推进证据", async (t) => {
  const { DB, env, fills } = await archive(t);
  const snapshot = async () =>
    JSON.stringify({
      sessions: (await DB.prepare("SELECT * FROM paper_live_sessions").all())
        .results,
      ledger: (await DB.prepare("SELECT * FROM paper_ledger ORDER BY id").all())
        .results,
    });
  const before = await snapshot();
  assert.ok(
    fills.some((f) => f.intent === "OPEN"),
    "合成行情应真实触发一次建仓",
  );
  assert.equal((await scoringPolicy(env)).publishedAt, null);
  await runScoringTick(env, { now: new Date(at("09:29:00")), maxFrames: 4 });
  assert.equal((await scoringScores(env, { date })).status, "LAGGING");
  await runScoringTick(env, { now: new Date(at("09:29:00")), maxFrames: 100 });
  assert.equal((await scoringScores(env, { date })).status, "CURRENT");
  const storedScore = (
    await DB.prepare(
      "SELECT payload FROM observation_score_latest LIMIT 1",
    ).first()
  ).payload;
  const expired = await scoringScores(env, {
    date,
    now: new Date(at("10:00:00")),
  });
  assert.equal(expired.rows[0].freshness, "STALE");
  assert.equal(expired.rows[0].risk.value, null);
  assert.ok(expired.rows[0].cards.every((c) => c.value === null));
  assert.equal(
    (
      await DB.prepare(
        "SELECT payload FROM observation_score_latest LIMIT 1",
      ).first()
    ).payload,
    storedScore,
  );
  const entries = (
    await DB.prepare(
      "SELECT * FROM observation_score_snapshots WHERE kind='ENTRY'",
    ).all()
  ).results;
  assert.equal(entries.length, 1);
  assert.ok(
    (
      await DB.prepare(
        "SELECT COUNT(*) AS n FROM observation_score_snapshots WHERE kind='TRIGGER'",
      ).first()
    ).n >= 1,
  );
  const count = (
    await DB.prepare(
      "SELECT COUNT(*) AS n FROM observation_score_snapshots",
    ).first()
  ).n;
  await runScoringTick(env, { maxFrames: 100 });
  assert.equal(
    (
      await DB.prepare(
        "SELECT COUNT(*) AS n FROM observation_score_snapshots",
      ).first()
    ).n,
    count,
  );
  assert.equal(await snapshot(), before);
  const changes = (await DB.prepare("SELECT total_changes() AS n").first()).n;
  for (const path of ["policy", "scores", "calibration"])
    assert.equal(
      (
        await api(
          new Request(
            `http://localhost/api/research/scoring/${path}?date=${date}`,
          ),
          env,
        )
      ).status,
      200,
    );
  assert.equal(
    (await DB.prepare("SELECT total_changes() AS n").first()).n,
    changes,
  );
  assert.equal(
    (
      await api(
        new Request("http://localhost/api/research/scoring/scores?code=bad"),
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await api(
        new Request("http://localhost/api/research/scoring/policy", {
          method: "POST",
        }),
        env,
      )
    ).status,
    405,
  );
  await assert.rejects(
    DB.prepare("UPDATE observation_score_snapshots SET payload='{}'").run(),
    /不可改写/,
  );
});

test("源观测篡改或断档停止评分，不制造新的实际成交", async (t) => {
  const { DB, env } = await archive(t);
  await DB.prepare(
    "UPDATE paper_live_ticks SET payload='{}' WHERE sequence=1",
  ).run();
  await assert.rejects(
    runScoringTick(env, { now: new Date(at("09:29:00")) }),
    /摘要不一致/,
  );
  assert.equal((await scoringScores(env, { date })).rows.length, 0);
});

test("已有v1政策与评分时登记新版本，旧版本不改写、新游标独立且重复推进不报版本冲突", async (t) => {
  const { DB, env } = await archive(t);
  const oldVersion = "dragon-observation-score-v1";
  const oldPolicy = {
    version: oldVersion,
    adaptiveRiskVersion: "dragon-adaptive-risk-v1",
    implementationDigest: "legacy-frozen-build",
  };
  const oldPayload = JSON.stringify(oldPolicy),
    oldDigest = await digestOf(oldPolicy);
  await DB.prepare(
    "INSERT INTO observation_score_policies(version,payload,digest,published_at) VALUES(?,?,?,?)",
  )
    .bind(oldVersion, oldPayload, oldDigest, at("09:00:00"))
    .run();
  const oldCursor = JSON.stringify({ sentinel: "original-v1-cursor" });
  await DB.prepare(
    "INSERT INTO observation_score_cursors(trade_date,version,sequence,payload,digest) VALUES(?,?,?,?,?)",
  )
    .bind(date, oldVersion, 7, oldCursor, await digestOf(JSON.parse(oldCursor)))
    .run();
  assert.equal((await scoringPolicy(env)).policy.version, P.version);
  assert.equal((await runScoringTick(env, { maxFrames: 1 })).processed, 1);
  assert.equal((await runScoringTick(env, { maxFrames: 1 })).processed, 1);
  const old = await DB.prepare(
    "SELECT payload,digest FROM observation_score_policies WHERE version=?",
  )
    .bind(oldVersion)
    .first();
  assert.deepEqual({ ...old }, { payload: oldPayload, digest: oldDigest });
  assert.equal(
    (
      await DB.prepare(
        "SELECT sequence FROM observation_score_cursors WHERE trade_date=? AND version=?",
      )
        .bind(date, P.version)
        .first()
    ).sequence,
    2,
  );
  assert.equal(
    (
      await DB.prepare(
        "SELECT payload FROM observation_score_cursors WHERE trade_date=? AND version=?",
      )
        .bind(date, oldVersion)
        .first()
    ).payload,
    oldCursor,
  );
});

test("已登记不同实现指纹的v3政策时新增v4，旧政策与游标不改写", async (t) => {
  const { DB, env } = await archive(t);
  const oldVersion = "dragon-observation-score-v3";
  const oldPolicy = {
    ...P,
    version: oldVersion,
    implementationDigest: "previous-v3-build",
  };
  const oldPayload = JSON.stringify(oldPolicy);
  const oldDigest = await digestOf(oldPolicy);
  const cursor = JSON.stringify({ original: "v3" });
  await DB.prepare(
    "INSERT INTO observation_score_policies(version,payload,digest,published_at) VALUES(?,?,?,?)",
  )
    .bind(oldVersion, oldPayload, oldDigest, at("09:00:00"))
    .run();
  await DB.prepare(
    "INSERT INTO observation_score_cursors(trade_date,version,sequence,payload,digest) VALUES(?,?,?,?,?)",
  )
    .bind(date, oldVersion, 7, cursor, await digestOf(JSON.parse(cursor)))
    .run();
  assert.notEqual(P.version, oldVersion);
  assert.equal((await runScoringTick(env, { maxFrames: 1 })).processed, 1);
  assert.equal((await runScoringTick(env, { maxFrames: 1 })).processed, 1);
  const old = await DB.prepare(
    "SELECT payload,digest FROM observation_score_policies WHERE version=?",
  )
    .bind(oldVersion)
    .first();
  assert.deepEqual({ ...old }, { payload: oldPayload, digest: oldDigest });
  assert.equal(
    (
      await DB.prepare(
        "SELECT payload FROM observation_score_cursors WHERE trade_date=? AND version=?",
      )
        .bind(date, oldVersion)
        .first()
    ).payload,
    cursor,
  );
  assert.equal(
    (
      await DB.prepare(
        "SELECT sequence FROM observation_score_cursors WHERE trade_date=? AND version=?",
      )
        .bind(date, P.version)
        .first()
    ).sequence,
    2,
  );
});

test("固定分箱只报告描述性区分，发布前样本不升级前瞻", () => {
  const entries = [],
    cycles = [],
    fills = [];
  for (let i = 0; i < 30; i++) {
    const bin = Math.floor(i / 10),
      id = `sample-${i}`;
    entries.push({
      cycleId: id,
      buyPoint: "late-dip",
      phase: "rising",
      prospective: true,
      initialR0Cents: 10,
      engineBuild: "build",
      configDigest: "config",
      feeDigest: "fees",
      profile: {
        version: P.version,
        stockClass: "relay-leader",
        risk: { value: [20, 50, 80][bin] },
        cards: [{ type: "late-dip", value: [50, 70, 90][bin] }],
      },
    });
    cycles.push({
      id,
      openedDate: `2026-09-${String(i + 1).padStart(2, "0")}`,
      closedDate: date,
      buyPoint: "late-dip",
      netPnlCents: [500, 1000, 1500][bin],
      feeCents: 500,
      holdingCalendarDays: 1,
    });
    fills.push({ cycleId: id, intent: "OPEN", quantity: 100 });
  }
  let report = buildScoreCalibration({ cycles, entries, fills, asOf: date });
  assert.equal(report.groups[0].direction, "POSITIVE");
  for (const e of entries) e.prospective = false;
  report = buildScoreCalibration({ cycles, entries, fills, asOf: date });
  assert.equal(report.groups[0].direction, "INSUFFICIENT");
  assert.equal(report.groups[0].mode, "REPLAY_DIAGNOSTIC");
});

test("重复报价不增加确认，午休断档和跨日保留未知", async (t) => {
  const { book, session, plan, observations } = await archive(t);
  const repeated = { ...observations.at(-1), observedAt: at("09:33:35") };
  const next = advanceSession(book, session, repeated);
  assert.equal(
    next.session.entryState.paths[code].stableQuotes,
    session.entryState.paths[code].stableQuotes,
  );
  const noon = structuredClone(observations.at(-1));
  noon.observedAt = at("13:00:00");
  noon.quotes[code].timestamp = noon.observedAt;
  noon.quotes[code].volumeShares += 100000;
  const afterLunch = advanceSession(book, session, noon);
  assert.equal(afterLunch.session.entryState.paths[code].stableQuotes, 0);
  const profile = scoreObservation({
    code,
    plan,
    session: afterLunch.session,
    observation: noon,
  });
  assert.equal(profile.risk.value, null);
  const tomorrow = structuredClone(noon);
  tomorrow.observedAt = "2026-10-27T09:30:00+08:00";
  const stale = scoreObservation({
    code,
    plan,
    session: { ...afterLunch.session, date: "2026-10-27" },
    observation: tomorrow,
  });
  assert.ok(
    stale.cards.every((c) => c.value === null && c.status === "WAITING_DATA"),
  );
});

test("真实跨日周期生成报告，篡改原始观测后拒绝沿用报告", async (t) => {
  const ctx = await archive(t),
    { DB, env } = ctx;
  await runScoringTick(env, { now: new Date(at("09:29:00")), maxFrames: 100 });
  const closed = closeSession(ctx.book, ctx.session, {
    date,
    previousTradingDate: signalDate,
    source: "synthetic",
    quotes: {
      [code]: {
        ...ctx.observations.at(-1).quotes[code],
        timestamp: at("15:00:00"),
      },
    },
  });
  let book = { ...closed.book, lastDate: date };
  await DB.prepare(
    "UPDATE paper_live_sessions SET payload=?,digest=? WHERE trade_date=?",
  )
    .bind(JSON.stringify(closed.session), await digestOf(closed.session), date)
    .run();
  const nextDate = "2026-10-27",
    cost = await latestPolicyBundle(DB);
  const plan = createDragonPlan(
    {
      date,
      stocks: [],
      intradayEntryContext: {
        version: "intraday-entry-v1",
        asOf: date,
        history: {
          [code]: {
            ...ctx.plan.entryExecutionPolicy.history[code],
            previousCloseCents: 1090,
          },
        },
      },
    },
    book,
    `${date}T17:00:00+08:00`,
    { executionCostPolicy: cost },
  );
  let session = openSession(book, plan, nextDate);
  const observation = structuredClone(ctx.observations.at(-1));
  observation.observedAt = `${nextDate}T09:30:00+08:00`;
  const q = observation.quotes[code];
  Object.assign(q, {
    date: nextDate,
    timestamp: observation.observedAt,
    previousCloseCents: 1090,
    limitUpCents: 1199,
    limitDownCents: 981,
    closeCents: 1000,
    openCents: 1000,
    highCents: 1000,
    lowCents: 1000,
    bid1Cents: 999,
    ask1Cents: 1001,
    orderBookTimestamp: observation.observedAt,
    volumeShares: 1000000,
  });
  observation.entryInputs.market.date = nextDate;
  observation.entryInputs.market.observedAt = observation.observedAt;
  for (let i = 0; i < 2; i++) {
    observation.observedAt = `${nextDate}T09:30:${i ? "10" : "00"}+08:00`;
    q.timestamp = q.orderBookTimestamp = observation.observedAt;
    q.volumeShares = (i + 1) * 1000000;
    observation.entryInputs.market.observedAt = observation.observedAt;
    const step = advanceSession(book, session, observation);
    book = step.book;
    session = step.session;
    for (const fill of step.ledger)
      await DB.prepare(
        "INSERT INTO paper_ledger(id,trade_date,payload) VALUES(?,?,?)",
      )
        .bind(fill.id, nextDate, JSON.stringify(fill))
        .run();
    await DB.prepare(
      "INSERT INTO paper_live_ticks(trade_date,sequence,payload,digest) VALUES(?,?,?,?)",
    )
      .bind(
        nextDate,
        i + 1,
        JSON.stringify(observation),
        await digestOf(observation),
      )
      .run();
  }
  assert.equal(book.positions.length, 0, "T+1后按实际保护条件退出完整仓位");
  await DB.prepare(
    "INSERT INTO paper_live_sessions(trade_date,payload,digest) VALUES(?,?,?)",
  )
    .bind(nextDate, JSON.stringify(session), await digestOf(session))
    .run();
  await DB.prepare(
    "INSERT INTO reviews(trade_date,snapshot_date,created_at,payload) VALUES(?,?,?,?)",
  )
    .bind(
      nextDate,
      date,
      observation.observedAt,
      JSON.stringify({ reviewKind: "DRAGON_PRACTICE" }),
    )
    .run();
  await runScoringTick(env, {
    now: new Date(`${nextDate}T17:01:00+08:00`),
    maxFrames: 100,
  });
  const report = await scoringCalibration(env);
  assert.equal(report.sampleCount, 1);
  assert.equal(report.groups[0].mode, "FORWARD_OBSERVATION");
  assert.ok(Number.isFinite(report.samples[0].netR));
  assert.equal(report.sourceManifest.days.length, 2);
  const before = (
    await DB.prepare(
      "SELECT payload FROM observation_score_snapshots WHERE kind='ENTRY'",
    ).first()
  ).payload;
  await DB.prepare(
    "UPDATE paper_live_ticks SET payload='{}' WHERE trade_date=? AND sequence=1",
  )
    .bind(date)
    .run();
  await assert.rejects(scoringCalibration(env), /原始观测摘要不一致/);
  assert.equal(
    (
      await DB.prepare(
        "SELECT payload FROM observation_score_snapshots WHERE kind='ENTRY'",
      ).first()
    ).payload,
    before,
  );
});
