// 统计证据编排（docs/design/statistical-evidence.md §8）：
// 读取来源、冻结输入、计算日指标与滚动报告。GET 只读；recompute 只重算
// 同一冻结输入；诊断报告固定无晋级资格（purpose=DIAGNOSTIC）。
import { EvidenceRepository } from "../storage/evidence.js";
import { PaperRepository } from "../storage/paper.js";
import { database } from "../storage/database.js";
import { digestOf } from "../domain/research-lineage.js";
import {
  normalizeEvidencePolicy,
  REVIEW_METRIC_FAMILY,
  METHOD_QUALIFIED_HORIZONS,
} from "../domain/evidence-policy.js";
import {
  buildEvidenceWindow,
  resampleSegmentIndexMatrix,
  bootstrapMeanEvidence,
  adjustEvidenceFamily,
  evidenceSeed,
  DIAGNOSTIC_METHOD_VERSION,
} from "../domain/research-statistics.js";
import { computeDailyReviewMetrics } from "../domain/review-metrics.js";
import { tradingCalendar } from "./market.js";

const NAMESPACE = "main";
export const REVIEW_SERIES = "review-primary";
export const ACCOUNT_SERIES = "account-primary";

function metricUnits(metric) {
  if (metric === "MEAN_DAILY_IC") return "CORRELATION";
  if (metric === "MEAN_DAILY_EXCESS" || metric === "MEAN_DAILY_RETURN")
    return "DECIMAL_RETURN";
  return "UNKNOWN";
}

const metricValueKey = (metric) =>
  metric === "MEAN_DAILY_IC"
    ? "ic"
    : metric === "MEAN_DAILY_EXCESS"
      ? "excessDecimal"
      : "meanDailyReturn";

async function policyBundle(repository) {
  const stored = await repository.latestPolicy();
  if (stored) return stored;
  const payload = normalizeEvidencePolicy(undefined);
  return {
    id: "default",
    version: 0,
    payload,
    digest: await digestOf(payload),
    effectiveFrom: null,
  };
}

// 冻结窗口日历：截至 asOf 的最后 horizon 个真实交易日。
// 不向窗口外寻找补位日期；asOf 非交易日时回退到最后一个交易日。
async function freezeCalendar({ asOf, horizon, calendarDates }) {
  if (Array.isArray(calendarDates)) {
    const ordered = [...calendarDates].filter((date) => date <= asOf).sort();
    const expected = ordered.slice(-horizon);
    if (expected.length !== horizon)
      throw new Error("冻结日历不足窗口长度，不补长窗口");
    return expected;
  }
  const start = new Date(
    Date.parse(`${asOf}T00:00:00Z`) - Math.ceil(horizon * 2.2) * 86400000,
  )
    .toISOString()
    .slice(0, 10);
  const { dates } = await tradingCalendar(start, asOf);
  const expected = dates.filter((date) => date <= asOf).slice(-horizon);
  if (expected.length !== horizon)
    throw new Error("交易日历不足窗口长度，不补长窗口");
  return expected;
}

// 来源提交后登记每日指标：复盘核验行 → 小数口径日指标（§3.1）。
export async function recordReviewDailyMetric(env, date) {
  const repository = new EvidenceRepository(env);
  const policyRow = await policyBundle(repository);
  const row = await database(env)
    .prepare("SELECT payload FROM reviews WHERE trade_date = ?")
    .bind(date)
    .first();
  if (!row) return { recorded: false, reason: "该日期尚无已核验反馈" };
  const review = JSON.parse(row.payload);
  const snapshotRow = await database(env)
    .prepare("SELECT payload FROM snapshots WHERE trade_date = ?")
    .bind(review.snapshotDate)
    .first();
  if (!snapshotRow) return { recorded: false, reason: "缺少冻结评分快照" };
  const snapshot = JSON.parse(snapshotRow.payload);
  const verifiedOutcomes = (review.rows ?? []).map((item) => ({
    code: item.code,
    // 复盘行的 closeReturn 为百分点；统计内核统一小数（§1）。
    returnDecimal: item.available ? item.closeReturn / 100 : null,
    available: !!item.available,
    reason: item.reason,
  }));
  const metric = await computeDailyReviewMetrics({
    frozenSnapshot: { ...snapshot, resultDate: date },
    verifiedOutcomes,
    policy: policyRow.payload,
  });
  const sourceDigest = await digestOf({
    review,
    snapshotDate: review.snapshotDate,
  });
  await repository.saveDailyMetric({
    namespace: NAMESPACE,
    seriesId: REVIEW_SERIES,
    outcomeDate: date,
    contextDigest: metric.contextDigest,
    sourceDigest,
    payload: metric,
  });
  return { recorded: true, date, status: metric.status };
}

function evidenceTags({
  observationGrade,
  missingDates,
  costUncalibrated,
  noComparableBaseline,
}) {
  const tags = ["EXPLORATORY_REPEATED_LOOKS"];
  if (missingDates?.length) tags.push("CONDITIONAL_ON_OBSERVED_DAYS");
  if (observationGrade) tags.push("OBSERVATION_NOT_EXECUTABLE");
  if (costUncalibrated) tags.push("COST_PRIOR_UNCALIBRATED");
  if (noComparableBaseline) tags.push("NO_COMPARABLE_BASELINE");
  return tags;
}

function directionOf(ci) {
  if (!ci) return null;
  if (ci.lower > 0) return "POSITIVE";
  if (ci.upper < 0) return "NEGATIVE";
  return "INCLUDES_ZERO";
}

// 滚动诊断报告（§7.1）：purpose=DIAGNOSTIC、eligibleForPromotion=false、
// repeatedLooksAdjusted=false；同输入/政策/方法幂等发布，不覆写原证据。
async function publishWindowReport({
  repository,
  policy,
  policyDigest,
  seriesId,
  asOf,
  horizon,
  expectedDates,
  metrics,
  metricKeys,
  observationGrade,
  costUncalibrated,
  noComparableBaseline,
}) {
  // 证据 epoch（§5.2）：窗口内上下文摘要不一致时标记 MIXED_CONTEXT。
  const contextDigests = [
    ...new Set(
      [...metrics.values()]
        .filter(Boolean)
        .map((row) => row.payload.contextDigest),
    ),
  ];
  const contextDigest = contextDigests.at(-1) ?? "no-metrics";
  const mixedContext = contextDigests.length > 1;
  const window = buildEvidenceWindow({
    expectedDates,
    dailyMetrics: metrics,
    horizon,
    contextDigest,
  });
  const sourceDigests = Object.fromEntries(
    window.validDates.map((date) => [
      date,
      metrics.get(date).sourceDigest ?? null,
    ]),
  );
  const inputDigest = await digestOf({
    seriesId,
    window: {
      expectedDates: window.expectedDates,
      validDates: window.validDates,
      missingDates: window.missingDates,
    },
    contextDigest,
    metrics: Object.fromEntries(
      window.validDates.map((date) => [date, metrics.get(date).payload]),
    ),
  });
  const seed = await evidenceSeed({
    namespace: NAMESPACE,
    purpose: policy.purpose,
    asOf,
    orderedWindowDates: window.validDates,
    inputDigest,
    policyDigest,
  });
  const base = {
    purpose: policy.purpose,
    eligibleForPromotion: false,
    repeatedLooksAdjusted: false,
    asOf,
    horizon,
    seriesId,
    window: {
      expectedDates: window.expectedDates,
      validDates: window.validDates,
      missingDates: window.missingDates,
      coverage: Number(window.coverage.toFixed(4)),
    },
    context: { digest: contextDigest, mixedContext },
    method: {
      version: DIAGNOSTIC_METHOD_VERSION,
      blockLength: policy.blockLength,
      resamples: policy.resamples,
      seed,
    },
    tags: evidenceTags({
      observationGrade,
      missingDates: window.missingDates,
      costUncalibrated,
      noComparableBaseline,
    }),
  };
  const publish = (payload) =>
    repository.publishReport({
      namespace: NAMESPACE,
      seriesId,
      asOf,
      horizon,
      purpose: policy.purpose,
      inputDigest,
      policyDigest,
      methodVersion: DIAGNOSTIC_METHOD_VERSION,
      payload,
      inputs: {
        orderedDates: window.expectedDates,
        sourceRefs: window.validDates.map((date) => `${seriesId}:${date}`),
        sourceDigests,
        contextDigest,
      },
    });
  if (!window.validDates.length)
    return (await publish({ ...base, status: "PENDING", family: [] })).report;
  if (window.coverage < policy.minWindowCoverage)
    return (
      await publish({
        ...base,
        status: "INCOMPLETE_DATA",
        family: [],
        reasons: [
          `窗口覆盖 ${window.coverage.toFixed(3)} 低于最低要求 ${policy.minWindowCoverage}`,
        ],
      })
    ).report;
  const segmentLengths = window.segments.map((segment) => segment.length);
  if (Math.min(...segmentLengths) < policy.blockLength)
    return (
      await publish({
        ...base,
        status: "INCOMPLETE_DATA",
        family: [],
        reasons: ["存在短于区块长度的连续片段，不输出区间"],
      })
    ).report;
  const { matrix } = await resampleSegmentIndexMatrix({
    segmentLengths,
    blockLength: policy.blockLength,
    resamples: policy.resamples,
    seedInput: seed,
  });
  // 同一份日期区块索引被整个检验族共享（§6.1），保留同日指标相关性。
  const validDates = window.validDates;
  const rawResults = new Map();
  const estimates = new Map();
  for (const metric of metricKeys) {
    const values = validDates.map(
      (date) => metrics.get(date).payload.values[metricValueKey(metric)],
    );
    const outcome = bootstrapMeanEvidence({
      values,
      indexMatrix: matrix,
      confidenceLevel: policy.confidenceLevel,
      nullMean: 0,
      side: "TWO_SIDED",
      minValidDays: policy.minValidDays,
    });
    estimates.set(metric, outcome);
    rawResults.set(metric, {
      key: metric,
      pRaw: outcome.pRaw,
      reason: outcome.reasons?.at(0) ?? null,
    });
  }
  const family = adjustEvidenceFamily({
    declaredHypotheses: metricKeys,
    results: [...rawResults.values()],
    method: "HOLM",
  });
  const adjustedByKey = new Map(family.hypotheses.map((row) => [row.key, row]));
  const entries = metricKeys.map((metric) => {
    const outcome = estimates.get(metric);
    const adjusted = adjustedByKey.get(metric);
    const degenerate =
      outcome.status === "DEGENERATE" ||
      (outcome.degenerateResampleRatio ?? 0) >
        policy.maxDegenerateResampleRatio;
    const ci =
      outcome.status === "READY" && !degenerate
        ? { ...outcome.ci, scope: "POINTWISE" }
        : null;
    return {
      metric,
      unit: metricUnits(metric),
      status: degenerate ? "DEGENERATE" : outcome.status,
      estimate: outcome.estimate ?? null,
      ci,
      pRaw: outcome.pRaw ?? null,
      pAdjustedWithinFamily: adjusted.pAdjustedWithinFamily,
      standardError: outcome.standardError ?? null,
      validDays: outcome.validDays ?? validDates.length,
      reasons: [
        ...(outcome.reasons ?? []),
        ...(degenerate ? ["退化重采样比例超过政策上限，不输出可靠区间"] : []),
        ...(adjusted.reason ? [adjusted.reason] : []),
      ],
      direction:
        degenerate || outcome.status !== "READY" ? null : directionOf(ci),
    };
  });
  const anyReady = entries.some((entry) => entry.status === "READY");
  const status = mixedContext
    ? anyReady
      ? "MIXED_CONTEXT"
      : "INSUFFICIENT_SAMPLE"
    : anyReady
      ? "READY"
      : entries[0].status;
  const tags = [...base.tags];
  if (horizon !== policy.primaryWindow && horizon === policy.windows[0])
    tags.push("SHORT_WINDOW");
  // 方法模拟资格（§10）：模拟未达阈值的窗口长度如实标注受限探索，
  // 页面与 AI 输入不得据此作结论性表述。
  if (!METHOD_QUALIFIED_HORIZONS.includes(horizon))
    tags.push("METHOD_SIMULATION_LIMITED");
  const payload = {
    ...base,
    tags,
    status,
    family: entries,
    reasons: [
      ...(status === "MIXED_CONTEXT"
        ? [
            "窗口内评分上下文摘要不一致（证据 epoch 变化），持续系统结论需另行声明",
          ]
        : []),
    ],
  };
  return (await publish(payload)).report;
}

// 个股评分质量系列（§3.1）：每日 IC 与观察超额，主检验族两个指标。
export async function buildReviewEvidence(
  env,
  { asOf, horizon, calendarDates } = {},
) {
  const repository = new EvidenceRepository(env);
  const policyRow = await policyBundle(repository);
  const policy = policyRow.payload;
  horizon = horizon ?? policy.primaryWindow;
  if (!policy.windows.includes(horizon))
    throw new Error(`窗口 ${horizon} 不在预登记 windows 内`);
  let expectedDates;
  try {
    expectedDates = await freezeCalendar({ asOf, horizon, calendarDates });
  } catch (error) {
    return { status: "PENDING", reason: `交易日历不可用：${error.message}` };
  }
  const asOfEffective = expectedDates.at(-1);
  const allMetrics = await repository
    .listDailyMetricsAcrossContexts({
      seriesId: REVIEW_SERIES,
      fromDate: expectedDates[0],
      toDate: asOfEffective,
    })
    .catch(() => []);
  // 证据 epoch：取窗口内最新上下文的指标；跨 epoch 仅标记不混合。
  const latestContext =
    allMetrics.at(-1)?.payload.contextDigest ?? "no-metrics";
  const metrics = new Map(
    allMetrics
      .filter((row) => row.payload.contextDigest === latestContext)
      .map((row) => [row.outcomeDate, row]),
  );
  return publishWindowReport({
    repository,
    policy,
    policyDigest: policyRow.digest,
    seriesId: REVIEW_SERIES,
    asOf: asOfEffective,
    horizon,
    expectedDates,
    metrics,
    metricKeys: REVIEW_METRIC_FAMILY,
    observationGrade: true,
    costUncalibrated: false,
    noComparableBaseline: false,
  });
}

// 模拟交易质量系列（§3.3）：主账户完整持久净值。
// 连续账本没有同口径匹配对照：配对部分如实返回 NO_COMPARABLE_BASELINE。
export async function buildAccountEvidence(
  env,
  { asOf, horizon, calendarDates } = {},
) {
  const repository = new EvidenceRepository(env);
  const policyRow = await policyBundle(repository);
  const policy = policyRow.payload;
  horizon = horizon ?? policy.primaryWindow;
  if (!policy.windows.includes(horizon))
    throw new Error(`窗口 ${horizon} 不在预登记 windows 内`);
  let expectedDates;
  try {
    expectedDates = await freezeCalendar({ asOf, horizon, calendarDates });
  } catch (error) {
    return { status: "PENDING", reason: `交易日历不可用：${error.message}` };
  }
  const asOfEffective = expectedDates.at(-1);
  const paper = new PaperRepository(env);
  const { book } = await paper.initialize();
  const rows = (await paper.history("paper_equity", 100000))
    .map((row) => JSON.parse(row.payload))
    .map((row) => ({
      tradeDate: row.date ?? row.trade_date,
      equityCents: row.equityCents,
    }))
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const byDate = new Map(rows.map((row) => [row.tradeDate, row.equityCents]));
  const prior = rows.filter((row) => row.tradeDate < expectedDates[0]);
  const baseEquityCents = prior.length
    ? prior.at(-1).equityCents
    : book.initialCashCents;
  // 账户上下文摘要（§5.2）：期初权益、费用模型、引擎与净值完整性口径。
  const contextDigest = await digestOf({
    account: "primary-continuous",
    initialEquityCents: baseEquityCents,
    feeModel: book.feeModel ?? null,
    executionCost: book.executionCost ?? null,
    returnMeasure: "EQUITY_CHAIN_DECIMAL",
  });
  const validDates = expectedDates.filter((date) => byDate.get(date));
  const missingDates = expectedDates.filter((date) => !byDate.get(date));
  const metrics = new Map();
  let previousEquity = baseEquityCents;
  for (const date of expectedDates) {
    const equity = byDate.get(date);
    if (!equity) {
      metrics.set(date, null);
      continue;
    }
    metrics.set(date, {
      outcomeDate: date,
      sourceDigest: await digestOf({ date, equityCents: equity }),
      payload: {
        outcomeDate: date,
        contextDigest,
        sourceDigest: null,
        values: { meanDailyReturn: equity / previousEquity - 1 },
        status: "READY",
        quality: {},
        exclusionReasons: {},
      },
    });
    previousEquity = equity;
  }
  void missingDates;
  return publishWindowReport({
    repository,
    policy,
    policyDigest: policyRow.digest,
    seriesId: ACCOUNT_SERIES,
    asOf: asOfEffective,
    horizon,
    expectedDates,
    metrics,
    metricKeys: ["MEAN_DAILY_RETURN"],
    observationGrade: false,
    costUncalibrated: true,
    noComparableBaseline: true,
  });
}

// recompute：只重算同一冻结诊断输入（同种子同政策），证明确定性；
// 不重开正式比较、不换种子、不重开窗口。
export async function recomputeEvidence(env, { id, calendarDates } = {}) {
  const repository = new EvidenceRepository(env);
  const report = await repository.getReport(id);
  if (!report) throw new Error("证据报告不存在");
  if (report.purpose !== "DIAGNOSTIC") throw new Error("只允许重算诊断报告");
  const policyRow = await policyBundle(repository);
  if (report.policyDigest !== policyRow.digest)
    throw new Error(
      "政策已变更，原报告保持冻结；如需新口径请以新 asOf 生成新报告",
    );
  const rebuild =
    report.seriesId === REVIEW_SERIES
      ? await buildReviewEvidence(env, {
          asOf: report.asOf,
          horizon: report.horizon,
          calendarDates,
        })
      : await buildAccountEvidence(env, {
          asOf: report.asOf,
          horizon: report.horizon,
          calendarDates,
        });
  if (rebuild.id !== id)
    throw new Error(
      "重算结果与原报告输入不一致：来源数据已修订，生成新报告而非覆盖",
    );
  return rebuild;
}

export async function exportEvidence(env, { id }) {
  const repository = new EvidenceRepository(env);
  const report = await repository.getReport(id);
  if (!report) throw new Error("证据报告不存在");
  const dailyMetrics = await repository
    .listDailyMetricsAcrossContexts({
      seriesId: report.seriesId,
      fromDate: report.inputs?.orderedDates?.[0] ?? "0000-01-01",
      toDate: report.asOf,
    })
    .catch(() => []);
  const policies = await repository.listPolicies(5);
  return {
    format: "limit-lens-evidence-v1",
    exportedAt: new Date().toISOString(),
    report,
    dailyMetrics,
    policies,
    note: "导出可独立重算：verify:evidence 按冻结输入、政策与方法核验摘要、区间与用途限制。",
  };
}

export async function getEvidence(env, { series, asOf, horizon }) {
  const repository = new EvidenceRepository(env);
  const reports = await repository.listReports({ seriesId: series, limit: 60 });
  const matching = reports.filter(
    (report) => report.horizon === horizon && (!asOf || report.asOf <= asOf),
  );
  return { report: matching.at(0) ?? null, history: reports.slice(0, 12) };
}

export async function evidenceOverview(env) {
  const repository = new EvidenceRepository(env);
  const policyRow = await policyBundle(repository);
  const review = await getEvidence(env, {
    series: REVIEW_SERIES,
    horizon: policyRow.payload.primaryWindow,
  });
  const account = await getEvidence(env, {
    series: ACCOUNT_SERIES,
    horizon: policyRow.payload.primaryWindow,
  });
  return {
    policy: policyRow,
    review,
    account,
    note: "滚动证据为探索诊断：purpose=DIAGNOSTIC、eligibleForPromotion=false；区间跨零表示证据不足，不等于策略无效。",
  };
}

// 盘后编排（§8.3）：来源提交后登记每日指标并幂等发布三个预登记窗口的
// 诊断报告。统计失败不阻塞交易/止损；任务发现由次日重跑补齐。
export async function refreshEvidence(env, { date, calendarDates } = {}) {
  const repository = new EvidenceRepository(env);
  const policyRow = await policyBundle(repository);
  const results = { date, recorded: null, reports: [], errors: [] };
  try {
    const recorded = await recordReviewDailyMetric(env, date);
    results.recorded = recorded.recorded;
    if (!recorded.recorded) results.errors.push(recorded.reason);
  } catch (error) {
    results.errors.push(`每日指标登记失败：${error.message}`);
  }
  for (const horizon of policyRow.payload.windows) {
    for (const builder of [buildReviewEvidence, buildAccountEvidence]) {
      try {
        const report = await builder(env, {
          asOf: date,
          horizon,
          calendarDates,
        });
        if (report?.id)
          results.reports.push({
            id: report.id,
            status: report.payload?.status ?? null,
            horizon,
            series: report.seriesId,
          });
        else
          results.errors.push(`${builder.name}：${report?.reason ?? "未发布"}`);
      } catch (error) {
        results.errors.push(`${builder.name} h${horizon}：${error.message}`);
      }
    }
  }
  return results;
}
