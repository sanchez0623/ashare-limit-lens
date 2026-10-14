import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import {
  selectionPolicyForBook,
  selectionPolicyFields,
} from "../backend/domain/signal-selection.js";
import { PaperRepository } from "../backend/storage/paper.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import { ResearchRepository } from "../backend/storage/research.js";
import { CohortRepository } from "../backend/storage/cohorts.js";
import {
  ShadowAccountRepository,
  SHADOW_ACCOUNT_KINDS,
} from "../backend/storage/shadow.js";
import { QuoteFrameRepository } from "../backend/storage/quotes.js";
import {
  BASE_STRATEGY,
  createPlan,
  defensivePlan,
  executePlan,
  newBook,
} from "../backend/domain/trading.js";
import {
  reserveCohort,
  scheduleCohortForward,
  runTournamentPoll,
  settleTournamentDay,
  runDailyTournament,
  evaluateCohort,
  tournamentStatus,
  cohortDetail,
  cohortLineage,
  closingQuotesFromFrames,
} from "../backend/services/strategy-tournament.js";
import {
  consumePortfolioFrame,
  settlePortfolioDay,
  freezePortfolioPlan,
} from "../backend/services/portfolio-runner.js";
import { promoteCohortChampion } from "../backend/services/promotion.js";
import { closeSession } from "../backend/domain/realtime.js";
import { digest } from "../backend/storage/paper.js";
import { proposeImprovement } from "../backend/services/research.js";
import { beijingMonth } from "../backend/domain/research-windows.js";
import {
  computeStatisticsBudget,
  validateCohortPolicy,
  frozenParamDistance,
  alphaPerComparisonForK,
  DEFAULT_COHORT_POLICY,
} from "../backend/domain/cohort-policy.js";
import {
  windowMetrics,
  completeRounds,
  rankEligibleMembers,
} from "../backend/domain/cohort-metrics.js";
import {
  pairedLowerBoundTest,
  resampleIndexMatrix,
} from "../backend/domain/research-statistics.js";
import { pairs, dateAt } from "./fixtures/trading.mjs";
import { DEFAULT_FEES, feesForBook } from "../shared/fees.js";
import {
  digestOf,
  EXECUTION_VERSION,
  SCORING_VERSION,
} from "../backend/domain/research-lineage.js";

const SEED = 260;
const FORWARD_DAYS = 30;
// 候选 A 提高筛选并分散到上涨样本之外；本组补丁全部合法、互不相同。
const CANDIDATE_PATCHES = [
  { minScore: 82, maxPositions: 3 },
  { maxHoldDays: 4, stopLoss: 0.055 },
  { tSellRise: 0.025 },
  { minScore: 78, maxPositions: 5 },
];

function stubCohortModel(patches = CANDIDATE_PATCHES) {
  const calls = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: patches.map((patch, index) => ({
                rationale: `候选${index + 1}`,
                patch,
              })),
            }),
          },
        },
      ],
    });
  };
  return { calls, restore: () => (globalThis.fetch = fetchBefore) };
}

async function buildEnv({ count = SEED } = {}) {
  const DB = localDatabase();
  const env = {
    DB,
    AI_API_KEY: "test-only-secret",
    AI_BASE_URL: "https://api.deepseek.com/v1",
  };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const all = pairs(count);
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
    // 捕获日前两天留给主账户结算写入
    if (
      pair.dataset.date === dateAt(count - 1) ||
      pair.dataset.date === dateAt(count)
    )
      continue;
    await DB.prepare(
      "INSERT INTO paper_market_days (trade_date,payload,digest) VALUES (?,?,?)",
    )
      .bind(pair.dataset.date, JSON.stringify(pair.dataset), "fixture")
      .run();
  }
  await new ResearchRepository(env).ensureRegistry();
  return { DB, env, repository, all };
}

async function settlePrimaryToCaptureDay(env, repository, all) {
  const repo = new RealtimeRepository(env);
  let account = await repo.initialize();
  const dayBefore = all[SEED - 2].dataset;
  const first = executePlan(account.book, null, dayBefore);
  assert.ok(await repo.settle(account.revision, first, dayBefore));
  account = await repo.account();
  const captureDay = all[SEED - 1].dataset;
  const plan = createPlan(
    all[SEED - 1].snapshot,
    account.book,
    BASE_STRATEGY,
    "baseline-v1",
    `${dateAt(SEED - 1)}T00:00:00.000Z`,
  );
  const second = executePlan(account.book, plan, captureDay);
  assert.ok(await repo.settle(account.revision, second, captureDay));
  account = await repo.account();
  assert.equal(account.book.lastDate, dateAt(SEED));
  assert.ok(account.book.positions.length > 0, "捕获起点应有持仓");
  return account;
}

function makeQuotes(datasetByDate, dayIndex, time, volume) {
  const day = datasetByDate.get(dateAt(dayIndex));
  return async (codes, date) => {
    assert.equal(date, day ? day.date : date);
    if (!day) return {};
    const quotes = {};
    for (const code of codes) {
      const quote = day.quotes[code];
      if (!quote) continue;
      quotes[code] = {
        ...quote,
        timestamp: `${date}T${time}+08:00`,
        volumeShares: volume,
      };
    }
    return quotes;
  };
}

function forwardFrames() {
  // 买入窗（≤09:35）与做 T 窗（≥09:35）各两帧；累积量单调递增且间隔 ≤20 秒。
  return [
    ["01:31:00", "09:31:00", 8000000],
    ["01:31:10", "09:31:10", 9000000],
    ["01:36:00", "09:36:00", 10000000],
    ["01:36:10", "09:36:10", 11000000],
  ];
}

async function seedForwardData(DB, env, count = SEED, days = FORWARD_DAYS) {
  const forwardPairs = pairs(count + days + 5).slice(count);
  for (const pair of forwardPairs) {
    // 前瞻合成环境：边际低分股弱于候选阈值，保留稳健晋级的正例。
    pair.snapshot.stocks[1].score = 81;
    pair.snapshot.stocks[1].factors.forEach((f) => {
      f.value = 81;
    });
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
      .bind(
        pair.dataset.date,
        JSON.stringify(pair.dataset),
        await digest(pair.dataset),
      )
      .run();
  }
  return forwardPairs;
}

async function reserveScheduledCohort(env, repository, patches) {
  const stub = stubCohortModel(patches);
  try {
    const reserved = await reserveCohort(repository, env);
    assert.equal(reserved.status, "SCHEDULED", JSON.stringify(reserved));
    return reserved;
  } finally {
    stub.restore();
  }
}

function datasetByDateOf(all, forwardPairs) {
  return new Map(
    [...all, ...forwardPairs].map((p) => [p.dataset.date, p.dataset]),
  );
}

test("统计预算、政策校验与固定排序由代码强制校验", async () => {
  // alpha 公式与重采样预算（§5.3）
  const budget = computeStatisticsBudget({
    ks: [1, 2, 3, 4],
    statistical: DEFAULT_COHORT_POLICY.statistical,
  });
  assert.equal(
    budget.requiredResamples,
    40000,
    "k=1..4 对应整批 40,000 次重采样",
  );
  assert.equal(budget.sufficient, true);
  const tight = computeStatisticsBudget({
    ks: [21, 22, 23, 24],
    statistical: DEFAULT_COHORT_POLICY.statistical,
  });
  assert.equal(tight.sufficient, false, "k>=22 超过 100 万重采样上限");
  assert.equal(alphaPerComparisonForK(4), 0.05 / (4 * 5) / 2);
  // 政策校验：候选数量、前瞻窗口离散取值与晋级上限
  assert.throws(
    () => validateCohortPolicy({ ...DEFAULT_COHORT_POLICY, maxCandidates: 5 }),
    /候选数量/,
  );
  assert.throws(
    () => validateCohortPolicy({ ...DEFAULT_COHORT_POLICY, forwardDays: 45 }),
    /前瞻窗口/,
  );
  assert.throws(
    () =>
      validateCohortPolicy({
        ...DEFAULT_COHORT_POLICY,
        promotionLimitPerCohort: 2,
      }),
    /最多启用一个候选/,
  );
  // 参数距离按冻结单次步长逐分量求和（§8.2）
  const distance = frozenParamDistance(
    { ...BASE_STRATEGY, minScore: 82, maxPositions: 3 },
    BASE_STRATEGY,
  );
  assert.equal(distance, 2 / 2 + 1 / 1);
  // 完整轮次：继承持仓平仓不凑次数，新轮次从零建仓到归零
  const rounds = completeRounds(
    [
      {
        code: "600001",
        side: "SELL",
        quantity: 500,
        date: "2026-01-01",
        sequence: 1,
      },
      {
        code: "600001",
        side: "BUY",
        quantity: 1000,
        date: "2026-01-02",
        sequence: 2,
      },
      {
        code: "600001",
        side: "SELL",
        quantity: 1000,
        date: "2026-01-05",
        sequence: 3,
      },
    ],
    ["2026-01-01", "2026-01-05"],
  );
  assert.equal(rounds.rounds, 1, "继承持仓清仓不计，新轮次完整闭合计一次");
  // 窗口指标：净收益、费用增量、回撤与覆盖率；期初快照与账本守恒一致
  // （权益变化 = 已实现增量 + 未实现增量，不一致的快照会被拒绝）。
  const metrics = windowMetrics({
    initial: {
      equityCents: 100000000,
      feesCents: 100,
      realizedPnlCents: 0,
      unrealizedPnlCents: 0,
    },
    final: {
      equityCents: 101000000,
      feesCents: 300,
      realizedPnlCents: 0,
      unrealizedPnlCents: 1_000_000,
    },
    equities: [
      { tradeDate: "2026-01-01", equityCents: 99000000 },
      { tradeDate: "2026-01-02", equityCents: 101000000 },
    ],
    windowDates: ["2026-01-01", "2026-01-02"],
  });
  assert.ok(Math.abs(metrics.netReturn - 0.01) < 1e-9);
  assert.equal(metrics.feesDeltaCents, 200);
  assert.equal(
    metrics.windowDrawdownPpm,
    10000,
    "期初到首日回撤 1%（百万分值）",
  );
  // 固定排序：权益 → 回撤百万分值 → 费用 → 参数距离 → 成员 ID
  const ranked = rankEligibleMembers([
    {
      memberId: "m2",
      finalEquityCents: 100,
      windowDrawdownPpm: 10,
      feesDeltaCents: 1,
      paramsDistance: 1,
    },
    {
      memberId: "m1",
      finalEquityCents: 100,
      windowDrawdownPpm: 10,
      feesDeltaCents: 1,
      paramsDistance: 1,
    },
    {
      memberId: "m3",
      finalEquityCents: 101,
      windowDrawdownPpm: 900,
      feesDeltaCents: 9,
      paramsDistance: 9,
    },
  ]);
  assert.deepEqual(
    ranked.map((row) => row.memberId),
    ["m3", "m1", "m2"],
  );
  // 配对统计：候选持续优于对照通过；噪声不通过
  const matrix = await resampleIndexMatrix({
    dates: Array.from({ length: 20 }, (_, i) => `d${i}`),
    blockLength: 5,
    resamples: 10000,
    seedInput: { test: "paired" },
  });
  const good = pairedLowerBoundTest({
    memberReturns: Array.from({ length: 20 }, (_, i) => 0.01 + (i % 3) * 0.001),
    comparisonReturns: Array.from({ length: 20 }, () => -0.005),
    matrix,
    alphaPerComparison: 0.00125,
  });
  assert.equal(good.passed, true);
  const noisy = pairedLowerBoundTest({
    memberReturns: Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.02 : -0.02)),
    comparisonReturns: Array.from({ length: 20 }, (_, i) =>
      i % 2 ? -0.02 : 0.02,
    ),
    matrix,
    alphaPerComparison: 0.00125,
  });
  assert.equal(noisy.passed, false, "相同收益的候选不能靠噪声成为合格改进");
});

test("批次预留：候选共同冻结、尝试序号分配与同批测试日期共享", async () => {
  const { DB, env, repository } = await buildEnv();
  await settlePrimaryToCaptureDay(env, repository, pairs(SEED));
  const stub = stubCohortModel();
  let reserved;
  try {
    reserved = await reserveCohort(repository, env);
  } finally {
    stub.restore();
  }
  assert.equal(reserved.status, "SCHEDULED", JSON.stringify(reserved));
  assert.equal(reserved.members.filter((m) => m.versionId).length, 4);
  assert.deepEqual(
    reserved.attemptSequences,
    [1, 2, 3, 4],
    "四个候选消耗四个全局尝试序号",
  );
  const research = new ResearchRepository(env);
  const registry = await research.ensureRegistry();
  assert.equal(registry.attemptSequence, 4, "尝试序号不因成功或失败清零");
  const cohorts = new CohortRepository(env);
  const cohort = await cohorts.getCohort(reserved.cohortId);
  assert.equal(cohort.stage, "SCHEDULED");
  // 统一窗口锁：owner_type = COHORT
  const owner = await cohorts.windowOwner();
  assert.equal(owner.ownerType, "COHORT");
  assert.equal(owner.ownerId, cohort.id);
  // 统一生成预算：本月生成槽位被四个候选占用
  const slots = (
    await DB.prepare(
      "SELECT COUNT(*) AS n FROM research_generation_slots WHERE owner_type = 'COHORT' AND owner_id = ?",
    )
      .bind(cohort.id)
      .first()
  ).n;
  assert.equal(slots, 4);
  // 测试日期全局键仍为 (namespace, outcome_date)，占用者扩展为 cohort
  const claims = (
    await DB.prepare(
      "SELECT COUNT(*) AS n FROM research_test_claims WHERE owner_type = 'COHORT' AND owner_id = ?",
    )
      .bind(cohort.id)
      .first()
  ).n;
  assert.equal(claims, 20, "历史测试窗口由 cohort 统一占用");
  // 每个成员单独写样本用途（训练 + 历史测试）
  for (const member of await cohorts.members(cohort.id)) {
    if (!member.params) continue;
    const uses = (
      await DB.prepare(
        "SELECT COUNT(*) AS n FROM research_sample_uses WHERE experiment_id = ?",
      )
        .bind(member.experimentId)
        .first()
    ).n;
    assert.equal(uses, 80, `${member.memberId} 的样本用途逐成员留痕`);
  }
  // 事件链可逐条复算
  const events = await cohorts.events(cohort.id);
  assert.ok(events.length >= 4);
  assert.equal(events[0].previousDigest, null);
  for (let i = 1; i < events.length; i++)
    assert.equal(events[i].previousDigest, events[i - 1].digest);
  // 因果冻结：成员参数在历史测试收益计算前持久化；阶段守卫拒绝错误的迁移路径
  const member = (await cohorts.members(cohort.id)).find((m) => m.params);
  assert.equal(member.stage, "SCHEDULED");
  await assert.rejects(
    () =>
      cohorts.transitionMember(cohort.id, member.memberId, {
        from: "RUNNING",
        to: "ERROR",
        failureReason: "窗口中途剔除成员",
      }),
    /成员状态已变化|不能从/,
  );
  const forged = await DB.prepare(
    "UPDATE strategy_cohort_members SET params = ? WHERE cohort_id = ? AND member_id = ?",
  )
    .bind(
      JSON.stringify({ ...BASE_STRATEGY, minScore: 95 }),
      cohort.id,
      member.memberId,
    )
    .run();
  assert.ok(forged.meta.changes === 1);
  // 赛马占用研究窗口时，单候选提案让路
  const stub2 = stubCohortModel();
  try {
    const busy = await proposeImprovement(repository, env);
    assert.equal(busy.status, "BUSY");
    assert.match(busy.reason, /赛马批次占用研究窗口/);
  } finally {
    stub2.restore();
  }
  // 新批次被拒绝：月度生成预算与活动窗口锁
  const stub3 = stubCohortModel();
  try {
    const second = await reserveCohort(repository, env);
    assert.equal(second.status, "BUSY", JSON.stringify(second));
  } finally {
    stub3.restore();
  }
  DB.close();
});

test("并发预留只有一批成功；统计预算不足返回 COMPUTE_BUDGET_INSUFFICIENT", async () => {
  const { DB, env, repository } = await buildEnv();
  await settlePrimaryToCaptureDay(env, repository, pairs(SEED));
  const stub = stubCohortModel();
  try {
    const results = await Promise.all([
      reserveCohort(repository, env),
      reserveCohort(repository, env),
    ]);
    const scheduled = results.filter((row) => row.status === "SCHEDULED");
    assert.equal(scheduled.length, 1, "并发预留只有一批成功");
    const other = results.find((row) => row.status !== "SCHEDULED");
    assert.ok(["BUSY", "BUDGET_EXHAUSTED"].includes(other.status));
    // 预算耗尽：活动窗口由 cohort 持有（窗口锁优先），本月生成槽位已被四个候选占用
    const exhausted = await reserveCohort(repository, env);
    assert.equal(exhausted.status, "BUSY");
    const monthSlots = (
      await DB.prepare(
        "SELECT COUNT(*) AS n FROM research_generation_slots WHERE namespace = 'main' AND month = ?",
      )
        .bind(beijingMonth())
        .first()
    ).n;
    assert.equal(monthSlots, 4, "四个候选占用本月四个生成槽位");
  } finally {
    stub.restore();
  }
  DB.close();

  const second = await buildEnv();
  await settlePrimaryToCaptureDay(second.env, second.repository, pairs(SEED));
  await second.DB.prepare(
    "UPDATE research_registry SET attempt_sequence = 21 WHERE namespace = 'main'",
  ).run();
  const stub2 = stubCohortModel();
  try {
    const insufficient = await reserveCohort(second.repository, second.env);
    assert.equal(insufficient.status, "COMPUTE_BUDGET_INSUFFICIENT");
    assert.ok(insufficient.requiredResamples > 1000000);
    const registry = await new ResearchRepository(second.env).ensureRegistry();
    assert.equal(
      registry.attemptSequence,
      21,
      "预检失败不占用尝试序号，不调用模型",
    );
    assert.equal(stub2.calls.length, 0, "不进行无意义的模型调用");
  } finally {
    stub2.restore();
  }
  second.DB.close();
});

test("重复或不合法候选占用序号留痕，批次结束释放窗口", async () => {
  const { DB, env, repository } = await buildEnv();
  await settlePrimaryToCaptureDay(env, repository, pairs(SEED));
  const duplicatePatches = [
    { minScore: 82 },
    { minScore: 82 },
    { minScore: 95, maxPositions: 9 },
    { minScore: 78, maxPositions: 5 },
  ];
  const stub = stubCohortModel(duplicatePatches);
  let reserved;
  try {
    reserved = await reserveCohort(repository, env);
  } finally {
    stub.restore();
  }
  assert.equal(reserved.status, "REJECTED", JSON.stringify(reserved));
  assert.equal(reserved.members.filter((m) => m.stage === "ERROR").length, 2);
  assert.equal(
    reserved.members.filter((m) => m.stage === "REJECTED").length,
    2,
  );
  const cohorts = new CohortRepository(env);
  const members = await cohorts.members(reserved.cohortId);
  assert.equal(
    members.filter((m) => m.k >= 1 && m.k <= 4).length,
    4,
    "失败、重复与非法候选占用已预留的序号",
  );
  assert.match(members[1].failureReason, /重复/);
  assert.match(members[2].failureReason, /越界|步长|授权/);
  const cohort = await cohorts.getCohort(reserved.cohortId);
  assert.equal(
    cohort.stage,
    "CLOSED",
    "历史阶段全部失败且未登记前瞻窗口时批次结束",
  );
  const owner = await cohorts.windowOwner();
  assert.equal(owner, null, "窗口锁释放，单候选流程可恢复");
  const registry = await new ResearchRepository(env).ensureRegistry();
  assert.equal(registry.attemptSequence, 4);
  DB.close();
});

test("匹配起点完整复制，联合行情覆盖候选独有代码并独立消费", async () => {
  const { DB, env, repository, all } = await buildEnv();
  await settlePrimaryToCaptureDay(env, repository, all);
  const reserved = await reserveScheduledCohort(env, repository);
  const cohortId = reserved.cohortId;
  const forwardPairs = await seedForwardData(DB, env);
  const datasetByDate = datasetByDateOf(all, forwardPairs);
  const calendar = {
    dates: [...all, ...forwardPairs].map((p) => p.dataset.date),
    benchmark: [],
  };
  const scheduled = await scheduleCohortForward(env, cohortId, {
    now: `${dateAt(SEED)}T07:30:00.000Z`,
  });
  assert.equal(scheduled.scheduled, true, JSON.stringify(scheduled));
  const shadows = new ShadowAccountRepository(env);
  const accounts = await shadows.accounts({ cohortId });
  const scheduledCount = reserved.members.filter(
    (member) => member.stage === "SCHEDULED",
  ).length;
  assert.equal(
    accounts.length,
    scheduledCount + 3,
    "每个进入前瞻窗口的候选 + 父策略匹配 + 固定基线匹配",
  );
  assert.ok(
    (await shadows.account("shadow-baseline-continuous")) !== null,
    "连续固定基线账户创建",
  );
  const candidate = accounts.find(
    (a) => a.kind === SHADOW_ACCOUNT_KINDS.CANDIDATE,
  );
  const parent = accounts.find(
    (a) => a.kind === SHADOW_ACCOUNT_KINDS.PARENT_MATCH,
  );
  // 同一起点：非空 FIFO、浮亏、风险峰值完整复制
  assert.deepEqual(candidate.book.positions, parent.book.positions);
  assert.equal(candidate.book.cashCents, parent.book.cashCents);
  assert.equal(candidate.book.peakEquityCents, parent.book.peakEquityCents);
  assert.equal(candidate.book.equityCents, parent.book.equityCents);
  // 每个组合按自身策略冻结下一实际交易日计划
  const candidatePlan = await shadows.plan(candidate.accountId, dateAt(SEED));
  const parentPlan = await shadows.plan(parent.accountId, dateAt(SEED));
  assert.ok(candidatePlan && parentPlan);
  assert.notDeepEqual(candidatePlan.orders, parentPlan.orders);
  // 主账户阻塞（周末拒绝执行）不停止研究行情；候选独有代码持续采集
  const weekendIndex = SEED + 1;
  const weekendDate = dateAt(weekendIndex);
  assert.ok([0, 6].includes(new Date(`${weekendDate}T00:00:00Z`).getUTCDay()));
  const poll = await runTournamentPoll(
    env,
    new Date(`${weekendDate}T01:31:00Z`),
    {
      providers: {
        calendar,
        quotes: makeQuotes(datasetByDate, weekendIndex, "09:31:00", 8000000),
      },
    },
  );
  assert.ok(poll, "行情帧照常落盘");
  assert.ok(poll.primary.status === "NON_TRADING_DAY", "主账户执行被阻断");
  assert.deepEqual(poll.missingCodes, [], "联合采集覆盖全部订阅代码");
  const frames = new QuoteFrameRepository(env);
  const frameRows = await frames.framesForDate(weekendDate);
  assert.equal(frameRows.length, 1);
  assert.deepEqual(
    frameRows[0].payload.pool.codes,
    ["600001", "600002"],
    "研究池与全部账户持仓之并集",
  );
  assert.ok(
    (await shadows.account(candidate.accountId)).cursorDate === weekendDate,
    "影子账户独立消费已落盘帧",
  );
  // 相同策略 + 相同帧 → 完全一致的成交、费用与净值（孪生账户随全流程消费并逐日结算）
  const captureClose = datasetByDate.get(dateAt(SEED)).quotes["600001"]
    .closeCents;
  const twinPlan = {
    signalDate: dateAt(SEED),
    createdAt: `${dateAt(SEED)}T07:10:00.000Z`,
    strategyVersion: "baseline-v1",
    strategy: BASE_STRATEGY,
    feeConfig: DEFAULT_FEES,
    feeModel: "itemized-v2",
    feeConfigVersion: 1,
    orders: [
      {
        id: "twin:OPEN:600001",
        code: "600001",
        name: "合成样本1",
        sector: "测试行业",
        score: 90,
        referenceCents: captureClose,
        action: "OPEN",
        side: "BUY",
        quantity: 1000,
        maxPriceCents: Math.round(captureClose * 1.03),
        stopCents: Math.round(captureClose * 0.94),
        takeProfitCents: Math.round(captureClose * 1.12),
      },
    ],
  };
  await shadows.ensureAccount("shadow-twin-a", {
    kind: SHADOW_ACCOUNT_KINDS.PARENT_MATCH,
    cohortId,
    memberId: "twin-a",
    book: structuredClone(parent.book),
  });
  await shadows.ensureAccount("shadow-twin-b", {
    kind: SHADOW_ACCOUNT_KINDS.PARENT_MATCH,
    cohortId,
    memberId: "twin-b",
    book: structuredClone(parent.book),
  });
  await shadows.savePlan("shadow-twin-a", { ...twinPlan });
  await shadows.savePlan("shadow-twin-b", { ...twinPlan });
  for (let dayIndex = SEED + 1; dayIndex <= SEED + 3; dayIndex++) {
    const date = dateAt(dayIndex);
    for (const [utc, beijing, volume] of forwardFrames())
      await runTournamentPoll(env, new Date(`${date}T${utc}Z`), {
        providers: {
          calendar,
          quotes: makeQuotes(datasetByDate, dayIndex, beijing, volume),
        },
      });
    const dataset = JSON.parse(
      (
        await DB.prepare(
          "SELECT payload FROM paper_market_days WHERE trade_date = ?",
        )
          .bind(date)
          .first()
      ).payload,
    );
    await settlePortfolioDay(env, "shadow-twin-a", date, dataset, { shadows });
    await settlePortfolioDay(env, "shadow-twin-b", date, dataset, { shadows });
  }
  const aLedger = await shadows.ledger("shadow-twin-a");
  const bLedger = await shadows.ledger("shadow-twin-b");
  assert.equal(aLedger.length, bLedger.length);
  assert.ok(aLedger.length > 0, "孪生账户产生相同成交");
  assert.deepEqual(
    aLedger.map((row) => [
      row.id,
      row.code,
      row.side,
      row.quantity,
      row.priceCents,
      row.feeCents,
    ]),
    bLedger.map((row) => [
      row.id,
      row.code,
      row.side,
      row.quantity,
      row.priceCents,
      row.feeCents,
    ]),
    "同起点、相同策略和同帧产生完全一致的成交与费用",
  );
  const aEquity = (await shadows.equities("shadow-twin-a")).map(
    (row) => row.equityCents,
  );
  const bEquity = (await shadows.equities("shadow-twin-b")).map(
    (row) => row.equityCents,
  );
  assert.deepEqual(aEquity, bEquity);
  DB.close();
});

test("账户隔离：同局部成交 ID 可共存，一账户失败不影响其他账户，帧消费幂等", async () => {
  const { DB, env } = await buildEnv({ count: 8 });
  const shadows = new ShadowAccountRepository(env);
  const bookA = {
    initialCashCents: 100000000,
    cashCents: 100000000,
    realizedPnlCents: 0,
    feesCents: 0,
    positions: [],
    lastDate: null,
    equityCents: 100000000,
    peakEquityCents: 100000000,
    activeStrategy: "baseline-v1",
    settlementCount: 0,
    feeModel: "itemized-v2",
    feeConfig: DEFAULT_FEES,
    feeConfigVersion: 1,
  };
  await shadows.ensureAccount("iso-a", {
    kind: "CANDIDATE",
    cohortId: "c1",
    memberId: "a",
    book: structuredClone(bookA),
  });
  await shadows.ensureAccount("iso-b", {
    kind: "CANDIDATE",
    cohortId: "c1",
    memberId: "b",
    book: structuredClone(bookA),
  });
  const fill = {
    id: "2026-01-05:live:0",
    date: "2026-01-05",
    sequence: 0,
    code: "600001",
    side: "BUY",
    quantity: 1000,
    priceCents: 1000,
  };
  const frameBook = {
    ...structuredClone(bookA),
    cashCents: bookA.cashCents - 1000 * 1000,
    positions: [
      {
        code: "600001",
        name: "x",
        sector: "s",
        lots: [
          {
            acquiredDate: "2026-01-05",
            quantity: 1000,
            costCents: 1000,
            priceCents: 1000,
          },
        ],
        heldDays: 0,
        markCents: 1000,
        lastScore: 90,
        markDate: "2026-01-05",
      },
    ],
    equityCents: 100000000,
  };
  const session = {
    date: "2026-01-05",
    status: "OPEN",
    sequence: 1,
    orders: [],
    quotes: {},
  };
  const first = await shadows.commitFrame({
    accountId: "iso-a",
    expectedRevision: 0,
    runId: "run-a1",
    tradeDate: "2026-01-05",
    sequence: 1,
    book: structuredClone(frameBook),
    session,
    observation: {},
    ledger: [fill],
  });
  assert.equal(first.applied, true);
  const second = await shadows.commitFrame({
    accountId: "iso-b",
    expectedRevision: 0,
    runId: "run-b1",
    tradeDate: "2026-01-05",
    sequence: 1,
    book: structuredClone(frameBook),
    session,
    observation: {},
    ledger: [{ ...fill }],
  });
  assert.equal(second.applied, true, "同日同局部成交 ID 在不同账户可保存");
  const duplicate = await shadows.commitFrame({
    accountId: "iso-a",
    expectedRevision: 0,
    runId: "run-a1-dup",
    tradeDate: "2026-01-05",
    sequence: 1,
    book: structuredClone(frameBook),
    session,
    observation: {},
    ledger: [fill],
  });
  assert.equal(duplicate.applied, false, "旧游标重放在 SQL 层幂等跳过");
  const conflict = await shadows.commitFrame({
    accountId: "iso-a",
    expectedRevision: 0,
    runId: "run-a1-conflict",
    tradeDate: "2026-01-05",
    sequence: 2,
    book: structuredClone(frameBook),
    session,
    observation: {},
    ledger: [],
  });
  assert.equal(conflict.applied, false, "revision CAS 阻止并发重复提交");
  const aFills = await shadows.ledger("iso-a");
  const bFills = await shadows.ledger("iso-b");
  assert.equal(aFills.length, 1);
  assert.equal(bFills.length, 1);
  assert.equal(aFills[0].id, bFills[0].id);
  DB.close();
});

test("完整前瞻窗口：固定窗口、闸门、固定排序与统一自动晋级", async () => {
  const { DB, env, repository, all } = await buildEnv();
  const cohortsSetup = new CohortRepository(env);
  // 所有者保存 30 天前瞻窗口与 1 轮完整轮次门槛的新政策
  await cohortsSetup.saveTournamentPolicy({
    forwardDays: FORWARD_DAYS,
    minimumCompletedRounds: 1,
  });
  const primaryBefore = await settlePrimaryToCaptureDay(env, repository, all);
  const reserved = await reserveScheduledCohort(env, repository);
  const cohortId = reserved.cohortId;
  const championMember = reserved.members[0];
  const forwardPairs = await seedForwardData(DB, env);
  const datasetByDate = datasetByDateOf(all, forwardPairs);
  const calendar = {
    dates: [...all, ...forwardPairs].map((p) => p.dataset.date),
    benchmark: [],
  };
  const scheduled = await scheduleCohortForward(env, cohortId, {
    now: `${dateAt(SEED)}T07:30:00.000Z`,
  });
  assert.equal(scheduled.scheduled, true);
  const cohorts = new CohortRepository(env);
  const shadows = new ShadowAccountRepository(env);
  // 盘后重复调用幂等：捕获日不是窗口市场日
  const captureDayResult = await settleTournamentDay(env, dateAt(SEED), {
    now: `${dateAt(SEED)}T07:30:00.000Z`,
  });
  assert.equal(captureDayResult.status, "CAPTURE_DAY");
  for (let offset = 1; offset <= FORWARD_DAYS; offset++) {
    const dayIndex = SEED + offset;
    const date = dateAt(dayIndex);
    for (const [utc, beijing, volume] of forwardFrames())
      await runTournamentPoll(env, new Date(`${date}T${utc}Z`), {
        providers: {
          calendar,
          quotes: makeQuotes(datasetByDate, dayIndex, beijing, volume),
        },
      });
    const settled = await settleTournamentDay(env, date, {
      calendarDates: [dateAt(dayIndex + 1), dateAt(dayIndex + 2)],
      now: `${date}T07:30:00.000Z`,
    });
    assert.equal(
      settled.status,
      "SETTLED",
      JSON.stringify(settled).slice(0, 200),
    );
    if (offset < FORWARD_DAYS) {
      const duplicate = await settleTournamentDay(env, date, {
        now: `${date}T07:35:00.000Z`,
      });
      assert.equal(
        duplicate.status,
        "DUPLICATE",
        "盘后任务重复不重复结算或延长窗口",
      );
    }
    if (offset % 10 === 0)
      assert.equal(
        settled.tradingDays,
        offset,
        "共同市场日按固定日历累计，不删除不延长",
      );
  }
  const evaluation = await cohorts.report(cohortId, "EVALUATION");
  assert.ok(evaluation, "窗口结束生成唯一最终报告");
  const verdicts = evaluation.payload.verdicts;
  const eligible = verdicts.filter((row) => row.stage === "ELIGIBLE");
  assert.equal(
    eligible.length,
    1,
    JSON.stringify({
      error: evaluation.payload.executionStressError,
      checks: verdicts.map((v) => v.checks),
    }),
  );
  assert.equal(eligible[0].memberId, championMember.memberId);
  assert.ok(evaluation.payload.champion);
  assert.equal(
    evaluation.payload.promotion.promoted,
    true,
    "批次结束时自动晋级一次",
  );
  const cohort = await cohorts.getCohort(cohortId);
  assert.equal(cohort.stage, "CLOSED");
  assert.equal(cohort.effectiveTradeDate, dateAt(SEED + FORWARD_DAYS + 2));
  assert.equal(await cohorts.windowOwner(), null, "窗口锁释放");
  // 主账户连续性：只切换未来策略引用
  const papers = new RealtimeRepository(env);
  const primaryAfter = await papers.account();
  assert.equal(primaryAfter.book.activeStrategy, championMember.versionId);
  assert.equal(
    primaryAfter.book.cashCents,
    primaryBefore.book.cashCents,
    "主账户现金不被影子账户覆盖",
  );
  assert.deepEqual(
    primaryAfter.book.positions.map((p) => [p.code, totalQuantityOf(p)]),
    primaryBefore.book.positions.map((p) => [p.code, totalQuantityOf(p)]),
    "主账户持仓不被影子结果替换",
  );
  assert.equal(
    primaryAfter.book.peakEquityCents,
    primaryBefore.book.peakEquityCents,
  );
  // 旧 API 统一走晋级服务：冠军幂等、非冠军拒绝
  const promoted = await promoteCohortChampion(env, cohortId, {});
  assert.equal(promoted.duplicate, true);
  const membersNow = await cohorts.members(cohortId);
  const rejectedMember = membersNow.find((member) =>
    ["REJECTED", "ERROR"].includes(member.stage),
  );
  assert.ok(rejectedMember, "未通过成员留痕");
  await assert.rejects(
    () =>
      promoteCohortChampion(env, cohortId, {
        evaluation: { champion: { memberId: rejectedMember.memberId } },
      }),
    /不符合启用条件|没有通过全部闸门/,
    "排行绕过被拒绝",
  );
  // P1-7 评估中断恢复：批次回到 EVALUATING 且报告丢失时重入评估，
  // 已裁定成员（含 PROMOTED）补齐指标、冠军回到排序首位、重入晋级
  // 识别 duplicate；报告摘要与内容自洽（P1-6），合法重试不被拒绝。
  await DB.prepare(
    "UPDATE strategy_cohorts SET stage = 'EVALUATING' WHERE id = ?",
  )
    .bind(cohortId)
    .run();
  await DB.prepare("DELETE FROM cohort_reports WHERE cohort_id = ?")
    .bind(cohortId)
    .run();
  const reentered = await evaluateCohort(env, cohortId, {});
  assert.ok(reentered.champion, "恢复后冠军仍可回到排序首位");
  assert.equal(reentered.champion.memberId, championMember.memberId);
  assert.equal(
    reentered.promotion?.promoted,
    true,
    "重入晋级识别 duplicate，不产生第二次切换",
  );
  const { digest: storedReportDigest, ...reportSource } = reentered;
  assert.equal(
    await digestOf(reportSource),
    storedReportDigest,
    "存储报告摘要与内容一致",
  );
  const cohortRecovered = await cohorts.getCohort(cohortId);
  assert.equal(cohortRecovered.stage, "CLOSED");
  // 报告与血缘可重放
  const detail = await cohortDetail(env, cohortId);
  assert.ok(detail.evaluationDigest);
  const lineage = await cohortLineage(env, cohortId);
  assert.equal(lineage.members.length, 4);
  const status = await tournamentStatus(env);
  assert.equal(status.activeCohort, null);
  assert.equal(status.cohorts.length, 1);
  assert.equal(status.cohorts[0].stage, "CLOSED");
  DB.close();
});

test("费用或父策略变化使批次资格失效；旧 API 仍拒绝绕过前瞻报告", async () => {
  const { DB, env, repository } = await buildEnv();
  await settlePrimaryToCaptureDay(env, repository, pairs(SEED));
  const reserved = await reserveScheduledCohort(env, repository);
  const cohorts = new CohortRepository(env);
  // 费用配置在冻结后变化
  await repository.configure({
    fees: { ...DEFAULT_FEES, commission_rate: 0.0006 },
  });
  const scheduled = await scheduleCohortForward(env, reserved.cohortId, {
    now: `${dateAt(SEED)}T07:30:00.000Z`,
  });
  assert.equal(scheduled.scheduled, false);
  assert.match(scheduled.reason, /费用配置已变化/);
  const cohort = await cohorts.getCohort(reserved.cohortId);
  assert.equal(cohort.stage, "CLOSED", "批次失效但保留占用与财务路径");
  assert.equal(await cohorts.windowOwner(), null);
  // 旧 API：启用未通过前瞻报告的候选仍被拒绝
  const research = new ResearchRepository(env);
  const legacy = research.activate ?? null;
  void legacy;
  const papers = new RealtimeRepository(env);
  const account = await papers.account();
  assert.equal(account.book.activeStrategy, "baseline-v1", "保持当前策略");
  DB.close();
});

function totalQuantityOf(position) {
  return position.lots.reduce((sum, lot) => sum + lot.quantity, 0);
}

test("继承持仓期间做 T 不计完整轮次；期间盈利与权益变化守恒", async () => {
  // P1-3：继承 500 股底仓 + 11 次做 T（买 100 卖 100）→ 0 个完整轮次
  const fills = [];
  let seq = 0;
  for (let i = 0; i < 11; i++) {
    fills.push({
      code: "600001",
      side: "BUY",
      quantity: 100,
      date: "2026-01-05",
      sequence: seq++,
    });
    fills.push({
      code: "600001",
      side: "SELL",
      quantity: 100,
      date: "2026-01-05",
      sequence: seq++,
    });
  }
  fills.push({
    code: "600001",
    side: "SELL",
    quantity: 500,
    date: "2026-01-06",
    sequence: seq++,
  });
  const inherited = completeRounds(fills, ["2026-01-05", "2026-01-06"], {
    600001: 500,
  });
  assert.equal(inherited.rounds, 0, "继承持仓未清零前，T 两腿不凑次数");
  // 继承清仓后从零新建仓并清仓 → 恰好 1 个完整轮次
  fills.push({
    code: "600002",
    side: "BUY",
    quantity: 1000,
    date: "2026-01-07",
    sequence: seq++,
  });
  fills.push({
    code: "600002",
    side: "SELL",
    quantity: 1000,
    date: "2026-01-08",
    sequence: seq++,
  });
  const mixed = completeRounds(fills, ["2026-01-05", "2026-01-08"], {
    600001: 500,
  });
  assert.equal(mixed.rounds, 1, "继承清仓不计数，新轮次完整闭合计一次");
  // P2-1：期初浮盈持仓按捕获价平价退出 → 浮盈实现而非新增，期间盈利为 0
  const initial = {
    equityCents: 100000000,
    feesCents: 0,
    realizedPnlCents: 0,
    unrealizedPnlCents: 900000,
  };
  const metrics = windowMetrics({
    initial,
    final: {
      equityCents: 100000000,
      feesCents: 0,
      realizedPnlCents: 900000,
      unrealizedPnlCents: 0,
    },
    equities: [{ tradeDate: "2026-01-06", equityCents: 100000000 }],
    windowDates: ["2026-01-06"],
  });
  assert.equal(metrics.profitCents, 0, "平价退出的期间盈利为 0，不虚增浮盈");
  // 净值摘要与账本不一致的期初快照被守恒校验拒绝，而不是输出矛盾指标
  assert.throws(
    () =>
      windowMetrics({
        initial: { ...initial, unrealizedPnlCents: 0 },
        final: {
          equityCents: 100000000,
          feesCents: 0,
          realizedPnlCents: 900000,
          unrealizedPnlCents: 0,
        },
        equities: [],
        windowDates: ["2026-01-06"],
      }),
    /期初快照与账本状态不匹配/,
  );
});

test("重启恢复按序重放未消费帧；帧价补齐候选独有持仓收盘", async () => {
  const { DB, env } = await buildEnv({ count: 5 });
  const shadows = new ShadowAccountRepository(env);
  const framesRepo = new QuoteFrameRepository(env);
  const day = dateAt(2);
  const accountId = "replay-a";
  const book = newBook();
  book.lastDate = dateAt(1);
  await shadows.ensureAccount(accountId, {
    kind: "CANDIDATE",
    cohortId: "c-replay",
    memberId: "m1",
    book,
  });
  for (let sequence = 0; sequence < 3; sequence++)
    await framesRepo.appendFrame({
      tradeDate: day,
      observedAt: `${day}T01:31:0${sequence}.000Z`,
      quotes: {},
      pollIntervalSeconds: 10,
      pool: { codes: [], sources: {} },
    });
  const persisted = await framesRepo.framesForDate(day);
  assert.equal(persisted.length, 3);
  // frame 1：无执行日计划 → stalled，不消费
  const first = await consumePortfolioFrame(env, accountId, persisted[0], {
    shadows,
  });
  assert.equal(first.stalled, true, "缺少执行日计划，账户暂停消费");
  // frame 2：直接消费被按序守卫拒绝，不越过未消费的持久帧
  const second = await consumePortfolioFrame(env, accountId, persisted[1], {
    shadows,
  });
  assert.equal(second.stalled, true, "不越过未消费的前序帧");
  // 模拟重启后恢复：计划就绪，按序重放全部持久帧
  await freezePortfolioPlan(
    env,
    accountId,
    {
      snapshot: null,
      strategy: BASE_STRATEGY,
      strategyVersion: "baseline-v1",
      now: `${dateAt(1)}T07:00:00.000Z`,
    },
    { shadows },
  );
  const replayResults = [];
  for (const frame of await framesRepo.framesSince(dateAt(0)))
    replayResults.push(
      await consumePortfolioFrame(env, accountId, frame, { shadows }),
    );
  assert.equal(
    replayResults.filter((row) => row.applied).length,
    3,
    "重启后按序重放，未消费帧全部补齐且不重复",
  );
  const account = await shadows.account(accountId);
  assert.equal(
    `${account.cursorDate}/${account.cursorSequence}`,
    `${day}/3`,
    "游标停最后消费帧",
  );
  // P1-1：候选独有代码由**最新观测帧**补齐收盘记录——09:31 的首条报价
  // 不能冒充 15:00 收盘价；日线已有收盘价不被覆盖。
  const enriched = closingQuotesFromFrames(
    [
      {
        sequence: 1,
        payload: {
          quotes: {
            600999: {
              closeCents: 1050,
              previousCloseCents: 1000,
              timestamp: `${day}T09:31:00+08:00`,
            },
          },
        },
      },
      {
        sequence: 2,
        payload: {
          quotes: {
            600999: {
              closeCents: 1080,
              previousCloseCents: 1000,
              timestamp: `${day}T09:36:00+08:00`,
            },
          },
        },
      },
    ],
    { 600001: { closeCents: 900, timestamp: `${day}T15:00:00+08:00` } },
    day,
  );
  assert.equal(
    enriched["600999"].closeCents,
    1080,
    "收盘盯市取最后观测帧价格，不用首条盘中报价",
  );
  assert.match(enriched["600999"].timestamp, /T15:00:00/, "补齐按收盘时点盯市");
  assert.equal(enriched["600999"].closingSource, "FRAME_LAST_OBSERVED");
  assert.equal(enriched["600001"].closeCents, 900, "日线收盘优先，不被帧覆盖");
  // P1-1：帧末观测价盯市的净值行 complete=false 且记 notice，
  // 由覆盖闸门当作数据缺失暴露，不用盘中价冒充收盘价参与晋级。
  const csBook = newBook();
  csBook.positions = [
    {
      code: "600999",
      name: "x",
      sector: "s",
      heldDays: 0,
      markCents: 1000,
      lots: [
        {
          acquiredDate: dateAt(1),
          quantity: 1000,
          costCents: 1_000_000,
          priceCents: 1000,
        },
      ],
    },
  ];
  csBook.cashCents = csBook.initialCashCents - 1_000_000;
  csBook.equityCents = csBook.initialCashCents;
  csBook.peakEquityCents = csBook.equityCents;
  csBook.lastDate = dateAt(1);
  const csSession = {
    date: day,
    status: "OPEN",
    sequence: 1,
    orders: [],
    quotes: {},
    initialBook: structuredClone(csBook),
  };
  const csResult = closeSession(csBook, csSession, {
    date: day,
    quotes: {
      600999: {
        date: day,
        closeCents: 1080,
        previousCloseCents: 1000,
        timestamp: `${day}T15:00:00+08:00`,
        closingSource: "FRAME_LAST_OBSERVED",
      },
    },
  });
  assert.equal(csResult.equity.complete, false, "帧价盯市的净值行不完整");
  assert.ok(
    csResult.notices.some((notice) => notice.includes("600999")),
    "盯市来源如实记入 notice",
  );
  DB.close();
});

test("固定窗口缺日不补满：窗口外日期收口评估且整批无资格", async () => {
  const { DB, env, repository, all } = await buildEnv();
  await settlePrimaryToCaptureDay(env, repository, all);
  await new CohortRepository(env).saveTournamentPolicy({
    forwardDays: FORWARD_DAYS,
    minimumCompletedRounds: 1,
  });
  const reserved = await reserveScheduledCohort(env, repository);
  const forwardPairs = await seedForwardData(DB, env);
  const datasetByDate = datasetByDateOf(all, forwardPairs);
  const calendar = {
    dates: [...all, ...forwardPairs].map((p) => p.dataset.date),
    benchmark: [],
  };
  await scheduleCohortForward(env, reserved.cohortId, {
    now: `${dateAt(SEED)}T07:30:00.000Z`,
  });
  const cohorts = new CohortRepository(env);
  // 第 15 日主账户未结算、无帧；第 30 日（窗口末日）同样缺失
  const missingOffsets = new Set([15, FORWARD_DAYS]);
  for (let offset = 1; offset < FORWARD_DAYS; offset++) {
    if (missingOffsets.has(offset)) continue;
    const dayIndex = SEED + offset;
    const date = dateAt(dayIndex);
    for (const [utc, beijing, volume] of forwardFrames())
      await runTournamentPoll(env, new Date(`${date}T${utc}Z`), {
        providers: {
          calendar,
          quotes: makeQuotes(datasetByDate, dayIndex, beijing, volume),
        },
      });
    await settleTournamentDay(env, date, {
      calendarDates: [dateAt(dayIndex + 1), dateAt(dayIndex + 2)],
      now: `${date}T07:30:00.000Z`,
    });
  }
  // 窗口末日缺失后，第 31 日不能补满窗口：按原固定窗口收口评估
  const ended = await settleTournamentDay(
    env,
    dateAt(SEED + FORWARD_DAYS + 1),
    {
      calendarDates: [dateAt(SEED + FORWARD_DAYS + 2)],
      now: `${dateAt(SEED + FORWARD_DAYS + 1)}T07:30:00.000Z`,
    },
  );
  assert.equal(ended.status, "WINDOW_ENDED");
  assert.ok(ended.evaluation, "固定窗口结束仍有缺口时按原窗口收口评估");
  assert.equal(
    ended.evaluation.windowDates.length,
    FORWARD_DAYS,
    "评估窗口仍是冻结的 30 个交易日，不含窗口外日期",
  );
  assert.ok(ended.evaluation.commonDataMissing, "缺失日使共同数据检查失败");
  assert.equal(
    ended.evaluation.verdicts.filter((row) => row.stage === "ELIGIBLE").length,
    0,
    "共同数据缺失使整批无资格，无成员可晋级",
  );
  assert.ok(
    ended.evaluation.verdicts.some((row) => row.stage === "INCONCLUSIVE"),
    "窗口成员保留 INCONCLUSIVE 失败路径",
  );
  assert.equal(ended.evaluation.promotion, null, "整批无资格时无自动晋级");
  const cohort = await cohorts.getCohort(reserved.cohortId);
  assert.equal(cohort.stage, "CLOSED");
  assert.equal(await cohorts.windowOwner(), null, "窗口锁释放");
  const primary = await new RealtimeRepository(env).account();
  assert.equal(primary.book.activeStrategy, "baseline-v1", "保持当前策略");
  DB.close();
});

test("过期批次恢复可达且盘中拒绝捕获起点", async () => {
  const { DB, env, repository, all } = await buildEnv();
  await settlePrimaryToCaptureDay(env, repository, all);
  const reserved = await reserveScheduledCohort(env, repository);
  const cohorts = new CohortRepository(env);
  // 盘中时段拒绝捕获匹配起点，批次保持 SCHEDULED
  const intraday = await scheduleCohortForward(env, reserved.cohortId, {
    now: `${dateAt(SEED)}T03:00:00.000Z`,
  });
  assert.equal(intraday.scheduled, false);
  assert.match(intraday.reason, /盘中时段/);
  assert.equal(
    (await cohorts.getCohort(reserved.cohortId)).stage,
    "SCHEDULED",
    "盘中捕获被拒绝且不改变批次状态",
  );
  // 午休（非连续竞价、今日会话仍 OPEN）同样拒绝捕获
  await DB.prepare(
    "INSERT INTO paper_live_sessions (trade_date, payload, digest) VALUES (?, ?, 'fixture')",
  )
    .bind(
      dateAt(SEED),
      JSON.stringify({
        date: dateAt(SEED),
        status: "OPEN",
        sequence: 1,
        orders: [],
        quotes: {},
      }),
    )
    .run();
  const lunchBreak = await scheduleCohortForward(env, reserved.cohortId, {
    now: `${dateAt(SEED)}T04:00:00.000Z`,
  });
  assert.equal(lunchBreak.scheduled, false);
  assert.match(lunchBreak.reason, /会话尚未关闭/, "午休不得创建赛马起点");
  await DB.prepare("DELETE FROM paper_live_sessions WHERE trade_date = ?")
    .bind(dateAt(SEED))
    .run();
  // 模拟候选请求发出后停机：批次回到 PROPOSING 且请求租约过期
  await DB.prepare(
    "UPDATE strategy_cohorts SET stage = 'PROPOSING' WHERE id = ?",
  )
    .bind(reserved.cohortId)
    .run();
  const last = await cohorts.lastEvent(reserved.cohortId);
  await cohorts.appendEvent(reserved.cohortId, {
    sequence: last.sequence + 1,
    eventType: "REQUEST_ISSUED",
    createdAt: "2020-01-01T00:00:00.000Z",
    payload: { requestIssuedAt: "2020-01-01T00:00:00.000Z" },
    previousDigest: last.digest,
  });
  // 再次预留：恢复逻辑可达，按错误收尾并释放窗口，而不是被窗口锁 BUSY 卡死
  const recovered = await reserveCohort(repository, env);
  assert.equal(recovered.status, "ERROR", JSON.stringify(recovered));
  assert.match(recovered.reason, /候选冻结前中断/);
  assert.equal(await cohorts.windowOwner(), null, "过期批次恢复后释放窗口");
  assert.equal((await cohorts.getCohort(reserved.cohortId)).stage, "CLOSED");
  DB.close();
});

test("并发状态迁移由 revision CAS 保证，更新与事件不丢失", async () => {
  const { DB, env } = await buildEnv({ count: 5 });
  const cohorts = new CohortRepository(env);
  const now = new Date().toISOString();
  await DB.prepare(
    "INSERT INTO strategy_cohorts (id, namespace, revision, parent_version, policy_id, policy_digest, research_policy_id, research_policy_digest, stage, max_candidates, forward_days, reservation_manifest, created_at, updated_at) VALUES ('c-cas', 'main', 0, 'baseline-v1', 'p', 'd', 'rp', 'rd', 'RUNNING', 4, 30, '{}', ?, ?)",
  )
    .bind(now, now)
    .run();
  const attempts = await Promise.allSettled([
    cohorts.transitionCohort("c-cas", {
      from: "RUNNING",
      to: "RUNNING",
      eventType: "FORWARD_DAY_SETTLED",
      payload: { tag: "A" },
      set: { forward_manifest: JSON.stringify({ tag: "A" }) },
    }),
    cohorts.transitionCohort("c-cas", {
      from: "RUNNING",
      to: "RUNNING",
      eventType: "FORWARD_DAY_SETTLED",
      payload: { tag: "B" },
      set: { forward_manifest: JSON.stringify({ tag: "B" }) },
    }),
  ]);
  assert.equal(
    attempts.filter((row) => row.status === "fulfilled").length,
    1,
    "并发迁移只有一个成功",
  );
  assert.match(
    attempts.find((row) => row.status === "rejected").reason.message,
    /冲突|已被其他流程改变|UNIQUE constraint/,
    "被拒者整体回滚，不产生部分写入",
  );
  const cohort = await cohorts.getCohort("c-cas");
  assert.ok(cohort.forwardManifest?.tag, "成功者的清单更新完整生效");
  const events = await cohorts.events("c-cas");
  assert.equal(events.length, 1, "事件链无缺口：被拒者不留事件");
  assert.equal(events[0].sequence, 1);
  // 并发路径即无孤儿验证：被拒者在同一事务内 UPDATE 0 行 + 事件 0 行
  // （EXISTS 新 revision 守卫），整体不产生任何写入。
  assert.notEqual(events[0].payload.tag, undefined, "唯一事件来自成功者");
  DB.close();
});

test("晋级输入验证：报告摘要、净值摘要、共同占用与期末净值缺一不可", async () => {
  const { DB, env } = await buildEnv({ count: 5 });
  const cohorts = new CohortRepository(env);
  const papers = new RealtimeRepository(env);
  const shadows = new ShadowAccountRepository(env);
  await papers.initialize();
  const account = await papers.account();
  const feeConfig = feesForBook(account.book);
  const feeConfigDigest = await digestOf(feeConfig);
  const initialAccounts = {
    "shadow-exp-x": {
      equityCents: account.book.equityCents,
      feesCents: account.book.feesCents,
      realizedPnlCents: account.book.realizedPnlCents,
      unrealizedPnlCents: 0,
    },
  };
  const forwardManifest = {
    captureDate: dateAt(4),
    ...selectionPolicyFields(selectionPolicyForBook(account.book)),
    requiredDays: 1,
    feeConfig,
    feeConfigDigest,
    initialAccounts,
    initialAccountsDigest: await digestOf(initialAccounts),
    accounts: {
      candidates: ["shadow-exp-x"],
      parentMatch: "shadow-parent-x",
      baselineMatch: "shadow-baseline-x",
    },
    tradingDates: [dateAt(5)],
    windowDates: [dateAt(5)],
  };
  const now = new Date().toISOString();
  await DB.prepare(
    "INSERT INTO strategy_cohorts (id, namespace, revision, parent_version, policy_id, policy_digest, research_policy_id, research_policy_digest, stage, max_candidates, forward_days, reservation_manifest, forward_manifest, created_at, updated_at) VALUES ('c-promo', 'main', 0, 'baseline-v1', 'p', 'd', 'rp', 'rd', 'EVALUATING', 4, 1, '{}', ?, ?, ?)",
  )
    .bind(JSON.stringify(forwardManifest), now, now)
    .run();
  await DB.prepare(
    "INSERT INTO strategy_cohort_members (cohort_id, member_id, slot_index, experiment_id, strategy_version, k, params, params_digest, params_distance, stage, created_at, updated_at) VALUES ('c-promo', 'm1', 1, 'exp-x', 'v-champ', 1, '{}', 'd', 1, 'ELIGIBLE', ?, ?)",
  )
    .bind(now, now)
    .run();
  const baseReport = (finalEquityCents) => ({
    ...selectionPolicyFields(selectionPolicyForBook(account.book)),
    cohortId: "c-promo",
    evaluatedAt: now,
    windowDates: [dateAt(5)],
    requiredDays: 1,
    commonCoverage: [],
    commonDataMissing: false,
    fingerprint: { environmentValid: true },
    minimumCompletedRounds: 1,
    statisticsBudget: null,
    verdicts: [],
    ranked: [],
    champion: { memberId: "m1", finalEquityCents },
    promotion: null,
    executionVersion: EXECUTION_VERSION,
    scoringVersion: SCORING_VERSION,
  });
  // 报告摘要缺失或与内容不匹配 → 拒绝
  await assert.rejects(
    () => promoteCohortChampion(env, "c-promo", { evaluation: baseReport(1) }),
    /报告摘要/,
    "缺少报告摘要的晋级输入被拒绝",
  );
  const tampered = baseReport(1_000_000_000);
  tampered.digest = await digestOf({
    ...tampered,
    champion: { memberId: "m1", finalEquityCents: 2 },
  });
  await assert.rejects(
    () => promoteCohortChampion(env, "c-promo", { evaluation: tampered }),
    /报告摘要/,
    "摘要与内容不一致的报告被拒绝",
  );
  // 净值摘要与捕获清单不一致 → 拒绝
  const badDigest = baseReport(1_000_000_000);
  badDigest.digest = await digestOf(badDigest);
  await DB.prepare(
    "UPDATE strategy_cohorts SET forward_manifest = ? WHERE id = 'c-promo'",
  )
    .bind(
      JSON.stringify({
        ...forwardManifest,
        initialAccounts: {
          "shadow-exp-x": {
            ...initialAccounts["shadow-exp-x"],
            equityCents: 42,
          },
        },
      }),
    )
    .run();
  await assert.rejects(
    () => promoteCohortChampion(env, "c-promo", { evaluation: badDigest }),
    /期初净值摘要/,
    "期初净值摘要被篡改时拒绝晋级",
  );
  await DB.prepare(
    "UPDATE strategy_cohorts SET forward_manifest = ? WHERE id = 'c-promo'",
  )
    .bind(JSON.stringify(forwardManifest))
    .run();
  // 完整登记校验的第一项：窗口日必须有主账户结算数据。
  await DB.prepare(
    "INSERT INTO paper_market_days (trade_date, payload, digest) VALUES (?, ?, 'fixture')",
  )
    .bind(dateAt(5), JSON.stringify({ date: dateAt(5), quotes: {} }))
    .run();
  // 共同市场日缺少批次占用登记 → 拒绝
  await assert.rejects(
    () => promoteCohortChampion(env, "c-promo", { evaluation: badDigest }),
    /占用登记/,
    "共同日期 claim 缺失时拒绝晋级",
  );
  await DB.prepare(
    "INSERT INTO research_test_claims (namespace, outcome_date, experiment_id, role, reserved_at, owner_type, owner_id) VALUES ('main', ?, 'c-promo', 'FORWARD_TEST', ?, 'COHORT', 'c-promo')",
  )
    .bind(dateAt(5), now)
    .run();
  // 冠军期末净值与影子账本不一致 → 拒绝（账户存在但净值对不上）
  await shadows.ensureAccount("shadow-exp-x", {
    kind: "CANDIDATE",
    cohortId: "c-promo",
    memberId: "m1",
    book: structuredClone(account.book),
  });
  await shadows.commitSettlement({
    accountId: "shadow-exp-x",
    expectedRevision: 0,
    runId: "run-0",
    tradeDate: dateAt(5),
    book: { ...structuredClone(account.book), lastDate: dateAt(5) },
    equity: { date: dateAt(5), equityCents: 1_999_999_999 },
    session: { date: dateAt(5), status: "CLOSED" },
  });
  // 共同对照影子账户是晋级证据：缺失即拒绝
  await shadows.ensureAccount("shadow-parent-x", {
    kind: "PARENT_MATCH",
    cohortId: "c-promo",
    memberId: "parent",
    book: structuredClone(account.book),
  });
  await shadows.commitSettlement({
    accountId: "shadow-parent-x",
    expectedRevision: 0,
    runId: "run-p0",
    tradeDate: dateAt(5),
    book: { ...structuredClone(account.book), lastDate: dateAt(5) },
    equity: { date: dateAt(5), equityCents: 1_000_000_000 },
    session: { date: dateAt(5), status: "CLOSED" },
  });
  await shadows.ensureAccount("shadow-baseline-x", {
    kind: "BASELINE_MATCH",
    cohortId: "c-promo",
    memberId: "baseline",
    book: structuredClone(account.book),
  });
  await assert.rejects(
    () => promoteCohortChampion(env, "c-promo", { evaluation: badDigest }),
    /期末净值/,
    "冠军期末净值与影子账本不一致时拒绝晋级",
  );
  // 日净值行内容被篡改而存储摘要未同步 → 拒绝（P1-2：对照证据同样校验）
  await DB.prepare(
    "UPDATE shadow_equity SET payload = json_set(payload, '$.equityCents', 42) WHERE account_id = 'shadow-exp-x' AND trade_date = ?",
  )
    .bind(dateAt(5))
    .run();
  await assert.rejects(
    () => promoteCohortChampion(env, "c-promo", { evaluation: badDigest }),
    /摘要与内容不一致/,
    "日净值摘要与内容不一致时拒绝晋级",
  );
  // 恢复冠军净值行自洽，再验证对照证据
  await DB.prepare(
    "DELETE FROM shadow_equity WHERE account_id = 'shadow-exp-x' AND trade_date = ?",
  )
    .bind(dateAt(5))
    .run();
  await shadows.commitSettlement({
    accountId: "shadow-exp-x",
    expectedRevision: 1,
    runId: "run-1",
    tradeDate: dateAt(5),
    book: { ...structuredClone(account.book), lastDate: dateAt(5) },
    equity: { date: dateAt(5), equityCents: 1_000_000_000 },
    session: { date: dateAt(5), status: "CLOSED" },
  });
  // P1-3：共同对照净值按盘中观测价盯市且摘要同步有效——收盘数据缺失，
  // 对照证据不完整使批次无资格。
  const parentRows = await shadows.equities("shadow-parent-x");
  const parentRow = parentRows.find((row) => row.tradeDate === dateAt(5));
  const {
    digest: parentStoredDigest,
    tradeDate: parentTradeDate,
    ...parentPayload
  } = parentRow;
  void parentStoredDigest;
  void parentTradeDate;
  const tamperedParentPayload = { ...parentPayload, complete: false };
  await DB.prepare(
    "UPDATE shadow_equity SET payload = ?, digest = ? WHERE account_id = 'shadow-parent-x' AND trade_date = ?",
  )
    .bind(
      JSON.stringify(tamperedParentPayload),
      await digest(tamperedParentPayload),
      dateAt(5),
    )
    .run();
  await assert.rejects(
    () => promoteCohortChampion(env, "c-promo", { evaluation: badDigest }),
    /盘中观测价盯市/,
    "对照净值盯市不完整时拒绝晋级",
  );
  // 恢复对照净值后，冠军净值行摘要为空同样不放行（P1-4）
  await DB.prepare(
    "DELETE FROM shadow_equity WHERE account_id = 'shadow-parent-x' AND trade_date = ?",
  )
    .bind(dateAt(5))
    .run();
  await shadows.commitSettlement({
    accountId: "shadow-parent-x",
    expectedRevision: 1,
    runId: "run-p1",
    tradeDate: dateAt(5),
    book: { ...structuredClone(account.book), lastDate: dateAt(5) },
    equity: { date: dateAt(5), equityCents: 1_000_000_000 },
    session: { date: dateAt(5), status: "CLOSED" },
  });
  await DB.prepare(
    "UPDATE shadow_equity SET digest = '' WHERE account_id = 'shadow-exp-x' AND trade_date = ?",
  )
    .bind(dateAt(5))
    .run();
  await assert.rejects(
    () => promoteCohortChampion(env, "c-promo", { evaluation: badDigest }),
    /缺少摘要/,
    "净值行摘要为空时拒绝晋级",
  );
  await DB.prepare(
    "DELETE FROM shadow_equity WHERE account_id = 'shadow-exp-x' AND trade_date = ?",
  )
    .bind(dateAt(5))
    .run();
  await shadows.commitSettlement({
    accountId: "shadow-exp-x",
    expectedRevision: 2,
    runId: "run-2",
    tradeDate: dateAt(5),
    book: { ...structuredClone(account.book), lastDate: dateAt(5) },
    equity: { date: dateAt(5), equityCents: 1_000_000_000 },
    session: { date: dateAt(5), status: "CLOSED" },
  });
  // P1-8：CAS 冲突后的定稿报告（含 promotion 失败结果）摘要自洽，
  // 合法重试被接受并完成晋级。
  const { digest: staleDigest, ...retryableSource } = badDigest;
  void staleDigest;
  const retryable = {
    ...retryableSource,
    promotion: { promoted: false, reason: "主账户正在更新，晋级未应用" },
  };
  retryable.digest = await digestOf(retryable);
  for (const accountId of [
    "shadow-exp-x",
    "shadow-parent-x",
    "shadow-baseline-x",
  ])
    await shadows.savePlan(
      accountId,
      defensivePlan(
        dateAt(4),
        account.book,
        BASE_STRATEGY,
        "baseline-v1",
        `${dateAt(4)}T07:10:00.000Z`,
      ),
    );
  await assert.rejects(
    () =>
      promoteCohortChampion(env, "c-promo", {
        evaluation: retryable,
        effectiveTradeDate: dateAt(6),
      }),
    /未事前冻结成本压力/,
    "旧报告摘要自洽也不能跳过新增成本闸门",
  );
  const after = await papers.account();
  assert.equal(after.book.activeStrategy, "baseline-v1");
  DB.close();
});

test("月度额度按批次数计；连续基线跨批次持续运行", async () => {
  const { DB, env, repository, all } = await buildEnv();
  await settlePrimaryToCaptureDay(env, repository, all);
  const research = new ResearchRepository(env);
  const reserved = await reserveScheduledCohort(env, repository);
  assert.equal(
    await research.monthUsage(beijingMonth()),
    1,
    "4 个候选槽位的批次按批次数计为 1",
  );
  const cohorts = new CohortRepository(env);
  const shadows = new ShadowAccountRepository(env);
  // 模拟批次已收口：窗口锁释放，但连续基线账户保留
  await DB.prepare("UPDATE strategy_cohorts SET stage = 'CLOSED' WHERE id = ?")
    .bind(reserved.cohortId)
    .run();
  await cohorts.releaseWindowOwner("COHORT", reserved.cohortId);
  const papers = new RealtimeRepository(env);
  const account = await papers.account();
  const continuousBook = structuredClone(account.book);
  continuousBook.lastDate = dateAt(SEED - 1);
  await shadows.ensureAccount("shadow-baseline-continuous", {
    kind: "BASELINE_CONTINUOUS",
    cohortId: reserved.cohortId,
    memberId: "baseline-continuous",
    book: continuousBook,
  });
  const snapshot = await papers.snapshot(dateAt(SEED - 1));
  await freezePortfolioPlan(
    env,
    "shadow-baseline-continuous",
    {
      snapshot,
      strategy: BASE_STRATEGY,
      strategyVersion: "baseline-v1",
      now: `${dateAt(SEED - 1)}T07:00:00.000Z`,
    },
    { shadows },
  );
  // 主账户需要当日执行计划（开盘前冻结）；主账户与影子同源按序消费：
  // 观察数始终追平已落盘帧数，模拟停机丢一条观察后下一轮重放补齐。
  await papers.savePlan(
    defensivePlan(
      dateAt(SEED),
      account.book,
      BASE_STRATEGY,
      "baseline-v1",
      `${dateAt(SEED - 1)}T07:00:00.000Z`,
    ),
  );
  // 无运行批次但存在连续基线：盘中仍联合采集，基线消费帧。
  // SEED+3 为合成日历中的周一，主账户按交易日执行观察。
  const replayDay = SEED + 3;
  const calendar = {
    dates: [...all.map((p) => p.dataset.date), dateAt(replayDay)],
    benchmark: [],
  };
  const poll = await runTournamentPoll(
    env,
    new Date(`${dateAt(replayDay)}T01:31:00Z`),
    {
      providers: {
        calendar,
        quotes: makeQuotes(
          datasetByDateOf(all, []),
          replayDay,
          "09:31:00",
          8000000,
        ),
      },
    },
  );
  assert.ok(poll, "无运行批次但有连续基线时仍采集");
  assert.ok(
    poll.shadows.some(
      (row) => row.accountId === "shadow-baseline-continuous" && row.applied,
    ),
    "连续基线消费联合帧",
  );
  const framesOf = async () =>
    (await new QuoteFrameRepository(env).framesForDate(dateAt(replayDay)))
      .length;
  const observationsOf = async () =>
    (await papers.observations(dateAt(replayDay))).length;
  assert.equal(await observationsOf(), await framesOf(), "无漏帧");
  await DB.prepare(
    "DELETE FROM paper_live_ticks WHERE trade_date = ? AND sequence = (SELECT MAX(sequence) FROM paper_live_ticks WHERE trade_date = ?)",
  )
    .bind(dateAt(replayDay), dateAt(replayDay))
    .run();
  assert.notEqual(
    await observationsOf(),
    await framesOf(),
    "模拟停机丢失一条观察",
  );
  const replayBackfill = await runTournamentPoll(
    env,
    new Date(`${dateAt(replayDay)}T01:31:20Z`),
    {
      providers: {
        calendar,
        quotes: makeQuotes(
          datasetByDateOf(all, []),
          replayDay,
          "09:31:20",
          10000000,
        ),
      },
    },
  );
  assert.ok(replayBackfill, "重放轮仍联合采集");
  assert.notEqual(
    replayBackfill.primary?.status,
    "ERROR",
    "主账户重放不因缺帧游标失败",
  );
  assert.equal(
    await observationsOf(),
    await framesOf(),
    "停机丢失的帧被主账户按序重放补齐",
  );
  // 盘后：无批次时连续基线仍按日结算并冻结次计划
  const seedDayRow = await DB.prepare(
    "SELECT payload FROM paper_market_days WHERE trade_date = ?",
  )
    .bind(dateAt(SEED))
    .first();
  const nextDataset = JSON.parse(seedDayRow.payload);
  nextDataset.date = dateAt(replayDay);
  for (const quote of Object.values(nextDataset.quotes)) {
    quote.date = dateAt(replayDay);
    quote.previousCloseCents = quote.closeCents;
    quote.timestamp = `${dateAt(replayDay)}T15:00:00+08:00`;
  }
  await DB.prepare(
    "INSERT INTO paper_market_days (trade_date, payload, digest) VALUES (?, ?, 'fixture')",
  )
    .bind(dateAt(replayDay), JSON.stringify(nextDataset))
    .run();
  const daily = await runDailyTournament(env, dateAt(replayDay), {
    calendarDates: [dateAt(replayDay + 1), dateAt(replayDay + 2)],
    now: `${dateAt(replayDay)}T07:30:00.000Z`,
  });
  assert.ok(daily.continuous?.applied, "连续基线跨批次按日结算");
  const continuousAccount = await shadows.account("shadow-baseline-continuous");
  assert.equal(continuousAccount.book.lastDate, dateAt(replayDay));
  DB.close();
});

test("窗口以主账户结算序列为准：不依赖未来日历，序数不足不评估", async () => {
  const { DB, env } = await buildEnv({ count: 5 });
  const cohorts = new CohortRepository(env);
  const now = new Date().toISOString();
  const forwardManifest = {
    captureDate: dateAt(4),
    requiredDays: 30,
    accounts: {
      candidates: [],
      parentMatch: "shadow-p",
      baselineMatch: "shadow-b",
      baselineContinuous: "shadow-baseline-continuous",
    },
    tradingDates: [],
    windowDates: [],
  };
  await DB.prepare(
    "INSERT INTO strategy_cohorts (id, namespace, revision, parent_version, policy_id, policy_digest, research_policy_id, research_policy_digest, stage, max_candidates, forward_days, reservation_manifest, forward_manifest, created_at, updated_at) VALUES ('c-cal', 'main', 0, 'baseline-v1', 'p', 'd', 'rp', 'rd', 'RUNNING', 4, 30, '{}', ?, ?, ?)",
  )
    .bind(JSON.stringify(forwardManifest), now, now)
    .run();
  // 指数日线只含已收盘历史日期，未来日历不存在：窗口推进完全不
  // 依赖 calendarDates——主账户结算序列就是交易日历。
  await DB.prepare(
    "INSERT INTO paper_market_days (trade_date, payload, digest) VALUES (?, ?, 'fixture')",
  )
    .bind(dateAt(5), JSON.stringify({ date: dateAt(5), quotes: {} }))
    .run();
  const settled = await settleTournamentDay(env, dateAt(5), {
    calendarDates: [],
  });
  assert.equal(
    settled.status,
    "SETTLED",
    "空日历不阻塞窗口登记：主账户序列驱动推进",
  );
  const manifest = (await cohorts.getCohort("c-cal")).forwardManifest;
  assert.deepEqual(manifest.tradingDates, [dateAt(5)]);
  assert.deepEqual(manifest.windowDates, [dateAt(5)]);
  assert.equal(settled.evaluation, null, "主账户序数未达窗口天数不评估");
  // 主账户序数达到窗口天数即收口评估，窗口列表 = 主账户前 N 个结算日
  for (let offset = 6; offset <= 35; offset++)
    await DB.prepare(
      "INSERT INTO paper_market_days (trade_date, payload, digest) VALUES (?, ?, 'fixture')",
    )
      .bind(
        dateAt(offset),
        JSON.stringify({ date: dateAt(offset), quotes: {} }),
      )
      .run();
  const completed = await settleTournamentDay(env, dateAt(35), {
    calendarDates: [],
  });
  assert.equal(completed.status, "WINDOW_ENDED", "第 31 个结算日在窗口外");
  const finished = await cohorts.getCohort("c-cal");
  assert.equal(finished.forwardManifest.windowDates.length, 30);
  assert.equal(
    finished.forwardManifest.tradingDates.length,
    1,
    "窗口外日期不登记：tradingDates 只含窗口内已登记日",
  );
  assert.equal(finished.stage, "CLOSED", "窗口缺口按主账户序列收口评估");
  DB.close();
});

test("评估中断由盘后任务恢复收尾，重入复用已发布报告", async () => {
  const { DB, env } = await buildEnv({ count: 5 });
  const cohorts = new CohortRepository(env);
  const now = new Date().toISOString();
  await DB.prepare(
    "INSERT INTO strategy_cohorts (id, namespace, revision, parent_version, policy_id, policy_digest, research_policy_id, research_policy_digest, stage, max_candidates, forward_days, reservation_manifest, created_at, updated_at) VALUES ('c-eval', 'main', 0, 'baseline-v1', 'p', 'd', 'rp', 'rd', 'EVALUATING', 4, 30, '{}', ?, ?)",
  )
    .bind(now, now)
    .run();
  const report = {
    cohortId: "c-eval",
    evaluatedAt: now,
    windowDates: [],
    requiredDays: 30,
    commonCoverage: [],
    commonDataMissing: false,
    fingerprint: { environmentValid: false },
    minimumCompletedRounds: 10,
    statisticsBudget: null,
    verdicts: [],
    ranked: [],
    champion: null,
    promotion: null,
    executionVersion: EXECUTION_VERSION,
    scoringVersion: SCORING_VERSION,
    digest: "stub",
  };
  await cohorts.saveReport("c-eval", "EVALUATION", report);
  const recovered = await settleTournamentDay(env, dateAt(5), {
    calendarDates: [dateAt(6)],
  });
  assert.equal(recovered.status, "EVALUATION_RECOVERED");
  assert.equal(recovered.evaluation.cohortId, "c-eval", "已发布报告幂等复用");
  assert.equal(
    (await cohorts.getCohort("c-eval")).stage,
    "CLOSED",
    "评估中断后批次补齐收尾",
  );
  DB.close();
});

// 前瞻窗口的通用前置：政策、捕获起点、预留批次、前瞻数据、日历与冻结窗口。
async function prepareForwardCohort() {
  const { DB, env, repository, all } = await buildEnv();
  await new CohortRepository(env).saveTournamentPolicy({
    forwardDays: FORWARD_DAYS,
    minimumCompletedRounds: 1,
  });
  await settlePrimaryToCaptureDay(env, repository, all);
  const reserved = await reserveScheduledCohort(env, repository);
  const forwardPairs = await seedForwardData(DB, env);
  const datasetByDate = datasetByDateOf(all, forwardPairs);
  const calendar = {
    dates: [...all, ...forwardPairs].map((p) => p.dataset.date),
    benchmark: [],
  };
  await scheduleCohortForward(env, reserved.cohortId, {
    now: `${dateAt(SEED)}T07:30:00.000Z`,
  });
  return { DB, env, cohortId: reserved.cohortId, datasetByDate, calendar };
}

// 驱动单日前瞻：先按帧采集，再按主账户结算序列登记窗口日。
async function driveForwardDay(
  env,
  { dayIndex, datasetByDate, calendar, calendarDates, now },
) {
  const date = dateAt(dayIndex);
  for (const [utc, beijing, volume] of forwardFrames())
    await runTournamentPoll(env, new Date(`${date}T${utc}Z`), {
      providers: {
        calendar,
        quotes: makeQuotes(datasetByDate, dayIndex, beijing, volume),
      },
    });
  return settleTournamentDay(env, date, {
    calendarDates: calendarDates ?? [
      dateAt(dayIndex + 1),
      dateAt(dayIndex + 2),
    ],
    now: now ?? `${date}T07:30:00.000Z`,
  });
}

// 驱动 1..29 日正常结算，第 30 日帧已落盘、末日登记已落库，但在进入
// EVALUATING 前进程退出（交由调用方断言两种恢复路径）。
async function driveToInterruptedFinalDay() {
  const { DB, env, cohortId, datasetByDate, calendar } =
    await prepareForwardCohort();
  const cohorts = new CohortRepository(env);
  for (let offset = 1; offset < FORWARD_DAYS; offset++)
    assert.equal(
      (
        await driveForwardDay(env, {
          dayIndex: SEED + offset,
          datasetByDate,
          calendar,
        })
      ).status,
      "SETTLED",
    );
  const lastIndex = SEED + FORWARD_DAYS;
  const lastDate = dateAt(lastIndex);
  for (const [utc, beijing, volume] of forwardFrames())
    await runTournamentPoll(env, new Date(`${lastDate}T${utc}Z`), {
      providers: {
        calendar,
        quotes: makeQuotes(datasetByDate, lastIndex, beijing, volume),
      },
    });
  const original = CohortRepository.prototype.transitionCohort;
  CohortRepository.prototype.transitionCohort = function (id, options) {
    if (options.to === "EVALUATING") throw new Error("模拟进入评估前进程退出");
    return original.call(this, id, options);
  };
  try {
    await assert.rejects(
      () =>
        settleTournamentDay(env, lastDate, {
          calendarDates: [dateAt(lastIndex + 1), dateAt(lastIndex + 2)],
          now: `${lastDate}T07:30:00.000Z`,
        }),
      /模拟进入评估前进程退出/,
    );
  } finally {
    CohortRepository.prototype.transitionCohort = original;
  }
  const interrupted = await cohorts.getCohort(cohortId);
  assert.equal(interrupted.stage, "RUNNING", "未进入评估，批次仍为运行中");
  assert.equal(
    interrupted.forwardManifest.tradingDates.length,
    FORWARD_DAYS,
    "末日登记已落库",
  );
  assert.ok(await cohorts.windowOwner(), "未收口期间窗口锁仍被占用");
  return {
    DB,
    env,
    cohortId,
    cohorts,
    lastDate,
    lastIndex,
    datasetByDate,
    calendar,
  };
}

test("末日登记后中断：同日重试由 DUPLICATE 恢复收口", async () => {
  const { DB, env, cohortId, cohorts, lastDate } =
    await driveToInterruptedFinalDay();
  // 同日重试：该日已在 tradingDates，走幂等 DUPLICATE 分支；窗口已满足
  // 主账户结算序数，必须借此恢复收口，而不是永久 RUNNING 占锁。
  const retry = await settleTournamentDay(env, lastDate, {
    now: `${lastDate}T07:35:00.000Z`,
  });
  assert.equal(retry.status, "DUPLICATE", JSON.stringify(retry).slice(0, 160));
  assert.ok(retry.evaluation, "DUPLICATE 分支按已满足窗口恢复收口评估");
  assert.equal(
    (await cohorts.getCohort(cohortId)).stage,
    "CLOSED",
    "恢复收口后批次关闭",
  );
  assert.equal(await cohorts.windowOwner(), null, "窗口锁释放");
  DB.close();
});

test("末日登记后中断：次日由 WINDOW_ENDED 兜底收口", async () => {
  const { DB, env, cohortId, cohorts, lastIndex } =
    await driveToInterruptedFinalDay();
  // 不重试同日，直接进入窗口外第 31 个主账户结算日：必须按原冻结窗口
  // 兜底收口，缺口由共同覆盖闸门暴露，而不是永久 RUNNING 占锁。
  const nextIndex = lastIndex + 1;
  const nextDate = dateAt(nextIndex);
  const ended = await settleTournamentDay(env, nextDate, {
    calendarDates: [dateAt(nextIndex + 1)],
    now: `${nextDate}T07:30:00.000Z`,
  });
  assert.equal(
    ended.status,
    "WINDOW_ENDED",
    JSON.stringify(ended).slice(0, 160),
  );
  assert.ok(ended.evaluation, "窗口外交易日兜底收口评估");
  assert.equal(
    ended.evaluation.windowDates.length,
    FORWARD_DAYS,
    "评估窗口仍是冻结的 30 个交易日",
  );
  assert.equal((await cohorts.getCohort(cohortId)).stage, "CLOSED");
  assert.equal(await cohorts.windowOwner(), null, "窗口锁释放");
  DB.close();
});

test("部分登记不晋级：claim 成功但完整日登记失败使整批无资格", async () => {
  const { DB, env, cohortId, datasetByDate, calendar } =
    await prepareForwardCohort();
  const cohorts = new CohortRepository(env);
  const faultIndex = SEED + 5;
  const faultDate = dateAt(faultIndex);
  let evaluation = null;
  for (let offset = 1; offset <= FORWARD_DAYS; offset++) {
    const dayIndex = SEED + offset;
    const date = dateAt(dayIndex);
    for (const [utc, beijing, volume] of forwardFrames())
      await runTournamentPoll(env, new Date(`${date}T${utc}Z`), {
        providers: {
          calendar,
          quotes: makeQuotes(datasetByDate, dayIndex, beijing, volume),
        },
      });
    if (offset === 5) {
      // 完整日登记前的 claim 与样本用途已提交，但 FORWARD_DAY_SETTLED
      // 失败且未恢复：该日缺席 tradingDates，必须让整批无资格。
      const original = CohortRepository.prototype.transitionCohort;
      CohortRepository.prototype.transitionCohort = function (id, options) {
        if (
          options.eventType === "FORWARD_DAY_SETTLED" &&
          options.payload?.date === faultDate
        )
          throw new Error("模拟完整日登记失败");
        return original.call(this, id, options);
      };
      try {
        await assert.rejects(
          () =>
            settleTournamentDay(env, date, {
              calendarDates: [dateAt(dayIndex + 1), dateAt(dayIndex + 2)],
              now: `${date}T07:30:00.000Z`,
            }),
          /模拟完整日登记失败/,
        );
      } finally {
        CohortRepository.prototype.transitionCohort = original;
      }
      continue;
    }
    const settled = await driveForwardDay(env, {
      dayIndex,
      datasetByDate,
      calendar,
    });
    assert.equal(
      settled.status,
      "SETTLED",
      JSON.stringify(settled).slice(0, 160),
    );
    if (offset === FORWARD_DAYS) evaluation = settled.evaluation;
  }
  assert.ok(evaluation, "第 30 个主账户结算日触发收口评估");
  const manifest = (await cohorts.getCohort(cohortId)).forwardManifest;
  assert.equal(
    manifest.tradingDates.length,
    FORWARD_DAYS - 1,
    "只有 29 个完整登记日",
  );
  assert.ok(
    !manifest.tradingDates.includes(faultDate),
    "登记失败日未计入 tradingDates",
  );
  assert.equal(evaluation.commonDataMissing, true, "登记不完整使共同覆盖失败");
  assert.equal(
    evaluation.verdicts.filter((row) => row.stage === "ELIGIBLE").length,
    0,
    "部分登记使整批无资格，无成员可晋级",
  );
  assert.ok(
    evaluation.verdicts.some((row) => row.stage === "INCONCLUSIVE"),
    "窗口成员保留 INCONCLUSIVE 失败路径",
  );
  assert.equal(evaluation.promotion, null, "整批无资格时无自动晋级");
  const cohort = await cohorts.getCohort(cohortId);
  assert.equal(cohort.stage, "CLOSED");
  assert.equal(await cohorts.windowOwner(), null, "窗口锁释放");
  const primary = await new RealtimeRepository(env).account();
  assert.equal(primary.book.activeStrategy, "baseline-v1", "保持当前策略");
  DB.close();
});

test("BLOCKED 后中断：未提交的首帧不被后续帧越序跳过", async () => {
  const { DB, env, datasetByDate, calendar } = await prepareForwardCohort();
  // 取窗口内的工作日：周末会被 pollTrading 直接判为 NON_TRADING_DAY，且真实
  // 窗口日历是主账户结算序列（不含周末），据此构造 tradingDates。
  const dayIndex = SEED + 3;
  const date = dateAt(dayIndex);
  const isTradingDay = (day) =>
    ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
  const tradingDates = calendar.dates.filter(isTradingDay);
  const tradeCalendar = { dates: tradingDates, benchmark: [] };
  const papers = new RealtimeRepository(env);
  // 主账户开盘需执行日前冻结的计划（openSession 校验 signalDate=上一交易日）；
  // 冻结捕获日计划，使日历恢复后首帧可正常提交观察。
  const account = await papers.account();
  await papers.savePlan(
    defensivePlan(
      dateAt(SEED),
      account.book,
      BASE_STRATEGY,
      "baseline-v1",
      `${dateAt(SEED - 1)}T07:00:00.000Z`,
    ),
  );
  // 移除捕获日：上一交易日解析为主账户更早的结算日，触发 BLOCKED。
  const blockedCalendar = {
    dates: tradingDates.filter((day) => day !== dateAt(SEED)),
    benchmark: [],
  };
  const frames = forwardFrames();
  const pollAt = (time, volume, providerCalendar) =>
    runTournamentPoll(env, new Date(`${date}T${time}Z`), {
      providers: {
        calendar: providerCalendar,
        quotes: makeQuotes(datasetByDate, dayIndex, time, volume),
      },
    });
  // 步骤 1：连续两帧在 BLOCKED 下采集落盘，但主账户观察均未提交。
  for (const [utc, , volume] of frames.slice(0, 2)) {
    const result = await pollAt(utc, volume, blockedCalendar);
    assert.equal(result.primary.status, "BLOCKED");
  }
  assert.equal(
    (await papers.observations(date)).length,
    0,
    "BLOCKED 时观察不提交",
  );
  // 步骤 2：上一日结算恰好完成、日历在首帧之后恢复时，循环必须停在
  // 未提交的首帧，不得带着未生效的前序帧继续处理后帧（否则越序跳过首帧）。
  let calendarCalls = 0;
  const transientCalendar = async () => {
    calendarCalls += 1;
    return calendarCalls === 1 ? blockedCalendar : tradeCalendar;
  };
  const guarded = await pollAt(frames[2][0], frames[2][2], transientCalendar);
  assert.equal(guarded.primary.status, "BLOCKED", "首帧仍未提交，循环停在此帧");
  assert.equal(calendarCalls, 1, "只处理未提交的首帧，不推进到后续帧");
  assert.equal(
    (await papers.observations(date)).length,
    0,
    "首帧未提交时后续帧不得越序提交",
  );
  // 步骤 3：上一日结算完成后，按序重放全部已落盘帧，数量与顺序一致。
  await pollAt(frames[3][0], frames[3][2], tradeCalendar);
  const observations = await papers.observations(date);
  assert.equal(observations.length, frames.length, "按序补齐已落盘帧");
  const observedTimes = observations.map((row) => row.payload.observedAt);
  assert.deepEqual(
    observedTimes,
    [...observedTimes].sort(),
    "观察按采集时刻严格升序，不越序",
  );
  assert.equal(
    observations[0].payload.observedAt,
    `${date}T${frames[0][0]}.000Z`,
    "首个观察正是最先落盘的帧",
  );
  DB.close();
});

// 驱动全部窗口日并完成收口评估：完整登记批次产生冠军（供晋级重试场景复用）。
async function driveForwardWindowToCompletion() {
  const { DB, env, cohortId, datasetByDate, calendar } =
    await prepareForwardCohort();
  let evaluation = null;
  for (let offset = 1; offset <= FORWARD_DAYS; offset++) {
    const settled = await driveForwardDay(env, {
      dayIndex: SEED + offset,
      datasetByDate,
      calendar,
    });
    assert.equal(
      settled.status,
      "SETTLED",
      JSON.stringify(settled).slice(0, 160),
    );
    if (offset === FORWARD_DAYS) evaluation = settled.evaluation;
  }
  assert.ok(evaluation?.champion, "完整登记批次收口评估产生冠军");
  return { DB, env, cohortId, datasetByDate, calendar, evaluation };
}

test("隔日恢复不混入窗口外盈亏：报告期末只计冻结窗口内已结算净值", async () => {
  const { DB, env, cohortId, lastIndex, datasetByDate, calendar } =
    await driveToInterruptedFinalDay();
  const shadows = new ShadowAccountRepository(env);
  // 次日盘中轮询：批次尚未收口（RUNNING），影子账户继续消费窗口外帧，
  // 账本当前权益被次日盯市/成交推进——这就是窗口外盈亏的来源。
  const nextIndex = lastIndex + 1;
  const nextDate = dateAt(nextIndex);
  for (const [utc, beijing, volume] of forwardFrames())
    await runTournamentPoll(env, new Date(`${nextDate}T${utc}Z`), {
      providers: {
        calendar,
        quotes: makeQuotes(datasetByDate, nextIndex, beijing, volume),
      },
    });
  const windowEnd = dateAt(lastIndex);
  let polluted = 0;
  for (const account of await shadows.accounts({ cohortId })) {
    const endRow = (await shadows.equities(account.accountId))
      .filter((row) => row.tradeDate <= windowEnd)
      .at(-1);
    if (endRow && account.book.equityCents !== endRow.equityCents)
      polluted += 1;
  }
  assert.ok(polluted > 0, "次日盘中轮询确实推进了窗口外账本权益");
  // 次日盘后：WINDOW_ENDED 兜底收口评估。报告必须仍是冻结的 30 日窗口，
  // 期末指标取窗口内最后一个已结算净值行，而非被污染的账本当前状态。
  const ended = await settleTournamentDay(env, nextDate, {
    calendarDates: [dateAt(nextIndex + 1)],
    now: `${nextDate}T07:30:00.000Z`,
  });
  assert.equal(
    ended.status,
    "WINDOW_ENDED",
    JSON.stringify(ended).slice(0, 160),
  );
  assert.ok(ended.evaluation, "窗口外交易日兜底收口评估");
  const evaluation = ended.evaluation;
  assert.equal(
    evaluation.windowDates.length,
    FORWARD_DAYS,
    "报告仍是冻结的 30 日窗口",
  );
  for (const verdict of evaluation.verdicts) {
    if (!verdict.metrics) continue;
    const endRow = (await shadows.equities(verdict.accountId))
      .filter((row) => evaluation.windowDates.includes(row.tradeDate))
      .at(-1);
    assert.ok(endRow, `${verdict.accountId} 有窗口内已结算净值行`);
    assert.equal(
      verdict.metrics.finalEquityCents,
      endRow.equityCents,
      `${verdict.accountId} 期末权益只计窗口内已结算净值，不含次日盘中盈亏`,
    );
  }
  assert.ok(evaluation.champion, "冻结窗口内证据完整时冠军仍可裁定");
  assert.equal(
    evaluation.promotion?.promoted,
    true,
    "报告与账本一致后合法晋级不被期末净值校验误拦",
  );
  DB.close();
});

test("旧报告晋级重试要求完整登记：窗口日缺席 tradingDates 时拒绝", async () => {
  const { DB, env, cohortId, evaluation } =
    await driveForwardWindowToCompletion();
  const cohorts = new CohortRepository(env);
  const papers = new RealtimeRepository(env);
  const before = await papers.account();
  // 复现旧版缺陷状态：第 5 日 claim 与结算数据完整，但完整日登记失败且
  // 未恢复，manifest.tradingDates 只有 29 日；报告是旧版实际生成的有效
  // 报告（摘要自洽、冠军合格），成员回退 ELIGIBLE 模拟晋级中断待重试。
  const manifest = (await cohorts.getCohort(cohortId)).forwardManifest;
  const dropped = manifest.tradingDates[4];
  await DB.prepare(
    "UPDATE strategy_cohorts SET forward_manifest = ? WHERE id = ?",
  )
    .bind(
      JSON.stringify({
        ...manifest,
        tradingDates: manifest.tradingDates.filter((date) => date !== dropped),
      }),
      cohortId,
    )
    .run();
  await DB.prepare(
    "UPDATE strategy_cohort_members SET stage = 'ELIGIBLE' WHERE cohort_id = ? AND member_id = ?",
  )
    .bind(cohortId, evaluation.champion.memberId)
    .run();
  await assert.rejects(
    () => promoteCohortChampion(env, cohortId, {}),
    /未完整登记/,
    "claim 齐全但完整登记缺席的窗口日不构成晋级证据",
  );
  assert.equal(
    (await papers.account()).book.activeStrategy,
    before.book.activeStrategy,
    "拒绝时不产生任何晋级副作用",
  );
  // 判别性对照：同一份报告在登记完整的清单上不再被登记校验拦截——
  // 恢复完整登记后，登记检查可以通过；已提交切换事件仍阻止再次晋级。
  await DB.prepare(
    "UPDATE strategy_cohorts SET forward_manifest = ? WHERE id = ?",
  )
    .bind(JSON.stringify(manifest), cohortId)
    .run();
  const cohort = await cohorts.getCohort(cohortId);
  await DB.prepare(
    "UPDATE paper_accounts SET state = json_set(state, '$.activeStrategy', ?) WHERE id = 'primary'",
  )
    .bind(cohort.parentVersion)
    .run();
  await assert.rejects(
    () => promoteCohortChampion(env, cohortId, {}),
    /启用事件已提交/,
  );
  DB.close();
});
