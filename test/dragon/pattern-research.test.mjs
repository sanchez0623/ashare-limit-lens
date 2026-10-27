import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../../scripts/local-db.mjs";
import { newBook } from "../../backend/domain/trading.js";
import { createDragonPlan } from "../../backend/domain/dragon-risk.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../../backend/domain/realtime.js";
import { digestOf } from "../../backend/domain/research-lineage.js";
import { defaultDragonConfig } from "../../shared/dragon-risk-config.js";
import {
  registerDragonConfig,
  dragonBookFields,
  bindDragonPlan,
} from "../../backend/storage/dragon-risk.js";
import { latestPolicyBundle } from "../../backend/storage/execution-cost.js";
import { preserveProgramSignal } from "../../backend/storage/strategy-signals.js";
import { PaperRepository } from "../../backend/storage/paper.js";
import { buildPracticeReview } from "../../backend/domain/practice-review.js";
import { practiceCoverage } from "../../backend/domain/practice-coverage.js";
import {
  proposePatternResearch,
  maintainPatternResearch,
  loadPatternDays,
} from "../../backend/services/dragon-pattern-research.js";
import {
  queueVerifiedPattern,
  verifyDragonObservation,
} from "../../backend/services/dragon-risk.js";
import { ShadowAccountRepository } from "../../backend/storage/shadow.js";
import { QuoteFrameRepository } from "../../backend/storage/quotes.js";
import { frozenProgramSignal } from "../../backend/storage/strategy-signals.js";
import {
  freezePortfolioPlan,
  consumePortfolioFrame,
  settlePortfolioDay,
} from "../../backend/services/portfolio-runner.js";
import { PATTERN_POLICY } from "../../backend/domain/dragon-patterns.js";
import { snapshot } from "../fixtures/trading.mjs";

// Entirely synthetic: a continuous, liquid, unchanged price in a frozen market.
// The archive genuinely runs the execution kernel and never generates a fill.
async function practiceArchive(t) {
  const DB = localDatabase(),
    env = { DB, AI_API_KEY: "test", TRADING_POLL_SECONDS: "20" };
  t.after(() => DB.close());
  const papers = new PaperRepository(env);
  await papers.initialize();
  const parent = await registerDragonConfig(DB, defaultDragonConfig(), null, {
    origin: "MANUAL",
    validationMode: "MANUAL_UNVERIFIED",
  });
  const cost = await latestPolicyBundle(DB);
  let book = {
    ...newBook(),
    ...dragonBookFields(parent),
    improvementMode: "auto",
  };
  const dates = [];
  for (let ms = Date.parse("2026-06-01"); dates.length < 81; ms += 86400000) {
    const d = new Date(ms);
    if (![0, 6].includes(d.getUTCDay()))
      dates.push(d.toISOString().slice(0, 10));
  }
  book.lastDate = dates[0];
  const sessions = [];
  for (let index = 1; index < dates.length; index++) {
    const date = dates[index],
      signalDate = dates[index - 1],
      source = snapshot(signalDate);
    source.cycle = { phase: "freezing" };
    source.intradayEntryContext = {
      version: "intraday-entry-v1",
      asOf: signalDate,
      history: {
        600003: {
          name: "合成候选",
          sector: "行业",
          stockClass: "swing-range",
          amount: 500000000,
          recentLimitUp: true,
          previousCloseCents: 1000,
          previousOpenCents: 990,
          previousChange: 10,
          previousHeight: 1,
          lastFourCloseSumCents: 4000,
        },
      },
    };
    const createdAt = `${signalDate}T17:00:00+08:00`;
    const plan = createDragonPlan(source, book, createdAt, {
      executionCostPolicy: cost,
    });
    await preserveProgramSignal(DB, plan, source);
    await (await bindDragonPlan(DB, plan, "main")).run();
    let session = openSession(book, plan, date);
    const observations = [],
      statements = [],
      frames = [];
    const quote = (observedAt, volumeShares) => ({
      code: "600003",
      date,
      timestamp: observedAt,
      closeCents: 1000,
      previousCloseCents: 1000,
      openCents: 1000,
      highCents: 1000,
      lowCents: 1000,
      limitUpCents: 1100,
      limitDownCents: 900,
      volumeShares,
      amountCents: volumeShares * 1000,
      orderBookQuality: "OK",
      orderBookTimestamp: observedAt,
      bid1Cents: 999,
      ask1Cents: 1001,
      bid1Shares: 100000,
      ask1Shares: 100000,
    });
    for (const [start, end] of [
      ["09:30:00", "11:30:00"],
      ["13:00:00", "14:56:40"],
    ]) {
      for (
        let ms = Date.parse(`${date}T${start}+08:00`);
        ms <= Date.parse(`${date}T${end}+08:00`);
        ms += 20000
      ) {
        const observedAt = new Date(ms).toISOString(),
          sequence = observations.length + 1;
        const observation = {
          observedAt,
          pollIntervalSeconds: 20,
          quotes: { 600003: quote(observedAt, sequence * 1000) },
          entryInputs: {
            market: {
              date,
              observedAt,
              cycle: { phase: "freezing" },
              metrics: {
                limitUp: 0,
                broken: 0,
                height: 0,
                premium: 0,
                premiumCoverage: 1,
              },
              sectorsComplete: true,
              sectors: [{ name: "行业", score: 70, count: 0, broken: 0 }],
            },
          },
        };
        observations.push(observation);
        const step = advanceSession(book, session, observation);
        assert.equal(step.ledger.length, 0);
        book = step.book;
        session = step.session;
        const hash = await digestOf(observation);
        statements.push(
          DB.prepare(
            "INSERT INTO paper_live_ticks(trade_date,sequence,payload,digest) VALUES(?,?,?,?)",
          ).bind(date, sequence, JSON.stringify(observation), hash),
        );
        // Frames are a separate immutable source from authoritative account ticks.
        const payload = {
          ...observation,
          pool: {
            codes: ["600003"],
            sources: { researchPoolDate: signalDate },
          },
        };
        frames.push({ observedAt, payload });
        statements.push(
          DB.prepare(
            "INSERT INTO quote_frames(trade_date,sequence,observed_at,pool_digest,payload,digest,created_at) VALUES(?,?,?,'synthetic',?,?,?)",
          ).bind(
            date,
            sequence,
            observedAt,
            JSON.stringify(payload),
            await digestOf(payload),
            observedAt,
          ),
        );
      }
    }
    const closeAt = `${date}T15:00:10+08:00`,
      closeQuote = quote(`${date}T15:00:05+08:00`, 2000000);
    const closingFrame = {
      observedAt: closeAt,
      pollIntervalSeconds: 20,
      quotes: { 600003: closeQuote },
      pool: { codes: ["600003"], sources: { researchPoolDate: signalDate } },
    };
    frames.push({ observedAt: closeAt, payload: closingFrame });
    statements.push(
      DB.prepare(
        "INSERT INTO quote_frames(trade_date,sequence,observed_at,pool_digest,payload,digest,created_at) VALUES(?,?,?,'synthetic',?,?,?)",
      ).bind(
        date,
        observations.length + 1,
        closeAt,
        JSON.stringify(closingFrame),
        await digestOf(closingFrame),
        closeAt,
      ),
    );
    const dataset = {
      date,
      previousTradingDate: signalDate,
      source: "SYNTHETIC",
      quotes: { 600003: closeQuote },
    };
    const settled = closeSession(book, session, dataset);
    book = settled.book;
    session = settled.session;
    const coverage = practiceCoverage({
      date,
      session,
      frames: observations,
      closingFrames: frames,
    });
    assert.equal(coverage.complete, true, JSON.stringify(coverage.gaps));
    const review = await buildPracticeReview({
      date,
      session,
      equity: settled.equity,
      dataset,
      fills: [],
      observations,
      coverage,
    });
    assert.equal(review.researchEligible, true);
    statements.push(
      DB.prepare(
        "INSERT INTO paper_live_sessions(trade_date,payload,digest) VALUES(?,?,?)",
      ).bind(date, JSON.stringify(session), await digestOf(session)),
      DB.prepare(
        "INSERT INTO paper_market_days(trade_date,payload,digest) VALUES(?,?,?)",
      ).bind(date, JSON.stringify(dataset), await digestOf(dataset)),
      DB.prepare(
        "INSERT INTO paper_equity(trade_date,payload) VALUES(?,?)",
      ).bind(date, JSON.stringify(settled.equity)),
      DB.prepare(
        "INSERT INTO reviews(trade_date,snapshot_date,created_at,payload,ai_payload) VALUES(?,?,?,?,?)",
      ).bind(
        date,
        signalDate,
        `${date}T17:00:00+08:00`,
        JSON.stringify(review),
        JSON.stringify({ summary: "PAST_AI_MUST_NOT_ENTER_RESEARCH" }),
      ),
    );
    await DB.batch(statements);
    sessions.push(session);
  }
  await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
    .bind(JSON.stringify(book))
    .run();
  return { DB, env, papers, parent, sessions };
}

test(
  "80日源归档只给模型60日客观特征；同批共享封存日并冻结公平对照，零周期不晋级",
  { timeout: 180000 },
  async (t) => {
    const f = await practiceArchive(t),
      before = await f.papers.account();
    assert.ok(f.sessions[0].entryState.admissions["600003"]);
    let requests = 0;
    const proposed = await proposePatternResearch(f.env, {
      propose: async (_, evidence) => {
        requests++;
        assert.equal(evidence.training.length, 60);
        assert.deepEqual(
          evidence.training.map((d) => d.date),
          f.sessions.slice(0, 60).map((s) => s.date),
        );
        const serialized = JSON.stringify(evidence);
        assert.doesNotMatch(serialized, /PAST_AI_MUST_NOT_ENTER_RESEARCH/);
        for (const session of f.sessions.slice(60))
          assert.equal(
            evidence.training.some((d) => d.date === session.date),
            false,
          );
        assert.equal(
          (
            await f.DB.prepare(
              "SELECT COUNT(*) AS n FROM research_test_claims",
            ).first()
          ).n,
          20,
        );
        assert.equal(
          (
            await f.DB.prepare(
              "SELECT attempt_sequence FROM research_registry WHERE namespace='main'",
            ).first()
          ).attempt_sequence,
          4,
        );
        assert.equal(
          (
            await proposePatternResearch(f.env, {
              propose: () => assert.fail("重复请求"),
            })
          ).status,
          "REQUESTING",
        );
        return {
          candidates: [
            {
              rationale: "练习样本比较盈利加仓",
              patch: { "operations.profitAdd": false },
            },
            {
              rationale: "练习样本比较亏损补仓及T比例",
              patch: {
                "operations.lossAdd": false,
                "advanced.tFraction": 0.12,
              },
            },
          ],
        };
      },
    });
    assert.equal(proposed.status, "HISTORICAL");
    assert.equal(requests, 1);
    assert.deepEqual(await f.papers.account(), before);
    const row = await f.DB.prepare(
      "SELECT * FROM dragon_pattern_batches WHERE id=?",
    )
      .bind(proposed.batchId)
      .first();
    const manifest = JSON.parse(row.manifest);
    assert.equal(manifest.candidates.length, 2);
    assert.equal(new Set(manifest.accounts.map((a) => a.accountId)).size, 4);
    for (const actor of manifest.accounts)
      assert.deepEqual(actor.record.config.risk, f.parent.config.risk);
    assert.deepEqual(manifest.fixed.config, defaultDragonConfig());
    assert.deepEqual(manifest.historicalStart, f.sessions[60].initialBook);
    assert.deepEqual(manifest.forwardStart, before.book);
    const result = await maintainPatternResearch(
      f.env,
      new Date(`${before.book.lastDate}T17:10:00+08:00`),
    );
    assert.equal(result.status, "INCONCLUSIVE", JSON.stringify(result));
    const final = await f.DB.prepare(
      "SELECT * FROM dragon_pattern_batches WHERE id=?",
    )
      .bind(proposed.batchId)
      .first();
    const report = JSON.parse(final.report);
    assert.equal(report.historical.length, 6);
    for (const c of manifest.candidates) {
      const comparisons = report.historical.filter(
        (r) => r.candidateId === c.id,
      );
      assert.deepEqual(
        comparisons.map((r) => r.multiplier),
        [1, 1.5, 2],
      );
      assert.ok(
        comparisons.every(
          (r) => r.status === "INSUFFICIENT_ROUNDS" && !r.passed,
        ),
      );
      assert.ok(
        comparisons.every(
          (r) =>
            r.parent.returns.length === 20 && r.baseline.returns.length === 20,
        ),
      );
    }
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT COUNT(*) AS n FROM research_window_owners",
        ).first()
      ).n,
      0,
    );
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT COUNT(*) AS n FROM research_test_claims",
        ).first()
      ).n,
      20,
    );
    assert.deepEqual(await f.papers.account(), before);
    assert.equal(await maintainPatternResearch(f.env), null);
    // Actual shadow consumption and replay must also accept the archive-only close.
    const last = f.sessions.at(-1),
      candidate = manifest.candidates[0];
    const observerId = `dragon-observer:${candidate.id}`,
      shadows = new ShadowAccountRepository(f.env);
    await shadows.ensureAccount(observerId, {
      kind: "DRAGON_OBSERVATION",
      book: { ...last.initialBook, ...dragonBookFields(candidate) },
    });
    await freezePortfolioPlan(f.env, observerId, {
      snapshot: await frozenProgramSignal(f.DB, last.plan),
      strategy: null,
      strategyVersion: candidate.id,
      now: `${last.date}T09:29:00+08:00`,
    });
    for (const frame of await new QuoteFrameRepository(f.env).framesForDate(
      last.date,
    )) {
      if (frame.observedAt === `${last.date}T15:00:10+08:00`) continue;
      assert.equal(
        (await consumePortfolioFrame(f.env, observerId, frame)).applied,
        true,
      );
    }
    const closingRow = await f.DB.prepare(
      "SELECT payload FROM paper_market_days WHERE trade_date=?",
    )
      .bind(last.date)
      .first();
    const closing = JSON.parse(closingRow.payload);
    await settlePortfolioDay(f.env, observerId, last.date, closing);
    const proof = await verifyDragonObservation(
      f.env,
      observerId,
      last.date,
      closing,
      new Date(`${last.date}T17:10:00+08:00`),
    );
    assert.equal(proof.passed, true, JSON.stringify(proof));
    assert.equal(proof.marketCoverage, true);
    assert.equal(proof.inputsPresent, true);
    assert.equal(proof.fills, 0); // Technical success does not grant profit qualification.
    assert.deepEqual(await f.papers.account(), before);
    // Persisted review tampering cannot silently become research input.
    await f.DB.prepare(
      "UPDATE reviews SET payload=json_set(payload,'$.summary.dailyPnlCents',123) WHERE trade_date=?",
    )
      .bind(f.sessions.at(-1).date)
      .run();
    await assert.rejects(
      loadPatternDays(f.env, [f.sessions.at(-1)]),
      /复盘与研究源未核对/,
    );
  },
);

test("采用入口拒绝伪造通过、负收益、重复成本档位或不足30日前瞻，不改主账户", async (t) => {
  const DB = localDatabase(),
    env = { DB },
    papers = new PaperRepository(env);
  t.after(() => DB.close());
  await papers.initialize();
  const before = await papers.account();
  const metrics = {
    netReturn: 0.02,
    maxDrawdown: 0.01,
    completedRounds: 10,
    returns: Array(30).fill(0.001),
  };
  const manifest = {
    policy: PATTERN_POLICY,
    candidates: [{ id: "candidate" }],
    accounts: [],
    parent: { config: defaultDragonConfig() },
  };
  const mHash = await digestOf(manifest);
  const variants = [
    {
      multipliers: [1, 1.5, 2],
      metrics: { ...metrics, netReturn: -0.01 },
      days: 30,
    },
    { multipliers: [1, 1, 1], metrics, days: 30 },
    { multipliers: [1, 1.5, 2], metrics, days: 29 },
  ];
  for (const [index, v] of variants.entries()) {
    const report = {
      winnerId: "candidate",
      actualAccountsVerified: true,
      forwardDates: Array.from({ length: v.days }, (_, i) => `day-${i}`),
      forward: v.multipliers.map((multiplier) => ({
        candidateId: "candidate",
        multiplier,
        passed: true,
        candidate: v.metrics,
        parent: metrics,
        baseline: metrics,
        againstParent: { passed: true },
        againstBaseline: { passed: true },
      })),
      historical: [],
    };
    await DB.prepare(
      "INSERT INTO dragon_pattern_batches(id,stage,manifest,manifest_digest,report,report_digest,comparison_end,created_at,updated_at) VALUES(?,'READY',?,?,?,?,4,'now','now')",
    )
      .bind(
        `rejected-${index}`,
        JSON.stringify(manifest),
        mHash,
        JSON.stringify(report),
        await digestOf(report),
      )
      .run();
    await assert.rejects(
      queueVerifiedPattern(env, `rejected-${index}`, 0),
      /净盈利和对照验证/,
    );
    assert.deepEqual(await papers.account(), before);
    await DB.prepare(
      "UPDATE dragon_pattern_batches SET stage='FAILED' WHERE id=?",
    )
      .bind(`rejected-${index}`)
      .run();
  }
});
