import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeExecutionCostPayload,
  normalizeExecutionCostPolicy,
  defaultExecutionCostPolicy,
  executionPeriod,
  EXECUTION_COST_MODEL,
  DEFAULT_EXECUTION_COST_PAYLOAD,
} from "../shared/execution-cost.js";
import {
  buildExecutionContext,
  estimateExecutionCost,
  solveFillQuantity,
  cumulativeImpactCents,
} from "../backend/domain/execution-cost.js";
import {
  newBook,
  createPlan,
  executePlan,
  totalQuantity,
  BASE_STRATEGY,
} from "../backend/domain/trading.js";
import { openSession, advanceSession } from "../backend/domain/realtime.js";
import { PaperRepository, digest } from "../backend/storage/paper.js";
import {
  ExecutionCostRepository,
  latestPolicyBundle,
  verifyPolicyBundle,
} from "../backend/storage/execution-cost.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import { freezePortfolioPlan } from "../backend/services/portfolio-runner.js";
import { consumePortfolioFrame } from "../backend/services/portfolio-runner.js";
import { replayStrategy } from "../backend/domain/validation.js";
import {
  runExecutionSensitivity,
  scenarioPolicyBundles,
} from "../backend/services/execution-sensitivity.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { parseTencentQuotes } from "../backend/services/market.js";
import {
  bars,
  dataset,
  order,
  plan,
  snapshot,
  pairs,
  dateAt,
} from "./fixtures/trading.mjs";

const event = (time, overrides = {}) => ({
  time,
  priceCents: 1000,
  volumeShares: 10_000_000,
  quality: "realtime_poll",
  intervalKey: `2026-01-02:${time}`,
  ...overrides,
});
const context = (overrides = {}) =>
  buildExecutionContext({
    plan: { previousLimitUpCodes: [], previousLimitUpKnown: true },
    code: "600001",
    event: event("10:00:00"),
    quote: {},
    ...overrides,
  });
const estimate = (overrides = {}) =>
  estimateExecutionCost({
    policy: defaultExecutionCostPolicy(),
    context: context(),
    side: "BUY",
    quantity: 1000,
    ...overrides,
  });

test("旧计划兼容：无政策标记的计划仍按 10bps 与 Math.round 重放，不产生成本分解", () => {
  const legacy = executePlan(
    newBook(100000),
    plan([order()]),
    dataset(dateAt(1)),
  );
  assert.equal(legacy.ledger.length, 1);
  assert.equal(legacy.ledger[0].executionCost, undefined);
  // 旧模型：Math.round(1000 × (1 + 10/10000)) = 1001
  assert.equal(legacy.ledger[0].priceCents, 1001);
  assert.equal(legacy.equity.executionCost, null);
});

test("敏感性：情景倍数冻结进政策，单笔成本随压力单调上升，完整重放互不影响", async () => {
  const DB = localDatabase(),
    env = { DB },
    repository = new PaperRepository(env);
  await repository.initialize();
  const sample = pairs(12);
  for (const pair of sample) {
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
  const base = defaultExecutionCostPolicy();
  const bundles = await scenarioPolicyBundles(base);
  assert.deepEqual(
    bundles.map((bundle) => bundle.payload.executionStressMultiplier),
    [1, 1.5, 2],
  );
  for (const bundle of bundles)
    assert.equal(await digest(bundle.payload), bundle.payloadDigest);
  const run = await runExecutionSensitivity(env, { days: 10 });
  assert.equal(run.status, "COMPLETE");
  assert.equal(run.manifest.scenarios.length, 3);
  assert.equal(run.payload.results.length, 3);
  const [baseline, mid, stress] = run.payload.results;
  assert.ok(baseline.fillCount > 0);
  assert.equal(mid.fillCount, baseline.fillCount);
  assert.equal(stress.fillCount, baseline.fillCount);
  assert.ok(mid.impliedCostCents > baseline.impliedCostCents);
  assert.ok(stress.impliedCostCents > mid.impliedCostCents);
  // 三情景各自独立重放，结果带完整摘要可独立复核
  assert.ok(run.manifest.basePolicy.payloadDigest);
  // P1-8：manifest 冻结策略身份与逐对输入摘要；逐情景账本随结果保存
  assert.ok(run.manifest.strategy?.digest);
  assert.equal(run.manifest.inputs?.length, run.manifest.sampleDays);
  assert.equal(run.payload.results[0].fills.length, baseline.fillCount);
  assert.ok(run.payload.results[0].equity.length > 0);
  const variant = await runExecutionSensitivity(env, {
    days: 10,
    strategy: { ...BASE_STRATEGY, minScore: 70 },
  });
  assert.notEqual(
    variant.manifest.strategy.digest,
    run.manifest.strategy.digest,
  );
  assert.notEqual(
    JSON.stringify(variant.manifest),
    JSON.stringify(run.manifest),
    "不同策略不得生成相同 manifest",
  );
  DB.close();
});

test("敏感性 manifest 冻结观测帧摘要：改变帧内容即被识别", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const repository = new PaperRepository(env);
    await repository.initialize();
    const sample = pairs(12);
    // 观测帧挂在最后一对：days=10 的切片必须包含它
    const withTicks = sample.map((pair, index) =>
      index === sample.length - 1
        ? {
            ...pair,
            // 标记实时模式：collectPairs 才会读取持久观测帧
            dataset: { ...pair.dataset, executionMode: "realtime" },
            observations: [
              {
                observedAt: new Date(
                  `${pair.dataset.date}T01:30:40.000Z`,
                ).toISOString(),
                quotes: {
                  600001: { timestamp: `${pair.dataset.date}T09:30:40+08:00` },
                },
                pollIntervalSeconds: 10,
              },
            ],
          }
        : pair,
    );
    for (const pair of withTicks) {
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
      // collectPairs 从 paper_live_ticks 读取实时观测帧
      if (pair.observations)
        for (const [sequence, tick] of pair.observations.entries())
          await DB.prepare(
            "INSERT INTO paper_live_ticks (trade_date,sequence,payload,digest) VALUES (?,?,?,?)",
          )
            .bind(
              pair.dataset.date,
              sequence + 1,
              JSON.stringify(tick),
              "fixture",
            )
            .run();
    }
    const first = await runExecutionSensitivity(env, { days: 10 });
    // 改变帧内容 → manifest 必须不同
    await DB.prepare(
      "UPDATE paper_live_ticks SET payload = ? WHERE trade_date = ? AND sequence = 1",
    )
      .bind(
        JSON.stringify([
          {
            observedAt: new Date(
              `${withTicks.at(-1).dataset.date}T01:30:41.000Z`,
            ).toISOString(),
            quotes: {
              600001: {
                timestamp: `${withTicks.at(-1).dataset.date}T09:30:41+08:00`,
              },
            },
            pollIntervalSeconds: 10,
          },
        ]),
        withTicks.at(-1).dataset.date,
      )
      .run();
    const second = await runExecutionSensitivity(env, { days: 10 });
    const observedInput = first.manifest.inputs.at(-1);
    assert.ok(observedInput.observationsDigest);
    assert.notEqual(
      observedInput.observationsDigest,
      second.manifest.inputs.at(-1).observationsDigest,
    );
    assert.notEqual(
      JSON.stringify(first.manifest),
      JSON.stringify(second.manifest),
    );
  } finally {
    DB.close();
  }
});
