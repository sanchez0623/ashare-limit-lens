import { createPlan, executePlan, newBook, BASE_STRATEGY } from "./trading.js";
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
    rationale: output.rationale,
  };
}
export function replayStrategy(
  pairs,
  strategy,
  initialCapital = DEFAULT_INITIAL_CAPITAL,
  feeConfig = DEFAULT_FEES,
) {
  let book = newBook(initialCapital, feeConfig);
  const equities = [],
    fills = [];
  let covered = true;
  let reason = null;
  for (const pair of pairs) {
    if (
      pair.snapshot.date !== pair.dataset.previousTradingDate ||
      pair.snapshot.date >= pair.dataset.date
    ) {
      covered = false;
      reason = "冻结评分与行情不是相邻交易日";
      break;
    }
    const plan = createPlan(
      pair.snapshot,
      book,
      strategy,
      "validation",
      pair.snapshot.createdAt,
    );
    try {
      const result = executePlan(book, plan, pair.dataset);
      book = result.book;
      equities.push(result.equity);
      fills.push(...result.ledger);
      if (
        !result.equity.complete ||
        result.equity.missingMinuteOrders ||
        result.outcomes.some((order) =>
          /缺少日期|可能除权/.test(order.reason || ""),
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
    reason,
    totalReturn: book.equityCents / book.initialCashCents - 1,
    maxDrawdown: Math.max(0, ...equities.map((row) => row.drawdown)),
    fillCount: fills.length,
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
) {
  const baseline = replayStrategy(
    holdoutPairs,
    base,
    initialCapital,
    feeConfig,
  );
  const proposed = replayStrategy(
    holdoutPairs,
    candidate,
    initialCapital,
    feeConfig,
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
    trainingStart: trainingPairs[0]?.dataset.date,
    trainingEnd: trainingPairs.at(-1)?.dataset.date,
    validationStart: holdoutPairs[0]?.dataset.date,
    validationEnd: holdoutPairs.at(-1)?.dataset.date,
    method:
      "20 日训练、10 日封存验证；同起始资金、手续费和成交约束；每个验证窗口只允许一个候选，后续窗口使用未参加候选验证的新日期。",
  };
}
