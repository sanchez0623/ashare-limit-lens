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
import {
  saveExecutionCostPolicy,
  getExecutionCostConfig,
} from "../backend/services/execution-cost.js";
import { ExecutionCostRepository } from "../backend/storage/execution-cost.js";
import { api } from "../backend/routes/api.js";
import { runCohortExecutionStress } from "../backend/services/execution-stress.js";
import { selectionPolicyFields } from "../backend/domain/signal-selection.js";
import { pairs } from "./fixtures/trading.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { ResearchRepository } from "../backend/storage/research.js";
import { CohortRepository } from "../backend/storage/cohorts.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function reservationOptions(env, date = "2026-01-06") {
  await new PaperRepository(env).initialize();
  const research = new ResearchRepository(env),
    cohorts = new CohortRepository(env);
  await research.ensureRegistry();
  return {
    cohortPolicy: await cohorts.getTournamentPolicy(),
    researchPolicy: await research.getPolicy(),
    month: "2099-01",
    parentVersion: "baseline-v1",
    windowPayload: {},
    testDates: [date],
    samples: [],
    forwardDays: 30,
    selectionPolicy: selectionPolicyForBook(newBook()),
  };
}

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

test("P1：先校准再正式预留，日期闸门原子回滚赛马和单候选预算，已校准读取保持自洽", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const options = await reservationOptions(env);
    const imported = await importExecutionCalibration(env, executionInput());
    const run = await runExecutionCalibration(env, imported.id);
    await saveExecutionCostPolicy(env, { calibrationId: run.id });
    const before = await DB.prepare(
      "SELECT revision,attempt_sequence FROM research_registry WHERE namespace='main'",
    ).first();
    await assert.rejects(
      () => new CohortRepository(env).reserveCohort(options),
      /成本校准用途/,
    );
    await assert.rejects(
      () =>
        new ResearchRepository(env).reserveAttempt({
          ...options,
          policy: options.researchPolicy,
        }),
      /成本校准用途/,
    );
    assert.deepEqual(
      await DB.prepare(
        "SELECT revision,attempt_sequence FROM research_registry WHERE namespace='main'",
      ).first(),
      before,
    );
    for (const table of [
      "strategy_cohorts",
      "research_experiments",
      "research_window_owners",
      "research_generation_slots",
      "research_test_claims",
    ])
      assert.equal(
        (await DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,
        0,
        `${table} 无部分预留`,
      );
    assert.equal(
      (await exportExecutionCalibration(env, run.id)).report.passed,
      true,
    );
    assert.equal(
      (await getExecutionCostConfig(env)).policy.calibrationStatus,
      "EXECUTION_CALIBRATED",
    );
    // 模拟 0016 期间留下的冲突，已热缓存也必须立即失效，不能继续返回已校准。
    DB.exec("DROP TRIGGER research_claims_calibration_guard");
    await DB.prepare(
      "INSERT INTO research_test_claims(namespace,outcome_date,experiment_id,role,reserved_at) VALUES('main','2026-01-06','legacy-conflict','HISTORICAL_TEST','now')",
    ).run();
    await assert.rejects(
      () => new ExecutionCostRepository(env).latest(),
      /正式研究测试\/前瞻日期重叠/,
    );
    await assert.rejects(
      () => getExecutionCostConfig(env),
      /正式研究测试\/前瞻日期重叠/,
    );
  } finally {
    DB.close();
  }
});

test("P1：导入检查后被研究抢占，输入、样本和日期登记整批回滚；前瞻/样本更新也不能绕过", async () => {
  const DB = localDatabase(),
    env = { DB },
    batch = DB.batch.bind(DB);
  try {
    let inject = true;
    DB.batch = async (statements) => {
      if (inject) {
        inject = false;
        await DB.prepare(
          "INSERT INTO research_test_claims(namespace,outcome_date,experiment_id,role,reserved_at) VALUES('main','2026-01-08','race','FORWARD_TEST','now')",
        ).run();
      }
      return batch(statements);
    };
    await assert.rejects(
      () => importExecutionCalibration(env, executionInput()),
      /正式研究测试\/前瞻日期重叠/,
    );
    for (const table of [
      "execution_calibration_inputs",
      "execution_calibration_sample_sets",
      "execution_calibration_sample_owners",
      "execution_calibration_date_uses",
    ])
      assert.equal(
        (await DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,
        0,
        `${table} 全部回滚`,
      );
    DB.batch = batch;
    await DB.prepare("DELETE FROM research_test_claims").run();
    await importExecutionCalibration(env, executionInput());
    await assert.rejects(
      () =>
        new CohortRepository(env).claimCohortForwardDate(
          "2026-01-08",
          "cohort-test",
        ),
      /成本校准用途/,
    );
    await assert.rejects(
      () =>
        DB.prepare(
          "INSERT INTO research_sample_uses(namespace,experiment_id,role,outcome_date,sample_key,payload,digest) VALUES('main','x','HISTORICAL_TEST','2026-01-08','x','{}','d')",
        ).run(),
      /成本校准用途/,
    );
    await DB.prepare(
      "INSERT INTO research_test_claims(namespace,outcome_date,experiment_id,role,reserved_at) VALUES('main','2026-02-01','safe','HISTORICAL_TEST','now')",
    ).run();
    await assert.rejects(
      () =>
        DB.prepare(
          "UPDATE research_test_claims SET outcome_date='2026-01-08' WHERE experiment_id='safe'",
        ).run(),
      /成本校准用途/,
    );
  } finally {
    DB.batch = batch;
    DB.close();
  }
});

test("P2：名称、来源、分界、外部 ID 和时区改名都复用首次实际样本协议，部分重用被拒绝", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const first = await importExecutionCalibration(env, executionInput());
    const run = await runExecutionCalibration(env, first.id);
    await new ExecutionCostRepository(env).save({
      payload: {
        ...defaultExecutionCostPolicy().payload,
        previousLimitUpPremiumBps: 20,
      },
    });
    const renamed = executionInput();
    renamed.provenance.datasetRef = "renamed";
    renamed.provenance.owner = "renamed-owner";
    renamed.provenance.source = "new-broker-export";
    renamed.trainingEnd = "2026-01-06";
    renamed.cutoff = "2026-01-09";
    renamed.orders.reverse();
    for (const order of renamed.orders) {
      order.id = `new-${order.id}`;
      for (const field of [
        "submittedAt",
        "completedAt",
        "marketVolumeObservedAt",
      ])
        order[field] = new Date(order[field]).toISOString();
      order.quote.observedAt = new Date(order.quote.observedAt).toISOString();
      for (const fill of order.fills) {
        fill.id = `new-${fill.id}`;
        fill.executedAt = new Date(fill.executedAt).toISOString();
      }
    }
    const again = await importExecutionCalibration(env, renamed);
    assert.equal(again.id, first.id);
    assert.equal(again.trainingEnd, "2026-01-05");
    assert.equal(again.cutoff, "2026-01-08");
    assert.equal((await runExecutionCalibration(env, again.id)).id, run.id);
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM execution_calibration_inputs",
        ).first()
      ).n,
      1,
    );
    const subset = executionInput();
    subset.orders.pop();
    await assert.rejects(
      () => importExecutionCalibration(env, subset),
      /实际委托\/成交样本已用于校准/,
    );
  } finally {
    DB.close();
  }
});

test("P2：并发别名导入只冻结一份协议，并发部分复用整批回滚", async () => {
  const DB = localDatabase(),
    env = { DB };
  try {
    const alias = executionInput();
    alias.provenance.datasetRef = "alias";
    const [first, second] = await Promise.all([
      importExecutionCalibration(env, executionInput()),
      importExecutionCalibration(env, alias),
    ]);
    assert.equal(first.id, second.id);
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM execution_calibration_inputs",
        ).first()
      ).n,
      1,
    );
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM execution_calibration_sample_sets",
        ).first()
      ).n,
      1,
    );
  } finally {
    DB.close();
  }
  const otherDB = localDatabase(),
    otherEnv = { DB: otherDB };
  try {
    const subset = executionInput();
    subset.orders.pop();
    const results = await Promise.allSettled([
      importExecutionCalibration(otherEnv, executionInput()),
      importExecutionCalibration(otherEnv, subset),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(
      (
        await otherDB
          .prepare("SELECT COUNT(*) n FROM execution_calibration_inputs")
          .first()
      ).n,
      1,
    );
    assert.equal(
      (
        await otherDB
          .prepare("SELECT COUNT(*) n FROM execution_calibration_sample_sets")
          .first()
      ).n,
      1,
    );
  } finally {
    otherDB.close();
  }
});

test("0016 升级回填旧用途和首次身份，保留历史内容并拒绝遗留冲突及别名协议", async () => {
  const directory = mkdtempSync(join(tmpdir(), "calibration-upgrade-")),
    path = join(directory, "legacy.sqlite");
  let DB;
  try {
    const sqlite = new DatabaseSync(path);
    sqlite.exec("CREATE TABLE local_migrations(name TEXT PRIMARY KEY)");
    for (const file of readdirSync("drizzle")
      .filter((f) => f.endsWith(".sql") && f < "0017")
      .sort()) {
      sqlite.exec(readFileSync(`drizzle/${file}`, "utf8"));
      sqlite.prepare("INSERT INTO local_migrations(name) VALUES(?)").run(file);
    }
    const basePolicy = defaultExecutionCostPolicy(),
      first = normalizeCalibrationInput(executionInput());
    const alias = structuredClone(first);
    alias.provenance.datasetRef = "legacy-alias";
    const ids = [];
    let primaryReport;
    for (const [index, input] of [first, alias].entries()) {
      const inputDigest = await calibrationInputDigest(input, basePolicy),
        inputId = `cal-input-${inputDigest}`;
      const report = await calibrateExecutionCost(input, basePolicy),
        digest = await digestOf(report),
        id = `cal-${digest}`;
      sqlite
        .prepare(
          "INSERT INTO execution_calibration_inputs(id,payload,digest,raw_digest,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          inputId,
          JSON.stringify({ input, basePolicy }),
          inputDigest,
          await digestOf(input),
          `2026-02-0${index + 1}`,
        );
      sqlite
        .prepare(
          "INSERT INTO execution_cost_calibrations(id,input_digest,cutoff,report,digest,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          inputDigest,
          report.cutoff,
          JSON.stringify({ inputId, report }),
          digest,
          `2026-02-0${index + 1}`,
        );
      ids.push(inputId);
      if (!index) primaryReport = { id, report };
    }
    sqlite
      .prepare(
        "INSERT INTO execution_cost_policies(id,version,model_version,payload,digest,calibration_status,calibration_cutoff,effective_from,created_at,calibration_id) VALUES('legacy-policy',1,?,?,?,'EXECUTION_CALIBRATED',?,'2026-02-01','2026-02-01',?)",
      )
      .run(
        basePolicy.modelVersion,
        JSON.stringify(primaryReport.report.payload),
        primaryReport.report.payloadDigest,
        primaryReport.report.cutoff,
        primaryReport.id,
      );
    sqlite
      .prepare(
        "INSERT INTO research_test_claims(namespace,outcome_date,experiment_id,role,reserved_at) VALUES('main','2026-01-06','legacy-conflict','HISTORICAL_TEST','now')",
      )
      .run();
    const beforeInputs = sqlite
      .prepare(
        "SELECT id,payload,digest,raw_digest FROM execution_calibration_inputs ORDER BY id",
      )
      .all();
    const beforeReports = sqlite
      .prepare("SELECT * FROM execution_cost_calibrations ORDER BY id")
      .all();
    sqlite.close();
    DB = localDatabase(path);
    const env = { DB };
    assert.deepEqual(
      (
        await DB.prepare(
          "SELECT id,payload,digest,raw_digest FROM execution_calibration_inputs ORDER BY id",
        ).all()
      ).results,
      beforeInputs,
    );
    assert.deepEqual(
      (
        await DB.prepare(
          "SELECT * FROM execution_cost_calibrations ORDER BY id",
        ).all()
      ).results,
      beforeReports,
    );
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM execution_calibration_date_uses",
        ).first()
      ).n,
      16,
    );
    await assert.rejects(
      () => DB.transaction(() => new ExecutionCostRepository(env).latest()),
      /正式研究测试\/前瞻日期重叠/,
    );
    assert.equal(
      (
        await DB.prepare(
          "SELECT COUNT(*) n FROM execution_calibration_inputs WHERE sample_digest IS NULL",
        ).first()
      ).n,
      2,
      "研究预留的外层事务回滚时，身份回填也回滚；后续读取可恢复",
    );
    await assert.rejects(
      () => new ExecutionCostRepository(env).latest(),
      /正式研究测试\/前瞻日期重叠/,
    );
    await DB.prepare(
      "DELETE FROM research_test_claims WHERE experiment_id='legacy-conflict'",
    ).run();
    assert.equal(
      (await new ExecutionCostRepository(env).latest()).calibrationStatus,
      "EXECUTION_CALIBRATED",
    );
    const renamed = executionInput();
    renamed.provenance.datasetRef = "third-name";
    renamed.trainingEnd = "2026-01-06";
    assert.equal((await importExecutionCalibration(env, renamed)).id, ids[0]);
    const aliasReport = await DB.prepare(
      "SELECT id FROM execution_cost_calibrations WHERE id<>?",
    )
      .bind(primaryReport.id)
      .first();
    await assert.rejects(
      () => exportExecutionCalibration(env, aliasReport.id),
      /首次冻结协议/,
    );
  } finally {
    DB?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("问题 3（P2）：配置和政策热读取不重新拟合，离线核验仍独立重算，篡改使缓存失效", async () => {
  const DB = localDatabase(),
    env = { DB },
    originalTimeout = globalThis.setTimeout;
  try {
    const imported = await importExecutionCalibration(env, executionInput());
    const run = await runExecutionCalibration(env, imported.id);
    await saveExecutionCostPolicy(env, { calibrationId: run.id });
    let yields = 0;
    globalThis.setTimeout = (...args) => {
      yields++;
      return originalTimeout(...args);
    };
    await getExecutionCostConfig(env);
    await getExecutionCostConfig(env);
    await new ExecutionCostRepository(env).latest();
    const bundle = await exportExecutionCalibration(env, run.id);
    assert.equal(yields, 0, "普通读取没有任何训练网格迭代");
    await verifyExecutionCalibration(bundle);
    assert.ok(yields > 0, "离线核验从冻结输入独立计算");
    // 同步重写报告摘要、ID 和政策引用，新的报告指纹不能命中旧核验缓存。
    bundle.report.validation.maeBps = 0;
    const digest = await digestOf(bundle.report),
      id = `cal-${digest}`;
    await DB.prepare(
      "INSERT INTO execution_cost_calibrations(id,input_digest,cutoff,report,digest,created_at) VALUES(?,?,?,?,?,'now')",
    )
      .bind(
        id,
        bundle.report.inputDigest,
        bundle.report.cutoff,
        JSON.stringify({ inputId: bundle.inputId, report: bundle.report }),
        digest,
      )
      .run();
    await DB.prepare("UPDATE execution_cost_policies SET calibration_id=?")
      .bind(id)
      .run();
    await assert.rejects(
      () => new ExecutionCostRepository(env).latest(),
      /独立重算不一致/,
    );
  } finally {
    globalThis.setTimeout = originalTimeout;
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
