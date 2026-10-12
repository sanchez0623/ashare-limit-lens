import { createPlan, executePlan, newBook, BASE_STRATEGY } from "./trading.js";
import {
  selectionPolicyForBook,
  selectionPolicyFields,
} from "./signal-selection.js";
import {
  openSession,
  advanceSession,
  closeSession,
  marketClock,
  inSession,
} from "./realtime.js";
import {
  DEFAULT_INITIAL_CAPITAL,
  DEFAULT_FEES,
  normalizeFees,
} from "../../shared/fees.js";

const RANGES = {
  minScore: [70, 95],
  minSectorScore: [40, 80],
  maxPositions: [2, 5],
  maxHoldDays: [2, 10],
  stopLoss: [0.02, 0.08],
  takeProfit: [0.06, 0.2],
  maxBuyGap: [0, 0.04],
  tFraction: [0.1, 0.25],
  tBuyDip: [0.01, 0.04],
  tSellRise: [0.01, 0.04],
};
export { RANGES };
export function validateProposal(output, base = BASE_STRATEGY) {
  if (
    !output ||
    typeof output !== "object" ||
    Array.isArray(output) ||
    typeof output.rationale !== "string" ||
    output.rationale.length > 2000
  )
    throw new Error("AI 建议结构无效");
  const patch = output.patch;
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    !Object.keys(patch).length
  )
    throw new Error("AI 未给出有效参数");
  for (const [key, value] of Object.entries(patch)) {
    if (key === "weights") {
      if (
        !Array.isArray(value) ||
        value.length !== 6 ||
        value.some((v) => !Number.isInteger(v) || v < 0 || v > 50) ||
        !value.some((v) => v > 0)
      )
        throw new Error("AI 权重不符合约束");
    } else {
      const range = RANGES[key];
      if (
        !range ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < range[0] ||
        value > range[1]
      )
        throw new Error("AI 提出了未授权或越界的参数");
      if (
        ["minScore", "minSectorScore", "maxPositions", "maxHoldDays"].includes(
          key,
        ) &&
        !Number.isInteger(value)
      )
        throw new Error("AI 整数参数无效");
    }
  }
  return {
    params: { ...structuredClone(base), ...patch },
    patch: { ...patch },
    rationale: output.rationale,
  };
}
export function replayStrategy(
  pairs,
  strategy,
  initialCapital = DEFAULT_INITIAL_CAPITAL,
  feeConfig = DEFAULT_FEES,
  initialBook = null,
  executionCostPolicy = null,
  options = {},
) {
  // observationOnly：调用方显式声明该窗口按观察口径评估（如冷启动训练
  // 的记录性指标），日线观察不视为覆盖缺口；但结果仍标注观察口径，
  // 不得据此主张可执行净收益或用于晋级（§4.4）。
  const observationGrade = options.observationOnly === true;
  let book = initialBook
    ? structuredClone(initialBook)
    : newBook(initialCapital, feeConfig);
  const policy = options.selectionPolicy ?? selectionPolicyForBook(book);
  const policyFields = selectionPolicyFields(policy);
  const equities = [],
    fills = [];
  let covered = true;
  let reason = null;
  // 原始分跨日回查：逐日累积已见评分，持仓掉出当日评分池时取最近一次入池评分。
  const scoreHistory = new Map();
  for (const pair of pairs) {
    if (
      pair.snapshot.date !== pair.dataset.previousTradingDate ||
      pair.snapshot.date >= pair.dataset.date
    ) {
      covered = false;
      reason = "冻结评分与行情不是相邻交易日";
      break;
    }
    for (const stock of pair.snapshot?.stocks ?? []) {
      if (stock?.score == null) continue;
      const score = Number(stock.score);
      if (Number.isFinite(score)) scoreHistory.set(stock.code, score);
    }
    // 情景重放（§6.2）：每个情景冻结自己的成本政策，重新生成因果计划与成交；
    // 未显式传入时使用默认政策，新研究不再默认全时段 10bps。
    const plan = createPlan(
      pair.snapshot,
      book,
      strategy,
      "validation",
      pair.snapshot.createdAt,
      {
        executionCostPolicy: executionCostPolicy ?? undefined,
        originalScoreLookup: (code) => scoreHistory.get(code) ?? null,
        selectionPolicy: policy,
      },
    );
    try {
      let result;
      if (pair.dataset.executionMode === "realtime") {
        if (!book.lastDate) book.lastDate = pair.snapshot.date;
        let session = openSession(book, plan, pair.dataset.date),
          liveFills = [];
        const observations = pair.observations || [];
        const watched = new Set(
          observations.flatMap((tick) => Object.keys(tick.quotes)),
        );
        if (
          !observations.length ||
          observations[0].observedAt > `${pair.dataset.date}T01:30:30.000Z` ||
          observations.at(-1).observedAt <
            `${pair.dataset.date}T06:55:00.000Z` ||
          plan.orders.some(
            (order) => order.action !== "HOLD" && !watched.has(order.code),
          )
        )
          covered = false;
        for (let i = 0; i < observations.length; i++) {
          const tick = observations[i];
          if (
            i &&
            new Date(tick.observedAt) -
              new Date(observations[i - 1].observedAt) >
              Math.max(
                20000,
                Math.min(60, tick.pollIntervalSeconds || 10) * 2000,
              ) &&
            inSession(
              marketClock(new Date(observations[i - 1].observedAt)).time,
            ) &&
            !(
              marketClock(new Date(observations[i - 1].observedAt)).time >=
                "11:29:40" &&
              marketClock(new Date(tick.observedAt)).time <= "13:00:20"
            )
          )
            covered = false;
          const step = advanceSession(book, session, tick);
          book = step.book;
          session = step.session;
          liveFills.push(...step.ledger);
        }
        result = closeSession(book, session, pair.dataset);
        result.ledger = liveFills;
        result.equity.missingMinuteOrders = 0;
      } else result = executePlan(book, plan, pair.dataset);
      book = result.book;
      equities.push(result.equity);
      fills.push(...result.ledger);
      // 日线观察与可信执行净收益必须隔离（§4.4）：DAILY_OBSERVATION_ONLY
      // 的窗口不构成覆盖，不能用于晋级或验证结论；观察口径评估除外。
      if (
        result.outcomes.some((outcome) =>
          String(outcome.reason || "").includes("DAILY_OBSERVATION_ONLY"),
        )
      ) {
        if (!observationGrade) {
          covered = false;
          reason =
            reason ??
            "DAILY_OBSERVATION_ONLY：日线观察收益不构成可信执行净收益";
        }
      }
      if (!observationGrade && result.equity.missingMinuteOrders > 0 && !reason)
        reason = "缺少盘中分钟数据：做 T 被跳过，窗口收益为观察口径";
      if (
        !result.equity.complete ||
        // 缺分钟数据的窗口不构成覆盖：做 T 被跳过或日线观察被拒绝时，
        // 收益只是观察口径，不能用于晋级或验证结论（§4.4）。
        (!observationGrade && result.equity.missingMinuteOrders > 0) ||
        (pair.dataset.executionMode === "realtime" &&
          result.equity.missingMinuteOrders) ||
        result.outcomes.some((outcome) =>
          /缺少日期|可能除权/.test(outcome.reason || ""),
        )
      )
        covered = false;
    } catch (error) {
      covered = false;
      reason = error.message;
      break;
    }
  }
  return {
    days: equities.length,
    covered,
    // 观察口径声明：为 true 时该窗口的收益是日线观察口径，
    // 不是可执行净收益（§4.4）。
    observationOnly: observationGrade,
    ...policyFields,
    reason,
    totalReturn:
      book.equityCents /
        (initialBook ? initialBook.equityCents : book.initialCashCents) -
      1,
    maxDrawdown: Math.max(0, ...equities.map((row) => row.drawdown)),
    fillCount: fills.length,
    // 逐笔成交随重放返回：成本敏感性据此汇总隐含成本（§6.2）。
    fills,
    feesCents: book.feesCents,
    equities,
  };
}
export function validateCandidate(
  trainingPairs,
  holdoutPairs,
  base,
  candidate,
  initialCapital,
  feeConfig = DEFAULT_FEES,
  initialBook = null,
  executionCostPolicy = null,
  options = {},
) {
  const baseline = replayStrategy(
    holdoutPairs,
    base,
    initialCapital,
    feeConfig,
    initialBook,
    executionCostPolicy,
    options,
  );
  const proposed = replayStrategy(
    holdoutPairs,
    candidate,
    initialCapital,
    feeConfig,
    initialBook,
    executionCostPolicy,
    options,
  );
  const checks = {
    trainingSize: trainingPairs.length >= 20,
    holdoutSize: holdoutPairs.length >= 10,
    chronology:
      trainingPairs.at(-1)?.dataset.date < holdoutPairs[0]?.dataset.date,
    coverage:
      baseline.covered &&
      proposed.covered &&
      baseline.days === holdoutPairs.length &&
      proposed.days === holdoutPairs.length,
    activity: baseline.fillCount >= 3 && proposed.fillCount >= 3,
    improvement: proposed.totalReturn >= baseline.totalReturn + 0.001,
    drawdown:
      proposed.maxDrawdown <= baseline.maxDrawdown + 0.005 &&
      proposed.maxDrawdown <= 0.1,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    baseline,
    candidate: proposed,
    feeConfig: normalizeFees(feeConfig),
    selectionPolicy: baseline.selectionPolicy,
    selectionPolicyDigest: baseline.selectionPolicyDigest,
    executionCostPolicy: executionCostPolicy
      ? {
          modelVersion: executionCostPolicy.modelVersion,
          payloadDigest: executionCostPolicy.payloadDigest,
        }
      : null,
    trainingStart: trainingPairs[0]?.dataset.date,
    trainingEnd: trainingPairs.at(-1)?.dataset.date,
    validationStart: holdoutPairs[0]?.dataset.date,
    validationEnd: holdoutPairs.at(-1)?.dataset.date,
    method:
      "20 日训练、10 日封存验证；同起始资金、手续费和成交约束；每个验证窗口只允许一个候选，后续窗口使用未参加候选验证的新日期。",
  };
}
