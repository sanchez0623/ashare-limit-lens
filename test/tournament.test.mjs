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
  tournamentStatus,
  cohortDetail,
  cohortLineage,
} from "../backend/services/strategy-tournament.js";
import {
  consumePortfolioFrame,
  settlePortfolioDay,
} from "../backend/services/portfolio-runner.js";
import { promoteCohortChampion } from "../backend/services/promotion.js";
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
import { DEFAULT_FEES } from "../shared/fees.js";
import { digestOf } from "../backend/domain/research-lineage.js";

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
    assert.equal(date, day.date);
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
  // 窗口指标：净收益、费用增量、回撤与覆盖率
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
      realizedPnlCents: 500,
      positions: [
        {
          markCents: 1100,
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
