import { replayStrategyAsync } from "./validation.js";
import { digestOf } from "./research-lineage.js";
import {
  normalizeExecutionCostPayload,
  normalizeExecutionCostPolicy,
} from "../../shared/execution-cost.js";
import { BASE_STRATEGY } from "./trading.js";
import { executionEngineBuildDigest } from "./execution-build.js";
import { verifyCalibratedPolicy } from "./execution-calibration.js";

export const STRESS_GATE_VERSION = "execution-stress-gate-v1";
// 固定经济闸门，与正式前瞻收益/回撤门槛一致；不重新使用统计预算。
export const STRESS_THRESHOLDS = Object.freeze({
  parentImprovement: 0.001,
  baselineImprovement: 0,
  maxDrawdown: 0.1,
  parentDrawdownAllowance: 0.005,
});

export async function freezeExecutionStress(policy, parentParams) {
  policy = normalizeExecutionCostPolicy(policy);
  if ((await digestOf(policy.payload)) !== policy.payloadDigest)
    throw new Error("压力测试成本政策摘要不一致");
  if (policy.payload.executionStressMultiplier !== 1)
    throw new Error("常规成本政策必须使用基准倍数 1");
  const multipliers = [1, ...policy.payload.stressResidualMultiplier];
  if (!multipliers.includes(1.5) || !multipliers.includes(2))
    throw new Error("晋级压力情景必须事前包含基准、1.5 和 2 倍");
  const source = {
    version: STRESS_GATE_VERSION,
    engineBuildDigest: await executionEngineBuildDigest(),
    policy,
    multipliers: [...new Set(multipliers)],
    thresholds: STRESS_THRESHOLDS,
    parentParams,
    parentParamsDigest: await digestOf(parentParams),
  };
  return { ...source, digest: await digestOf(source) };
}

export async function verifyStressFreeze(frozen) {
  if (!frozen || frozen.version !== STRESS_GATE_VERSION)
    throw new Error("批次未事前冻结成本压力闸门，请重新建立批次");
  const expected = await freezeExecutionStress(
    frozen.policy,
    frozen.parentParams,
  );
  if ((await digestOf(expected)) !== (await digestOf(frozen)))
    throw new Error("成本压力情景、父策略或经济门槛与冻结声明不一致");
}

export async function replayExecutionStress(input, cache = {}) {
  const { frozen, pairs, initialBook, strategies, feeConfig, selectionPolicy } =
    input;
  await verifyStressFreeze(frozen);
  await verifyCalibratedPolicy(frozen.policy, input.calibration);
  if (
    (await digestOf(strategies.parent)) !== frozen.parentParamsDigest ||
    (await digestOf(strategies.baseline)) !== (await digestOf(BASE_STRATEGY))
  )
    throw new Error("压力对照必须使用冻结父策略和固定基线");
  if (
    !pairs.length ||
    pairs.some(
      (p, i) =>
        i &&
        (p.dataset.date <= pairs[i - 1].dataset.date ||
          p.dataset.previousTradingDate !== pairs[i - 1].dataset.date),
    )
  )
    throw new Error("压力重放窗口为空、不连续或日期顺序错误");
  const scenarios = [];
  for (const multiplier of frozen.multipliers) {
    const payload = normalizeExecutionCostPayload({
      ...frozen.policy.payload,
      executionStressMultiplier: multiplier,
    });
    const policy = {
      ...frozen.policy,
      payload,
      payloadDigest: await digestOf(payload),
    };
    const paths = {};
    for (const [id, params] of Object.entries(strategies)) {
      const cached = await cache.load?.(multiplier, id);
      if (cached) {
        paths[id] = cached;
        continue;
      }
      const replay = await replayStrategyAsync(
        pairs,
        params,
        initialBook.initialCashCents / 100,
        feeConfig,
        initialBook,
        policy,
        {
          selectionPolicy,
          onYield: cache.heartbeat,
          strictExecutionCoverage: true,
        },
      );
      let peak = initialBook.equityCents;
      let drawdown = 0;
      for (const row of replay.equities) {
        peak = Math.max(peak, row.equityCents);
        drawdown = Math.max(drawdown, 1 - row.equityCents / peak);
      }
      let requestedQuantity = 0,
        filledQuantity = 0,
        unrestoredTQuantity = 0;
      for (const day of replay.executionDiagnostics)
        for (const order of day.outcomes) {
          if (order.side === "NONE") continue;
          const expected =
            (order.quantity ?? 0) * (order.side === "PAIR" ? 2 : 1);
          const fills = replay.fills.filter(
            (f) =>
              f.date === day.date &&
              (f.orderId === order.id ||
                f.id.startsWith(`${day.date}:${order.id}:`)),
          );
          requestedQuantity += expected;
          filledQuantity += Math.min(
            expected,
            fills.reduce((n, f) => n + f.quantity, 0),
          );
          if (order.side === "PAIR")
            unrestoredTQuantity += Math.abs(
              fills.reduce(
                (n, f) => n + (f.side === "BUY" ? f.quantity : -f.quantity),
                0,
              ),
            );
        }
      paths[id] = {
        covered: replay.covered && replay.days === pairs.length,
        reason: replay.reason,
        finalEquityCents:
          replay.equities.at(-1)?.equityCents ?? initialBook.equityCents,
        netReturn: replay.totalReturn,
        drawdownPpm: Math.round(drawdown * 1_000_000),
        feesCents: replay.feesCents - initialBook.feesCents,
        impliedCostCents: replay.fills.reduce(
          (n, f) => n + (f.executionCost?.impliedCostCents ?? 0),
          0,
        ),
        fillCount: replay.fillCount,
        fillRate: requestedQuantity ? filledQuantity / requestedQuantity : null,
        unfilledQuantity: requestedQuantity - filledQuantity,
        unrestoredTQuantity,
        dataQuality: Object.fromEntries(
          [...new Set(replay.fills.map((f) => f.dataQuality))].map((q) => [
            q,
            replay.fills.filter((f) => f.dataQuality === q).length,
          ]),
        ),
        diagnostics: replay.executionDiagnostics,
        equity: replay.equities,
        fills: replay.fills,
      };
      await cache.save?.(multiplier, id, paths[id]);
      // 让行情轮询在路径之间继续运行；计算不请求网络、不写任何交易账户。
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const checks = {};
    const parent = paths.parent,
      baseline = paths.baseline;
    if (!parent || !baseline)
      throw new Error("成本压力重放缺少父策略或固定基线");
    for (const [id, path] of Object.entries(paths)) {
      if (["parent", "baseline"].includes(id)) continue;
      checks[id] = {
        coverage: path.covered && parent.covered && baseline.covered,
        againstParent:
          path.finalEquityCents >
          parent.finalEquityCents +
            Math.round(
              initialBook.equityCents * frozen.thresholds.parentImprovement,
            ),
        againstBaseline:
          path.finalEquityCents >
          baseline.finalEquityCents +
            Math.round(
              initialBook.equityCents * frozen.thresholds.baselineImprovement,
            ),
        drawdown:
          path.drawdownPpm <=
            Math.round(frozen.thresholds.maxDrawdown * 1_000_000) &&
          path.drawdownPpm <=
            parent.drawdownPpm +
              Math.round(frozen.thresholds.parentDrawdownAllowance * 1_000_000),
      };
      checks[id].passed = Object.values(checks[id]).every(Boolean);
    }
    scenarios.push({
      multiplier,
      policyDigest: policy.payloadDigest,
      paths,
      checks,
    });
  }
  return {
    scenarios,
    passed: Object.fromEntries(
      Object.keys(strategies)
        .filter((id) => !["parent", "baseline"].includes(id))
        .map((id) => [id, scenarios.every((s) => s.checks[id].passed)]),
    ),
  };
}

export async function verifyExecutionStress(bundle) {
  if (bundle.schemaVersion !== 1 || bundle.namespace !== "execution-cost")
    throw new Error("压力报告格式或研究用途无效");
  const { id, digest, ...source } = bundle;
  const expectedDigest = await digestOf(source);
  if (digest !== expectedDigest || id !== `stress-${expectedDigest}`)
    throw new Error("压力报告 id 或摘要不一致");
  const expected = await replayExecutionStress(bundle.input);
  if ((await digestOf(expected)) !== (await digestOf(bundle.result)))
    throw new Error("压力路径或闸门与独立重放不一致");
  return { passed: true, candidates: expected.passed };
}
