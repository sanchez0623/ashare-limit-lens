import { validDate } from "../http.js";
import {
  executionPeriod,
  normalizeExecutionCostPayload,
  EXECUTION_COST_FIELDS,
} from "../../shared/execution-cost.js";
import { digestOf } from "./research-lineage.js";

export const CALIBRATION_VERSION = "execution-calibration-v1";
export const CALIBRATION_RULES = Object.freeze({
  minTrainingOrders: 60,
  minValidationOrders: 30,
  minTrainingDays: 5,
  minValidationDays: 3,
  minStratumFills: 10,
  minQuoteCoverage: 0.9,
  maxQuoteAgeMs: 3000,
  maxValidationMaeBps: 15,
  maxValidationP90ErrorBps: 30,
  impactGridBps: [5, 10, 15, 20, 30],
  exponentGrid: [0.3, 0.5, 0.7],
  premiumGridBps: [0, 5, 10, 15, 20, 30],
  minImpactBucketFills: 20,
});
const periods = [
  "openFirstMinute",
  "openNextFourMinutes",
  "earlySession",
  "regular",
];
export async function calibrationInputDigest(input, basePolicy) {
  return digestOf({
    input: normalizeCalibrationInput(input),
    basePolicy,
    version: CALIBRATION_VERSION,
    rules: CALIBRATION_RULES,
  });
}
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))
  ];
};
const timestamp = (value) =>
  typeof value === "string" &&
  validDate(value.slice(0, 10)) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+08:00)$/.test(
    value,
  ) &&
  Number.isFinite(Date.parse(value));
const marketDate = (value) =>
  new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 10);
const marketTime = (value) =>
  new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(11, 19);

// JSON 标准格式，价格单位为分、数量为股。真实/代理来源及所有者必须显式登记。
// 缺盘口保留为缺失；未成交委托保留，不能只导入成功成交提高覆盖率。
export function normalizeCalibrationInput(input) {
  if (!input || input.schemaVersion !== 1 || input.kind !== "REAL_EXECUTION")
    throw new Error(
      "真实执行校准需要 schemaVersion 1、REAL_EXECUTION 输入；K 线和报价代理不能伪装真实成交",
    );
  const p = input.provenance;
  if (
    !p ||
    ![p.owner, p.source, p.datasetRef].every(
      (v) => typeof v === "string" && v.trim().length >= 2,
    ) ||
    p.role !== "INDEPENDENT_CALIBRATION" ||
    p.paperGenerated !== false ||
    p.ordersComplete !== true ||
    /paper|synthetic|simulation|fixture|模拟|合成/i.test(p.source)
  )
    throw new Error(
      "校准需要独立真实来源、所有者、完整委托声明；纸面成交不能用于校准",
    );
  if (
    !validDate(input.trainingEnd) ||
    !validDate(input.cutoff) ||
    input.trainingEnd >= input.cutoff
  )
    throw new Error("校准训练截止日必须早于后续验证截止日");
  if (
    !Array.isArray(input.orders) ||
    !input.orders.length ||
    input.orders.length > 20000
  )
    throw new Error("校准委托数必须在 1–20000 之间");
  const ids = new Set(),
    fillIds = new Set();
  const orders = input.orders
    .map((order) => {
      if (
        !order ||
        typeof order.id !== "string" ||
        !order.id ||
        ids.has(order.id) ||
        !/^\d{6}$/.test(order.code) ||
        !["BUY", "SELL"].includes(order.side) ||
        !timestamp(order.submittedAt) ||
        !timestamp(order.completedAt) ||
        Date.parse(order.completedAt) < Date.parse(order.submittedAt) ||
        marketDate(order.completedAt) !== marketDate(order.submittedAt) ||
        !Number.isSafeInteger(order.quantity) ||
        order.quantity <= 0 ||
        !["FILLED", "PARTIAL", "CANCELLED", "REJECTED"].includes(
          order.status,
        ) ||
        typeof order.previousLimitUp !== "boolean" ||
        !Number.isSafeInteger(order.marketVolumeShares) ||
        order.marketVolumeShares < 0 ||
        !timestamp(order.marketVolumeObservedAt) ||
        Date.parse(order.marketVolumeObservedAt) >
          Date.parse(order.submittedAt) ||
        marketDate(order.marketVolumeObservedAt) !==
          marketDate(order.submittedAt)
      )
        throw new Error("校准委托身份、时序、数量、参与率或状态无效");
      ids.add(order.id);
      const date = marketDate(order.submittedAt),
        time = marketTime(order.submittedAt);
      if (
        date > input.cutoff ||
        !executionPeriod(time) ||
        time > "15:00:00" ||
        (time >= "11:30:00" && time < "13:00:00")
      )
        throw new Error("校准委托超出截止日或连续竞价时段");
      let quote = null;
      if (order.quote != null) {
        const q = order.quote;
        if (
          !timestamp(q.observedAt) ||
          !Number.isSafeInteger(q.bid1Cents) ||
          q.bid1Cents <= 0 ||
          !Number.isSafeInteger(q.ask1Cents) ||
          q.ask1Cents <= 0 ||
          q.bid1Cents > q.ask1Cents ||
          Date.parse(q.observedAt) > Date.parse(order.submittedAt) ||
          marketDate(q.observedAt) !== date
        )
          throw new Error("盘口价格无效或使用了委托之后的未来盘口");
        quote = {
          observedAt: q.observedAt,
          bid1Cents: q.bid1Cents,
          ask1Cents: q.ask1Cents,
        };
      }
      if (!Array.isArray(order.fills))
        throw new Error("校准委托必须带 fills 数组，未成交使用空数组");
      const fills = order.fills
        .map((f) => {
          if (
            !f ||
            typeof f.id !== "string" ||
            !f.id ||
            fillIds.has(f.id) ||
            !timestamp(f.executedAt) ||
            Date.parse(f.executedAt) < Date.parse(order.submittedAt) ||
            Date.parse(f.executedAt) > Date.parse(order.completedAt) ||
            !Number.isSafeInteger(f.quantity) ||
            f.quantity <= 0 ||
            !Number.isSafeInteger(f.priceCents) ||
            f.priceCents <= 0
          )
            throw new Error(
              "真实成交身份、时序、数量或价格无效，代理数据不得伪装成交",
            );
          fillIds.add(f.id);
          return {
            id: f.id,
            executedAt: f.executedAt,
            quantity: f.quantity,
            priceCents: f.priceCents,
          };
        })
        .sort(
          (a, b) =>
            a.executedAt.localeCompare(b.executedAt) ||
            a.id.localeCompare(b.id),
        );
      const filled = fills.reduce((n, f) => n + f.quantity, 0);
      if (
        (filled && !order.marketVolumeShares) ||
        filled > order.quantity ||
        (order.status === "FILLED" && filled !== order.quantity) ||
        (order.status === "PARTIAL" &&
          !(filled > 0 && filled < order.quantity)) ||
        (order.status === "REJECTED" && filled !== 0)
      )
        throw new Error("委托状态与真实成交数量不一致");
      return {
        id: order.id,
        code: order.code,
        side: order.side,
        submittedAt: order.submittedAt,
        completedAt: order.completedAt,
        quantity: order.quantity,
        status: order.status,
        previousLimitUp: order.previousLimitUp,
        marketVolumeShares: order.marketVolumeShares,
        marketVolumeObservedAt: order.marketVolumeObservedAt,
        quote,
        fills,
      };
    })
    .sort(
      (a, b) =>
        a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id),
    );
  return {
    schemaVersion: 1,
    kind: input.kind,
    provenance: {
      owner: p.owner,
      source: p.source,
      datasetRef: p.datasetRef,
      role: p.role,
      paperGenerated: false,
      ordersComplete: true,
    },
    trainingEnd: input.trainingEnd,
    cutoff: input.cutoff,
    orders,
  };
}

function samplesOf(input, payload) {
  return input.orders.map((o) => {
    const date = marketDate(o.submittedAt),
      period = executionPeriod(marketTime(o.submittedAt));
    const quoteFresh =
      o.quote &&
      Date.parse(o.submittedAt) - Date.parse(o.quote.observedAt) <=
        CALIBRATION_RULES.maxQuoteAgeMs;
    const liquidityFresh =
      Date.parse(o.submittedAt) - Date.parse(o.marketVolumeObservedAt) <=
      CALIBRATION_RULES.maxQuoteAgeMs;
    const fresh = quoteFresh && liquidityFresh;
    const quantity = o.fills.reduce((n, f) => n + f.quantity, 0);
    const midpoint = fresh ? (o.quote.bid1Cents + o.quote.ask1Cents) / 2 : null;
    const vwap = quantity
      ? o.fills.reduce((n, f) => n + f.priceCents * f.quantity, 0) / quantity
      : null;
    const observedBps =
      midpoint && vwap
        ? ((o.side === "BUY" ? vwap - midpoint : midpoint - vwap) / midpoint) *
          10000
        : null;
    const spreadBps = midpoint
      ? ((o.quote.ask1Cents - o.quote.bid1Cents) / (2 * midpoint)) * 10000
      : null;
    const participation = quantity ? quantity / o.marketVolumeShares : 0;
    // 每个观测单位为完整委托；不得将同一委托拆成交笔数凑样本量。
    const impactBps = quantity
      ? payload.impactBpsAtReferenceParticipation *
        Math.pow(
          participation / payload.referenceParticipation,
          payload.impactExponent,
        )
      : null;
    const premium = o.previousLimitUp ? payload.previousLimitUpPremiumBps : 0;
    const predictedBps =
      spreadBps == null || !quantity
        ? null
        : spreadBps + payload.periodBaseBps[period] + premium + impactBps;
    return {
      id: o.id,
      date,
      period,
      previousLimitUp: o.previousLimitUp,
      participation,
      liquidity: o.marketVolumeShares < 100000 ? "LOW" : "HIGH",
      fresh: Boolean(fresh),
      quoteFresh: Boolean(quoteFresh),
      liquidityFresh,
      quantity,
      observedBps,
      predictedBps,
      spreadBps,
      residualBps:
        observedBps == null
          ? null
          : observedBps - spreadBps - premium - impactBps,
      failed: quantity < o.quantity,
    };
  });
}
function metrics(samples) {
  const observed = samples.filter((s) => s.observedBps != null);
  const errors = observed.map((s) => Math.abs(s.observedBps - s.predictedBps));
  return {
    orders: samples.length,
    days: new Set(samples.map((s) => s.date)).size,
    quoteCoverage: samples.length
      ? samples.filter((s) => s.quoteFresh).length / samples.length
      : 0,
    liquidityCoverage: samples.length
      ? samples.filter((s) => s.liquidityFresh).length / samples.length
      : 0,
    filledOrders: observed.length,
    failedOrders: samples.filter((s) => s.failed).length,
    p50Bps: quantile(
      observed.map((s) => s.observedBps),
      0.5,
    ),
    p90Bps: quantile(
      observed.map((s) => s.observedBps),
      0.9,
    ),
    p95Bps: quantile(
      observed.map((s) => s.observedBps),
      0.95,
    ),
    maeBps: errors.length
      ? errors.reduce((a, b) => a + b, 0) / errors.length
      : null,
    p90ErrorBps: quantile(errors, 0.9),
  };
}

export async function calibrateExecutionCost(rawInput, basePolicy) {
  const input = normalizeCalibrationInput(rawInput);
  if (
    (await digestOf(basePolicy.payload)) !== basePolicy.payloadDigest ||
    basePolicy.payload.executionStressMultiplier !== 1
  )
    throw new Error("校准基础政策摘要或执行倍数无效");
  const payload = structuredClone(basePolicy.payload);
  const initial = samplesOf(input, payload);
  const training = initial.filter((s) => s.date <= input.trainingEnd);
  const fittedPeriods = [],
    priorPeriods = [];
  for (const period of periods) {
    const samples = training.filter(
      (s) => s.period === period && s.residualBps != null,
    );
    if (samples.length < CALIBRATION_RULES.minStratumFills)
      priorPeriods.push(period);
    else fittedPeriods.push(period);
  }
  const usable = training.filter((s) => s.observedBps != null);
  const impactIdentifiable =
    [true, false].every(
      (low) =>
        usable.filter((s) => s.participation <= 0.005 === low).length >=
        CALIBRATION_RULES.minImpactBucketFills,
    ) && new Set(usable.map((s) => s.participation)).size >= 3;
  const premiumIdentifiable = [true, false].every(
    (flag) =>
      usable.filter((s) => s.previousLimitUp === flag).length >=
      CALIBRATION_RULES.minStratumFills,
  );
  const kappas = impactIdentifiable
    ? [
        ...new Set([
          payload.impactBpsAtReferenceParticipation,
          ...CALIBRATION_RULES.impactGridBps,
        ]),
      ]
    : [payload.impactBpsAtReferenceParticipation];
  const exponents = impactIdentifiable
    ? [...new Set([payload.impactExponent, ...CALIBRATION_RULES.exponentGrid])]
    : [payload.impactExponent];
  const premiums = premiumIdentifiable
    ? [
        ...new Set([
          payload.previousLimitUpPremiumBps,
          ...CALIBRATION_RULES.premiumGridBps,
        ]),
      ]
    : [payload.previousLimitUpPremiumBps];
  let fitted = payload,
    bestError = Infinity;
  // 固定、有限的训练集网格；当前先验排在最前，相同误差不任意改变系数。
  for (const kappa of kappas)
    for (const exponent of exponents)
      for (const premium of premiums) {
        const candidate = {
          ...payload,
          periodBaseBps: { ...payload.periodBaseBps },
          impactBpsAtReferenceParticipation: kappa,
          impactExponent: exponent,
          previousLimitUpPremiumBps: premium,
        };
        const samples = samplesOf(input, candidate).filter(
          (s) => s.date <= input.trainingEnd,
        );
        for (const period of fittedPeriods) {
          const values = samples
            .filter((s) => s.period === period && s.residualBps != null)
            .map((s) => s.residualBps);
          const field = EXECUTION_COST_FIELDS.find(
            (f) => f.key === `periodBaseBps.${period}`,
          );
          candidate.periodBaseBps[period] = Math.max(
            field.min,
            Math.min(field.max, Math.round(quantile(values, 0.5))),
          );
        }
        const error = metrics(
          samplesOf(input, candidate).filter(
            (s) => s.date <= input.trainingEnd,
          ),
        ).maeBps;
        if (error != null && error < bestError - 1e-9) {
          bestError = error;
          fitted = candidate;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
  fitted = normalizeExecutionCostPayload(fitted);
  const all = samplesOf(input, fitted);
  const train = metrics(all.filter((s) => s.date <= input.trainingEnd));
  const validationSamples = all.filter((s) => s.date > input.trainingEnd);
  const validation = metrics(validationSamples);
  const priorValidation = metrics(
    initial.filter((s) => s.date > input.trainingEnd),
  );
  const real = input.kind === "REAL_EXECUTION";
  const checks = {
    samples:
      train.orders >= CALIBRATION_RULES.minTrainingOrders &&
      validation.orders >= CALIBRATION_RULES.minValidationOrders &&
      train.days >= CALIBRATION_RULES.minTrainingDays &&
      validation.days >= CALIBRATION_RULES.minValidationDays,
    coverage:
      train.quoteCoverage >= CALIBRATION_RULES.minQuoteCoverage &&
      validation.quoteCoverage >= CALIBRATION_RULES.minQuoteCoverage,
    liquidity:
      train.liquidityCoverage >= CALIBRATION_RULES.minQuoteCoverage &&
      validation.liquidityCoverage >= CALIBRATION_RULES.minQuoteCoverage,
    fills:
      !real ||
      (train.filledOrders >= CALIBRATION_RULES.minTrainingOrders &&
        validation.filledOrders >= CALIBRATION_RULES.minValidationOrders),
    accuracy:
      !real ||
      (validation.maeBps != null &&
        validation.maeBps <= CALIBRATION_RULES.maxValidationMaeBps &&
        validation.p90ErrorBps <= CALIBRATION_RULES.maxValidationP90ErrorBps &&
        validation.maeBps <= priorValidation.maeBps),
    fitted: !real || fittedPeriods.length > 0,
    validationStrata:
      fittedPeriods.every(
        (period) =>
          validationSamples.filter(
            (s) => s.period === period && s.observedBps != null,
          ).length >= CALIBRATION_RULES.minStratumFills,
      ) &&
      (!impactIdentifiable ||
        [true, false].every(
          (low) =>
            validationSamples.filter(
              (s) => s.observedBps != null && s.participation <= 0.005 === low,
            ).length >= CALIBRATION_RULES.minStratumFills,
        )) &&
      (!premiumIdentifiable ||
        [true, false].every(
          (flag) =>
            validationSamples.filter(
              (s) => s.observedBps != null && s.previousLimitUp === flag,
            ).length >= CALIBRATION_RULES.minStratumFills,
        )),
  };
  const passed = Object.values(checks).every(Boolean);
  const strata = Object.fromEntries(
    [
      ...new Set(
        all.map(
          (s) =>
            `${s.period}/${s.previousLimitUp ? "LIMIT_UP" : "NORMAL"}/${s.liquidity}/${s.participation <= 0.005 ? "LOW_PARTICIPATION" : "HIGH_PARTICIPATION"}`,
        ),
      ),
    ].map((key) => [
      key,
      metrics(
        all.filter(
          (s) =>
            `${s.period}/${s.previousLimitUp ? "LIMIT_UP" : "NORMAL"}/${s.liquidity}/${s.participation <= 0.005 ? "LOW_PARTICIPATION" : "HIGH_PARTICIPATION"}` ===
            key,
        ),
      ),
    ]),
  );
  return {
    version: CALIBRATION_VERSION,
    inputDigest: await calibrationInputDigest(input, basePolicy),
    cutoff: input.cutoff,
    trainingEnd: input.trainingEnd,
    basePolicy,
    rules: CALIBRATION_RULES,
    payload: fitted,
    payloadDigest: await digestOf(fitted),
    fittedPeriods,
    priorPeriods,
    train,
    validation,
    priorValidation,
    strata,
    checks,
    passed,
    calibratedParameters: {
      periods: fittedPeriods,
      impact: impactIdentifiable,
      limitUpPremium: premiumIdentifiable,
    },
    calibrationStatus: passed ? "EXECUTION_CALIBRATED" : "PRIOR_UNCALIBRATED",
    limitations:
      "真实来源由导入者声明，系统不能认证券商原始凭证。成本以委托前盘口中价为参照，含执行延迟的总实现偏差；不是纯自身冲击的因果估计。参与率缺乏变化或样本不足的分层保留先验，验证数据不参与拟合。",
  };
}

export async function verifyExecutionCalibration(bundle) {
  const input = normalizeCalibrationInput(bundle.input);
  if (
    bundle.inputId !==
    `cal-input-${await calibrationInputDigest(input, bundle.report.basePolicy)}`
  )
    throw new Error("校准输入 id 不一致");
  const report = await calibrateExecutionCost(input, bundle.report.basePolicy);
  const digest = await digestOf(report);
  if (
    bundle.id !== `cal-${digest}` ||
    bundle.digest !== digest ||
    (await digestOf(bundle.report)) !== digest
  )
    throw new Error("校准报告、id、分块或独立重算不一致");
  return {
    passed: true,
    eligible: report.passed,
    calibrationStatus: report.calibrationStatus,
  };
}

export async function verifyCalibratedPolicy(policy, evidence) {
  if (!policy || policy.calibrationStatus === "PRIOR_UNCALIBRATED") return true;
  if (!evidence) throw new Error("已校准政策缺少独立执行/盘口证据");
  const audit = await verifyExecutionCalibration(evidence);
  if (
    !audit.eligible ||
    evidence.report.payloadDigest !== (policy.payloadDigest ?? policy.digest) ||
    evidence.report.calibrationStatus !== policy.calibrationStatus ||
    evidence.report.cutoff !== policy.calibrationCutoff ||
    !policy.effectiveFrom ||
    policy.effectiveFrom <= evidence.report.cutoff
  )
    throw new Error("成本校准声明与独立证据不一致");
  return true;
}
