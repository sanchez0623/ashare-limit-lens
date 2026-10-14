import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { localDatabase } from "../scripts/local-db.mjs";
import { pairs, dateAt } from "./fixtures/trading.mjs";
import {
  BASE_STRATEGY,
  executePlan,
  createPlan,
} from "../backend/domain/trading.js";
import { PaperRepository } from "../backend/storage/paper.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import { ResearchRepository } from "../backend/storage/research.js";
import { CohortRepository } from "../backend/storage/cohorts.js";
import { ShadowAccountRepository } from "../backend/storage/shadow.js";
import {
  proposeImprovement,
  researchStatus,
} from "../backend/services/research.js";
import {
  startSingleForward,
  researchExperimentDetail,
  exportResearchExperiment,
  promoteSingleCandidate,
  rollbackResearchCandidate,
  listResearchExperiments,
} from "../backend/services/walk-forward.js";
import { adoptSingleExperiment } from "../backend/storage/walk-forward.js";
import {
  runTournamentPoll,
  settleTournamentDay,
  runDailyTournament,
} from "../backend/services/strategy-tournament.js";
import { verifyResearchExport } from "../backend/domain/research-verifier.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import { openSession, closeSession } from "../backend/domain/realtime.js";
import { api } from "../backend/routes/api.js";
import {
  pairedComparisonsStreaming,
  pairedLowerBoundTest,
  resampleIndexMatrix,
} from "../backend/domain/research-statistics.js";

const CAPTURE = 100;
async function seed({ forwardDays = 90, badPatch = false } = {}) {
  const DB = localDatabase();
  const env = {
    DB,
    AI_API_KEY: "test-only",
    AI_BASE_URL: "https://api.deepseek.com/v1",
    ALERTS_ENABLED: "false",
  };
  const papers = new RealtimeRepository(env);
  await papers.initialize();
  const base = { ...BASE_STRATEGY };
  await DB.prepare(
    "UPDATE strategy_versions SET params=? WHERE id='baseline-v1'",
  )
    .bind(JSON.stringify(base))
    .run();
  const research = new ResearchRepository(env);
  await research.ensureRegistry();
  await research.savePolicy({ forwardDays });
  const all = pairs(CAPTURE + forwardDays + 4);
  for (const [index, pair] of all.entries()) {
    pair.snapshot.stocks[1].score = 81;
    pair.snapshot.stocks[1].factors.forEach((factor) => (factor.value = 81));
    await DB.prepare(
      "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
    )
      .bind(
        pair.snapshot.date,
        pair.snapshot.createdAt,
        JSON.stringify(pair.snapshot),
      )
      .run();
    if (index >= CAPTURE) continue;
    await DB.prepare(
      "INSERT INTO paper_market_days(trade_date,payload,digest) VALUES(?,?,?)",
    )
      .bind(
        pair.dataset.date,
        JSON.stringify(pair.dataset),
        await digestOf(pair.dataset),
      )
      .run();
  }
  const RealDate = globalThis.Date;
  const frozenTime = `${dateAt(CAPTURE)}T07:15:00.000Z`;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [frozenTime]));
    }
    static now() {
      return RealDate.parse(frozenTime);
    }
  };
  let result;
  try {
    result = await proposeImprovement(papers, env, async () => ({
      patch: badPatch ? { minScore: 78 } : { minScore: 82 },
      rationale: "确定性合成测试，仅验证流程",
    }));
  } finally {
    globalThis.Date = RealDate;
  }
  const account = await papers.account();
  const first = executePlan(account.book, null, all[CAPTURE - 2].dataset);
  const plan = createPlan(
    all[CAPTURE - 1].snapshot,
    first.book,
    base,
    "baseline-v1",
    `${dateAt(CAPTURE - 1)}T07:10:00.000Z`,
  );
  const settled = executePlan(first.book, plan, all[CAPTURE - 1].dataset);
  await DB.prepare(
    "UPDATE paper_accounts SET state=?,revision=revision+1 WHERE id='primary'",
  )
    .bind(JSON.stringify(settled.book))
    .run();
  await papers.savePlan(
    createPlan(
      all[CAPTURE].snapshot,
      settled.book,
      base,
      "baseline-v1",
      `${dateAt(CAPTURE)}T07:10:00.000Z`,
    ),
  );
  return { DB, env, papers, research, all, result, base, forwardDays };
}
async function drive(fixture, { omitOffset = null, changeFees = false } = {}) {
  const { DB, env, papers, base, all, result, forwardDays } = fixture;
  const start = await startSingleForward(env, result.experimentId, {
    now: `${dateAt(CAPTURE)}T07:30:00.000Z`,
  });
  assert.equal(start.scheduled, true, JSON.stringify(start));
  const calendar = {
    dates: all.map((pair) => pair.dataset.date),
    benchmark: [],
  };
  for (let offset = 1; offset <= forwardDays; offset++) {
    const pair = all[CAPTURE + offset - 1],
      date = pair.dataset.date;
    if (changeFees && offset === 2)
      await DB.prepare(
        "UPDATE paper_accounts SET state=json_set(state,'$.feeConfig.commission_min',6) WHERE id='primary'",
      ).run();
    if (offset !== omitOffset) {
      for (const [utc, time, volume] of [
        ["01:31:00", "09:31:00", 8000000],
        ["01:31:10", "09:31:10", 9000000],
        ["01:36:00", "09:36:00", 10000000],
        ["01:36:10", "09:36:10", 11000000],
      ])
        await runTournamentPoll(env, new Date(`${date}T${utc}Z`), {
          providers: {
            calendar,
            quotes: async (codes) =>
              Object.fromEntries(
                codes
                  .filter((code) => pair.dataset.quotes[code])
                  .map((code) => [
                    code,
                    {
                      ...pair.dataset.quotes[code],
                      timestamp: `${date}T${time}+08:00`,
                      volumeShares: volume,
                    },
                  ]),
              ),
          },
        });
    }
    const primary = await papers.account();
    const session =
      (await papers.session(date)) ??
      openSession(primary.book, await papers.plan(primary.book.lastDate), date);
    const primarySettlement = closeSession(primary.book, session, pair.dataset);
    assert.equal(
      await papers.settle(primary.revision, primarySettlement, pair.dataset),
      true,
    );
    await papers.savePlan(
      createPlan(
        all[CAPTURE + offset].snapshot,
        primarySettlement.book,
        base,
        "baseline-v1",
        `${date}T07:10:00.000Z`,
      ),
    );
    if (offset === omitOffset) continue;
    const settled = await settleTournamentDay(env, date, {
      now: `${date}T07:30:00.000Z`,
      calendarDates: [
        dateAt(CAPTURE + offset + 1),
        dateAt(CAPTURE + offset + 2),
      ],
    });
    if (offset === forwardDays)
      return { start, settled, primaryBeforePromotion: primarySettlement.book };
  }
}

test("单候选开户沿用原预算和日期；匹配完整期初账本；重复和并发开户幂等", async () => {
  const fixture = await seed();
  const { DB, env, research, papers, result } = fixture;
  assert.equal(result.status, "AWAITING_SHADOW", JSON.stringify(result));
  const before = await research.getExperiment(result.experimentId);
  const k = (await research.ensureRegistry()).attemptSequence;
  const uses = await research.experimentSamples(result.experimentId);
  const [a, b] = await Promise.all([
    adoptSingleExperiment(env, result.experimentId),
    adoptSingleExperiment(env, result.experimentId),
  ]);
  assert.equal(a.cohortId, b.cohortId);
  assert.equal((await research.ensureRegistry()).attemptSequence, k);
  assert.deepEqual(await research.experimentSamples(result.experimentId), uses);
  assert.deepEqual(
    (await research.getExperiment(result.experimentId)).proposalManifest,
    before.proposalManifest,
  );
  const start = await startSingleForward(env, result.experimentId, {
    now: `${dateAt(CAPTURE)}T07:30:00.000Z`,
  });
  assert.equal(start.scheduled, true);
  assert.equal(
    (await research.getExperiment(result.experimentId)).stage,
    "SHADOWING",
  );
  const status = await researchStatus(env);
  assert.equal(status.activeExperiment.stage, "SHADOWING");
  assert.equal(status.activeExperiment.mode, "SINGLE");
  assert.equal(status.activeExperiment.experimentId, result.experimentId);
  const original = (await papers.account()).book;
  const shadows = await new ShadowAccountRepository(env).accounts({
    cohortId: a.cohortId,
  });
  assert.equal(shadows.length, 4);
  for (const shadow of shadows) assert.deepEqual(shadow.book, original);
  const duplicate = await runDailyTournament(env, dateAt(CAPTURE), {
    now: `${dateAt(CAPTURE)}T07:35:00.000Z`,
  });
  assert.equal(duplicate.settle.status, "CAPTURE_DAY");
  await assert.rejects(
    () => promoteSingleCandidate(env, result.experimentId),
    /没有通过|没有.*冠军|没有.*可启用/,
  );
  DB.close();
});

test("90 日单候选闭环：匹配账本、完整轮次、独立重放、自动启用、受控回退", async () => {
  const fixture = await seed();
  const { DB, env, papers, research, result } = fixture;
  const before = structuredClone((await papers.account()).book);
  const { settled, primaryBeforePromotion } = await drive(fixture);
  const report = settled.evaluation;
  assert.ok(report.champion, JSON.stringify(report.verdicts));
  assert.equal(
    report.promotion?.promoted,
    true,
    JSON.stringify(report.promotion),
  );
  assert.equal(
    (await research.getExperiment(result.experimentId)).stage,
    "PROMOTED",
  );
  const after = (await papers.account()).book;
  assert.deepEqual(
    { ...after, activeStrategy: before.activeStrategy },
    primaryBeforePromotion,
    "启用不复制影子账户也不重置盈亏",
  );
  const bundle = await exportResearchExperiment(env, result.experimentId);
  const audit = await verifyResearchExport(bundle);
  assert.equal(audit.eligibleForPromotion, true, JSON.stringify(audit));
  writeFileSync(
    "/tmp/single-candidate-research-verified.json",
    JSON.stringify(bundle),
  );
  const forged = structuredClone(bundle);
  const fakeAccount = forged.accounts.find((a) => a.kind === "CANDIDATE");
  fakeAccount.equities[0].payload.equityCents += 1000000;
  fakeAccount.equities[0].digest = await digestOf(
    fakeAccount.equities[0].payload,
  );
  await assert.rejects(() => verifyResearchExport(forged), /重放不一致/);
  const duplicate = await promoteSingleCandidate(env, result.experimentId);
  assert.equal(duplicate.duplicate, true);
  const frozenPlan = await papers.plan(dateAt(CAPTURE));
  const account = await papers.account();
  // 切换期间已经存在的盈亏和风险状态必须保留，不从期初或父策略影子账本恢复。
  const live = {
    ...account.book,
    cashCents: account.book.cashCents - 12345,
    equityCents: account.book.equityCents - 12345,
    realizedPnlCents: account.book.realizedPnlCents - 12345,
  };
  await DB.prepare(
    "UPDATE paper_accounts SET state=?,revision=revision+1 WHERE id='primary'",
  )
    .bind(JSON.stringify(live))
    .run();
  const realBatch = DB.batch.bind(DB);
  DB.batch = async (statements) => {
    await DB.prepare(
      "UPDATE paper_accounts SET revision=revision+1 WHERE id='primary'",
    ).run();
    return realBatch(statements);
  };
  await assert.rejects(
    () => rollbackResearchCandidate(env, result.experimentId, "模拟 CAS 竞争"),
    /并发更新/,
  );
  assert.equal(
    (
      await DB.prepare(
        "SELECT COUNT(*) n FROM strategy_switch_events WHERE event_type='ROLLBACK'",
      ).first()
    ).n,
    0,
  );
  assert.equal(
    (await research.getExperiment(result.experimentId)).stage,
    "PROMOTED",
  );
  DB.batch = realBatch;
  const rolled = await rollbackResearchCandidate(
    env,
    result.experimentId,
    "合成测试确认回退保留已发生亏损",
  );
  assert.equal(rolled.rolledBack, true);
  assert.deepEqual((await papers.account()).book, {
    ...live,
    activeStrategy: before.activeStrategy,
  });
  assert.deepEqual(await papers.plan(dateAt(CAPTURE)), frozenPlan);
  assert.equal(
    (await research.getExperiment(result.experimentId)).stage,
    "ROLLED_BACK",
  );
  assert.equal(
    (await rollbackResearchCandidate(env, result.experimentId, "重复请求"))
      .duplicate,
    true,
  );
  await assert.rejects(
    () => promoteSingleCandidate(env, result.experimentId),
    /回退|不符合启用/,
  );
  assert.equal(
    (await researchExperimentDetail(env, result.experimentId)).canRollback,
    false,
  );
  const switches = (
    await DB.prepare(
      "SELECT event_type FROM strategy_switch_events ORDER BY account_revision",
    ).all()
  ).results;
  assert.deepEqual(
    switches.map((row) => row.event_type),
    ["PROMOTE", "ROLLBACK"],
  );
  DB.close();
});

test("研究 API：方法、同源、阶段闸门、详情、分页与失败记录", async () => {
  const fixture = await seed({ badPatch: true });
  const { DB, env, result } = fixture;
  assert.equal(result.status, "REJECTED");
  const prefix = `http://localhost/api/research/experiments/${result.experimentId}`;
  assert.equal((await api(new Request(`${prefix}/promote`), env)).status, 405);
  assert.equal(
    (
      await api(
        new Request(`${prefix}/start`, {
          method: "POST",
          headers: { Origin: "https://example.test" },
          body: "{}",
        }),
        env,
      )
    ).status,
    403,
  );
  assert.equal((await api(new Request(prefix), env)).status, 200);
  const page = await listResearchExperiments(env, { limit: 1 });
  assert.equal(page.experiments[0].stage, "REJECTED");
  await assert.rejects(
    () => listResearchExperiments(env, { limit: 51 }),
    /分页/,
  );
  const old = await api(
    new Request("http://localhost/api/paper/activate", {
      method: "POST",
      body: JSON.stringify({ id: result.experimentId }),
    }),
    env,
  );
  assert.equal(old.status, 503);
  DB.close();
});

test("自动晋级 CAS 冲突不留状态或事件，人工重试同一报告只能切换一次", async () => {
  const fixture = await seed();
  const { DB, env, result, research } = fixture;
  const batch = DB.batch.bind(DB);
  let interfered = false;
  DB.batch = async (statements) => {
    const state = statements[0]?.args?.[0];
    if (
      !interfered &&
      typeof state === "string" &&
      state.startsWith('{"initialCashCents"') &&
      JSON.parse(state).activeStrategy === result.experimentId
    ) {
      interfered = true;
      await DB.prepare(
        "UPDATE paper_accounts SET revision=revision+1 WHERE id='primary'",
      ).run();
    }
    return batch(statements);
  };
  const { settled } = await drive(fixture);
  DB.batch = batch;
  assert.equal(interfered, true);
  assert.equal(settled.evaluation.promotion.promoted, false);
  assert.equal(
    (await research.getExperiment(result.experimentId)).stage,
    "APPROVED",
  );
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) n FROM strategy_switch_events").first())
      .n,
    0,
  );
  assert.equal(
    (await fixture.papers.account()).book.activeStrategy,
    "baseline-v1",
  );
  const promoted = await promoteSingleCandidate(env, result.experimentId);
  assert.equal(promoted.promoted, true);
  assert.equal(
    (await research.getExperiment(result.experimentId)).stage,
    "PROMOTED",
  );
  assert.equal(
    (await promoteSingleCandidate(env, result.experimentId)).duplicate,
    true,
  );
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) n FROM strategy_switch_events").first())
      .n,
    1,
  );
  DB.close();
});

test("窗口缺失不补长，费用变化判失效；两个完整失败周期保持父策略", async () => {
  for (const options of [{ omitOffset: 3 }, { changeFees: true }]) {
    const fixture = await seed({ forwardDays: 20 });
    const { DB, env, research, result } = fixture;
    const { settled, start } = await drive(fixture, options);
    const detail = await researchExperimentDetail(env, result.experimentId);
    assert.equal(detail.forward.cohort.forwardManifest.windowDates.length, 20);
    assert.equal(
      detail.forward.cohort.forwardManifest.windowDates.at(-1),
      dateAt(CAPTURE + 20),
    );
    assert.equal(settled.evaluation.champion, null);
    assert.equal(settled.evaluation.promotion, null);
    assert.equal(
      (await fixture.papers.account()).book.activeStrategy,
      "baseline-v1",
    );
    assert.equal(
      await research.activeExperiment(),
      null,
      "原定窗口结束才释放名额",
    );
    assert.equal(
      (await research.getExperiment(result.experimentId)).stage,
      options.changeFees ? "INVALIDATED" : "INCONCLUSIVE",
    );
    assert.equal(
      (await new CohortRepository(env).getCohort(start.cohortId)).stage,
      "CLOSED",
    );
    await assert.rejects(
      () => promoteSingleCandidate(env, result.experimentId),
      /没有.*冠军|没有.*可启用/,
    );
    DB.close();
  }
});

test("旧候选不能事后补压力规则；捕获日缺失评分时等待；研究政策修改不能绕过活动窗口", async () => {
  const fixture = await seed();
  const { DB, env, research, result } = fixture;
  const blocked = await api(
    new Request("http://localhost/api/research/policy", {
      method: "POST",
      body: JSON.stringify({ forwardDays: 60 }),
    }),
    env,
  );
  assert.equal(blocked.status, 409);
  await DB.prepare("DELETE FROM snapshots WHERE trade_date=?")
    .bind(dateAt(CAPTURE))
    .run();
  const waiting = await startSingleForward(env, result.experimentId, {
    now: `${dateAt(CAPTURE)}T07:30:00.000Z`,
  });
  assert.equal(waiting.scheduled, false);
  assert.match(waiting.reason, /评分快照缺失/);
  assert.ok(await research.activeExperiment());
  DB.close();
  const legacy = await seed();
  await legacy.DB.prepare(
    "UPDATE research_experiments SET reservation_payload=json_remove(reservation_payload,'$.singleForward') WHERE id=?",
  )
    .bind(legacy.result.experimentId)
    .run();
  const invalid = await adoptSingleExperiment(
    legacy.env,
    legacy.result.experimentId,
  );
  assert.equal(invalid.invalidated, true);
  assert.equal(
    (await legacy.research.getExperiment(legacy.result.experimentId)).stage,
    "INVALIDATED",
  );
  assert.equal(await legacy.research.activeExperiment(), null);
  assert.equal(
    (await legacy.DB.prepare("SELECT COUNT(*) n FROM strategy_cohorts").first())
      .n,
    0,
  );
  legacy.DB.close();
});

test("统计分片与既有完整矩阵完全一致，并在计算期间让出事件循环", async () => {
  const dates = Array.from({ length: 30 }, (_, i) => dateAt(i));
  const memberReturns = dates.map((_, i) => Math.sin(i) * 0.005 + 0.002);
  const comparisons = {
    againstParent: dates.map((_, i) => Math.cos(i) * 0.004),
    againstBaseline: dates.map(() => 0.001),
  };
  const args = {
    dates,
    blockLength: 5,
    resamples: 10000,
    seedInput: { experiment: "single-deterministic-test" },
    alphaPerComparison: 0.0125,
  };
  const matrix = await resampleIndexMatrix(args);
  let yielded = false;
  setTimeout(() => (yielded = true), 0);
  const streamed = await pairedComparisonsStreaming({
    ...args,
    memberReturns,
    comparisons,
  });
  assert.equal(yielded, true);
  for (const [key, comparisonReturns] of Object.entries(comparisons))
    assert.deepEqual(
      streamed[key],
      pairedLowerBoundTest({
        memberReturns,
        comparisonReturns,
        matrix,
        alphaPerComparison: args.alphaPerComparison,
      }),
    );
});
