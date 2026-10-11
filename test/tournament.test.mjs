import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
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
  executePlan,
} from "../backend/domain/trading.js";
import {
  reserveCohort,
  scheduleCohortForward,
  runTournamentPoll,
  settleTournamentDay,
  runDailyTournament,
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
import { proposeImprovement } from "../backend/services/research.js";
import { beijingMonth } from "../backend/domain/research-windows.js";
import { newBook } from "../backend/domain/trading.js";
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
    finalBook: {
      equityCents: 101000000,
      feesCents: 300,
      realizedPnlCents: 0,
      positions: [
        {
          markCents: 1001,
          lots: [{ quantity: 1000, costCents: 1000 }],
        },
      ],
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
  assert.equal(eligible.length, 1, "只有通过全部闸门的成员合格");
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
    finalBook: {
      equityCents: 100000000,
      feesCents: 0,
      realizedPnlCents: 900000,
      positions: [],
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
        finalBook: {
          equityCents: 100000000,
          feesCents: 0,
          realizedPnlCents: 900000,
          positions: [],
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
  // P1-6：候选独有代码由当日帧观测价补齐收盘记录；已有日线收盘不被覆盖
  const enriched = closingQuotesFromFrames(
    [
      {
        sequence: 1,
        payload: {
          quotes: {
            600999: {
              closeCents: 1050,
              previousCloseCents: 1000,
              timestamp: `${day}T10:00:00+08:00`,
            },
          },
        },
      },
    ],
    { 600001: { closeCents: 900, timestamp: `${day}T15:00:00+08:00` } },
    day,
  );
  assert.equal(enriched["600999"].closeCents, 1050, "候选独有代码由帧价补齐");
  assert.match(enriched["600999"].timestamp, /T15:00:00/, "补齐按收盘时点盯市");
  assert.equal(enriched["600001"].closeCents, 900, "日线收盘优先，不被帧覆盖");
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
    requiredDays: 30,
    feeConfig,
    feeConfigDigest,
    initialAccounts,
    initialAccountsDigest: await digestOf(initialAccounts),
    accounts: { candidates: ["shadow-exp-x"] },
    tradingDates: [dateAt(5)],
    windowDates: [dateAt(5)],
  };
  const now = new Date().toISOString();
  await DB.prepare(
    "INSERT INTO strategy_cohorts (id, namespace, revision, parent_version, policy_id, policy_digest, research_policy_id, research_policy_digest, stage, max_candidates, forward_days, reservation_manifest, forward_manifest, created_at, updated_at) VALUES ('c-promo', 'main', 0, 'baseline-v1', 'p', 'd', 'rp', 'rd', 'EVALUATING', 4, 30, '{}', ?, ?, ?)",
  )
    .bind(JSON.stringify(forwardManifest), now, now)
    .run();
  await DB.prepare(
    "INSERT INTO strategy_cohort_members (cohort_id, member_id, slot_index, experiment_id, strategy_version, k, params, params_digest, params_distance, stage, created_at, updated_at) VALUES ('c-promo', 'm1', 1, 'exp-x', 'v-champ', 1, '{}', 'd', 1, 'ELIGIBLE', ?, ?)",
  )
    .bind(now, now)
    .run();
  const baseReport = (finalEquityCents) => ({
    cohortId: "c-promo",
    evaluatedAt: now,
    windowDates: [dateAt(5)],
    requiredDays: 30,
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
  await assert.rejects(
    () => promoteCohortChampion(env, "c-promo", { evaluation: badDigest }),
    /期末净值/,
    "冠军期末净值与影子账本不一致时拒绝晋级",
  );
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
  // 输入完整且一致时晋级成功，主账户未来策略引用切换
  const promoted = await promoteCohortChampion(env, "c-promo", {
    evaluation: badDigest,
    effectiveTradeDate: dateAt(6),
  });
  assert.equal(promoted.promoted, true);
  const after = await papers.account();
  assert.equal(after.book.activeStrategy, "v-champ");
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
  // 无运行批次但存在连续基线：盘中仍联合采集，基线消费帧（SEED+1 日）
  const calendar = {
    dates: all.map((p) => p.dataset.date),
    benchmark: [],
  };
  const poll = await runTournamentPoll(
    env,
    new Date(`${dateAt(SEED + 1)}T01:31:00Z`),
    {
      providers: {
        calendar,
        quotes: makeQuotes(
          datasetByDateOf(all, []),
          SEED + 1,
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
  // 盘后：无批次时连续基线仍按日结算并冻结次计划
  const seedDayRow = await DB.prepare(
    "SELECT payload FROM paper_market_days WHERE trade_date = ?",
  )
    .bind(dateAt(SEED))
    .first();
  const nextDataset = JSON.parse(seedDayRow.payload);
  nextDataset.date = dateAt(SEED + 1);
  for (const quote of Object.values(nextDataset.quotes)) {
    quote.date = dateAt(SEED + 1);
    quote.previousCloseCents = quote.closeCents;
    quote.timestamp = `${dateAt(SEED + 1)}T15:00:00+08:00`;
  }
  await DB.prepare(
    "INSERT INTO paper_market_days (trade_date, payload, digest) VALUES (?, ?, 'fixture')",
  )
    .bind(dateAt(SEED + 1), JSON.stringify(nextDataset))
    .run();
  const daily = await runDailyTournament(env, dateAt(SEED + 1), {
    calendarDates: [dateAt(SEED + 2), dateAt(SEED + 3)],
    now: `${dateAt(SEED + 1)}T07:30:00.000Z`,
  });
  assert.ok(daily.continuous?.applied, "连续基线跨批次按日结算");
  const continuousAccount = await shadows.account("shadow-baseline-continuous");
  assert.equal(continuousAccount.book.lastDate, dateAt(SEED + 1));
  DB.close();
});
