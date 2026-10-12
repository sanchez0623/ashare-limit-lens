// 完整路径成本敏感性（§6.2）：隔离的多情景完整重放。
// 每个情景完整运行同一策略，使用相同期初账户、行情、费用和窗口，
// 各自重新生成因果计划与成交；不是在最终利润上统一扣一点费用。
// 运行结果写入独立研究 namespace，不写主账户，不重复占用正式测试日期。
import { collectPairs } from "./research.js";
import { replayStrategy } from "../domain/validation.js";
import { feesForBook } from "../../shared/fees.js";
import {
  EXECUTION_COST_MODEL,
  normalizeExecutionCostPayload,
} from "../../shared/execution-cost.js";
import {
  ExecutionCostRepository,
  policyDigest,
} from "../storage/execution-cost.js";
import { PaperRepository } from "../storage/paper.js";

// 情景 bundle：把登记的压力倍数冻结进政策 payload 并重算摘要，
// 使每个情景都是一份完整声明过假设的成本政策。
export async function scenarioPolicyBundles(basePolicy) {
  const scenarios = [1, ...basePolicy.payload.stressResidualMultiplier];
  return Promise.all(
    scenarios.map(async (multiplier) => {
      const payload = normalizeExecutionCostPayload({
        ...basePolicy.payload,
        executionStressMultiplier: multiplier,
      });
      return {
        id: `${basePolicy.id}-s${multiplier}`,
        version: basePolicy.version,
        modelVersion: EXECUTION_COST_MODEL,
        payloadDigest: await policyDigest(payload),
        calibrationStatus: basePolicy.calibrationStatus,
        calibrationCutoff: basePolicy.calibrationCutoff,
        effectiveFrom: basePolicy.effectiveFrom,
        payload,
      };
    }),
  );
}

const REPLAY_FIELDS = [
  "days",
  "covered",
  "reason",
  "totalReturn",
  "maxDrawdown",
  "fillCount",
  "feesCents",
];

export async function runExecutionSensitivity(
  env,
  { days = 40, strategy = null } = {},
) {
  const repository = new PaperRepository(env);
  const account = await repository.initialize();
  const pairs = (await collectPairs(repository)).slice(-Math.max(5, days));
  if (pairs.length < 5)
    throw new Error("已积累样本不足 5 个交易日，无法运行成本敏感性重放");
  const strategyParams = strategy ?? (await repository.strategy(account.book));
  const initialCapital = account.book.initialCashCents / 100;
  const feeConfig = feesForBook(account.book);
  const basePolicy = await new ExecutionCostRepository(env).latest();
  const bundles = await scenarioPolicyBundles(basePolicy);
  // 独立复核所需的冻结输入（§6.2）：策略身份与摘要、逐对评分/行情摘要。
  const strategyDigest = await policyDigest(strategyParams);
  const inputDigests = await Promise.all(
    pairs.map(async (pair) => ({
      tradeDate: pair.dataset.date,
      snapshotDigest: await policyDigest(pair.snapshot),
      marketDigest: await policyDigest(pair.dataset),
    })),
  );
  const results = [];
  for (const bundle of bundles) {
    const replay = replayStrategy(
      pairs,
      strategyParams,
      initialCapital,
      feeConfig,
      null,
      bundle,
    );
    const impliedCostCents = replay.fills.reduce(
      (sum, fill) => sum + (fill.executionCost?.impliedCostCents ?? 0),
      0,
    );
    results.push({
      scenario: bundle.payload.executionStressMultiplier,
      policyDigest: bundle.payloadDigest,
      ...Object.fromEntries(
        REPLAY_FIELDS.map((field) => [field, replay[field] ?? null]),
      ),
      impliedCostCents,
      // 逐情景完整账本与权益曲线：结果可从冻结输入独立重算。
      equity: replay.equities,
      fills: replay.fills,
    });
  }
  const manifest = {
    namespace: "execution-cost",
    basePolicy: {
      id: basePolicy.id,
      version: basePolicy.version,
      payloadDigest: basePolicy.payloadDigest,
      payload: basePolicy.payload,
    },
    scenarios: bundles.map((bundle) => ({
      multiplier: bundle.payload.executionStressMultiplier,
      payloadDigest: bundle.payloadDigest,
    })),
    strategy: { params: strategyParams, digest: strategyDigest },
    inputs: inputDigests,
    sampleDays: pairs.length,
    firstDate: pairs[0].dataset.date,
    lastDate: pairs.at(-1).dataset.date,
    initialCapitalCents: account.book.initialCashCents,
    feeConfig,
    note: "成本压力区间不是收益统计置信区间；单笔价格/成本单调，不要求每条资金曲线排序单调。",
  };
  const store = new ExecutionCostRepository(env);
  const id = `sens-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const payload = { results };
  await store.saveSensitivityRun({
    id,
    namespace: manifest.namespace,
    manifest,
    status: "COMPLETE",
    payload,
  });
  const saved = await store.sensitivityRun(id);
  return { id, ...saved };
}
