import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  DIAGNOSTIC_METHOD_VERSION,
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
import { digestOf } from "../backend/domain/research-lineage.js";
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
// 空样本窗口：登记空评分快照与复盘，全部日指标因无有效样本被每日质量
// 闸门剔除（用于 P1 正常导出误拒绝 / 零样本漏验回归）。
async function seedEmptyReviews(env, dates) {
  const db = (await import("../backend/storage/database.js")).database(env);
  for (const date of dates) {
    const snapshot = {
      date,
      createdAt: `${date}T07:10:00.000Z`,
      modelVersion: "rules-v1",
      weights: [8, 8, 8, 8, 8, 8],
      stocks: [],
    };
    await db
      .prepare(
        "INSERT OR IGNORE INTO snapshots (trade_date, created_at, payload) VALUES (?,?,?)",
      )
      .bind(date, snapshot.createdAt, JSON.stringify(snapshot))
      .run();
    const review = {
      date,
      snapshotDate: date,
      modelVersion: "rules-v1",
      rows: [],
      validCount: 0,
      coverage: 0,
      systemScore: null,
    };
    await db
      .prepare(
        "INSERT OR IGNORE INTO reviews (trade_date, snapshot_date, created_at, payload) VALUES (?,?,?,?)",
      )
      .bind(date, date, review.date, JSON.stringify(review))
      .run();
  }
  for (const date of dates) await recordReviewDailyMetric(env, date);
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

// ---------- 合成 K 线响应（默认日历路径的 fetch 桩） ----------
function klineResponse(dates) {
  return {
    ok: true,
    json: async () => ({
      data: {
        sh000001: {
          day: dates.map((date) => [date, "10", "10", "10", "10", "100"]),
        },
      },
    }),
  };
}

test("冻结日历：默认路径按窗口长度取数，未来日历回退自取（P1-2）", async () => {
  const DB = localDatabase(),
    env = { DB };
  const originalFetch = globalThis.fetch;
  try {
    const asOf = "2026-12-31";
    const allDates = tradingDates(280, "2026-01-01");
    const pastDates = allDates.filter((date) => date <= asOf);
    globalThis.fetch = async () => klineResponse(pastDates);
    // 默认接口不再只取 80 条：120 日窗口可以完整冻结
    const report = await buildReviewEvidence(env, { asOf, horizon: 120 });
    assert.equal(report.payload.window.expectedDates.length, 120);
    assert.equal(report.payload.window.expectedDates.at(-1), pastDates.at(-1));
    // 自动流程误传未来日历（账户结算交出的下一交易日列表）：过滤后为空，
    // 回退到自行冻结而不是冻结出空窗口
    const futureCalendar = allDates.filter((date) => date > asOf).slice(0, 10);
    assert.ok(futureCalendar.length >= 10);
    const refreshed = await refreshEvidence(env, {
      date: pastDates.at(-1),
      calendarDates: futureCalendar,
    });
    assert.equal(
      refreshed.reports.length,
      6,
      "未来日历回退自取后三窗口 × 两系列全部发布",
    );
    const review20 = refreshed.reports.find(
      (row) => row.series === "review-primary" && row.horizon === 20,
    );
    assert.ok(review20?.id);
  } finally {
    globalThis.fetch = originalFetch;
    DB.close();
  }
});

test("每日质量闸门：不合格日不计为有效样本且公开剔除原因（P1-3）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(120);
    // 空评分快照与空复盘行：每日指标全部 INSUFFICIENT_SAMPLE
    const db = (await import("../backend/storage/database.js")).database(env);
    for (const date of dates) {
      const snapshot = {
        date,
        createdAt: `${date}T07:10:00.000Z`,
        modelVersion: "rules-v1",
        weights: [8, 8, 8, 8, 8, 8],
        stocks: [],
      };
      await db
        .prepare(
          "INSERT OR IGNORE INTO snapshots (trade_date, created_at, payload) VALUES (?,?,?)",
        )
        .bind(date, snapshot.createdAt, JSON.stringify(snapshot))
        .run();
      const review = {
        date,
        snapshotDate: date,
        modelVersion: "rules-v1",
        rows: [],
        validCount: 0,
        coverage: 0,
        systemScore: null,
      };
      await db
        .prepare(
          "INSERT OR IGNORE INTO reviews (trade_date, snapshot_date, created_at, payload) VALUES (?,?,?,?)",
        )
        .bind(date, date, review.date, JSON.stringify(review))
        .run();
    }
    for (const date of dates) await recordReviewDailyMetric(env, date);
    const report = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    assert.equal(
      report.payload.status,
      "INSUFFICIENT_SAMPLE",
      "120 天全部不合格时不得显示 READY",
    );
    assert.equal(report.payload.window.coverage, 0, "覆盖率如实为 0");
    assert.equal(report.payload.window.validDates.length, 0);
    assert.equal(report.payload.window.excludedDates.length, 20);
    assert.equal(report.payload.family.length, 0);
    assert.ok(
      Object.values(report.payload.window.exclusionReasons).every(
        (reason) => reason && reason.length > 0,
      ),
      "剔除原因公开",
    );
  } finally {
    DB.close();
  }
});

test("账户缺口与期初相邻性：跨缺口不算一天，净值完整性核验（P1-4）", async () => {
  const equityPayload = (date, cents) =>
    JSON.stringify({
      date,
      equityCents: cents,
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
    });
  // 情景一：h60 窗口（longDates[80..139]）内 index 130 缺失
  const DB = localDatabase(),
    env = { DB };
  try {
    const paper = new PaperRepository(env);
    await paper.initialize();
    const longDates = tradingDates(140);
    for (const [index, date] of longDates.entries()) {
      if (index === 130) continue; // 窗口内缺口
      await DB.prepare(
        "INSERT OR IGNORE INTO paper_equity (trade_date, payload) VALUES (?,?)",
      )
        .bind(date, equityPayload(date, 100000000 + index * 100000))
        .run();
    }
    const report = await buildAccountEvidence(env, {
      asOf: longDates.at(-1),
      horizon: 60,
      calendarDates: longDates,
    });
    const window = report.payload.window;
    assert.deepEqual(window.missingDates, [longDates[130]]);
    assert.deepEqual(
      window.excludedDates,
      [longDates[131]],
      "缺口后第一天不得把两天收益算成一天",
    );
    assert.match(window.exclusionReasons[longDates[131]], /前一日净值缺失/);
    assert.equal(report.payload.status, "READY");
    assert.equal(window.validDates.length, 58);
    assert.equal(report.payload.family[0].validDays, 58);
    // 缺口后第二天恢复单日口径：收益基于缺口日净值（≈0.1%），
    // 而不是把两天收益合并成一天（≈0.2%）
    const afterGap = report.inputs.metrics.find(
      (row) => row.outcomeDate === longDates[132],
    );
    const singleDay = afterGap.payload.values.meanDailyReturn;
    assert.ok(
      singleDay > 0 && singleDay < 0.0012,
      `缺口后第二天应为单日收益，实际 ${singleDay}`,
    );
  } finally {
    DB.close();
  }
  // 情景二：跳过窗口前最近交易日（h20 窗口为 dates[100..119]，其前一日
  // 为 dates[99]），期初退回更早净值，窗口首日不可核验为单日样本
  const DB2 = localDatabase(),
    env2 = { DB: DB2 };
  try {
    const paper = new PaperRepository(env2);
    await paper.initialize();
    const dates = tradingDates(120);
    for (const [index, date] of dates.entries()) {
      if (index === 99) continue;
      await DB2.prepare(
        "INSERT OR IGNORE INTO paper_equity (trade_date, payload) VALUES (?,?)",
      )
        .bind(date, equityPayload(date, 100000000 + index * 100000))
        .run();
    }
    const firstDayReport = await buildAccountEvidence(env2, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    const firstWindow = firstDayReport.payload.window;
    assert.ok(
      firstWindow.excludedDates.includes(dates[100]),
      "期初净值不相邻时窗口首日不得计为单日样本",
    );
    assert.match(firstWindow.exclusionReasons[dates[100]], /期初净值/);
    assert.ok(
      !firstWindow.excludedDates.includes(dates[101]),
      "首日核验失败后，次日恢复单日口径",
    );
  } finally {
    DB2.close();
  }
});

test("输入冻结与残缺修复：来源修订后旧报告可复核，重试补齐清单（P1-5/P1-7）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(120);
    await seedReviewHistory(env, dates, { effect: 0.004 });
    for (const date of dates.slice(1)) await recordReviewDailyMetric(env, date);
    const repository = new EvidenceRepository(env);
    const report = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    assert.equal(report.inputs.metrics.length, 20, "发布时固化冻结输入");
    // 模拟非原子提交的历史残缺：报告存在但输入清单缺失
    await DB.prepare("DELETE FROM evidence_report_inputs WHERE report_id=?")
      .bind(report.id)
      .run();
    let broken = await repository.getReport(report.id);
    assert.equal(broken.inputs, null);
    // 重试同输入发布：清单自动补齐，报告本身不覆写
    const repaired = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    assert.equal(repaired.id, report.id);
    assert.equal(repaired.digest, report.digest);
    broken = await repository.getReport(report.id);
    assert.equal(broken.inputs.metrics.length, 20, "清单已补齐");
    assert.equal(
      (await verifyEvidenceBundle(await exportEvidence(env, { id: report.id })))
        .passed,
      true,
    );
    // 来源修订：同一日期的日指标被新版本覆盖
    const metric = broken.inputs.metrics[10];
    const revised = structuredClone(metric.payload);
    revised.reasons = ["来源修订测试"];
    await repository.saveDailyMetric({
      namespace: "main",
      seriesId: "review-primary",
      outcomeDate: metric.outcomeDate,
      contextDigest: metric.payload.contextDigest,
      sourceDigest: "revised-digest",
      payload: revised,
    });
    // 旧报告导出仍使用冻结清单：不受修订影响，核验通过
    const oldBundle = await exportEvidence(env, { id: report.id });
    assert.equal(
      oldBundle.dailyMetrics.find(
        (row) => row.outcomeDate === metric.outcomeDate,
      ).digest,
      metric.digest,
      "导出携带冻结输入而非当前修订",
    );
    assert.equal((await verifyEvidenceBundle(oldBundle)).passed, true);
    // 新发布产生新报告 id：来源修订生成新证据，不覆写旧报告
    const revisedReport = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    assert.notEqual(revisedReport.id, report.id);
  } finally {
    DB.close();
  }
});

// ---------- 合法退化组合：超额恒定（DEGENERATE）+ IC 变化（READY） ----------
function rotatedSnapshot(date, dayIndex) {
  return {
    date,
    createdAt: `${date}T07:10:00.000Z`,
    modelVersion: "rules-v1",
    weights: [8, 8, 8, 8, 8, 8],
    stocks: Array.from({ length: 20 }, (_, index) => ({
      code: `6000${String(index).padStart(2, "0")}`,
      name: `合成${index}`,
      sector: "测试行业",
      // 分数按日轮转：秩相关随日变化，超额保持恒定
      score: 95 - ((index + dayIndex) % 20) * 2,
      price: 10 + index,
      height: 1,
      risks: [],
    })),
  };
}
function constantExcessReviewRows(snapshot) {
  // 冻结 Top（前 4 只）收益 0.2%，其余 0.1%：超额逐日恒定
  return snapshot.stocks.map((stock, index) => ({
    code: stock.code,
    available: true,
    reason: null,
    closeReturn: index < 4 ? 0.2 : 0.1,
    continued: false,
  }));
}

test("verifier：合法退化组合通过，方法/状态/方向/manifest 篡改拒绝（P1-6）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(120);
    const db = (await import("../backend/storage/database.js")).database(env);
    for (const [index, date] of dates.entries()) {
      const snapshot = rotatedSnapshot(date, index);
      await db
        .prepare(
          "INSERT OR IGNORE INTO snapshots (trade_date, created_at, payload) VALUES (?,?,?)",
        )
        .bind(date, snapshot.createdAt, JSON.stringify(snapshot))
        .run();
      if (index === 0) continue;
      const review = {
        date,
        snapshotDate: dates[index - 1],
        modelVersion: "rules-v1",
        rows: constantExcessReviewRows(
          rotatedSnapshot(dates[index - 1], index - 1),
        ),
        validCount: 20,
        coverage: 1,
        systemScore: null,
      };
      await db
        .prepare(
          "INSERT OR IGNORE INTO reviews (trade_date, snapshot_date, created_at, payload) VALUES (?,?,?,?)",
        )
        .bind(date, dates[index - 1], review.date, JSON.stringify(review))
        .run();
    }
    for (const date of dates.slice(1)) await recordReviewDailyMetric(env, date);
    const report = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    assert.equal(report.payload.status, "READY");
    const [ic, excess] = report.payload.family;
    assert.equal(ic.status, "READY", "IC 逐日轮转后可估计");
    assert.ok(ic.ci);
    assert.equal(
      excess.status,
      "DEGENERATE",
      "超额逐日恒定 → 合法退化，不输出区间",
    );
    assert.equal(excess.ci, null);
    assert.equal(excess.pRaw, null);
    const bundle = await exportEvidence(env, { id: report.id });
    const audit = await verifyEvidenceBundle(bundle);
    assert.equal(
      audit.passed,
      true,
      `合法退化组合应通过：${JSON.stringify(audit)}`,
    );
    // 篡改方法元数据并重算报告摘要：仍被拒绝
    const methodTampered = structuredClone(bundle);
    methodTampered.report.payload.method.blockLength = 3;
    methodTampered.report.digest = await digestOf(
      methodTampered.report.payload,
    );
    const methodAudit = await verifyEvidenceBundle(methodTampered);
    assert.equal(methodAudit.passed, false);
    assert.match(methodAudit.reason, /区块长度/);
    // 篡改重采样次数并重算摘要：仍被拒绝
    const resampleTampered = structuredClone(bundle);
    resampleTampered.report.payload.method.resamples = 100;
    resampleTampered.report.digest = await digestOf(
      resampleTampered.report.payload,
    );
    const resampleAudit = await verifyEvidenceBundle(resampleTampered);
    assert.equal(resampleAudit.passed, false);
    assert.match(resampleAudit.reason, /重采样次数/);
    // 篡改方向并重算摘要：仍被拒绝
    const directionTampered = structuredClone(bundle);
    directionTampered.report.payload.family[0].direction = "NEGATIVE";
    directionTampered.report.digest = await digestOf(
      directionTampered.report.payload,
    );
    const directionAudit = await verifyEvidenceBundle(directionTampered);
    assert.equal(directionAudit.passed, false);
    assert.match(directionAudit.reason, /方向/);
    // 篡改整体状态并重算摘要：仍被拒绝
    const statusTampered = structuredClone(bundle);
    statusTampered.report.payload.status = "INSUFFICIENT_SAMPLE";
    statusTampered.report.digest = await digestOf(
      statusTampered.report.payload,
    );
    const statusAudit = await verifyEvidenceBundle(statusTampered);
    assert.equal(statusAudit.passed, false);
    assert.match(statusAudit.reason, /整体状态/);
    // 篡改 manifest 冻结指标：导出的 dailyMetrics 与 inputs.metrics 同源，
    // 摘要核验（日指标或清单）必然拒绝
    const manifestTampered = structuredClone(bundle);
    manifestTampered.report.inputs.metrics[0].payload.values.ic = 0.9;
    const manifestAudit = await verifyEvidenceBundle(manifestTampered);
    assert.equal(manifestAudit.passed, false);
    assert.match(manifestAudit.reason, /摘要不一致/);
    // 篡改窗口覆盖率并重算摘要：仍被拒绝
    const coverageTampered = structuredClone(bundle);
    coverageTampered.report.payload.window.coverage = 0.5;
    coverageTampered.report.digest = await digestOf(
      coverageTampered.report.payload,
    );
    const coverageAudit = await verifyEvidenceBundle(coverageTampered);
    assert.equal(coverageAudit.passed, false);
    assert.match(coverageAudit.reason, /覆盖率/);
    // 清空检验族并改成 PENDING、重算报告摘要：空族规则拒绝（P1-2）
    const familyCleared = structuredClone(bundle);
    familyCleared.report.payload.family = [];
    familyCleared.report.payload.status = "PENDING";
    familyCleared.report.digest = await digestOf(familyCleared.report.payload);
    const familyAudit = await verifyEvidenceBundle(familyCleared);
    assert.equal(familyAudit.passed, false);
    assert.match(familyAudit.reason, /空检验族/);
    // 删减族成员（去掉超额）并重算摘要：预登记族不一致，拒绝（P1-2）
    const familyTrimmed = structuredClone(bundle);
    familyTrimmed.report.payload.family = [
      familyTrimmed.report.payload.family[0],
    ];
    familyTrimmed.report.digest = await digestOf(familyTrimmed.report.payload);
    const trimAudit = await verifyEvidenceBundle(familyTrimmed);
    assert.equal(trimAudit.passed, false);
    assert.match(trimAudit.reason, /检验族/);
    // 单项状态 READY → DEGENERATE（保留区间与 p 值）并重算摘要：拒绝（P2-1）
    const degenerateFlip = structuredClone(bundle);
    degenerateFlip.report.payload.family[0].status = "DEGENERATE";
    degenerateFlip.report.digest = await digestOf(
      degenerateFlip.report.payload,
    );
    const degenerateAudit = await verifyEvidenceBundle(degenerateFlip);
    assert.equal(degenerateAudit.passed, false);
    assert.match(degenerateAudit.reason, /状态与重算不一致/);
    // 翻转 mixedContext 并切换状态分支：上下文标记与窗口指标不一致，拒绝
    const mixedFlip = structuredClone(bundle);
    mixedFlip.report.payload.context.mixedContext = true;
    mixedFlip.report.payload.status = "MIXED_CONTEXT";
    mixedFlip.report.digest = await digestOf(mixedFlip.report.payload);
    const mixedAudit = await verifyEvidenceBundle(mixedFlip);
    assert.equal(mixedAudit.passed, false);
    assert.match(mixedAudit.reason, /上下文/);
  } finally {
    DB.close();
  }
});

test("证据 API：asOf 截取不混入所选日期之后的报告（P1-8）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(120);
    await seedReviewHistory(env, dates, { effect: 0.004 });
    for (const date of dates.slice(1)) await recordReviewDailyMetric(env, date);
    // 总览读取主视图窗口（primaryWindow=60）
    await buildReviewEvidence(env, {
      asOf: dates[118],
      horizon: 60,
      calendarDates: dates,
    });
    await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    const earlier = await api(
      new Request(
        `https://example.test/api/evidence?asOf=${encodeURIComponent(dates[118])}`,
      ),
      env,
    );
    const earlierBody = await earlier.json();
    assert.equal(earlierBody.review.report.asOf, dates[118]);
    assert.ok(
      earlierBody.review.history.every((row) => row.asOf <= dates[118]),
      "历史同样按 asOf 截取",
    );
    const latest = await api(
      new Request(
        `https://example.test/api/evidence?asOf=${encodeURIComponent(dates.at(-1))}`,
      ),
      env,
    );
    assert.equal((await latest.json()).review.report.asOf, dates.at(-1));
    const badAsOf = await api(
      new Request("https://example.test/api/evidence?asOf=not-a-date"),
      env,
    );
    assert.equal(badAsOf.status, 400);
  } finally {
    DB.close();
  }
});

test("覆盖率精度：58/60 有效日的合法报告不被核验拒绝（P1-1）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(120);
    await seedReviewHistory(env, dates, { effect: 0.004 });
    // h60 窗口 = dates[60..119]：只登记 dates[1..117] → 有效 58 天
    for (const date of dates.slice(1, 118))
      await recordReviewDailyMetric(env, date);
    const report = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    assert.equal(report.payload.window.validDates.length, 58);
    assert.equal(report.payload.status, "READY");
    // 58/60 = 0.9666…，报告按 4 位小数发布为 0.9667，不得因精度差异被拒
    assert.equal(report.payload.window.coverage, 0.9667);
    const audit = await verifyEvidenceBundle(
      await exportEvidence(env, { id: report.id }),
    );
    assert.equal(audit.passed, true, JSON.stringify(audit));
  } finally {
    DB.close();
  }
});

test("账户净值完整性：complete=false 当日与次日不计有效样本（P1-3）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const paper = new PaperRepository(env);
    await paper.initialize();
    const dates = tradingDates(140);
    const equityRow = (date, cents, complete) =>
      JSON.stringify({
        date,
        equityCents: cents,
        complete,
        cashCents: 0,
        marketValueCents: 0,
        dailyPnlCents: 0,
        dailyReturn: 0,
        totalReturn: 0,
        realizedPnlCents: 0,
        unrealizedPnlCents: 0,
        feesCents: 0,
        drawdown: 0,
        positionCount: 0,
        missingMinuteOrders: complete ? 0 : 3,
        source: "fixture",
      });
    // h60 窗口（dates[80..139]）内 index 130 净值不完整
    for (const [index, date] of dates.entries()) {
      await DB.prepare(
        "INSERT OR IGNORE INTO paper_equity (trade_date, payload) VALUES (?,?)",
      )
        .bind(date, equityRow(date, 100000000 + index * 100000, index !== 130))
        .run();
    }
    const report = await buildAccountEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    const window = report.payload.window;
    assert.deepEqual(
      window.excludedDates,
      [dates[130], dates[131]],
      "不完整净值当日与次日都不计有效样本",
    );
    assert.deepEqual(window.missingDates, []);
    assert.match(window.exclusionReasons[dates[130]], /当日净值不完整/);
    assert.match(window.exclusionReasons[dates[131]], /前一日净值不完整/);
    assert.equal(window.validDates.length, 58);
    assert.equal(report.payload.status, "READY");
    // 132 恢复单日口径：收益基于 131 的完整净值（≈0.1%），
    // 不把不完整净值的跨期波动合并进来
    const afterGap = report.inputs.metrics.find(
      (row) => row.outcomeDate === dates[132],
    );
    const singleDay = afterGap.payload.values.meanDailyReturn;
    assert.ok(
      singleDay > 0 && singleDay < 0.0012,
      `缺口后应为单日收益，实际 ${singleDay}`,
    );
    const audit = await verifyEvidenceBundle(
      await exportEvidence(env, { id: report.id }),
    );
    assert.equal(audit.passed, true, JSON.stringify(audit));
  } finally {
    DB.close();
  }
});

test("历史 asOf 查询：深分页不受最新 60 条截断影响（P2-1）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(70);
    // 直插 65 个 h20 报告（asOf 递增）：最老一条在最新 60 条之外
    for (const [index, date] of dates.slice(0, 65).entries()) {
      const payload = JSON.stringify({
        purpose: "DIAGNOSTIC",
        eligibleForPromotion: false,
        repeatedLooksAdjusted: false,
        asOf: date,
        horizon: 20,
        seriesId: "review-primary",
        status: "PENDING",
        family: [],
        window: {
          expectedDates: [],
          validDates: [],
          missingDates: [],
          excludedDates: [],
          exclusionReasons: {},
          coverage: 0,
        },
        context: { digest: "legacy", mixedContext: false },
        method: {
          version: DIAGNOSTIC_METHOD_VERSION,
          blockLength: 5,
          resamples: 100,
          seed: "s",
        },
        tags: [],
      });
      await DB.prepare(
        "INSERT OR IGNORE INTO evidence_reports (id,namespace,series_id,as_of,horizon,purpose,input_digest,policy_digest,method_version,payload,digest,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          `legacy-${index}`,
          "main",
          "review-primary",
          date,
          20,
          "DIAGNOSTIC",
          `in-${index}`,
          "pol",
          DIAGNOSTIC_METHOD_VERSION,
          payload,
          `d-${index}`,
          new Date().toISOString(),
        )
        .run();
    }
    // 修复前：最新 60 条（dates[5..64]）内没有 ≤ dates[0] 的报告 → 漏掉
    const response = await api(
      new Request(
        `https://example.test/api/evidence?series=review-primary&horizon=20&asOf=${encodeURIComponent(dates[0])}`,
      ),
      env,
    );
    const body = await response.json();
    assert.equal(body.report?.asOf, dates[0], "深分页外的历史报告必须可见");
    assert.ok(body.history.every((row) => row.asOf <= dates[0]));
    assert.equal(body.history.length, 1);
  } finally {
    DB.close();
  }
});

test("迁移前旧报告：无冻结指标列仍可通过核验（P2-2）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(120);
    await seedReviewHistory(env, dates, { effect: 0.004 });
    for (const date of dates.slice(1)) await recordReviewDailyMetric(env, date);
    const repository = new EvidenceRepository(env);
    const report = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    assert.equal(
      (await verifyEvidenceBundle(await exportEvidence(env, { id: report.id })))
        .passed,
      true,
    );
    // 真实旧格式：输入没有版本/成本/板块字段，按原摘要与种子重算主族。
    const legacy = await exportEvidence(env, { id: report.id });
    for (const metric of legacy.dailyMetrics) {
      delete metric.payload.sectors;
      delete metric.payload.values.sectorReturnIc;
      delete metric.payload.quality.sectorCount;
      metric.digest = await digestOf(metric.payload);
      await DB.prepare(
        "UPDATE evidence_daily_metrics SET payload=?,digest=? WHERE series_id=? AND outcome_date=?",
      )
        .bind(
          JSON.stringify(metric.payload),
          metric.digest,
          report.seriesId,
          metric.outcomeDate,
        )
        .run();
    }
    delete legacy.report.payload.secondaryFamilies;
    legacy.report.inputDigest = await digestOf({
      seriesId: report.seriesId,
      window: {
        expectedDates: report.payload.window.expectedDates,
        validDates: report.payload.window.validDates,
        missingDates: report.payload.window.missingDates,
      },
      contextDigest: report.payload.context.digest,
      metrics: Object.fromEntries(
        legacy.dailyMetrics.map((metric) => [
          metric.outcomeDate,
          metric.payload,
        ]),
      ),
    });
    legacy.report.payload.method.seed = await evidenceSeed({
      namespace: report.namespace,
      purpose: report.purpose,
      asOf: report.asOf,
      orderedWindowDates: report.payload.window.validDates,
      inputDigest: legacy.report.inputDigest,
      policyDigest: report.policyDigest,
    });
    legacy.report.payload.family = await forgeFamily(
      legacy,
      normalizeEvidencePolicy(undefined),
    );
    legacy.report.id = `evidence-${await digestOf({
      seriesId: report.seriesId,
      asOf: report.asOf,
      horizon: report.horizon,
      purpose: report.purpose,
      inputDigest: legacy.report.inputDigest,
      policyDigest: report.policyDigest,
      methodVersion: report.methodVersion,
    })}`;
    legacy.report.digest = await digestOf(legacy.report.payload);
    await DB.prepare(
      "UPDATE evidence_reports SET id=?,input_digest=?,payload=?,digest=? WHERE id=?",
    )
      .bind(
        legacy.report.id,
        legacy.report.inputDigest,
        JSON.stringify(legacy.report.payload),
        legacy.report.digest,
        report.id,
      )
      .run();
    const inputs = report.inputs;
    const legacyDigest = await digestOf({
      orderedDates: inputs.orderedDates,
      sourceRefs: inputs.sourceRefs,
      sourceDigests: inputs.sourceDigests,
      contextDigest: report.payload.context.digest,
    });
    await DB.prepare(
      "UPDATE evidence_report_inputs SET report_id=?,metrics_json=NULL,schema_version=NULL,cost_json=NULL,manifest_digest=? WHERE report_id=?",
    )
      .bind(legacy.report.id, legacyDigest, report.id)
      .run();
    const legacyBundle = await exportEvidence(env, { id: legacy.report.id });
    assert.equal(legacyBundle.report.inputs.metrics, null);
    assert.equal(legacyBundle.dailyMetrics.length, 20, "导出回退当前日指标");
    const audit = await verifyEvidenceBundle(legacyBundle);
    assert.equal(audit.passed, true, JSON.stringify(audit));
  } finally {
    DB.close();
  }
});

// ---------- 攻击者复刻发布算法重算族（绕过数值核验的结构闸门） ----------
const forgeMetricValueKey = (metric) =>
  metric === "MEAN_DAILY_IC"
    ? "ic"
    : metric === "MEAN_DAILY_EXCESS"
      ? "excessDecimal"
      : "meanDailyReturn";
async function forgeFamily(bundle, policy) {
  const report = bundle.report;
  const validDates = report.payload.window.validDates;
  const byDate = new Map(
    bundle.dailyMetrics.map((row) => [row.outcomeDate, row]),
  );
  const validSet = new Set(validDates);
  const segmentLengths = [];
  let current = 0;
  for (const date of report.payload.window.expectedDates) {
    if (validSet.has(date)) current++;
    else if (current) {
      segmentLengths.push(current);
      current = 0;
    }
  }
  if (current) segmentLengths.push(current);
  const { matrix } = await resampleSegmentIndexMatrix({
    segmentLengths,
    blockLength: policy.blockLength,
    resamples: policy.resamples,
    seedInput: report.payload.method.seed,
  });
  const rawResults = new Map();
  const entries = [];
  for (const metric of ["MEAN_DAILY_IC", "MEAN_DAILY_EXCESS"]) {
    const values = validDates.map(
      (date) => byDate.get(date).payload.values[forgeMetricValueKey(metric)],
    );
    const outcome = bootstrapMeanEvidence({
      values,
      indexMatrix: matrix,
      confidenceLevel: policy.confidenceLevel,
      nullMean: 0,
      side: "TWO_SIDED",
      minValidDays: policy.minValidDays,
    });
    rawResults.set(metric, { key: metric, pRaw: outcome.pRaw });
    entries.push({
      metric,
      unit: metric === "MEAN_DAILY_IC" ? "CORRELATION" : "DECIMAL_RETURN",
      status: outcome.status,
      estimate: outcome.estimate,
      ci: outcome.ci ? { ...outcome.ci, scope: "POINTWISE" } : null,
      pRaw: outcome.pRaw ?? null,
      pAdjustedWithinFamily: null,
      standardError: outcome.standardError ?? null,
      validDays: validDates.length,
      reasons: [],
      direction: outcome.ci
        ? outcome.ci.lower > 0
          ? "POSITIVE"
          : outcome.ci.upper < 0
            ? "NEGATIVE"
            : "INCLUDES_ZERO"
        : null,
    });
  }
  const family = adjustEvidenceFamily({
    declaredHypotheses: ["MEAN_DAILY_IC", "MEAN_DAILY_EXCESS"],
    results: [...rawResults.values()],
    method: "HOLM",
  });
  for (const entry of entries) {
    const hypothesis = family.hypotheses.find(
      (row) => row.key === entry.metric,
    );
    entry.pAdjustedWithinFamily = hypothesis.pAdjustedWithinFamily;
  }
  return entries;
}

test("结构闸门：覆盖不足与短片段塞入重算一致的族仍被拒绝（P1-1/P1-2）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(120);
    await seedReviewHistory(env, dates, { effect: 0.004 });
    const policy = normalizeEvidencePolicy(undefined);
    // 情景一：h60 窗口只登记 dates[60..98] → 39/60 = 65% 覆盖
    for (const date of dates.slice(1, 99))
      await recordReviewDailyMetric(env, date);
    const sparse = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    assert.equal(sparse.payload.status, "INCOMPLETE_DATA");
    assert.equal(sparse.payload.window.coverage, 0.65);
    const sparseBundle = await exportEvidence(env, { id: sparse.id });
    // 合法受限报告（覆盖不足 → INCOMPLETE_DATA）必须通过核验：受限标签由
    // 窗口/政策派生，不能因提前返回而缺标（P1 正常导出误拒绝）。
    const sparseAudit = await verifyEvidenceBundle(sparseBundle);
    assert.equal(
      sparseAudit.passed,
      true,
      `覆盖不足的合法报告不应被拒：${JSON.stringify(sparseAudit)}`,
    );
    // 攻击者用真实算法重算族塞入、状态改 READY、重算报告摘要：
    // 数值核验全部一致，必须由覆盖率闸门拒绝（P1-1）
    const forged = structuredClone(sparseBundle);
    forged.report.payload.family = await forgeFamily(forged, policy);
    forged.report.payload.status = "READY";
    forged.report.digest = await digestOf(forged.report.payload);
    const forgedAudit = await verifyEvidenceBundle(forged);
    assert.equal(forgedAudit.passed, false);
    assert.match(forgedAudit.reason, /覆盖低于政策最低要求/);
    // 情景二：h20 窗口隔日登记 → 每个连续片段 1 天 < 区块长度 5
    for (const [index, date] of dates.slice(100, 120).entries()) {
      if (index % 2 === 0) await recordReviewDailyMetric(env, date);
    }
    const fragmented = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    assert.equal(fragmented.payload.status, "INCOMPLETE_DATA");
    const fragmentedBundle = await exportEvidence(env, {
      id: fragmented.id,
    });
    // 攻击者塞入编造的区间与 p 值：短片段分支必须拒绝任何族内容（P1-2）
    const fabricated = structuredClone(fragmentedBundle);
    const validCount = fragmented.payload.window.validDates.length;
    fabricated.report.payload.family = [
      {
        metric: "MEAN_DAILY_IC",
        unit: "CORRELATION",
        status: "READY",
        estimate: 0.5,
        ci: { level: 0.95, lower: 0.4, upper: 0.6, scope: "POINTWISE" },
        pRaw: 0.001,
        pAdjustedWithinFamily: 0.002,
        standardError: 0.01,
        validDays: validCount,
        reasons: [],
        direction: "POSITIVE",
      },
      {
        metric: "MEAN_DAILY_EXCESS",
        unit: "DECIMAL_RETURN",
        status: "READY",
        estimate: 0.02,
        ci: { level: 0.95, lower: 0.01, upper: 0.03, scope: "POINTWISE" },
        pRaw: 0.004,
        pAdjustedWithinFamily: 0.008,
        standardError: 0.005,
        validDays: validCount,
        reasons: [],
        direction: "POSITIVE",
      },
    ];
    fabricated.report.payload.status = "READY";
    fabricated.report.digest = await digestOf(fabricated.report.payload);
    const fabricatedAudit = await verifyEvidenceBundle(fabricated);
    assert.equal(fabricatedAudit.passed, false);
    assert.match(fabricatedAudit.reason, /片段短于区块长度时不得输出检验结果/);
  } finally {
    DB.close();
  }
});

test("空样本与零有效样本：合法受限报告通过、塞入检验结果被拒（P1 误拒绝/漏验）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(120);
    await seedEmptyReviews(env, dates);
    // 情景一：h60 空样本复盘报告——无有效日、全部日指标被闸门剔除 →
    // INSUFFICIENT_SAMPLE 且不含族；受限标签仍须由窗口/政策派生，
    // 否则核验端按结构派生出的标签会误拒合法报告（P1 正常导出误拒绝）。
    const review = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    assert.equal(review.payload.status, "INSUFFICIENT_SAMPLE");
    assert.equal(review.payload.family.length, 0);
    const reviewAudit = await verifyEvidenceBundle(
      await exportEvidence(env, { id: review.id }),
    );
    assert.equal(
      reviewAudit.passed,
      true,
      `空样本复盘报告不应被拒：${JSON.stringify(reviewAudit)}`,
    );
    // 情景二：h60 空样本账户报告（无净值行 → 无有效日）同样必须通过核验。
    const account = await buildAccountEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    assert.equal(account.payload.family.length, 0);
    const accountAudit = await verifyEvidenceBundle(
      await exportEvidence(env, { id: account.id }),
    );
    assert.equal(
      accountAudit.passed,
      true,
      `空样本账户报告不应被拒：${JSON.stringify(accountAudit)}`,
    );
    // 情景三：h120 零有效样本报告——发布端不输出任何检验结果；攻击者
    // 塞入编造的区间与 p 值并重算摘要后，必须被拒绝（P1 零样本漏验）。
    const zero = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 120,
      calendarDates: dates,
    });
    assert.equal(zero.payload.window.validDates.length, 0);
    assert.equal(zero.payload.family.length, 0);
    const forged = structuredClone(await exportEvidence(env, { id: zero.id }));
    forged.report.payload.family = [
      {
        metric: "MEAN_DAILY_IC",
        unit: "CORRELATION",
        status: "READY",
        estimate: 0.5,
        ci: { level: 0.95, lower: 0.4, upper: 0.6, scope: "POINTWISE" },
        pRaw: 0.001,
        pAdjustedWithinFamily: 0.002,
        standardError: 0.01,
        validDays: 120,
        reasons: [],
        direction: "POSITIVE",
      },
    ];
    forged.report.digest = await digestOf(forged.report.payload);
    const forgedAudit = await verifyEvidenceBundle(forged);
    assert.equal(forgedAudit.passed, false);
    assert.match(forgedAudit.reason, /无有效日指标时不得输出检验结果/);
  } finally {
    DB.close();
  }
});

test("报告 id 自洽：同步改写窗口与摘要的深伪造被拒绝（P1）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(120);
    await seedReviewHistory(env, dates, { effect: 0.004 });
    for (const date of dates.slice(1)) await recordReviewDailyMetric(env, date);
    const report = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 20,
      calendarDates: dates,
    });
    const bundle = await exportEvidence(env, { id: report.id });
    // 深伪造：把最后一个有效日挪到缺失、同步清单/覆盖/输入摘要/种子
    // 与报告摘要——payload 层所有检查都能自洽，只有 id 对不上。
    const forged = structuredClone(bundle);
    const fr = forged.report;
    const removed = fr.payload.window.validDates.pop();
    fr.payload.window.missingDates.push(removed);
    fr.payload.window.missingDates.sort();
    fr.payload.window.coverage = Number(
      (
        fr.payload.window.validDates.length /
        fr.payload.window.expectedDates.length
      ).toFixed(4),
    );
    fr.inputs.metrics = fr.inputs.metrics.filter(
      (row) => row.outcomeDate !== removed,
    );
    delete fr.inputs.sourceDigests[removed];
    fr.inputs.manifestDigest = await digestOf({
      orderedDates: fr.inputs.orderedDates,
      sourceRefs: fr.inputs.sourceRefs,
      sourceDigests: fr.inputs.sourceDigests,
      contextDigest: fr.payload.context.digest,
      metrics: fr.inputs.metrics,
    });
    fr.inputDigest = await digestOf({
      seriesId: fr.seriesId,
      window: {
        expectedDates: fr.payload.window.expectedDates,
        validDates: fr.payload.window.validDates,
        missingDates: fr.payload.window.missingDates,
      },
      contextDigest: fr.payload.context.digest,
      metrics: Object.fromEntries(
        fr.payload.window.validDates.map((date) => [
          date,
          forged.dailyMetrics.find((row) => row.outcomeDate === date).payload,
        ]),
      ),
    });
    fr.payload.method.seed = await evidenceSeed({
      namespace: fr.namespace,
      purpose: fr.purpose,
      asOf: fr.asOf,
      orderedWindowDates: fr.payload.window.validDates,
      inputDigest: fr.inputDigest,
      policyDigest: fr.policyDigest,
    });
    fr.digest = await digestOf(fr.payload);
    const forgedAudit = await verifyEvidenceBundle(forged);
    assert.equal(forgedAudit.passed, false);
    assert.match(forgedAudit.reason, /报告 id 与冻结标识不一致/);
  } finally {
    DB.close();
  }
});

// ---------- 批次 C：板块次要族、成本联动与晋级入口 ----------

// 多板块合成快照：四个板块各 3 只，板块评分与板块收益同向且逐日微噪声，
// 用于次要族发布与核验（§3.2/§6.4 批次 C）。
const SECTORS = [
  { name: "电子", score: 90 },
  { name: "机械", score: 80 },
  { name: "电力", score: 70 },
  { name: "医药", score: 60 },
];
function sectorSnapshot(date, dayIndex) {
  return {
    date,
    createdAt: `${date}T07:10:00.000Z`,
    modelVersion: "rules-v1",
    weights: [8, 8, 8, 8, 8, 8],
    sectors: SECTORS,
    stocks: Array.from({ length: 12 }, (_, index) => {
      const sectorIndex = index % 4;
      return {
        code: `3000${String(index).padStart(2, "0")}`,
        name: `合成${index}`,
        sector: SECTORS[sectorIndex].name,
        score: SECTORS[sectorIndex].score,
        price: 10 + index,
        height: 1,
        risks: [],
      };
    }),
  };
}
function sectorReviewPayload(date, snapshot, dayIndex) {
  const noiseRandom = mulberry32(((dayIndex + 1) * 40503) >>> 0);
  const rows = snapshot.stocks.map((stock) => {
    const sectorIndex = SECTORS.findIndex((s) => s.name === stock.sector);
    const ret = (noiseRandom() * 2 - 1) * 0.004 + 0.002 * (3 - sectorIndex);
    return {
      code: stock.code,
      available: true,
      reason: null,
      closeReturn: Number((ret * 100).toFixed(4)),
      continued: false,
    };
  });
  return {
    date,
    snapshotDate: snapshot.date,
    modelVersion: "rules-v1",
    rows,
    validCount: rows.length,
    coverage: 1,
    systemScore: null,
  };
}
async function seedSectorReviews(env, dates) {
  const db = (await import("../backend/storage/database.js")).database(env);
  for (const [index, date] of dates.entries()) {
    const snapshot = sectorSnapshot(date, index);
    await db
      .prepare(
        "INSERT OR IGNORE INTO snapshots (trade_date, created_at, payload) VALUES (?,?,?)",
      )
      .bind(date, snapshot.createdAt, JSON.stringify(snapshot))
      .run();
    if (index === 0) continue;
    const snapshotPrev = sectorSnapshot(dates[index - 1], index - 1);
    const review = sectorReviewPayload(date, snapshotPrev, index);
    await db
      .prepare(
        "INSERT OR IGNORE INTO reviews (trade_date, snapshot_date, created_at, payload) VALUES (?,?,?,?)",
      )
      .bind(date, snapshotPrev.date, review.date, JSON.stringify(review))
      .run();
  }
  for (const date of dates.slice(1)) await recordReviewDailyMetric(env, date);
}

test("批次 C：板块次要族随复盘报告发布，Holm 跨板块校正，导出可核验", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(62);
    await seedSectorReviews(env, dates);
    const report = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    assert.equal(report.payload.status, "READY");
    const secondary = report.payload.secondaryFamilies ?? [];
    assert.equal(secondary.length, 2);
    const excess = secondary.find(
      (family) => family.name === "SECTOR_SECONDARY_EXCESS",
    );
    assert.equal(excess.familySize, 4);
    assert.equal(excess.role, "SECONDARY");
    assert.equal(excess.entries.length, 4);
    assert.deepEqual(
      // 族成员按名称 Unicode 码位排序（发布端 declared.sort()）。
      excess.entries.map((entry) => entry.sector),
      ["医药", "机械", "电力", "电子"],
    );
    // 板块超额随板块评分同向：高分板块区间为正，低分板块为负。
    assert.equal(excess.entries[3].direction, "POSITIVE");
    assert.equal(excess.entries[0].direction, "NEGATIVE");
    for (const entry of excess.entries) {
      assert.equal(entry.metric, "MEAN_SECTOR_EXCESS");
      assert.equal(entry.status, "READY");
      assert.ok(entry.ci);
      // Holm：族校正 p 不小于 raw p，且单调不减（按 raw p 排序）。
      assert.ok(entry.pAdjustedWithinFamily >= entry.pRaw);
    }
    const aggregate = secondary.find(
      (family) => family.name === "SECTOR_AGGREGATE_IC",
    );
    assert.equal(aggregate.familySize, 1);
    assert.equal(aggregate.entries[0].metric, "SECTOR_RETURN_IC");
    assert.equal(aggregate.entries[0].status, "READY");
    assert.ok(aggregate.entries[0].estimate > 0.9);
    // 导出核验通过；篡改板块区间被拒绝。
    const audit = await verifyEvidenceBundle(
      await exportEvidence(env, { id: report.id }),
    );
    assert.equal(audit.passed, true, JSON.stringify(audit));
    const forged = await exportEvidence(env, { id: report.id });
    forged.report.payload.secondaryFamilies.find(
      (family) => family.name === "SECTOR_SECONDARY_EXCESS",
    ).entries[0].ci.upper += 0.01;
    forged.report.digest = await digestOf(forged.report.payload);
    const forgedAudit = await verifyEvidenceBundle(forged);
    assert.equal(forgedAudit.passed, false);
    assert.match(forgedAudit.reason, /区间不一致|点估计不一致/);
  } finally {
    DB.close();
  }
});

test("批次 C：账户证据绑定执行成本指纹与校准标签", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const paper = new PaperRepository(env);
    await paper.initialize();
    const dates = tradingDates(65);
    const db = (await import("../backend/storage/database.js")).database(env);
    let equity = 100000000;
    for (const date of dates) {
      equity += 80000;
      await db
        .prepare(
          "INSERT OR IGNORE INTO paper_equity (trade_date, payload) VALUES (?,?)",
        )
        .bind(
          date,
          JSON.stringify({
            date,
            equityCents: equity,
            complete: true,
            cashCents: equity,
            marketValueCents: 0,
            dailyPnlCents: 80000,
            dailyReturn: 0.0008,
            totalReturn: equity / 100000000 - 1,
            realizedPnlCents: 0,
            unrealizedPnlCents: 0,
            feesCents: 0,
            drawdown: 0,
            positionCount: 0,
          }),
        )
        .run();
    }
    const report = await buildAccountEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    assert.equal(report.payload.status, "READY");
    // 成本指纹（§7.2 批次 C）：校准状态由成本政策事实派生，先验未校准。
    assert.ok(report.payload.cost);
    assert.equal(report.payload.cost.calibrationStatus, "PRIOR_UNCALIBRATED");
    assert.ok(/^[0-9a-f]{64}$/.test(report.payload.cost.digest));
    assert.ok(report.payload.tags.includes("COST_PRIOR_UNCALIBRATED"));
    assert.ok(report.payload.tags.includes("NO_COMPARABLE_BASELINE"));
    const audit = await verifyEvidenceBundle(
      await exportEvidence(env, { id: report.id }),
    );
    assert.equal(audit.passed, true, JSON.stringify(audit));
  } finally {
    DB.close();
  }
});

test("批次 C：统一晋级入口拒绝诊断证据报告（含资格标记不一致）", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const { promoteCohortChampion } = await import(
      "../backend/services/promotion.js"
    );
    const db = (await import("../backend/storage/database.js")).database(env);
    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO strategy_cohorts (id, namespace, parent_version, policy_id, policy_digest, research_policy_id, research_policy_digest, stage, max_candidates, forward_days, reservation_manifest, created_at, updated_at) VALUES ('cohort-diag', 'main', 'baseline-v1', 'p', 'pd', 'rp', 'rpd', 'EVALUATING', 2, 60, '{}', ?, ?)",
      )
      .bind(now, now)
      .run();
    await assert.rejects(
      promoteCohortChampion(env, "cohort-diag", {
        evaluation: {
          champion: { memberId: "m1" },
          purpose: "DIAGNOSTIC",
          eligibleForPromotion: false,
        },
      }),
      /诊断证据报告没有启用资格/,
    );
    await assert.rejects(
      promoteCohortChampion(env, "cohort-diag", {
        evaluation: {
          champion: { memberId: "m1" },
          purpose: "DIAGNOSTIC",
          eligibleForPromotion: true,
        },
      }),
      /诊断证据报告没有启用资格/,
    );
  } finally {
    DB.close();
  }
});

// ---------- 复核修复回归（P1/P2） ----------

test("复核 P1：成本政策存储损坏时晋级抛错，不静默放行", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const { promoteCohortChampion } = await import(
      "../backend/services/promotion.js"
    );
    const db = (await import("../backend/storage/database.js")).database(env);
    await new PaperRepository(env).initialize();
    const now = new Date().toISOString();
    // 显式插入一条合法政策行（initialize 不写政策），随后篡改其内容。
    const { defaultExecutionCostPolicy } = await import(
      "../shared/execution-cost.js"
    );
    const { policyDigest } = await import(
      "../backend/storage/execution-cost.js"
    );
    const fallbackPolicy = defaultExecutionCostPolicy();
    await db
      .prepare(
        "INSERT INTO execution_cost_policies (id,version,model_version,payload,digest,calibration_status,calibration_cutoff,effective_from,created_at) VALUES (?,1,?,?,?,?,?,?,?)",
      )
      .bind(
        "cost-default",
        fallbackPolicy.modelVersion,
        JSON.stringify(fallbackPolicy.payload),
        await policyDigest(fallbackPolicy.payload),
        "PRIOR_UNCALIBRATED",
        null,
        null,
        now,
      )
      .run();
    const forwardManifest = {
      initialAccounts: {},
      initialAccountsDigest: await digestOf({}),
    };
    await db
      .prepare(
        "INSERT INTO strategy_cohorts (id, namespace, revision, parent_version, policy_id, policy_digest, research_policy_id, research_policy_digest, stage, max_candidates, forward_days, reservation_manifest, forward_manifest, created_at, updated_at) VALUES ('c-corrupt', 'main', 0, 'baseline-v1', 'p', 'd', 'rp', 'rd', 'EVALUATING', 2, 60, '{}', ?, ?, ?)",
      )
      .bind(JSON.stringify(forwardManifest), now, now)
      .run();
    await db
      .prepare(
        "INSERT INTO strategy_cohort_members (cohort_id, member_id, slot_index, experiment_id, strategy_version, k, params, params_digest, params_distance, stage, created_at, updated_at) VALUES ('c-corrupt', 'm1', 1, 'exp-x', 'v-champ', 1, '{}', 'd', 1, 'ELIGIBLE', ?, ?)",
      )
      .bind(now, now)
      .run();
    const evaluation = { champion: { memberId: "m1" }, promotion: null };
    evaluation.digest = await digestOf(evaluation);
    // 存储行 JSON 合法但摘要不匹配 → latestPolicyBundle 抛错 → 晋级失败。
    await db
      .prepare(
        "UPDATE execution_cost_policies SET payload = '{\"tampered\":1}'",
      )
      .run();
    await assert.rejects(
      promoteCohortChampion(env, "c-corrupt", { evaluation }),
      /成本政策 v1 存储内容(与摘要不一致|损坏)，拒绝静默回退/,
      "成本政策损坏时晋级必须失败",
    );
  } finally {
    DB.close();
  }
});

test("复核 P1：重复同名板块检验族夹带编造结果被 verifier 拒绝", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(62);
    await seedSectorReviews(env, dates);
    const report = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    const forged = await exportEvidence(env, { id: report.id });
    // 在合法族之外夹带一个同名族（内含编造结果），并重算报告摘要。
    forged.report.payload.secondaryFamilies.unshift({
      name: "SECTOR_SECONDARY_EXCESS",
      familySize: 1,
      role: "SECONDARY",
      entries: [
        {
          sector: "伪造板块",
          metric: "MEAN_SECTOR_EXCESS",
          unit: "DECIMAL_RETURN_PER_DAY",
          status: "READY",
          estimate: 0.09,
          ci: { lower: 0.08, upper: 0.1, level: 0.95 },
          pRaw: 0.0001,
          pAdjustedWithinFamily: 0.0001,
          standardError: 0.005,
          validDays: 60,
          direction: "POSITIVE",
        },
      ],
    });
    forged.report.digest = await digestOf(forged.report.payload);
    const audit = await verifyEvidenceBundle(forged);
    assert.equal(audit.passed, false);
    assert.match(audit.reason, /次要检验族数量与重算不一致/);
  } finally {
    DB.close();
  }
});

test("复核 P1：板块单日股票数不足的日期不计入该板块有效样本", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(62);
    const db = (await import("../backend/storage/database.js")).database(env);
    // 与 seedSectorReviews 相同的种子，但 dates[30] 只保留 2 只医药股票
    // （单日样本不足）。
    for (const [index, date] of dates.entries()) {
      const snapshot = sectorSnapshot(date, index);
      await db
        .prepare(
          "INSERT OR IGNORE INTO snapshots (trade_date, created_at, payload) VALUES (?,?,?)",
        )
        .bind(date, snapshot.createdAt, JSON.stringify(snapshot))
        .run();
      if (index === 0) continue;
      const snapshotPrev = sectorSnapshot(dates[index - 1], index - 1);
      const review = sectorReviewPayload(date, snapshotPrev, index);
      if (index === 30) {
        // 医药 3 只中剔除 1 只：validStocks=2 < 下限 3。
        review.rows = review.rows.filter(
          (row) => row.code !== "300003", // index 3 → 医药
        );
        review.validCount = review.rows.length;
      }
      await db
        .prepare(
          "INSERT OR IGNORE INTO reviews (trade_date, snapshot_date, created_at, payload) VALUES (?,?,?,?)",
        )
        .bind(date, snapshotPrev.date, review.date, JSON.stringify(review))
        .run();
    }
    for (const date of dates.slice(1)) await recordReviewDailyMetric(env, date);
    const report = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    const excess = report.payload.secondaryFamilies.find(
      (family) => family.name === "SECTOR_SECONDARY_EXCESS",
    );
    const pharma = excess.entries.find((entry) => entry.sector === "医药");
    const electronics = excess.entries.find((entry) => entry.sector === "电子");
    // 医药在窗口内有一个样本不足日 → 序列不完整 → 如实降级，不输出区间。
    assert.equal(pharma.status, "INSUFFICIENT_SAMPLE");
    assert.equal(pharma.validDays, 59);
    assert.equal(pharma.ci, null);
    // 其余板块不受影响，仍输出 READY 区间。
    assert.equal(electronics.status, "READY");
    assert.ok(electronics.ci);
    const audit = await verifyEvidenceBundle(
      await exportEvidence(env, { id: report.id }),
    );
    assert.equal(audit.passed, true, JSON.stringify(audit));
  } finally {
    DB.close();
  }
});

test("复核 P1：伪造校准等级（带摘要/无摘要）均被 verifier 拒绝", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(65);
    await new PaperRepository(env).initialize();
    const db = (await import("../backend/storage/database.js")).database(env);
    let equity = 100000000;
    for (const date of dates) {
      equity += 80000;
      await db
        .prepare(
          "INSERT OR IGNORE INTO paper_equity (trade_date, payload) VALUES (?,?)",
        )
        .bind(
          date,
          JSON.stringify({
            date,
            equityCents: equity,
            complete: true,
            cashCents: equity,
            marketValueCents: 0,
            dailyPnlCents: 80000,
            dailyReturn: 0.0008,
            totalReturn: equity / 100000000 - 1,
            realizedPnlCents: 0,
            unrealizedPnlCents: 0,
            feesCents: 0,
            drawdown: 0,
            positionCount: 0,
          }),
        )
        .run();
    }
    const report = await buildAccountEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    assert.equal(report.payload.cost.calibrationStatus, "PRIOR_UNCALIBRATED");
    // 伪造一：保留摘要但宣称已校准 → 与导出内成本政策记录不一致。
    const forged = await exportEvidence(env, { id: report.id });
    assert.equal(forged.executionCostPolicies.length, 1);
    forged.report.payload.cost.calibrationStatus = "EXECUTION_CALIBRATED";
    forged.report.digest = await digestOf(forged.report.payload);
    const audit = await verifyEvidenceBundle(forged);
    assert.equal(audit.passed, false);
    assert.match(audit.reason, /成本指纹 calibrationStatus 与成本政策不一致/);
    // 伪造二：去掉摘要直接宣称已校准 → 无记录支撑即拒绝。
    const forged2 = await exportEvidence(env, { id: report.id });
    delete forged2.report.payload.cost.digest;
    forged2.report.payload.cost.calibrationStatus = "EXECUTION_CALIBRATED";
    forged2.report.digest = await digestOf(forged2.report.payload);
    const audit2 = await verifyEvidenceBundle(forged2);
    assert.equal(audit2.passed, false);
    assert.match(audit2.reason, /无成本政策摘要不得宣称已校准/);
  } finally {
    DB.close();
  }
});

test("复核 P2：空样本账户报告（先验未校准）与旧格式报告可核验", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(65);
    await new PaperRepository(env).initialize();
    const db = (await import("../backend/storage/database.js")).database(env);
    // 60 日日历内仅 1 个完整结算日：窗口几乎全空（空样本形态），
    // 报告如实发布为样本不足而非拒绝。
    await db
      .prepare(
        "INSERT OR IGNORE INTO paper_equity (trade_date, payload) VALUES (?,?)",
      )
      .bind(
        dates.at(-1),
        JSON.stringify({
          date: dates.at(-1),
          equityCents: 100000000,
          complete: true,
          cashCents: 100000000,
          marketValueCents: 0,
          dailyPnlCents: 0,
          dailyReturn: 0,
          totalReturn: 0,
          realizedPnlCents: 0,
          unrealizedPnlCents: 0,
          feesCents: 0,
          drawdown: 0,
          positionCount: 0,
        }),
      )
      .run();
    const report = await buildAccountEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    assert.ok(report?.payload, "应发布报告而非静默跳过");
    assert.notEqual(report.payload.status, "READY");
    assert.equal(report.payload.cost.calibrationStatus, "PRIOR_UNCALIBRATED");
    const audit = await verifyEvidenceBundle(
      await exportEvidence(env, { id: report.id }),
    );
    assert.equal(audit.passed, true, JSON.stringify(audit));
  } finally {
    DB.close();
  }
});

test("独立统计 worker：发现缺失窗口、幂等补齐发布", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const { runEvidenceWorkerTick } = await import(
      "../backend/services/evidence.js"
    );
    const dates = tradingDates(62);
    await seedSectorReviews(env, dates);
    const first = await runEvidenceWorkerTick(env, { calendarDates: dates });
    // 62 个来源日：20/60 日窗口可构建，120 日窗口因数量不足被跳过。
    assert.equal(first.discovered, 2);
    assert.ok(first.results.every((result) => result.reportId));
    // 幂等：第二次执行不再发现缺失窗口。
    const second = await runEvidenceWorkerTick(env);
    assert.equal(second.discovered, 0);
    assert.equal(second.results.length, 0);
    // 发布的报告可通过既有核验。
    const latest = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    const audit = await verifyEvidenceBundle(
      await exportEvidence(env, { id: latest.id }),
    );
    assert.equal(audit.passed, true, JSON.stringify(audit));
  } finally {
    DB.close();
  }
});

test("验收 P1：删除/null/对象板块族不能伪装成旧格式", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const dates = tradingDates(62);
    await seedSectorReviews(env, dates);
    const report = await buildReviewEvidence(env, {
      asOf: dates.at(-1),
      horizon: 60,
      calendarDates: dates,
    });
    const bundle = await exportEvidence(env, { id: report.id });
    assert.equal((await verifyEvidenceBundle(bundle)).passed, true);
    for (const value of [undefined, null, {}]) {
      const forged = structuredClone(bundle);
      if (value === undefined) delete forged.report.payload.secondaryFamilies;
      else forged.report.payload.secondaryFamilies = value;
      forged.report.digest = await digestOf(forged.report.payload);
      assert.equal(forged.report.id, report.id);
      assert.equal(forged.report.inputDigest, report.inputDigest);
      assert.deepEqual(forged.report.inputs, report.inputs);
      const audit = await verifyEvidenceBundle(forged);
      assert.equal(audit.passed, false, JSON.stringify(audit));
      assert.match(audit.reason, /次要检验族必须是数组/);
    }
    // 同步删除输入格式版本并重算 manifest，也不能绕过原 inputDigest。
    const downgraded = structuredClone(bundle);
    delete downgraded.report.inputs.schemaVersion;
    delete downgraded.report.inputs.cost;
    delete downgraded.report.payload.secondaryFamilies;
    downgraded.report.inputs.manifestDigest = await digestOf({
      orderedDates: report.inputs.orderedDates,
      sourceRefs: report.inputs.sourceRefs,
      sourceDigests: report.inputs.sourceDigests,
      contextDigest: report.payload.context.digest,
      metrics: report.inputs.metrics,
    });
    downgraded.report.digest = await digestOf(downgraded.report.payload);
    assert.equal((await verifyEvidenceBundle(downgraded)).passed, false);
  } finally {
    DB.close();
  }
});

async function accountAcceptanceFixture(env) {
  const dates = tradingDates(65);
  await new PaperRepository(env).initialize();
  for (const [index, date] of dates.entries())
    await env.DB.prepare(
      "INSERT INTO paper_equity (trade_date,payload) VALUES (?,?)",
    )
      .bind(
        date,
        JSON.stringify({
          date,
          complete: true,
          equityCents: 100000000 + 70000 * index + (index % 4) * 3000,
        }),
      )
      .run();
  return { asOf: dates.at(-1), horizon: 60, calendarDates: dates };
}

test("验收 P1：同步篡改报告/成本行/标签，冻结身份不变时仍拒绝", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const options = await accountAcceptanceFixture(env);
    const report = await buildAccountEvidence(env, options);
    const bundle = await exportEvidence(env, { id: report.id });
    assert.equal((await verifyEvidenceBundle(bundle)).passed, true);
    const forged = structuredClone(bundle);
    forged.report.payload.cost.calibrationStatus = "EXECUTION_CALIBRATED";
    forged.executionCostPolicies[0].calibrationStatus = "EXECUTION_CALIBRATED";
    forged.report.payload.tags = forged.report.payload.tags.filter(
      (tag) => !tag.startsWith("COST_"),
    );
    forged.report.digest = await digestOf(forged.report.payload);
    assert.equal(forged.report.id, report.id);
    assert.equal(forged.report.inputDigest, report.inputDigest);
    assert.deepEqual(forged.report.inputs, report.inputs);
    const audit = await verifyEvidenceBundle(forged);
    assert.equal(audit.passed, false);
    assert.match(audit.reason, /成本指纹与冻结成本输入不一致/);
    // 连冻结清单都同步改写，原报告 inputDigest 仍会揭示篡改。
    forged.report.inputs.cost.calibrationStatus = "EXECUTION_CALIBRATED";
    forged.report.inputs.manifestDigest = await digestOf({
      orderedDates: report.inputs.orderedDates,
      sourceRefs: report.inputs.sourceRefs,
      sourceDigests: report.inputs.sourceDigests,
      contextDigest: report.payload.context.digest,
      metrics: report.inputs.metrics,
      schemaVersion: report.inputs.schemaVersion,
      cost: forged.report.inputs.cost,
    });
    const deepAudit = await verifyEvidenceBundle(forged);
    assert.equal(deepAudit.passed, false);
    assert.match(deepAudit.reason, /输入摘要与报告不一致/);
  } finally {
    DB.close();
  }
});

test("验收 P2：同参数/同校准等级 v2 不替换 v1，超过 50 版仍可导出", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const { ExecutionCostRepository } = await import(
      "../backend/storage/execution-cost.js"
    );
    const { defaultExecutionCostPolicy } = await import(
      "../shared/execution-cost.js"
    );
    const costs = new ExecutionCostRepository(env);
    const options = await accountAcceptanceFixture(env);
    const payload = defaultExecutionCostPolicy().payload;
    const v1 = await costs.save({ payload });
    const report = await buildAccountEvidence(env, options);
    const original = await exportEvidence(env, { id: report.id });
    const v2 = await costs.save({ payload });
    assert.equal(v1.payloadDigest, v2.payloadDigest);
    assert.equal(v1.calibrationStatus, v2.calibrationStatus);
    for (const count of [2, 52]) {
      if (count === 52)
        for (let version = 3; version <= count; version++)
          await costs.save({ payload });
      const bundle = await exportEvidence(env, { id: report.id });
      assert.equal(bundle.executionCostPolicies[0].policyId, v1.id);
      assert.equal(bundle.executionCostPolicies[0].version, 1);
      assert.deepEqual(bundle.report, original.report);
      const audit = await verifyEvidenceBundle(bundle);
      assert.equal(audit.passed, true, JSON.stringify(audit));
      // verifier 也按完整引用定位，数组中的相同摘要 v2 不应抢占 v1。
      bundle.executionCostPolicies.unshift({
        ...bundle.executionCostPolicies[0],
        policyId: v2.id,
        version: v2.version,
      });
      assert.equal((await verifyEvidenceBundle(bundle)).passed, true);
    }
    const next = await buildAccountEvidence(env, options);
    assert.notEqual(next.id, report.id);
    assert.notEqual(next.inputDigest, report.inputDigest);
    assert.equal(next.inputs.cost.version, 52);
    assert.equal(
      (await verifyEvidenceBundle(await exportEvidence(env, { id: next.id })))
        .passed,
      true,
    );
  } finally {
    DB.close();
  }
});

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
function workerProcess(args, cwd, env) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      windowsHide: true,
    });
    let stdout = "",
      stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("worker 子进程超时"));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

test("验收 P1：官方 worker --once 读取配置/默认文件库，61 条复盘发布两个窗口", async () => {
  const taskDir = mkdtempSync(join(tmpdir(), "evidence-worker-"));
  try {
    cpSync(join(repoRoot, "drizzle"), join(taskDir, "drizzle"), {
      recursive: true,
    });
    const dates = tradingDates(62);
    const preload = join(taskDir, "calendar.mjs");
    writeFileSync(
      preload,
      `globalThis.fetch = async () => Response.json(${JSON.stringify({ data: { sh000001: { day: dates.map((date) => [date, "10", "10", "10", "10", "100"]) } } })});`,
    );
    for (const configured of [true, false]) {
      const dbPath = join(
        taskDir,
        configured ? "configured/data.sqlite" : ".sites-runtime/local.sqlite",
      );
      mkdirSync(dirname(dbPath), { recursive: true });
      let DB = localDatabase(dbPath);
      await seedReviewHistory({ DB }, dates);
      assert.equal(
        (await DB.prepare("SELECT COUNT(*) AS n FROM reviews").first()).n,
        61,
      );
      const { discoverMissingEvidenceWindows } = await import(
        "../backend/services/evidence.js"
      );
      assert.equal((await discoverMissingEvidenceWindows({ DB })).length, 2);
      DB.close();
      const childEnv = { ...process.env };
      if (configured) childEnv.LOCAL_DATABASE_PATH = dbPath;
      else delete childEnv.LOCAL_DATABASE_PATH;
      const args = [
        "--import",
        pathToFileURL(preload).href,
        join(repoRoot, "scripts/evidence-worker.mjs"),
        "--once",
      ];
      const first = await workerProcess(args, taskDir, childEnv);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /发现 2 个缺失窗口，发布 2，失败 0/);
      const second = await workerProcess(args, taskDir, childEnv);
      assert.equal(second.code, 0, second.stderr);
      DB = localDatabase(dbPath);
      try {
        const rows = (await DB.prepare("SELECT id FROM evidence_reports").all())
          .results;
        assert.equal(rows.length, 2, "重复单轮保持幂等");
        for (const row of rows) {
          const audit = await verifyEvidenceBundle(
            await exportEvidence({ DB }, { id: row.id }),
          );
          assert.equal(audit.passed, true, JSON.stringify(audit));
        }
      } finally {
        DB.close();
      }
    }
  } finally {
    assert.equal(dirname(taskDir), tmpdir());
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("验收 P1：官方常驻 worker 保持存活，等待中 SIGTERM 立即退出且无顶层 await 警告", async () => {
  const taskDir = mkdtempSync(join(tmpdir(), "evidence-resident-"));
  try {
    cpSync(join(repoRoot, "drizzle"), join(taskDir, "drizzle"), {
      recursive: true,
    });
    const preload = join(taskDir, "shutdown.mjs");
    // 此定时器也 unref：它不帮 worker 保活，旧 worker 会提前以 13 退出。
    writeFileSync(
      preload,
      'setTimeout(() => process.emit("SIGTERM"), 1200).unref();',
    );
    const result = await workerProcess(
      [
        "--import",
        pathToFileURL(preload).href,
        join(repoRoot, "scripts/evidence-worker.mjs"),
      ],
      taskDir,
      {
        ...process.env,
        LOCAL_DATABASE_PATH: join(taskDir, "resident.sqlite"),
        EVIDENCE_WORKER_INTERVAL_MS: "60000",
      },
    );
    assert.match(result.stdout, /启动，间隔 60000ms/);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.elapsedMs >= 1100, `提前退出：${result.elapsedMs}ms`);
    assert.ok(result.elapsedMs < 5000, `停止未唤醒等待：${result.elapsedMs}ms`);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
  } finally {
    assert.equal(dirname(taskDir), tmpdir());
    rmSync(taskDir, { recursive: true, force: true });
  }
});
