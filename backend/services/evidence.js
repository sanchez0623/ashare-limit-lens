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
  ACCOUNT_METRIC_FAMILY,
  REVIEW_EVIDENCE_SERIES,
  ACCOUNT_EVIDENCE_SERIES,
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
// 系列与检验族常量统一从预登记政策导出（P1-2）：verifier 按同一来源核对。
export const REVIEW_SERIES = REVIEW_EVIDENCE_SERIES;
export const ACCOUNT_SERIES = ACCOUNT_EVIDENCE_SERIES;

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
// 返回窗口日期与窗口之前的最近交易日（predecessor）：账户系列据此核验
// 期初净值与窗口首日的相邻性（§3.3 窗口首日相对捕获期初权益）。
async function freezeCalendar({ asOf, horizon, calendarDates }) {
  const selfFreeze = async () => {
    const start = new Date(
      Date.parse(`${asOf}T00:00:00Z`) - Math.ceil(horizon * 2.2) * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    // 行情接口按条数截断：必须请求覆盖整个回看区间的条数，否则 120 日
    // 窗口只能取到接口默认的 80 条（P1-2）。
    const limit = Math.ceil(horizon * 2.2) + 10;
    // tradingCalendar 第四参为日历条数（第三参为基准指数，证据日历不需要）。
    const { dates } = await tradingCalendar(start, asOf, null, limit);
    const ordered = dates.filter((date) => date <= asOf);
    const expected = ordered.slice(-horizon);
    if (expected.length !== horizon)
      throw new Error("交易日历不足窗口长度，不补长窗口");
    const index = ordered.indexOf(expected[0]);
    return {
      dates: expected,
      predecessor: index > 0 ? ordered[index - 1] : null,
    };
  };
  if (Array.isArray(calendarDates)) {
    const ordered = [...calendarDates].filter((date) => date <= asOf).sort();
    // 自动流程可能误传“未来日历”（如账户结算交出的下一交易日列表）：
    // 过滤后为空说明调用方没有提供窗口内的历史日历，回退到自行冻结，
    // 而不是把窗口冻结成空（P1-2）。
    if (!ordered.length) return await selfFreeze();
    const expected = ordered.slice(-horizon);
    if (expected.length !== horizon)
      throw new Error("冻结日历不足窗口长度，不补长窗口");
    const index = ordered.indexOf(expected[0]);
    return {
      dates: expected,
      predecessor: index > 0 ? ordered[index - 1] : null,
    };
  }
  return await selfFreeze();
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

// 标签由窗口/政策/系列结构完全派生（§4/§7.1/§10），与是否输出检验族无关：
// 空样本、覆盖不足、片段过短等提前返回的报告同样如实标注受限探索，
// 否则核验端按结构派生出的标签会与发布端不一致（P1 正常导出误拒绝）。
function evidenceTags({
  observationGrade,
  missingDates,
  costUncalibrated,
  noComparableBaseline,
  horizon,
  policy,
}) {
  const tags = ["EXPLORATORY_REPEATED_LOOKS"];
  if (missingDates?.length) tags.push("CONDITIONAL_ON_OBSERVED_DAYS");
  if (observationGrade) tags.push("OBSERVATION_NOT_EXECUTABLE");
  if (costUncalibrated) tags.push("COST_PRIOR_UNCALIBRATED");
  if (noComparableBaseline) tags.push("NO_COMPARABLE_BASELINE");
  if (horizon !== policy.primaryWindow && horizon === policy.windows[0])
    tags.push("SHORT_WINDOW");
  // 方法模拟资格（§10）：模拟未达阈值的窗口长度如实标注受限探索，
  // 页面与 AI 输入不得据此作结论性表述。
  if (!METHOD_QUALIFIED_HORIZONS.includes(horizon))
    tags.push("METHOD_SIMULATION_LIMITED");
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
  // 每日质量闸门（§4/§5.1）：仅 status=READY 的日指标进入诊断序列。
  // 未通过质量的日期留在窗口里并公开剔除原因，不计入覆盖率与有效天数；
  // 空评分等不合格样本不得计为有效（P1-3）。
  const readyMetrics = new Map();
  const excludedDates = [];
  const exclusionReasons = {};
  for (const date of expectedDates) {
    const row = metrics.get(date);
    if (!row) continue;
    if (row.payload?.status === "READY") {
      readyMetrics.set(date, row);
      continue;
    }
    excludedDates.push(date);
    exclusionReasons[date] =
      row.payload?.reasons?.join("；") ??
      row.payload?.status ??
      "日指标质量不合格";
  }
  // 证据 epoch（§5.2）：窗口内上下文摘要不一致时标记 MIXED_CONTEXT。
  const contextDigests = [
    ...new Set(
      [...readyMetrics.values()]
        .filter(Boolean)
        .map((row) => row.payload.contextDigest),
    ),
  ];
  const contextDigest = contextDigests.at(-1) ?? "no-metrics";
  const mixedContext = contextDigests.length > 1;
  const window = buildEvidenceWindow({
    expectedDates,
    dailyMetrics: readyMetrics,
    horizon,
    contextDigest,
  });
  // 质量剔除日与无指标缺失日分开呈现：missingDates 只含无日指标的日期，
  // 与 validDates/excludedDates 互斥并覆盖冻结日历（P1-3/P1-6）。
  const excludedDateSet = new Set(excludedDates);
  const missingDates = window.missingDates.filter(
    (date) => !excludedDateSet.has(date),
  );
  const sourceDigests = Object.fromEntries(
    window.validDates.map((date) => [
      date,
      readyMetrics.get(date).sourceDigest ?? null,
    ]),
  );
  // 冻结输入清单（§8.2）：报告发布时把参与计算的每日指标连同摘要一起
  // 固化到 manifest，来源修订后旧报告仍可从导出独立重算（P1-5）。
  const manifestMetrics = await Promise.all(
    window.validDates.map(async (date) => {
      const row = readyMetrics.get(date);
      return {
        outcomeDate: date,
        contextDigest: row.payload.contextDigest,
        sourceDigest: row.sourceDigest ?? null,
        payload: row.payload,
        digest: row.digest ?? (await digestOf(row.payload)),
      };
    }),
  );
  const inputDigest = await digestOf({
    seriesId,
    window: {
      expectedDates: window.expectedDates,
      validDates: window.validDates,
      missingDates,
    },
    contextDigest,
    metrics: Object.fromEntries(
      window.validDates.map((date) => [date, readyMetrics.get(date).payload]),
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
      missingDates,
      excludedDates,
      exclusionReasons,
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
      horizon,
      policy,
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
        metrics: manifestMetrics,
      },
    });
  if (!window.validDates.length) {
    const allExcluded = excludedDates.length > 0;
    return (
      await publish({
        ...base,
        status: allExcluded ? "INSUFFICIENT_SAMPLE" : "PENDING",
        family: [],
        reasons: allExcluded
          ? [
              `窗口内全部 ${excludedDates.length} 个日指标未通过每日质量闸门，不输出统计结论`,
            ]
          : undefined,
      })
    ).report;
  }
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
      (date) => readyMetrics.get(date).payload.values[metricValueKey(metric)],
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
  const payload = {
    ...base,
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
  let frozen;
  try {
    frozen = await freezeCalendar({ asOf, horizon, calendarDates });
  } catch (error) {
    return { status: "PENDING", reason: `交易日历不可用：${error.message}` };
  }
  const expectedDates = frozen.dates;
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
  let frozen;
  try {
    frozen = await freezeCalendar({ asOf, horizon, calendarDates });
  } catch (error) {
    return { status: "PENDING", reason: `交易日历不可用：${error.message}` };
  }
  const expectedDates = frozen.dates;
  const asOfEffective = expectedDates.at(-1);
  const paper = new PaperRepository(env);
  const { book } = await paper.initialize();
  const rows = (await paper.history("paper_equity", 100000))
    .map((row) => JSON.parse(row.payload))
    .map((row) => ({
      tradeDate: row.date ?? row.trade_date,
      equityCents: row.equityCents,
      // 净值完整性（P1-3）：complete=false 表示当日净值为临时值
      // （如缺行情/分钟数据），当日与次日收益都不可作为有效单日样本。
      complete: row.complete !== false,
    }))
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const byDate = new Map(rows.map((row) => [row.tradeDate, row]));
  const prior = rows.filter((row) => row.tradeDate < expectedDates[0]);
  // 净值完整性（§5.2）：期初权益必须是窗口首日之前最近交易日的已结算净值。
  // 无法核验相邻性、期初净值不完整、或账户存在更早历史但净值序列缺失时，
  // 窗口首日的收益可能跨越多个交易日，不得算作单日样本（P1-4/P1-3）。
  let baseEquityCents;
  let firstDayAdjacent;
  if (prior.length) {
    baseEquityCents = prior.at(-1).equityCents;
    firstDayAdjacent =
      frozen.predecessor != null &&
      prior.at(-1).tradeDate === frozen.predecessor &&
      prior.at(-1).complete !== false;
  } else if (book.lastDate && book.lastDate < expectedDates[0]) {
    // 账户在窗口之前已有结算，但净值序列缺失：期初权益不可信。
    baseEquityCents = book.initialCashCents;
    firstDayAdjacent = false;
  } else {
    // 账户首个结算日不早于窗口首日：期初现金即捕获期初权益。
    baseEquityCents = book.initialCashCents;
    firstDayAdjacent = true;
  }
  // 账户上下文摘要（§5.2）：期初权益、费用模型、引擎与净值完整性口径。
  const contextDigest = await digestOf({
    account: "primary-continuous",
    initialEquityCents: baseEquityCents,
    feeModel: book.feeModel ?? null,
    executionCost: book.executionCost ?? null,
    returnMeasure: "EQUITY_CHAIN_DECIMAL",
    equityIntegrity: "GAP_INVALIDATES_FOLLOWING_DAY",
  });
  const metrics = new Map();
  const buildPayload = (date, values, status, reasons = []) => ({
    outcomeDate: date,
    contextDigest,
    sourceDigest: null,
    values,
    status,
    quality: {},
    exclusionReasons: {},
    ...(reasons.length ? { reasons } : {}),
  });
  let previousEquity = baseEquityCents;
  // firstDayAdjacent=false 时窗口首日不可作为单日样本；缺口后的第一天
  // 同理：跨缺口收益是多个交易日的合计，不能算成一天（P1-4）。
  let previousSettled = firstDayAdjacent;
  let pendingReason = firstDayAdjacent
    ? null
    : "期初净值与窗口首日不相邻或不可核验，跨期收益无法拆分为单日";
  for (const date of expectedDates) {
    const row = byDate.get(date);
    if (!row || row.equityCents === undefined || row.equityCents === null) {
      metrics.set(date, null);
      if (previousSettled)
        pendingReason = "前一日净值缺失，跨缺口收益无法拆分为单日";
      previousSettled = false;
      continue;
    }
    const equity = row.equityCents;
    if (!row.complete) {
      // 净值不完整（P1-3）：当日为临时净值，当日与次日都不作为有效
      // 单日样本，且当日净值不得作为后续收益的基数。
      metrics.set(date, {
        outcomeDate: date,
        sourceDigest: await digestOf({ date, equityCents: equity }),
        payload: buildPayload(
          date,
          { meanDailyReturn: null },
          "INSUFFICIENT_SAMPLE",
          ["当日净值不完整（complete=false），不作为有效样本"],
        ),
      });
      if (previousSettled)
        pendingReason =
          "前一日净值不完整（complete=false），跨期收益无法拆分为单日";
      previousSettled = false;
      continue;
    }
    if (!previousSettled) {
      metrics.set(date, {
        outcomeDate: date,
        sourceDigest: await digestOf({ date, equityCents: equity }),
        payload: buildPayload(
          date,
          { meanDailyReturn: null },
          "INSUFFICIENT_SAMPLE",
          [pendingReason ?? "前一日净值缺失，跨缺口收益无法拆分为单日"],
        ),
      });
      pendingReason = null;
      previousSettled = true;
      previousEquity = equity;
      continue;
    }
    const value = equity / previousEquity - 1;
    const broken = !Number.isFinite(value) || previousEquity <= 0 || equity < 0;
    metrics.set(date, {
      outcomeDate: date,
      sourceDigest: await digestOf({ date, equityCents: equity }),
      payload: broken
        ? buildPayload(date, { meanDailyReturn: null }, "INSUFFICIENT_SAMPLE", [
            "期初或当日净值无效，无法计算单日收益",
          ])
        : buildPayload(date, { meanDailyReturn: value }, "READY"),
    });
    previousEquity = equity;
  }
  return publishWindowReport({
    repository,
    policy,
    policyDigest: policyRow.digest,
    seriesId: ACCOUNT_SERIES,
    asOf: asOfEffective,
    horizon,
    expectedDates,
    metrics,
    metricKeys: ACCOUNT_METRIC_FAMILY,
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
  // 输入冻结（P1-5）：优先使用报告发布时固化的 manifest 指标，来源修订
  // 后旧报告仍可独立重算；旧报告（无冻结清单）回退当前日指标。
  const frozenMetrics = report.inputs?.metrics;
  const dailyMetrics = frozenMetrics?.length
    ? frozenMetrics
    : await repository
        .listDailyMetricsAcrossContexts({
          seriesId: report.seriesId,
          fromDate: report.inputs?.orderedDates?.[0] ?? "0000-01-01",
          toDate: report.asOf,
        })
        .catch(() => []);
  // 政策必须能按报告的 policyDigest 找回，否则 verifier 无法重算（P1-5）。
  const policies = await repository.listPolicies(5);
  const byDigest = await repository.getPolicyByDigest(report.policyDigest);
  if (byDigest && !policies.some((row) => row.digest === byDigest.digest))
    policies.unshift(byDigest);
  if (!policies.some((row) => row.digest === report.policyDigest)) {
    const fallbackPayload = normalizeEvidencePolicy(undefined);
    const fallbackDigest = await digestOf(fallbackPayload);
    if (fallbackDigest === report.policyDigest)
      policies.push({
        id: "default",
        version: 0,
        payload: fallbackPayload,
        digest: fallbackDigest,
        effectiveFrom: null,
        createdAt: null,
      });
  }
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
  // asOf 与 horizon 下推到 SQL（P2-1）：先取最新 60 条再过滤会漏掉
  // 深分页之外的历史报告，历史 asOf 查询必须完整。
  const reports = await repository.listReports({
    seriesId: series,
    limit: 60,
    asOf,
    horizon,
  });
  return { report: reports.at(0) ?? null, history: reports.slice(0, 12) };
}

export async function evidenceOverview(env, { asOf } = {}) {
  const repository = new EvidenceRepository(env);
  const policyRow = await policyBundle(repository);
  const review = await getEvidence(env, {
    series: REVIEW_SERIES,
    asOf,
    horizon: policyRow.payload.primaryWindow,
  });
  const account = await getEvidence(env, {
    series: ACCOUNT_SERIES,
    asOf,
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
