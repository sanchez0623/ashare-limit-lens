import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEvidencePolicy,
  DEFAULT_EVIDENCE_POLICY,
  REVIEW_METRIC_FAMILY,
} from "../backend/domain/evidence-policy.js";
import {
  computeDailyReviewMetrics,
  spearman,
} from "../backend/domain/review-metrics.js";
import {
  buildEvidenceWindow,
  resampleSegmentIndexMatrix,
  bootstrapMeanEvidence,
  adjustEvidenceFamily,
  evidenceSeed,
} from "../backend/domain/research-statistics.js";
import { EvidenceRepository } from "../backend/storage/evidence.js";
import {
  recordReviewDailyMetric,
  buildReviewEvidence,
  buildAccountEvidence,
  recomputeEvidence,
  exportEvidence,
  refreshEvidence,
} from "../backend/services/evidence.js";
import { verifyEvidenceBundle } from "../scripts/verify-evidence.mjs";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { api } from "../backend/routes/api.js";

// ---------- 交易日日历（合成，周一至周五） ----------
function tradingDates(count, start = "2026-01-05") {
  const result = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  while (result.length < count) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6)
      result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

// ---------- 合成评分快照与复盘行（收益单位：百分点，与生产一致） ----------
function snapshotPayload(date, dayIndex, stockCount = 12) {
  return {
    date,
    createdAt: `${date}T07:10:00.000Z`,
    modelVersion: "rules-v1",
    weights: [8, 8, 8, 8, 8, 8],
    stocks: Array.from({ length: stockCount }, (_, index) => ({
      code: `3000${String(index).padStart(2, "0")}`,
      name: `合成${index}`,
      sector: "测试行业",
      // 分数与日期确定性相关：正向效应情景
      score: 95 - index * 2 + (dayIndex % 3),
      price: 10 + index,
      height: 1,
      risks: [],
    })),
  };
}
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function reviewPayload(
  date,
  snapshot,
  dayIndex,
  { effect = 0.02, missingTop = false } = {},
) {
  // 逐日独立伪随机噪声：不引入横截面系统性趋势
  const noiseRandom = mulberry32(((dayIndex + 1) * 2654435761) >>> 0);
  const rows = snapshot.stocks.map((stock, index) => {
    const missing = missingTop && index === 0;
    // 高分股获得正效应：观察收益 = 独立噪声 + effect×(score/95)
    const noise = (noiseRandom() * 2 - 1) * 0.01;
    const ret = noise + effect * (stock.score / 95);
    return {
      code: stock.code,
      available: !missing,
      reason: missing ? "行情日期不匹配或停牌" : null,
      closeReturn: Number((ret * 100).toFixed(4)),
      continued: false,
    };
  });
  return {
    date,
    snapshotDate: snapshot.date,
    modelVersion: "rules-v1",
    rows,
    validCount: rows.filter((row) => row.available).length,
    coverage: rows.filter((row) => row.available).length / rows.length,
    systemScore: null,
  };
}
async function seedReviewHistory(env, dates, { effect, missingTopIndex } = {}) {
  for (const [index, date] of dates.entries()) {
    const snapshot = snapshotPayload(date, index);
    await (await import("../backend/storage/database.js"))
      .database(env)
      .prepare(
        "INSERT OR IGNORE INTO snapshots (trade_date, created_at, payload) VALUES (?,?,?)",
      )
      .bind(date, snapshot.createdAt, JSON.stringify(snapshot))
      .run();
  }
  for (const [index, date] of dates.entries()) {
    if (index === 0) continue;
    const snapshot = snapshotPayload(dates[index - 1], index - 1);
    const review = reviewPayload(date, snapshot, index, {
      effect,
      missingTop: missingTopIndex === index,
    });
    await (await import("../backend/storage/database.js"))
      .database(env)
      .prepare(
        "INSERT OR IGNORE INTO reviews (trade_date, snapshot_date, created_at, payload) VALUES (?,?,?,?)",
      )
      .bind(date, snapshot.date, review.date, JSON.stringify(review))
      .run();
  }
}

test("证据政策：严格 schema 拒绝未知字段、越界与非主视图窗口", () => {
  const policy = normalizeEvidencePolicy(undefined);
  assert.deepEqual(policy.windows, DEFAULT_EVIDENCE_POLICY.windows);
  assert.equal(policy.primaryWindow, 60);
  assert.equal(policy.purpose, "DIAGNOSTIC");
  assert.throws(
    () => normalizeEvidencePolicy({ ...DEFAULT_EVIDENCE_POLICY, bogus: 1 }),
    /未知字段/,
  );
  assert.throws(
    () =>
      normalizeEvidencePolicy({
        ...DEFAULT_EVIDENCE_POLICY,
        resamples: 50,
      }),
    /超出范围/,
  );
  assert.throws(
    () =>
      normalizeEvidencePolicy({
        ...DEFAULT_EVIDENCE_POLICY,
        primaryWindow: 30,
      }),
    /必须属于 windows/,
  );
  assert.throws(
    () =>
      normalizeEvidencePolicy({
        ...DEFAULT_EVIDENCE_POLICY,
        blockLengthSensitivity: [3, 10],
      }),
    /敏感性预登记/,
  );
});

test("评分日指标：并列取平均秩、冻结 Top 不重选、单位为小数", async () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.equal(spearman([5, 5, 5, 5], [1, 2, 3, 4]), null, "常数分数退化");
  const policy = normalizeEvidencePolicy(undefined);
  const stocks = [
    { code: "A", score: 95 },
    { code: "B", score: 90 },
    { code: "C", score: 85 },
    { code: "D", score: 80 },
    { code: "E", score: 75 },
  ];
  // Top 20% = 1 只：A 冻结为前组；A 停牌时不重选 Top，B 不顶替。
  const metric = await computeDailyReviewMetrics({
    frozenSnapshot: {
      date: "d0",
      resultDate: "d1",
      modelVersion: "rules-v1",
      stocks,
    },
    verifiedOutcomes: [
      { code: "A", available: false, reason: "停牌" },
      { code: "B", returnDecimal: 0.02, available: true },
      { code: "C", returnDecimal: 0.01, available: true },
      { code: "D", returnDecimal: 0.004, available: true },
      { code: "E", returnDecimal: -0.01, available: true },
    ],
    policy,
  });
  assert.equal(metric.quality.validStocks, 4);
  assert.equal(metric.quality.topStocks, 0, "A 停牌后前组有效为 0，不补齐");
  assert.equal(metric.exclusionReasons.A, "停牌");
  // 超额与均值均为小数：topMean 0.01 = 1 个百分点
  assert.ok(Math.abs(metric.values.allMeanDecimal - 0.006) < 1e-12);
  // IC 基于全部有效样本（4 只），与 Top 是否有效无关
  assert.equal(metric.values.ic, 1, "B–E 分数与收益完全同序");
  assert.equal(
    metric.status,
    "INSUFFICIENT_SAMPLE",
    "前组不足进入样本不足状态",
  );
  const full = await computeDailyReviewMetrics({
    frozenSnapshot: {
      date: "d0",
      resultDate: "d1",
      modelVersion: "rules-v1",
      // 20 只股票：Top 20% = 4 只 ≥ minTopStocks
      stocks: Array.from({ length: 20 }, (_, index) => ({
        code: `6000${String(index).padStart(2, "0")}`,
        score: 95 - index * 2,
      })),
    },
    verifiedOutcomes: Array.from({ length: 20 }, (_, index) => ({
      code: `6000${String(index).padStart(2, "0")}`,
      available: true,
      returnDecimal: 0.05 - index * 0.005,
    })),
    policy,
  });
  assert.equal(full.status, "READY");
  assert.equal(full.values.ic, 1, "分数与收益完全同序");
  // 超额 = 前20%均值 − 全样本均值（小数）
  const expectedExcess = (0.05 + 0.045 + 0.04 + 0.035) / 4 - 0.0025;
  assert.ok(Math.abs(full.values.excessDecimal - expectedExcess) < 1e-12);
});

test("缺口窗口：缺失日期留在窗口、片段独立、覆盖不足返回原因", () => {
  const dates = tradingDates(10);
  const metrics = new Map();
  dates.forEach((date, index) => {
    if (index !== 4) metrics.set(date, { ic: 0.1, excessDecimal: 0.001 });
  });
  const window = buildEvidenceWindow({
    expectedDates: dates,
    dailyMetrics: metrics,
    horizon: 10,
  });
  assert.deepEqual(window.missingDates, [dates[4]]);
  assert.deepEqual(
    window.segments.map((segment) => segment.length),
    [4, 5],
    "缺口把有效日期分成两个连续片段",
  );
  assert.ok(Math.abs(window.coverage - 0.9) < 1e-12);
});

test("片段区块：索引从不跨缺口拼接；短片段返回 INCOMPLETE_DATA", async () => {
  const seed = await evidenceSeed({
    namespace: "test",
    purpose: "DIAGNOSTIC",
    asOf: "2026-01-16",
    orderedWindowDates: ["a", "b"],
    inputDigest: "in",
    policyDigest: "pol",
  });
  const { matrix } = await resampleSegmentIndexMatrix({
    segmentLengths: [5, 5],
    blockLength: 5,
    resamples: 50,
    seedInput: seed,
  });
  for (const indices of matrix) {
    for (const index of indices.slice(0, 5))
      assert.ok(index >= 0 && index < 5, "第一段索引不越界");
    for (const index of indices.slice(5))
      assert.ok(index >= 5 && index < 10, "第二段索引不越界");
  }
  const short = await resampleSegmentIndexMatrix({
    segmentLengths: [3, 7],
    blockLength: 5,
    resamples: 10,
    seedInput: seed,
  });
  assert.equal(short.matrix, null);
  assert.equal(short.reason, "INCOMPLETE_DATA");
});

test("basic 区间与居中 p：确定性、p 下界、方向一致、退化拒绝", async () => {
  const values = Array.from(
    { length: 60 },
    (_, index) => Math.sin(index * 3.7) * 0.01 + index * 1e-5,
  );
  const seed = await evidenceSeed({
    namespace: "t",
    purpose: "DIAGNOSTIC",
    asOf: "x",
    orderedWindowDates: values.map((_, index) => String(index)),
    inputDigest: "in",
    policyDigest: "pol",
  });
  const { matrix } = await resampleSegmentIndexMatrix({
    segmentLengths: [60],
    blockLength: 5,
    resamples: 2000,
    seedInput: seed,
  });
  const first = bootstrapMeanEvidence({
    values,
    indexMatrix: matrix,
    confidenceLevel: 0.95,
  });
  const second = bootstrapMeanEvidence({
    values,
    indexMatrix: matrix,
    confidenceLevel: 0.95,
  });
  assert.deepEqual(first.ci, second.ci, "同输入同种子结果完全一致");
  assert.ok(
    first.ci.lower <= first.estimate && first.estimate <= first.ci.upper,
  );
  assert.ok(first.pRaw >= 1 / 2001, "p 至少为 1/(B+1)");
  // 单侧方向与均值一致：正均值时单侧 p 不大于双侧 p
  const oneSided = bootstrapMeanEvidence({
    values,
    indexMatrix: matrix,
    confidenceLevel: 0.95,
    side: "POSITIVE",
  });
  assert.ok(oneSided.pRaw <= first.pRaw);
  // 常数序列退化：不虚构区间或 p=0
  const degenerate = bootstrapMeanEvidence({
    values: Array(60).fill(0.001),
    indexMatrix: matrix,
  });
  assert.equal(degenerate.status, "DEGENERATE");
  assert.equal(degenerate.pRaw, null);
  // 非有限输入拒绝
  const nonFinite = bootstrapMeanEvidence({
    values: values.map((value, index) => (index === 3 ? Number.NaN : value)),
    indexMatrix: matrix,
  });
  assert.equal(nonFinite.status, "DEGENERATE");
  // 零效应序列双侧 p 应偏大（不超过 0.05 的比例受模拟验收控制）
  const zero = bootstrapMeanEvidence({
    values: Array.from(
      { length: 60 },
      (_, index) => Math.cos(index * 11.3) * 0.01,
    ),
    indexMatrix: matrix,
  });
  assert.ok(zero.pRaw > 0.01, "零效应序列不应出现极小 p");
});

test("Holm 校正：族大小保留、不可估计占位 p=1、单调映射", () => {
  const family = adjustEvidenceFamily({
    declaredHypotheses: ["MEAN_DAILY_IC", "MEAN_DAILY_EXCESS"],
    results: [
      { key: "MEAN_DAILY_IC", pRaw: 0.01 },
      { key: "MEAN_DAILY_EXCESS", pRaw: 0.04 },
    ],
    method: "HOLM",
  });
  assert.equal(family.familySize, 2);
  const byKey = new Map(family.hypotheses.map((row) => [row.key, row]));
  // p=0.01 排第一：×2 = 0.02；p=0.04 排第二：×1 = 0.04，且单调 ≥ 0.02
  assert.ok(
    Math.abs(byKey.get("MEAN_DAILY_IC").pAdjustedWithinFamily - 0.02) < 1e-12,
  );
  assert.ok(
    Math.abs(byKey.get("MEAN_DAILY_EXCESS").pAdjustedWithinFamily - 0.04) <
      1e-12,
  );
  const withBroken = adjustEvidenceFamily({
    declaredHypotheses: ["MEAN_DAILY_IC", "MEAN_DAILY_EXCESS"],
    results: [
      { key: "MEAN_DAILY_IC", pRaw: 0.01 },
      { key: "MEAN_DAILY_EXCESS", pRaw: null, reason: "检验不可估计" },
    ],
    method: "HOLM",
  });
  const broken = withBroken.hypotheses.find(
    (row) => row.key === "MEAN_DAILY_EXCESS",
  );
  assert.equal(broken.pAdjustedWithinFamily, null, "不可估计外部返回 null");
  assert.equal(broken.estimable, false);
  // 族大小仍为 2：不可估计占名额，IC 的校正值 ×2 = 0.02 而非 ×1
  assert.ok(
    Math.abs(
      withBroken.hypotheses.find((row) => row.key === "MEAN_DAILY_IC")
        .pAdjustedWithinFamily - 0.02,
    ) < 1e-12,
  );
});

test("端到端：日指标登记 → 诊断报告发布 → 确定性重算 → 导出核验", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(120);
    await seedReviewHistory(env, dates, { effect: 0.004 });
    for (const date of dates.slice(1)) await recordReviewDailyMetric(env, date);
    const repository = new EvidenceRepository(env);
    const stored = await repository.listDailyMetricsAcrossContexts({
      seriesId: "review-primary",
      fromDate: dates[0],
      toDate: dates.at(-1),
    });
    assert.equal(stored.length, dates.length - 1);
    const report = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    assert.equal(report.purpose, "DIAGNOSTIC");
    assert.equal(report.payload.eligibleForPromotion, false);
    assert.equal(report.payload.repeatedLooksAdjusted, false);
    assert.equal(report.payload.status, "READY");
    assert.ok(report.payload.tags.includes("OBSERVATION_NOT_EXECUTABLE"));
    assert.ok(report.payload.tags.includes("EXPLORATORY_REPEATED_LOOKS"));
    assert.deepEqual(
      report.payload.family.map((entry) => entry.metric),
      REVIEW_METRIC_FAMILY,
    );
    const ic = report.payload.family[0];
    assert.equal(ic.unit, "CORRELATION");
    assert.ok(ic.ci.lower <= ic.estimate && ic.estimate <= ic.ci.upper);
    // 正效应情景：均值 IC 应偏正
    assert.ok(ic.estimate > 0, `正效应下 IC 均值应偏正，实际 ${ic.estimate}`);
    assert.ok(
      report.payload.family[1].unit === "DECIMAL_RETURN",
      "超额单位为小数收益",
    );
    // 同输入重发布：幂等不覆写
    const again = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    assert.equal(again.id, report.id);
    assert.equal(again.digest, report.digest);
    // 方法模拟资格（§10）：模拟未达标的 20 日窗口如实标注受限探索，
    // 达标的 120 日窗口不带该标签
    assert.ok(
      report.payload.tags.includes("METHOD_SIMULATION_LIMITED"),
      "h20 方法模拟未达标，应标注受限探索",
    );
    const longReport = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 120,
      calendarDates: dates,
    });
    assert.equal(longReport.payload.status, "READY");
    assert.ok(
      !longReport.payload.tags.includes("METHOD_SIMULATION_LIMITED"),
      "h120 方法模拟达标",
    );
    // recompute 确定性：同种子同输入 → 同一报告
    const recomputed = await recomputeEvidence(env, {
      id: report.id,
      calendarDates: dates,
    });
    assert.equal(recomputed.id, report.id);
    // 导出与独立核验
    const bundle = await exportEvidence(env, { id: report.id });
    const audit = await verifyEvidenceBundle(bundle);
    assert.equal(audit.passed, true, JSON.stringify(audit));
    // 篡改区间 → 核验拒绝
    const tampered = structuredClone(bundle);
    tampered.report.payload.family[0].ci.lower += 0.01;
    const tamperAudit = await verifyEvidenceBundle(tampered);
    assert.equal(tamperAudit.passed, false);
    // 缺口情景：窗口内只登记 5 天指标 → 覆盖不足 INCOMPLETE_DATA，
    // 日历不补长、不虚构区间
    const DB2 = localDatabase(),
      env2 = { DB: DB2 };
    try {
      await seedReviewHistory(env2, dates, { effect: 0.004 });
      // 只登记窗口内 5 天指标（h20 窗口 = 最后 20 个交易日）
      for (const date of dates.slice(105, 110))
        await recordReviewDailyMetric(env2, date);
      const incomplete = await buildReviewEvidence(env2, {
        asOf: dates.at(-1),
        horizon: 20,
        calendarDates: dates,
      });
      assert.equal(incomplete.payload.status, "INCOMPLETE_DATA");
      assert.ok(incomplete.payload.reasons.length >= 1);
      assert.equal(incomplete.payload.eligibleForPromotion, false);
      assert.equal(incomplete.payload.window.validDates.length, 5);
      assert.equal(incomplete.payload.window.missingDates.length, 15);
    } finally {
      DB2.close();
    }
    // 账户系列：无匹配对照 → NO_COMPARABLE_BASELINE；现金日 0 收益保留
    const paper = new PaperRepository(env);
    await paper.initialize();
    for (const [index, date] of dates.entries()) {
      const equity = {
        date,
        equityCents: 100000000 + index * 100000,
        cashCents: 0,
        marketValueCents: 0,
        dailyPnlCents: 0,
        dailyReturn: 0,
        totalReturn: 0,
        realizedPnlCents: 0,
        unrealizedPnlCents: 0,
        feesCents: 0,
        drawdown: 0,
        complete: true,
        positionCount: 0,
        missingMinuteOrders: 0,
        source: "fixture",
      };
      await DB.prepare(
        "INSERT OR IGNORE INTO paper_equity (trade_date, payload) VALUES (?,?)",
      )
        .bind(date, JSON.stringify(equity))
        .run();
    }
    const account = await buildAccountEvidence(env, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    assert.ok(account.payload.tags.includes("NO_COMPARABLE_BASELINE"));
    assert.ok(account.payload.tags.includes("COST_PRIOR_UNCALIBRATED"));
    assert.equal(account.payload.status, "READY");
    const accountMetric = account.payload.family[0];
    // 窗口首日相对捕获期初权益：日收益约 0.1%（小数 0.001，允许复利基数漂移）
    assert.ok(
      Math.abs(accountMetric.estimate - 0.001) < 1e-4,
      `每日收益应接近 0.1%，实际 ${accountMetric.estimate}`,
    );
    // API：GET 只读 + 越权 horizon 拒绝
    const overview = await api(
      new Request("https://example.test/api/evidence"),
      env,
    );
    assert.equal(overview.status, 200);
    const bad = await api(
      new Request("https://example.test/api/evidence?horizon=3"),
      env,
    );
    assert.equal(bad.status, 400);
  } finally {
    DB.close();
  }
});

test("盘后编排：来源缺失不阻塞，指标登记后幂等补齐报告", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    // 120 个交易日日历：预登记窗口 20/60/120 全部可冻结，不补长
    const dates = tradingDates(120);
    const first = await refreshEvidence(env, {
      date: dates.at(-1),
      calendarDates: dates,
    });
    assert.equal(first.recorded, false, "无复盘来源时如实登记失败");
    assert.ok(first.errors.length >= 1);
    assert.ok(
      first.reports.every(
        (row) => row.status === "PENDING" || row.status === "INCOMPLETE_DATA",
      ),
      "无来源时发布 PENDING/INCOMPLETE 报告，不虚构证据",
    );
    await seedReviewHistory(env, dates, { effect: 0.004 });
    for (const date of dates.slice(1)) await recordReviewDailyMetric(env, date);
    const second = await refreshEvidence(env, {
      date: dates.at(-1),
      calendarDates: dates,
    });
    assert.equal(second.recorded, true);
    assert.equal(second.reports.length, 6, "三个预登记窗口 × 两个系列");
    assert.ok(second.reports.every((row) => row.id));
  } finally {
    DB.close();
  }
});
