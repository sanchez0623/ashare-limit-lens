import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceEnvironment,
  MARKET_ENVIRONMENT_POLICY,
} from "../shared/market-environment.js";
import {
  initialAdaptiveRisk,
  advanceAdaptiveRisk,
  adaptiveEffective,
  ADAPTIVE_RISK_POLICY,
  ADAPTIVE_RISK_POLICY_V2,
  NEUTRAL_ADAPTIVE_RISK_POLICY,
} from "../shared/adaptive-risk.js";
import { defaultDragonConfig } from "../shared/dragon-risk-config.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import { ShadowAccountRepository } from "../backend/storage/shadow.js";
import {
  registerDragonConfig,
  dragonBookFields,
} from "../backend/storage/dragon-risk.js";
import { latestPolicyBundle } from "../backend/storage/execution-cost.js";
import { selectionSnapshotDigest } from "../backend/domain/signal-selection.js";
import { newBook } from "../backend/domain/trading.js";
import {
  createDragonPlan,
  openDragonSession,
  advanceDragonSession,
  closeDragonSession,
} from "../backend/domain/dragon-risk.js";
import {
  prepareEnvironmentTrial,
  marketEnvironment,
  researchEnvironment,
  maintainEnvironmentTrials,
  replayEnvironmentPressure,
} from "../backend/services/market-environment.js";
import { consumePortfolioFrame } from "../backend/services/portfolio-runner.js";
import { environmentCalibration } from "../backend/domain/environment-report.js";
import { api } from "../backend/routes/api.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import { QuoteFrameRepository } from "../backend/storage/quotes.js";
const date = "2026-10-27",
  signalDate = "2026-10-26";
const stamp = (s) =>
  new Date(Date.parse(`${date}T09:30:00+08:00`) + s * 1000).toISOString();
const members = Array.from({ length: 8 }, (_, i) => ({
  code: `60000${i + 1}`,
  closeCents: 1000,
  height: i < 3 ? 3 : 1,
}));
const cohort = { signalDate, knownAt: `${signalDate}T07:10:00Z`, members };
function input(seconds, { damage = 0, missing = false } = {}) {
  return {
    date,
    observedAt: stamp(seconds),
    cohort,
    environmentCohort: cohort,
    baseline: {
      strength: 0.8,
      applied: 0.7,
      trend: { oneMinute: 0.01, fiveMinutes: -0.03 },
    },
    market: {
      date,
      observedAt: stamp(Math.floor(seconds / 30) * 30),
      sectorsComplete: true,
      metrics: {
        limitUp: 80,
        broken: 0,
        height: 5,
        premium: 3,
        premiumCoverage: 1,
      },
      sectors: [{ name: "测试行业", score: 85, count: 6, broken: 0 }],
      discoveries: [],
    },
    quotes: missing
      ? {}
      : Object.fromEntries(
          members.map((m) => [
            m.code,
            {
              date,
              timestamp: stamp(seconds),
              previousCloseCents: 1000,
              closeCents: 1000 - damage,
              openCents: 940,
              highCents: 1000,
              lowCents: 940,
              volumeShares: 1000000 + seconds * 100000,
              limitUpCents: 1100,
              limitDownCents: 900,
              bid1Cents: 999 - damage,
              ask1Cents: 1001 - damage,
              bid1Shares: 1000000,
              ask1Shares: 1000000,
              orderBookQuality: "OK",
              orderBookTimestamp: stamp(seconds),
            },
          ]),
        ),
  };
}
test("三维环境只用盘前样本和已到达报价，追加未来前缀不改变旧结果", () => {
  const prefix = advanceEnvironment(null, input(0, { damage: 60 }));
  assert.equal(prefix.fragility.value, 1);
  assert.equal(prefix.cap, 0.25);
  assert.equal(prefix.direction.band, "DETERIORATING");
  const original = structuredClone(prefix);
  advanceEnvironment(prefix, input(600));
  assert.deepEqual(prefix, original);
  const future = input(0);
  for (const q of Object.values(future.quotes)) q.timestamp = stamp(1);
  assert.equal(advanceEnvironment(null, future).status, "DEGRADED_BASELINE");
  assert.equal(
    advanceEnvironment(null, {
      ...input(0),
      cohort: { ...cohort, knownAt: stamp(1) },
    }).fragility.ordinary.value,
    null,
  );
});
test("脆弱性恶化立即约束、改善需连续独立证据；缓存不增加确认", () => {
  let e = advanceEnvironment(null, input(0, { damage: 60 }));
  e = advanceEnvironment(e, input(10));
  assert.equal(e.cap, 0.25);
  const cached = input(20);
  cached.quotes = input(10).quotes;
  cached.market = input(10).market;
  e = advanceEnvironment(e, cached);
  assert.equal(e.pending.count, 1);
  e = advanceEnvironment(e, input(40));
  assert.equal(e.cap, 0.25);
  e = advanceEnvironment(e, input(70));
  assert.equal(e.cap, 0.45);
  const held = advanceEnvironment(e, input(80, { missing: true }));
  assert.equal(held.cap, 0.45);
  assert.equal(held.status, "RETAINED");
  assert.equal(
    advanceEnvironment(held, input(260, { missing: true })).status,
    "DEGRADED_BASELINE",
  );
});
test("部分指标缺失仍执行已知风险上限，不用不完整的低风险值提前放宽", () => {
  const partial = input(0, { missing: true });
  Object.assign(partial.market.metrics, { limitUp: 20, broken: 80 });
  const knownRisk = advanceEnvironment(null, partial);
  assert.equal(knownRisk.fragility.value, 0.8);
  assert.equal(knownRisk.fragility.complete, false);
  assert.equal(knownRisk.fragility.band, "UNKNOWN");
  assert.equal(knownRisk.cap, 0.25);
  assert.equal(knownRisk.status, "PARTIAL_CURRENT");
  const weaker = advanceEnvironment(knownRisk, input(10, { missing: true }));
  assert.equal(weaker.cap, 0.25);
  assert.equal(weaker.status, "RETAINED");
  const expired = advanceEnvironment(weaker, input(190, { missing: true }));
  assert.equal(expired.cap, 1);
  assert.equal(expired.status, "DEGRADED_BASELINE");
});
test("V3新增风险受F约束，持仓保护和T第二腿与V2完全相同", () => {
  const config = defaultDragonConfig(),
    legacy = initialAdaptiveRisk(date, ADAPTIVE_RISK_POLICY_V2),
    modern = initialAdaptiveRisk(date);
  for (let s = 0; s <= 330; s += 10) {
    const x = input(s);
    advanceAdaptiveRisk(legacy, {
      ...x,
      sectors: Object.fromEntries(members.map((m) => [m.code, "测试行业"])),
    });
    advanceAdaptiveRisk(modern, {
      ...x,
      environmentQuotes: input(s, { damage: 60 }).quotes,
      sectors: Object.fromEntries(members.map((m) => [m.code, "测试行业"])),
    });
  }
  const options = { code: "600001", sector: "测试行业" },
    a = adaptiveEffective(config, legacy, options),
    b = adaptiveEffective(config, modern, options);
  assert(b.entryRisk < a.entryRisk);
  assert.deepEqual(a.protection, b.protection);
  assert.deepEqual(
    adaptiveEffective(config, modern, { ...options, intent: "T_RECOVERY" }),
    a,
  );
});
test("无市场择时对照只移除市场系数，行业和个股数据约束仍生效", () => {
  const state = initialAdaptiveRisk(date, NEUTRAL_ADAPTIVE_RISK_POLICY),
    config = defaultDragonConfig();
  for (let s = 0; s <= 330; s += 10)
    advanceAdaptiveRisk(state, {
      ...input(s),
      sectors: { 600001: "测试行业" },
    });
  const e = adaptiveEffective(config, state, {
    code: "600001",
    sector: "测试行业",
  });
  assert.equal(e.marketFactor, 1);
  state.sectors["测试行业"].valid = false;
  assert.equal(
    adaptiveEffective(config, state, { code: "600001", sector: "测试行业" })
      .open,
    false,
  );
});
async function fixture(t) {
  const DB = localDatabase(),
    env = { DB },
    papers = new PaperRepository(env);
  t.after(() => DB.close());
  await papers.initialize();
  const record = await registerDragonConfig(DB, defaultDragonConfig(), null, {
    origin: "MANUAL",
    validationMode: "MANUAL_UNVERIFIED",
  });
  const source = {
    date: signalDate,
    createdAt: `${signalDate}T07:10:00Z`,
    stocks: members.map((m) => ({
      ...m,
      name: m.code,
      price: 10,
      sector: "测试行业",
    })),
    sectors: [],
    intradayEntryContext: {
      version: "intraday-entry-v1",
      asOf: signalDate,
      history: Object.fromEntries(
        members.map((m) => [
          m.code,
          {
            name: m.code,
            sector: "测试行业",
            stockClass: "relay-leader",
            recentLimitUp: true,
            amount: 500000000,
            previousCloseCents: 1000,
            previousOpenCents: 950,
            previousChange: 10,
            previousHeight: m.height,
            previousTouchedLimit: true,
            lastFourCloseSumCents: 3600,
          },
        ]),
      ),
    },
  };
  const book = {
    ...newBook(),
    ...dragonBookFields(record),
    lastDate: signalDate,
    tradingCycleId: "environment-test",
    dragonTransition: {
      state: "ACTIVE",
      configId: record.id,
      candidate: false,
    },
  };
  await DB.prepare(
    "UPDATE paper_accounts SET state=?,revision=revision+1 WHERE id='primary'",
  )
    .bind(JSON.stringify(book))
    .run();
  await DB.prepare(
    "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
  )
    .bind(signalDate, source.createdAt, JSON.stringify(source))
    .run();
  const plan = createDragonPlan(source, book, `${signalDate}T08:00:00Z`, {
    snapshotDigest: await selectionSnapshotDigest(source),
    executionCostPolicy: await latestPolicyBundle(DB),
  });
  await papers.savePlan(plan);
  return { DB, env, papers, book, source, plan, record };
}
test("盘前事务创建三组对照，原版V2、新版V3、无市场择时版本独立；重复不开户", async (t) => {
  const f = await fixture(t),
    before = await f.papers.account();
  const trial = await prepareEnvironmentTrial(
    f.env,
    new Date(`${signalDate}T20:00:00+08:00`),
  );
  assert.equal(trial.status, "ACTIVE");
  const repo = new ShadowAccountRepository(f.env);
  assert.equal((await repo.accounts()).length, 3);
  assert.equal(
    (await repo.plan(trial.accounts.LEGACY, signalDate)).dragonPolicy
      .adaptiveRiskPolicy.version,
    ADAPTIVE_RISK_POLICY_V2.version,
  );
  const { digest: _, ...mirror } = await repo.plan(
    trial.accounts.NEW,
    signalDate,
  );
  assert.deepEqual(mirror, f.plan);
  await prepareEnvironmentTrial(
    f.env,
    new Date(`${signalDate}T21:00:00+08:00`),
  );
  assert.equal((await repo.accounts()).length, 3);
  assert.deepEqual(await f.papers.account(), before);
});
test("主账户与新版影子同帧同成交；环境证据随CAS原子落库，重启重复不计机会", async (t) => {
  const f = await fixture(t),
    trial = await prepareEnvironmentTrial(
      f.env,
      new Date(`${signalDate}T20:00:00+08:00`),
    ),
    repo = new RealtimeRepository(f.env),
    shadows = new ShadowAccountRepository(f.env);
  let book = f.book,
    session = openDragonSession(book, f.plan, date);
  for (let seconds = 0; seconds <= 180; seconds += 10) {
    const x = input(seconds),
      target = x.quotes["600001"],
      o = {
        observedAt: x.observedAt,
        quotes: x.quotes,
        pollIntervalSeconds: 10,
        entryInputs: {
          market: x.market,
          auction: {
            600001: {
              date,
              final: true,
              openCents: 940,
              previousCloseCents: 1000,
            },
          },
        },
      };
    Object.assign(target, { closeCents: 950, bid1Cents: 949, ask1Cents: 951 });
    const step = advanceDragonSession(book, session, o),
      account = await repo.account();
    assert.equal(await repo.commitObservation(account.revision, step, o), true);
    const frame = {
      tradeDate: date,
      sequence: seconds / 10 + 1,
      observedAt: o.observedAt,
      payload: o,
    };
    const mirrored = await consumePortfolioFrame(
      f.env,
      trial.accounts.NEW,
      frame,
    );
    assert.equal(mirrored.applied, true);
    for (const role of ["LEGACY", "NEUTRAL"])
      assert.equal(
        (await consumePortfolioFrame(f.env, trial.accounts[role], frame))
          .applied,
        true,
      );
    assert.deepEqual(
      (await shadows.account(trial.accounts.NEW)).book,
      step.book,
    );
    assert.equal(
      (await consumePortfolioFrame(f.env, trial.accounts.NEW, frame)).skipped,
      true,
    );
    book = step.book;
    session = step.session;
  }
  const e = await marketEnvironment(f.env, { date, at: stamp(60) });
  assert(
    (await f.DB.prepare("SELECT COUNT(*) AS n FROM paper_ledger").first()).n >
      0,
    "必须包含真实模拟成交，不能只比较空账本",
  );
  assert.equal(
    (
      await f.DB.prepare(
        "SELECT COUNT(*) AS n FROM market_environment_opportunities WHERE scope='primary' AND kind='ENTRY'",
      ).first()
    ).n,
    1,
  );
  assert.equal(e.asOf, stamp(60));
  const snapshotCount = (
    await f.DB.prepare(
      "SELECT COUNT(*) AS n FROM market_environment_snapshots WHERE scope='primary'",
    ).first()
  ).n;
  assert.equal(snapshotCount, 19);
  const x = input(190),
    o = {
      observedAt: x.observedAt,
      quotes: x.quotes,
      entryInputs: { market: x.market },
    },
    step = advanceDragonSession(book, session, o),
    before = await f.papers.account();
  f.DB.exec(
    "CREATE TRIGGER fail_environment BEFORE INSERT ON market_environment_snapshots BEGIN SELECT RAISE(ABORT,'injected environment failure'); END;",
  );
  await assert.rejects(
    repo.commitObservation(before.revision, step, o),
    /injected/,
  );
  assert.deepEqual(await f.papers.account(), before);
  assert.equal(
    (
      await f.DB.prepare(
        "SELECT COUNT(*) AS n FROM market_environment_snapshots WHERE scope='primary'",
      ).first()
    ).n,
    19,
  );
  await assert.rejects(
    f.DB.prepare("UPDATE market_environment_snapshots SET payload='{}'").run(),
    /不可改写/,
  );
  await f.DB.prepare(
    "UPDATE paper_live_ticks SET payload='{}' WHERE trade_date=? AND sequence=7",
  )
    .bind(date)
    .run();
  await assert.rejects(
    marketEnvironment(f.env, { date, at: stamp(60) }),
    /摘要不一致/,
  );
});
test("已开始执行的日期不补建对照；API拒绝未来时点和非法买点筛选", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await prepareEnvironmentTrial(f.env, new Date(stamp(0)))).status,
    "WAITING_NEXT_PLAN",
  );
  for (const path of [
    "/api/market/environment?at=2999-01-01T00:00:00Z",
    "/api/research/environment?dimension=all",
    "/api/research/environment?buyPoint=bad",
  ])
    assert.equal(
      (await api(new Request(`http://localhost${path}`), f.env)).status,
      400,
    );
  assert.equal((await researchEnvironment(f.env)).groups.length, 0);
});
test("同日多笔、部分成交和T腿不制造独立天数；未来清仓不能提前进入收益统计", async () => {
  const source = {
    engineBuild: "build",
    configDigest: "config",
    feeDigest: "fees",
    prospective: true,
  };
  const env = {
    strengthBand: "STRONG",
    direction: { band: "FLAT" },
    fragility: { band: "LOW" },
  };
  const at = stamp(10),
    event = {
      scope: "primary",
      tradeDate: date,
      asOf: at,
      code: "600001",
      buyPoint: "auction-dip",
      source,
      environment: env,
    };
  const fills = [
    {
      id: "buy",
      date,
      code: "600001",
      cycleId: "cycle",
      intent: "OPEN",
      side: "BUY",
      quantity: 100,
      priceCents: 1000,
      cashDeltaCents: -100005,
      feeCents: 5,
      sequence: 0,
      buyPoint: "auction-dip",
      entryEvidence: { observedAt: at },
    },
    {
      id: "sell",
      date: "2026-10-28",
      code: "600001",
      cycleId: "cycle",
      intent: "EXIT",
      side: "SELL",
      quantity: 100,
      priceCents: 1100,
      cashDeltaCents: 109995,
      feeCents: 5,
      sequence: 0,
      entryEvidence: { observedAt: "2026-10-28T02:00:00Z" },
    },
  ];
  const events = [
    { ...event, kind: "TRIGGER" },
    { ...event, kind: "ENTRY", cycleId: "cycle", initialRiskPerShareCents: 40 },
  ];
  const today = await environmentCalibration({ events, fills, asOf: date });
  assert.equal(today.openCycles.length, 1);
  assert.equal(today.groups[0].cycles, 0);
  const later = await environmentCalibration({
    events,
    fills,
    asOf: "2026-10-28",
  });
  assert.equal(later.groups[0].cycles, 1);
  assert.equal(later.groups[0].status, "INSUFFICIENT");
  assert.equal(later.groups[0].meanMaeR, null);
  assert(later.groups[0].meanNetR > 0);
});

test("缺日也占固定30日窗口，不延长、不重开；报告与原账本绑定", async (t) => {
  const f = await fixture(t);
  const trial = await prepareEnvironmentTrial(
    f.env,
    new Date(`${signalDate}T20:00:00+08:00`),
  );
  const dates = [];
  for (let time = Date.parse(date); dates.length < 31; time += 86400000) {
    const d = new Date(time);
    if (![0, 6].includes(d.getUTCDay()))
      dates.push(d.toISOString().slice(0, 10));
  }
  const options = {
    now: new Date(`${dates.at(-1)}T17:10:00+08:00`),
    calendarProvider: async () => ({ dates }),
  };
  const [first, other] = await Promise.all([
    maintainEnvironmentTrials(f.env, options),
    maintainEnvironmentTrials(f.env, options),
  ]);
  assert.equal(first.results.length + other.results.length, 1);
  const report = await researchEnvironment(f.env);
  assert.equal(report.trial.status, "INCONCLUSIVE");
  assert.deepEqual(report.comparison.dates, dates.slice(0, 30));
  assert.equal(report.comparison.costStress.length, 0);
  assert.equal(report.eligibleForPromotion, false);
  assert.equal(
    (
      await prepareEnvironmentTrial(
        f.env,
        new Date(`${signalDate}T21:00:00+08:00`),
      )
    ).status,
    "INCONCLUSIVE",
  );
  assert.equal((await new ShadowAccountRepository(f.env).accounts()).length, 3);
  await f.DB.prepare(
    "INSERT INTO paper_ledger(id,trade_date,payload) VALUES('tamper',?,?)",
  )
    .bind(date, JSON.stringify({ id: "tamper", date, sequence: 1 }))
    .run();
  await assert.rejects(researchEnvironment(f.env), /原始账本已改变/);
  assert.equal(
    (
      await f.DB.prepare(
        "SELECT COUNT(*) AS n FROM market_environment_reports WHERE trial_id=?",
      )
        .bind(trial.id)
        .first()
    ).n,
    1,
  );
});

test("30个周期仍要求20个不同入场日，按日聚类区间；回放不冒充前瞻", async () => {
  const source = {
    engineBuild: "build",
    configDigest: "config",
    feeDigest: "fee",
    prospective: true,
  };
  const environment = {
    strengthBand: "STRONG",
    direction: { band: "IMPROVING" },
    fragility: { band: "LOW" },
  };
  const build = (clustered = false, prospective = true) => {
    const events = [],
      fills = [];
    for (let i = 0; i < 30; i++) {
      const day = `2026-08-${String(clustered ? 1 : i + 1).padStart(2, "0")}`;
      const end = "2026-09-01",
        cycleId = `cycle-${i}`,
        code = `60${String(i).padStart(4, "0")}`;
      const event = {
        scope: "primary",
        tradeDate: day,
        asOf: `${day}T02:00:00Z`,
        code,
        buyPoint: "auction-dip",
        environment,
        source: { ...source, prospective },
      };
      events.push(
        { ...event, kind: "TRIGGER" },
        { ...event, kind: "ENTRY", cycleId, initialRiskPerShareCents: 40 },
      );
      fills.push(
        {
          id: `${i}:0`,
          date: day,
          cycleId,
          code,
          side: "BUY",
          intent: "OPEN",
          buyPoint: "auction-dip",
          quantity: 100,
          priceCents: 1000,
          feeCents: 5,
          cashDeltaCents: -100005,
          sequence: 1,
          entryEvidence: { observedAt: event.asOf },
        },
        {
          id: `${i}:1`,
          date: end,
          cycleId,
          code,
          side: "SELL",
          intent: "EXIT",
          quantity: 100,
          priceCents: 1000 + i,
          feeCents: 5,
          cashDeltaCents: 99995 + i * 100,
          sequence: 1,
          entryEvidence: { observedAt: `${end}T02:00:00Z` },
        },
      );
    }
    return { events, fills, asOf: "2026-09-01" };
  };
  const clustered = await environmentCalibration(build(true));
  assert.equal(clustered.groups[0].entryDates, 1);
  assert.equal(clustered.groups[0].status, "INSUFFICIENT");
  const enough = await environmentCalibration(build());
  assert.equal(enough.groups[0].status, "DESCRIPTIVE");
  assert(enough.groups[0].interval.upper > enough.groups[0].interval.lower);
  const replay = await environmentCalibration(build(false, false));
  assert.equal(replay.groups[0].status, "INSUFFICIENT");
  assert.equal(replay.groups[0].mode, "REPLAY_DIAGNOSTIC");
});

test("三组成本压力复用真实撮合与T+1，固定1/1.5/2倍并统一校正六个比较", async (t) => {
  const f = await fixture(t),
    days = [];
  for (let i = 0; i < 3; i++) {
    const d = `2026-10-${27 + i}`,
      sd = `2026-10-${26 + i}`;
    const source = structuredClone(f.source);
    source.date = sd;
    source.createdAt = `${sd}T07:10:00Z`;
    source.intradayEntryContext.asOf = sd;
    const frames = [];
    for (let seconds = 0; seconds <= 330; seconds += 10) {
      const x = input(seconds),
        observedAt = new Date(
          Date.parse(`${d}T09:30:00+08:00`) + seconds * 1000,
        ).toISOString();
      x.market.date = d;
      x.market.observedAt = observedAt;
      for (const q of Object.values(x.quotes))
        Object.assign(q, {
          date: d,
          timestamp: observedAt,
          orderBookTimestamp: observedAt,
        });
      const price = i ? 900 : 950;
      Object.assign(x.quotes["600001"], {
        closeCents: price,
        lowCents: price,
        bid1Cents: price,
        ask1Cents: price + 1,
      });
      frames.push({
        observedAt,
        payload: {
          observedAt,
          quotes: x.quotes,
          pollIntervalSeconds: 10,
          entryInputs: {
            market: x.market,
            auction: {
              600001: {
                date: d,
                final: true,
                openCents: 940,
                previousCloseCents: 1000,
              },
            },
          },
        },
      });
    }
    const quotes = structuredClone(frames.at(-1).payload.quotes);
    for (const q of Object.values(quotes))
      Object.assign(q, { timestamp: `${d}T07:00:00.000Z`, closeCents: 1000 });
    days.push({
      date: d,
      source,
      createdAt: `${sd}T08:00:00Z`,
      fees: f.plan.feeConfig,
      feeModel: f.plan.feeModel,
      feeConfigVersion: f.plan.feeConfigVersion,
      cost: f.plan.executionCostPolicy,
      observationUniverse: f.plan.observationUniverse,
      dataset: { date: d, source: "synthetic-cost-test", quotes, minutes: {} },
      frames,
    });
  }
  const result = await replayEnvironmentPressure({
    manifest: { id: "fixed-test", initialBook: f.book },
    record: f.record,
    days,
    loadFrames: async (day) => day.frames,
  });
  assert.deepEqual(
    result.costStress.map((s) => s.multiplier),
    [1, 1.5, 2],
  );
  assert.equal(result.tests.length, 6);
  assert.equal(result.tests[0].alphaPerComparison, 0.05 / 6);
  assert.equal(result.correction.familySize, 6);
  assert.equal(result.eligibleForPromotion, false);
  assert(
    result.costStress[0].arms.NEW.fills > 0,
    "必须真实成交，不能空账本压力测试",
  );
  assert(
    result.costStress[2].arms.NEW.feesCents >=
      result.costStress[0].arms.NEW.feesCents,
  );
});

test(
  "完整真实模拟日生成环境报告，次日计划暂缺不作版本失效；输入被篡改后拒绝沿用",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t),
      trial = await prepareEnvironmentTrial(
        f.env,
        new Date(`${signalDate}T20:00:00+08:00`),
      );
    const repo = new RealtimeRepository(f.env),
      frames = new QuoteFrameRepository(f.env);
    let book = f.book,
      session = openDragonSession(book, f.plan, date),
      last;
    for (const [start, end] of [
      ["09:30:00", "11:30:00"],
      ["13:00:00", "14:56:40"],
    ]) {
      for (
        let ms = Date.parse(`${date}T${start}+08:00`);
        ms <= Date.parse(`${date}T${end}+08:00`);
        ms += 20000
      ) {
        const seconds = (ms - Date.parse(stamp(0))) / 1000,
          x = input(seconds),
          target = x.quotes["600001"];
        Object.assign(target, {
          closeCents: 950,
          bid1Cents: 949,
          ask1Cents: 951,
        });
        const o = {
          observedAt: x.observedAt,
          quotes: x.quotes,
          pollIntervalSeconds: 20,
          entryInputs: {
            market: x.market,
            auction: Object.fromEntries(
              members.map((m) => [
                m.code,
                { date, final: true, openCents: 940, previousCloseCents: 1000 },
              ]),
            ),
          },
        };
        const frame = await frames.appendFrame({
          tradeDate: date,
          ...o,
          pool: { codes: Object.keys(o.quotes) },
          entryInputs: o.entryInputs,
        });
        const step = advanceDragonSession(book, session, o),
          account = await repo.account();
        assert.equal(
          await repo.commitObservation(account.revision, step, o),
          true,
        );
        for (const id of Object.values(trial.accounts))
          assert.equal(
            (await consumePortfolioFrame(f.env, id, { ...frame, payload: o }))
              .applied,
            true,
          );
        book = step.book;
        session = step.session;
        last = o;
      }
    }
    const closing = structuredClone(last.quotes);
    for (const q of Object.values(closing))
      q.timestamp = `${date}T07:00:05.000Z`;
    await frames.appendFrame({
      tradeDate: date,
      observedAt: `${date}T07:00:10.000Z`,
      quotes: closing,
      pollIntervalSeconds: 20,
      pool: { codes: Object.keys(closing) },
    });
    const dataset = {
      date,
      source: "SYNTHETIC_COMPLETE_ENVIRONMENT",
      quotes: closing,
      minutes: {},
    };
    const closed = closeDragonSession(book, session, dataset),
      account = await repo.account();
    assert.equal(await repo.close(account.revision, closed, dataset), true);
    assert.equal(await f.papers.plan(date), null);
    const result = await maintainEnvironmentTrials(f.env, {
      now: new Date(`${date}T17:10:00+08:00`),
      calendarProvider: async () => ({ dates: [date] }),
    });
    const report = await researchEnvironment(f.env);
    assert.equal(
      result.results[0].status,
      "OBSERVING",
      JSON.stringify(report.comparison.missing),
    );
    assert.equal(report.trial.status, "ACTIVE");
    assert.equal(report.comparison.mirrorConsistent, true);
    assert.equal(report.comparison.missing.length, 0);
    assert(report.groups.length > 0);
    assert(report.openCycles.length > 0);
    assert(report.comparison.arms.NEW.fills > 0);
    await f.DB.prepare(
      "UPDATE quote_frames SET digest='changed' WHERE trade_date=? AND sequence=1",
    )
      .bind(date)
      .run();
    await assert.rejects(researchEnvironment(f.env), /来源已改变|摘要不一致/);
  },
);
