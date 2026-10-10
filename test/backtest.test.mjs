import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { localDatabase } from "../scripts/local-db.mjs";
import { openHistoryStore } from "../backend/storage/history.js";
import { runBacktest, backtestDetail } from "../backend/services/backtest.js";
import { FACTORS, PRESETS } from "../shared/scoring.js";

const DATES = ["2026-03-02", "2026-03-03", "2026-03-04"];
const CODES = ["600001", "600002"];
function snapshotPayload(date, priceStep) {
  return {
    date,
    createdAt: `${date}T07:05:00.000Z`,
    emotion: 70,
    stocks: CODES.map((code, index) => ({
      code,
      name: `样本${index + 1}`,
      sector: "测试行业",
      price: 10.5 + index * 0.5 + priceStep,
      deduction: 0,
      factors: FACTORS.map((factor, i) => ({
        key: factor.key,
        name: factor.name,
        value: [92, 90, 88, 91, 89, 87][i],
        weight: PRESETS.balanced[i],
      })),
      risks: [],
    })),
    sectors: [{ name: "测试行业", score: 82, count: CODES.length }],
  };
}
function minuteBars(basePrice) {
  return [
    { time: "09:31", priceCents: basePrice - 20, volumeShares: 1200000 },
    { time: "09:32", priceCents: basePrice - 15, volumeShares: 600000 },
    { time: "09:33", priceCents: basePrice - 10, volumeShares: 600000 },
    { time: "09:34", priceCents: basePrice - 5, volumeShares: 600000 },
    { time: "10:00", priceCents: basePrice, volumeShares: 600000 },
    { time: "14:50", priceCents: basePrice, volumeShares: 400000 },
    { time: "15:00", priceCents: basePrice + 5, volumeShares: 200000 },
  ];
}
async function seedDataset(env, store, { minuteOn }) {
  const datasetId = `hds-${crypto.randomUUID()}`;
  await store.createDatasetVersion({
    id: datasetId,
    provider: "tencent-free",
    kind: "LIMIT_FEATURES",
    executionModel: "SIX_FACTOR_V1",
    requestedStart: DATES[0],
    requestedEnd: DATES.at(-1),
    coverage: { succeededDates: DATES, coverage: { ratio: 100 } },
  });
  for (const [index, date] of DATES.entries())
    await store.saveScore(
      datasetId,
      date,
      "rules-v1-historical",
      "test-params",
      snapshotPayload(date, index * 0.1),
    );
  for (const date of minuteOn)
    for (const [codeIndex, code] of CODES.entries())
      await store.saveMinuteInputs(datasetId, date, code, {
        bars: minuteBars(1050 + codeIndex * 50),
        anomalies: [],
        sampled: true,
      });
  await store.updateDatasetCoverage(datasetId, {
    executionModel: "SIX_FACTOR_V1",
    succeededDates: DATES,
  });
  return datasetId;
}
test("研究回测：采样模型成交、T+1 与费用入账、收益可重放验证", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-bt-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const store = openHistoryStore(env);
  const datasetId = await seedDataset(env, store, { minuteOn: DATES.slice(1) });
  try {
    const run = await runBacktest(env, {
      datasetId,
      name: "采样回测",
      initialCapital: 1000000,
    });
    assert.equal(run.stage, "READY");
    assert.equal(run.executionModel, "MINUTE_SAMPLE_V1");
    assert.equal(run.coverage.plannedPairs, 2);
    assert.equal(run.coverage.executedPairs, 2);
    assert.equal(run.coverage.equity.length, 2);
    assert.ok(Number.isFinite(run.coverage.totalReturn));
    assert.ok(run.coverage.feesCents > 0);
    const detail = await backtestDetail(env, run.id);
    assert.equal(detail.verification.totalReturnMatches, true);
    assert.ok(detail.ledgerCount > 0);
    const dayOneSells = detail.ledger.filter(
      (row) =>
        row.tradeDate === DATES[1] &&
        (row.side === "SELL" ||
          row.action === "EXIT" ||
          row.action === "REDUCE"),
    );
    const dayOneBuys = detail.ledger.filter(
      (row) => row.tradeDate === DATES[1] && row.side === "BUY",
    );
    for (const sell of dayOneSells)
      assert.ok(
        !dayOneBuys.some((buy) => buy.code === sell.code),
        "T+1：当日买入的股票不允许当日卖出",
      );
    const rerunEquity = await store.listBacktestEquity(run.id);
    assert.equal(rerunEquity.length, 2);
  } finally {
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("缺少分钟采样的交易日被跳过并标记 PARTIAL；账本跨日保留", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-bt-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const store = openHistoryStore(env);
  const datasetId = await seedDataset(env, store, { minuteOn: [DATES[1]] });
  try {
    const run = await runBacktest(env, { datasetId, initialCapital: 1000000 });
    assert.equal(run.stage, "PARTIAL");
    assert.equal(run.coverage.plannedPairs, 2);
    assert.equal(run.coverage.executedPairs, 1);
    assert.ok(
      run.coverage.skippedPairs.some(
        (row) => row.tradeDate === DATES[2] && row.reason.includes("分钟"),
      ),
    );
    const detail = await backtestDetail(env, run.id);
    assert.equal(detail.verification.totalReturnMatches, true);
  } finally {
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("非六因子数据集拒绝回测", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-bt-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const store = openHistoryStore(env);
  const datasetId = `hds-${crypto.randomUUID()}`;
  try {
    await store.createDatasetVersion({
      id: datasetId,
      provider: "tencent-free",
      kind: "DAILY",
      executionModel: "DAILY_OBSERVATION_V1",
      requestedStart: DATES[0],
      requestedEnd: DATES.at(-1),
      coverage: {},
    });
    await assert.rejects(
      () => runBacktest(env, { datasetId }),
      /六因子历史评分数据集/,
    );
  } finally {
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("账本被清空后收益核验必须失败而非通过", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-bt-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const store = openHistoryStore(env);
  const datasetId = await seedDataset(env, store, { minuteOn: DATES.slice(1) });
  try {
    const run = await runBacktest(env, { datasetId, initialCapital: 1000000 });
    const before = await backtestDetail(env, run.id);
    assert.equal(before.verification.totalReturnMatches, true);
    await store.db
      .prepare("DELETE FROM backtest_ledger WHERE run_id = ?")
      .bind(run.id)
      .run();
    const after = await backtestDetail(env, run.id);
    assert.equal(after.verification.totalReturnMatches, false);
    assert.equal(after.verification.ledgerCountMatches, false);
    assert.ok(after.verification.note.includes("无法核验"));
  } finally {
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("数据集输入被篡改后回测拒绝并提示校验失败", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-bt-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const store = openHistoryStore(env);
  const datasetId = await seedDataset(env, store, { minuteOn: DATES.slice(1) });
  try {
    await store.updateDatasetCoverage(datasetId, {
      executionModel: "SIX_FACTOR_V1",
    });
    await store.saveDailyInputs(datasetId, DATES[1], {
      normalized: [{ tampered: true }],
      provenance: {},
    });
    await assert.rejects(
      () => runBacktest(env, { datasetId, initialCapital: 1000000 }),
      /manifest 校验失败/,
    );
  } finally {
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("分钟数据篡改使 manifest 核验失败", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-bt-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const store = openHistoryStore(env);
  const datasetId = await seedDataset(env, store, { minuteOn: DATES.slice(1) });
  try {
    await store.updateDatasetCoverage(datasetId, {
      executionModel: "SIX_FACTOR_V1",
    });
    const before = await store.datasetIntegrity(datasetId);
    assert.equal(before.verified, true);
    await store.saveMinuteInputs(datasetId, DATES[1], "600001", {
      bars: [{ time: "09:31", priceCents: 1, volumeShares: 1 }],
      anomalies: [],
      sampled: true,
    });
    const after = await store.datasetIntegrity(datasetId);
    assert.equal(after.verified, false);
    assert.ok(
      after.issues.some((issue) => issue.includes("manifest 摘要不一致")),
    );
  } finally {
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("回测不跨缺失交易日配对执行", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-bt-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const store = openHistoryStore(env);
  const datasetId = await seedDataset(env, store, { minuteOn: DATES });
  try {
    await store.updateDatasetCoverage(datasetId, {
      executionModel: "SIX_FACTOR_V1",
      succeededDates: ["2026-03-02", "2026-03-04"],
    });
    const run = await runBacktest(env, { datasetId, initialCapital: 1000000 });
    assert.equal(run.stage, "PARTIAL");
    assert.ok(
      run.coverage.skippedPairs.some((row) =>
        row.reason.includes("不跨缺失日配对"),
      ),
    );
    assert.equal(run.coverage.executedPairs, 0);
  } finally {
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
test("修改账本成交价格后收益核验失败", async () => {
  const DB = localDatabase();
  const researchPath = `.sites-runtime/test-bt-${crypto.randomUUID()}.sqlite`;
  const env = { DB, LOCAL_RESEARCH_DB_PATH: researchPath };
  const store = openHistoryStore(env);
  const datasetId = await seedDataset(env, store, { minuteOn: DATES.slice(1) });
  try {
    const run = await runBacktest(env, { datasetId, initialCapital: 1000000 });
    const before = await backtestDetail(env, run.id);
    assert.equal(before.verification.totalReturnMatches, true);
    const rows = await store.db
      .prepare("SELECT id, payload FROM backtest_ledger WHERE run_id = ?")
      .bind(run.id)
      .all();
    const target = rows.results[0];
    const payload = JSON.parse(target.payload);
    payload.priceCents += 50;
    await store.db
      .prepare(
        "UPDATE backtest_ledger SET payload = ? WHERE run_id = ? AND id = ?",
      )
      .bind(JSON.stringify(payload), run.id, target.id)
      .run();
    const after = await backtestDetail(env, run.id);
    assert.equal(after.verification.cashChainMatches, false);
    assert.equal(after.verification.totalReturnMatches, false);
    assert.ok(after.verification.cashIssues.length > 0);
  } finally {
    DB.close();
    store.close();
    try {
      unlinkSync(researchPath);
    } catch {}
  }
});
