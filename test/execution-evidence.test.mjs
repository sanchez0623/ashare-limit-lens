import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { BASE_STRATEGY, newBook } from "../backend/domain/trading.js";
import { DEFAULT_FEES } from "../shared/fees.js";
import { defaultExecutionCostPolicy } from "../shared/execution-cost.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import { selectionPolicyForBook } from "../backend/domain/signal-selection.js";
import {
  freezeExecutionStress,
  replayExecutionStress,
  verifyExecutionStress,
} from "../backend/domain/execution-stress.js";
import {
  normalizeCalibrationInput,
  calibrateExecutionCost,
  verifyExecutionCalibration,
  calibrationInputDigest,
} from "../backend/domain/execution-calibration.js";
import {
  importExecutionCalibration,
  runExecutionCalibration,
  exportExecutionCalibration,
} from "../backend/services/execution-calibration.js";
import { saveExecutionCostPolicy } from "../backend/services/execution-cost.js";
import { ExecutionCostRepository } from "../backend/storage/execution-cost.js";
import { api } from "../backend/routes/api.js";
import { runCohortExecutionStress } from "../backend/services/execution-stress.js";
import { selectionPolicyFields } from "../backend/domain/signal-selection.js";
import { pairs } from "./fixtures/trading.mjs";

// 这些数据全部是合成边界样本；真实来源字符串仅用于测试导入者声明的格式。
function executionInput({ failures = 0, quoteMissing = false } = {}) {
  const orders = [];
  for (let day = 1; day <= 8; day++)
    for (let slot = 0; slot < 12; slot++) {
      const date = `2026-01-${String(day).padStart(2, "0")}`;
      const id = `${day}-${slot}`;
      const side = slot % 2 ? "SELL" : "BUY";
      const failed = slot < failures;
      orders.push({
        id,
        code: "600001",
        side,
        quantity: 1000,
        submittedAt: `${date}T10:00:00+08:00`,
        completedAt: `${date}T10:00:02+08:00`,
        status: failed ? "REJECTED" : "FILLED",
        previousLimitUp: slot % 3 === 0,
        marketVolumeShares: 1000000,
        marketVolumeObservedAt: `${date}T09:59:59+08:00`,
        quote: quoteMissing
          ? null
          : {
              observedAt: `${date}T09:59:59+08:00`,
              bid1Cents: 9990,
              ask1Cents: 10010,
            },
        fills: failed
          ? []
          : [
              {
                id: `f-${id}`,
                executedAt: `${date}T10:00:01+08:00`,
                quantity: 1000,
                priceCents:
                  side === "BUY"
                    ? 10025 + (slot % 3 === 0 ? 15 : 0)
                    : 9975 - (slot % 3 === 0 ? 15 : 0),
              },
            ],
      });
    }
  return {
    schemaVersion: 1,
    kind: "REAL_EXECUTION",
    trainingEnd: "2026-01-05",
    cutoff: "2026-01-08",
    provenance: {
      owner: "test-owner",
      source: "broker-export",
      datasetRef: "test-format-only",
      role: "INDEPENDENT_CALIBRATION",
      paperGenerated: false,
      ordersComplete: true,
    },
    orders,
  };
}

test("三情景分别生成因果账本；基准胜出但压力失败的候选不能晋级", async () => {
  const input = {
    frozen: await freezeExecutionStress(
      defaultExecutionCostPolicy(),
      BASE_STRATEGY,
    ),
    pairs: pairs(300).slice(260),
    initialBook: newBook(1000000),
    strategies: {
      parent: BASE_STRATEGY,
      baseline: BASE_STRATEGY,
      m1: { ...BASE_STRATEGY, minScore: 82, maxPositions: 3 },
    },
    feeConfig: DEFAULT_FEES,
    selectionPolicy: selectionPolicyForBook(newBook(1000000)),
  };
  const result = await replayExecutionStress(input);
  assert.deepEqual(
    result.scenarios.map((s) => s.multiplier),
    [1, 1.5, 2],
  );
  assert.ok(
    result.scenarios.every(
      (s) => s.paths.m1.fills.length && s.paths.parent.equity.length === 40,
    ),
  );
  assert.notDeepEqual(
    result.scenarios[0].paths.m1.fills,
    result.scenarios[2].paths.m1.fills,
  );
  assert.equal(result.scenarios[0].checks.m1.passed, true);
  assert.equal(result.scenarios[1].checks.m1.passed, true);
  assert.equal(result.scenarios[2].checks.m1.passed, false);
  assert.equal(result.passed.m1, false);
  // 禁止事后删去不利情景，即使攻击者重新生成所有摘要和报告 id。
  const source = {
    schemaVersion: 1,
    namespace: "execution-cost",
    input,
    result,
  };
  const hash = await digestOf(source),
    bundle = { ...source, digest: hash, id: `stress-${hash}` };
  assert.equal((await verifyExecutionStress(bundle)).passed, true);
  const forged = structuredClone(bundle);
  forged.result.scenarios.pop();
  const { id, digest, ...content } = forged;
  forged.digest = await digestOf(content);
  forged.id = `stress-${forged.digest}`;
  await assert.rejects(() => verifyExecutionStress(forged), /独立重放不一致/);
  const weakened = structuredClone(input);
  weakened.frozen.thresholds.parentImprovement = -1;
  await assert.rejects(() => replayExecutionStress(weakened), /冻结声明不一致/);
});

test("压力情景必须事前包含 1、1.5、2，数据断档不能成为晋级证据", async () => {
  const policy = structuredClone(defaultExecutionCostPolicy());
  policy.payload.stressResidualMultiplier = [1.2];
  policy.payloadDigest = await digestOf(policy.payload);
  await assert.rejects(
    () => freezeExecutionStress(policy, BASE_STRATEGY),
    /必须事前包含/,
  );
  const input = {
    frozen: await freezeExecutionStress(
      defaultExecutionCostPolicy(),
      BASE_STRATEGY,
    ),
    pairs: pairs(5),
    initialBook: newBook(100000),
    strategies: {
      parent: BASE_STRATEGY,
      baseline: BASE_STRATEGY,
      m1: BASE_STRATEGY,
    },
    feeConfig: DEFAULT_FEES,
    selectionPolicy: selectionPolicyForBook(newBook(100000)),
  };
  delete input.pairs[0].dataset.minutes;
  const result = await replayExecutionStress(input);
  assert.equal(result.passed.m1, false);
  assert.ok(result.scenarios.every((s) => !s.checks.m1.coverage));
});

test("校准按日期分块，验证数据不改变系数，缺样本分层保留先验", async () => {
  const raw = executionInput(),
    policy = defaultExecutionCostPolicy();
  const report = await calibrateExecutionCost(raw, policy);
  assert.equal(report.passed, true);
  assert.deepEqual(report.fittedPeriods, ["regular"]);
  assert.equal(
    report.payload.periodBaseBps.openFirstMinute,
    policy.payload.periodBaseBps.openFirstMinute,
  );
  assert.ok(report.validation.maeBps < report.priorValidation.maeBps);
  const altered = structuredClone(raw);
  for (const order of altered.orders.filter(
    (o) => o.submittedAt.slice(0, 10) > raw.trainingEnd,
  ))
    order.fills[0].priceCents += 100;
  const future = await calibrateExecutionCost(altered, policy);
  assert.deepEqual(future.payload, report.payload);
  assert.equal(future.passed, false);
  const input = normalizeCalibrationInput(raw),
    hash = await digestOf(report);
  const bundle = {
    input,
    inputId: `cal-input-${await calibrationInputDigest(input, policy)}`,
    report,
    digest: hash,
    id: `cal-${hash}`,
  };
  assert.equal((await verifyExecutionCalibration(bundle)).eligible, true);
  bundle.report.validation.maeBps = 0;
  bundle.digest = await digestOf(bundle.report);
  bundle.id = `cal-${bundle.digest}`;
  await assert.rejects(
    () => verifyExecutionCalibration(bundle),
    /独立重算不一致/,
  );
});

test("校准拒绝纸面来源、未来盘口、重复成交和伪造状态，保留失败及缺失", async () => {
  for (const mutate of [
    (raw) => {
      raw.provenance.paperGenerated = true;
    },
    (raw) => {
      raw.provenance.source = "paper-ledger";
    },
    (raw) => {
      raw.orders[0].quote.observedAt = "2026-01-01T10:00:01+08:00";
    },
    (raw) => {
      raw.orders[1].fills[0].id = raw.orders[0].fills[0].id;
    },
    (raw) => {
      raw.orders[0].status = "REJECTED";
    },
    (raw) => {
      raw.orders[0].marketVolumeObservedAt = "2026-01-01T10:00:01+08:00";
    },
    (raw) => {
      raw.kind = "QUOTE_PROXY";
    },
  ]) {
    const raw = executionInput();
    mutate(raw);
    assert.throws(() => normalizeCalibrationInput(raw));
  }
  const failed = await calibrateExecutionCost(
    executionInput({ failures: 3 }),
    defaultExecutionCostPolicy(),
  );
  assert.equal(failed.train.failedOrders, 15);
  assert.equal(failed.passed, false, "未成交委托不能被删掉凑成交样本量");
  const missing = await calibrateExecutionCost(
    executionInput({ quoteMissing: true }),
    defaultExecutionCostPolicy(),
  );
  assert.equal(missing.validation.quoteCoverage, 0);
  assert.equal(missing.validation.p50Bps, null);
  assert.equal(missing.calibrationStatus, "PRIOR_UNCALIBRATED");
});

test("冲击参数需要参与率变化及后续分层验证，不能只验证未拟合的时段", async () => {
  const raw = executionInput();
  const volumes = [1000000, 333333, 142857, 111111];
  raw.orders.forEach((order, i) => {
    order.marketVolumeShares = volumes[i % 4];
    // 独立合成真实偏差：30bps 数量冲击、5bps 时段项、10bps 半价差。
    const cost = Math.round(
      15 +
        30 * Math.sqrt(1000 / order.marketVolumeShares / 0.01) +
        (order.previousLimitUp ? 15 : 0),
    );
    order.fills[0].priceCents = 10000 + (order.side === "BUY" ? cost : -cost);
  });
  const report = await calibrateExecutionCost(
    raw,
    defaultExecutionCostPolicy(),
  );
  assert.equal(report.calibratedParameters.impact, true);
  assert.equal(report.passed, true);
  assert.ok(report.validation.maeBps < report.priorValidation.maeBps);
  const otherPeriod = executionInput();
  for (const order of otherPeriod.orders.filter(
    (o) => o.submittedAt.slice(0, 10) > otherPeriod.trainingEnd,
  )) {
    const date = order.submittedAt.slice(0, 10);
    order.submittedAt = `${date}T09:30:10+08:00`;
    order.completedAt = `${date}T09:30:12+08:00`;
    order.quote.observedAt =
      order.marketVolumeObservedAt = `${date}T09:30:09+08:00`;
    order.fills[0].executedAt = `${date}T09:30:11+08:00`;
  }
  const uncovered = await calibrateExecutionCost(
    otherPeriod,
    defaultExecutionCostPolicy(),
  );
  assert.equal(uncovered.checks.validationStrata, false);
  assert.equal(uncovered.calibrationStatus, "PRIOR_UNCALIBRATED");
});

test("校准输入与报告不可覆盖，升级需冻结报告，篡改历史证据导致政策读取拒绝", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    await assert.rejects(
      () =>
        saveExecutionCostPolicy(env, {
          calibrationStatus: "EXECUTION_CALIBRATED",
        }),
      /不能手工声明/,
    );
    const imported = await importExecutionCalibration(env, executionInput());
    const duplicate = await importExecutionCalibration(env, executionInput());
    assert.equal(duplicate.id, imported.id);
    const run = await runExecutionCalibration(env, imported.id);
    const bundle = await exportExecutionCalibration(env, run.id);
    assert.equal((await verifyExecutionCalibration(bundle)).eligible, true);
    await assert.rejects(
      () =>
        saveExecutionCostPolicy(env, {
          calibrationId: run.id,
          effectiveFrom: run.report.cutoff,
        }),
      /不能回填/,
    );
    const saved = await saveExecutionCostPolicy(env, { calibrationId: run.id });
    assert.equal(saved.policy.calibrationStatus, "EXECUTION_CALIBRATED");
    assert.deepEqual(saved.policy.payload, run.report.payload);
    const next = await new ExecutionCostRepository(env).save({
      payload: saved.policy.payload,
    });
    assert.equal(
      next.calibrationStatus,
      "PRIOR_UNCALIBRATED",
      "新版本参数相同也不继承校准声明",
    );
    const again = await importExecutionCalibration(env, executionInput());
    assert.equal(again.id, imported.id, "重复导入保留首次基础政策");
    assert.equal(
      (await runExecutionCalibration(env, again.id)).id,
      run.id,
      "不会按新基础政策重用验证窗口拟合",
    );
    await DB.prepare("DELETE FROM execution_cost_policies WHERE id=?")
      .bind(next.id)
      .run();
    await DB.prepare(
      "UPDATE execution_calibration_inputs SET payload='{}' WHERE id=?",
    )
      .bind(imported.id)
      .run();
    await assert.rejects(
      () => new ExecutionCostRepository(env).latest(),
      /校准|schemaVersion/,
    );
  } finally {
    DB.close();
  }
});

test("正式测试日期不能被重新用于成本校准", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    await DB.prepare(
      "INSERT INTO research_test_claims(namespace,outcome_date,experiment_id,role,reserved_at,owner_type,owner_id) VALUES('main','2026-01-03','x','FORWARD_TEST','now','COHORT','c')",
    ).run();
    await assert.rejects(
      () => importExecutionCalibration(env, executionInput()),
      /正式研究测试\/前瞻日期重叠/,
    );
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM execution_calibration_inputs",
        ).first()
      ).n,
      0,
    );
  } finally {
    DB.close();
  }
});

test("两天样本如实保留但不升级，API 可导入大于 12KB 的独立数据并阻止跨站发布", async () => {
  const raw = executionInput();
  raw.orders = raw.orders.filter(
    (o) => o.submittedAt.slice(0, 10) <= "2026-01-02",
  );
  raw.trainingEnd = "2026-01-01";
  raw.cutoff = "2026-01-02";
  const report = await calibrateExecutionCost(
    raw,
    defaultExecutionCostPolicy(),
  );
  assert.equal(report.train.orders, 12);
  assert.equal(report.validation.orders, 12);
  assert.equal(report.checks.samples, false);
  assert.equal(report.calibrationStatus, "PRIOR_UNCALIBRATED");
  const DB = localDatabase(),
    env = { DB };
  try {
    const body = JSON.stringify(executionInput());
    assert.ok(body.length > 12000);
    const response = await api(
      new Request(
        "https://example.test/api/research/execution-calibration/inputs",
        {
          method: "POST",
          headers: {
            "Content-Length": String(body.length),
            Origin: "https://example.test",
          },
          body,
        },
      ),
      env,
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).orders, 96);
    const publish = await api(
      new Request("https://example.test/api/paper/execution-cost", {
        method: "PUT",
        headers: { Origin: "https://evil.test" },
        body: "{}",
      }),
      env,
    );
    assert.equal(publish.status, 403);
  } finally {
    DB.close();
  }
});

test("压力任务失败后恢复路径检查点，活动租约防止重复计算，日期与预算不被占用", async () => {
  const DB = localDatabase(),
    env = { DB };
  const data = pairs(5),
    book = newBook(100000);
  const frozen = await freezeExecutionStress(
    defaultExecutionCostPolicy(),
    BASE_STRATEGY,
  );
  const reservation = { executionStress: frozen };
  const cohort = {
    id: "cost-recovery",
    reservationManifest: {
      ...reservation,
      reservationDigest: await digestOf(reservation),
    },
    forwardManifest: {
      executionStress: frozen,
      initialBook: book,
      initialBookDigest: await digestOf(book),
      initialEquityCents: book.equityCents,
      requiredDays: 5,
      windowDates: data.map((p) => p.dataset.date),
      feeConfig: DEFAULT_FEES,
      ...selectionPolicyFields(selectionPolicyForBook(book)),
    },
  };
  const prepare = DB.prepare;
  try {
    for (const pair of data) {
      await DB.prepare(
        "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
      )
        .bind(
          pair.snapshot.date,
          pair.snapshot.createdAt,
          JSON.stringify(pair.snapshot),
        )
        .run();
      await DB.prepare(
        "INSERT INTO paper_market_days(trade_date,payload,digest) VALUES(?,?,?)",
      )
        .bind(
          pair.dataset.date,
          JSON.stringify(pair.dataset),
          await digestOf(pair.dataset),
        )
        .run();
    }
    await DB.prepare(
      "INSERT INTO strategy_cohort_members(cohort_id,member_id,slot_index,experiment_id,strategy_version,k,params,params_digest,stage,created_at,updated_at) VALUES('cost-recovery','m1',1,'x','v1',1,?,?,'RUNNING','now','now')",
    )
      .bind(JSON.stringify(BASE_STRATEGY), await digestOf(BASE_STRATEGY))
      .run();
    await DB.prepare(
      "INSERT INTO strategy_versions(id,created_at,status,params,evidence) VALUES('v1','now','VALIDATED',?,'{}')",
    )
      .bind(JSON.stringify(BASE_STRATEGY))
      .run();
    let writes = 0;
    DB.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("INSERT INTO execution_stress_paths")) {
        const run = statement.run.bind(statement);
        statement.run = async () => {
          if (++writes === 2)
            throw new Error("SQLITE_BUSY simulated checkpoint interruption");
          return run();
        };
      }
      return statement;
    };
    await assert.rejects(
      () =>
        runCohortExecutionStress(
          env,
          cohort,
          cohort.forwardManifest.windowDates,
        ),
      /simulated checkpoint interruption/,
    );
    DB.prepare = prepare;
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM execution_stress_paths",
        ).first()
      ).n,
      1,
    );
    await DB.prepare(
      "UPDATE research_tasks SET stage='RUNNING',lease_until='2099-01-01',lease_owner='other'",
    ).run();
    await assert.rejects(
      () =>
        runCohortExecutionStress(
          env,
          cohort,
          cohort.forwardManifest.windowDates,
        ),
      /任务正在计算/,
    );
    await DB.prepare(
      "UPDATE research_tasks SET lease_until='2000-01-01'",
    ).run();
    const bundle = await runCohortExecutionStress(
      env,
      cohort,
      cohort.forwardManifest.windowDates,
    );
    assert.equal((await verifyExecutionStress(bundle)).passed, true);
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM execution_stress_paths",
        ).first()
      ).n,
      9,
    );
    assert.equal(
      (await DB.prepare("SELECT COUNT(*) n FROM research_tasks").first()).n,
      1,
    );
    assert.equal(
      (await DB.prepare("SELECT stage FROM research_tasks").first()).stage,
      "DONE",
    );
    assert.equal(
      (await DB.prepare("SELECT COUNT(*) n FROM research_test_claims").first())
        .n,
      0,
    );
    await DB.prepare("UPDATE strategy_versions SET params=? WHERE id='v1'")
      .bind(
        JSON.stringify({
          ...BASE_STRATEGY,
          minScore: BASE_STRATEGY.minScore + 1,
        }),
      )
      .run();
    await assert.rejects(
      () =>
        runCohortExecutionStress(
          env,
          cohort,
          cohort.forwardManifest.windowDates,
        ),
      /候选版本与冻结参数不一致/,
    );
  } finally {
    DB.prepare = prepare;
    DB.close();
  }
});
