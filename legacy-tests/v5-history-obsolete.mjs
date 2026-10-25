import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { localDatabase } from "../scripts/local-db.mjs";
import {
  HistoryDatasetStore,
  openHistoryStore,
} from "../backend/storage/history.js";
import { PaperRepository } from "../backend/storage/paper.js";
import {
  createHistoryImport,
  runHistoryImport,
} from "../backend/services/history.js";
import { runBacktest, backtestDetail } from "../backend/services/backtest.js";
import {
  auditArchivedDay,
  evaluateArchivedInterval,
  researchSnapshotView,
} from "../backend/services/archived-backtest.js";
import {
  fetchCompleteHistoricalPool,
  reconstructV5Snapshot,
  V5_SCORING_VERSION,
  V5_RECONSTRUCTION_VERSION,
  freezeResearchConfiguration,
  fetchResearchDailyRecord,
  withResearchDailyRecords,
} from "../backend/services/v5-reconstruction.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import {
  createPlan,
  newBook,
  BASE_STRATEGY,
} from "../backend/domain/trading.js";
import { openSession, advanceSession } from "../backend/domain/realtime.js";
import { defaultExecutionCostPolicy } from "../shared/execution-cost.js";
import { DEFAULT_FEES } from "../shared/fees.js";
import { DEFAULT_RISK_LIMITS } from "../shared/risk-limits.js";
import { snapshot as baseSnapshot } from "./fixtures/trading.mjs";
import { INTRADAY_ENTRY_VERSION } from "../backend/domain/intraday-entry.js";
import { defaultDragonConfig } from "../shared/dragon-risk-config.js";
import {
  registerDragonConfig,
  dragonBookFields,
} from "../backend/storage/dragon-risk.js";
import {
  summarizeTQuality,
  buildTQualityEvidence,
} from "../backend/domain/t-quality.js";
import { analyze } from "../shared/scoring.js";
import {
  computeEodRowsWithPrev,
  computeMa5ByCode,
  computeStockFeaturesByCode,
} from "../backend/services/daily-closes.js";

const signalDate = "2026-03-02",
  date = "2026-03-03";
const configuration = {
  strategy: BASE_STRATEGY,
  fees: DEFAULT_FEES,
  riskLimits: DEFAULT_RISK_LIMITS,
  initialCapital: 1000000,
  activeStrategy: "baseline-v1",
  executionCostPolicy: defaultExecutionCostPolicy(),
  buyPointParams: { firstNegMinPrevHeight: 3 },
};
function source(overrides = {}) {
  return {
    ...baseSnapshot(signalDate, [1000]),
    stocks: baseSnapshot(signalDate, [1000]).stocks.slice(0, 1),
    brokenStocks: [],
    extraStocks: [],
    modelVersion: V5_SCORING_VERSION,
    reconstructionVersion: V5_RECONSTRUCTION_VERSION,
    createdAt: "2026-10-22T10:00:00.000Z",
    decisionAt: `${signalDate}T07:10:00.000Z`,
    candidateCoverage: { status: "COMPLETE", issues: [] },
    researchExitInputs: {},
    intradayEntryContext: {
      version: INTRADAY_ENTRY_VERSION,
      asOf: signalDate,
      firstNegMinPrevHeight: 3,
      history: {
        600001: {
          name: "合成样本",
          sector: "测试行业",
          stockClass: "relay-leader",
          recentLimitUp: true,
          amount: 500000000,
          previousCloseCents: 1000,
          previousOpenCents: 950,
          previousChange: 10,
          previousHeight: 3,
          previousTouchedLimit: true,
          lastFourCloseSumCents: 3600,
          previousVolumeShares: null,
          ...overrides,
        },
      },
    },
  };
}
function planFor(s) {
  return createPlan(
    researchSnapshotView(s),
    {
      ...newBook(),
      lastDate: signalDate,
      entryExecutionMode: "intraday-conditional",
    },
    BASE_STRATEGY,
    "baseline-v1",
    `${signalDate}T07:15:00.000Z`,
    s.tQualityRulesVersion
      ? {
          tQuality: summarizeTQuality([], { signalDate, tradingDates: [] }),
          tQualityEvidence: buildTQualityEvidence([], []),
        }
      : {},
  );
}
async function framesFor(kind = "none") {
  const frames = [];
  const open =
    kind === "auction-dip" ? 940 : kind === "fake-neg-limit-dip" ? 910 : 1000;
  let high = 1000,
    volume = 100000;
  for (const [from, to] of [
    ["09:30:00", "11:30:00"],
    ["13:00:00", "14:56:50"],
    ["15:00:00", "15:00:00"],
  ]) {
    for (
      let t = Date.parse(`${date}T${from}+08:00`);
      t <= Date.parse(`${date}T${to}+08:00`);
      t += 10000
    ) {
      const time = new Date(t + 8 * 3600000).toISOString().slice(11, 19);
      let price = 1000;
      if (kind === "auction-dip") price = 950;
      if (kind === "fake-neg-limit-dip") price = 921;
      if (kind === "broken-board-dip" && time >= "10:45:00") {
        price = 1040;
        high = 1100;
      }
      if (kind === "first-neg-dip" && time >= "14:31:00") price = 970;
      if (kind === "late-dip" && time >= "14:31:00") price = 960;
      if (kind === "limit-up-momentum" && time >= "09:45:00") {
        price = time === "09:45:00" ? 1100 : 1090;
        high = 1100;
      }
      const observedAt = new Date(t).toISOString(),
        pool = {
          codes: ["600001"],
          sources: { 600001: ["TEST_FIXTURE"] },
          declaredAt: observedAt,
        };
      const poolDigest = await digestOf(pool);
      const payload = {
        observedAt,
        pollIntervalSeconds: 10,
        pool,
        poolDigest,
        capture: { missingCodes: [] },
        quotes: {
          600001: {
            date,
            timestamp: observedAt,
            closeCents: price,
            previousCloseCents: 1000,
            openCents: open,
            highCents: high,
            lowCents: Math.min(open, price),
            volumeShares: volume,
            limitUpCents: 1100,
            limitDownCents: 900,
            bid1Cents: price - 1,
            ask1Cents: price + 1,
            bid1Shares: 100000,
            ask1Shares: 100000,
            orderBookQuality: "OK",
            orderBookTimestamp: observedAt,
          },
        },
        entryInputs: {
          market: {
            date,
            observedAt,
            emotion: 75,
            cycle: { maxGrossExposure: 0.6 },
            sectors: [{ name: "测试行业", score: 85 }],
            discoveries: [],
          },
          auction: {
            600001: {
              date,
              final: true,
              openCents: open,
              previousCloseCents: 1000,
            },
          },
        },
      };
      frames.push({
        tradeDate: date,
        sequence: frames.length + 1,
        observedAt,
        poolDigest,
        payload,
        digest: await digestOf(payload),
        origin: "REAL_QUOTE_ARCHIVE",
        createdAt: observedAt,
        importedAt: "2026-10-22T10:00:00.000Z",
      });
      volume += 100000;
    }
  }
  return frames;
}
function fakeStore(s, frames) {
  return {
    listScores: async () => [{ tradeDate: signalDate, payload: s }],
    listArchivedFrames: async () => frames,
  };
}
function dataset() {
  const warmupDates = candidateDataset().dates.slice(-22, -1);
  return {
    id: "synthetic-test-only",
    coverage: {
      executionDates: [date],
      signalDates: [signalDate],
      warmupDates,
      tradingDates: [...warmupDates, signalDate, date],
    },
  };
}

function candidateDataset() {
  const dates = [];
  for (let n = 60; n >= 0; n--) {
    const d = new Date(Date.parse(`${signalDate}T00:00:00Z`) - n * 86400000);
    if (![0, 6].includes(d.getUTCDay()))
      dates.push(d.toISOString().slice(0, 10));
  }
  const count = dates.length,
    codes = new Map();
  for (const code of ["600001", "600002", "600003", "600004"]) {
    const c = Array(count).fill(10),
      o = Array(count).fill(10),
      h = Array(count).fill(10.5),
      l = Array(count).fill(9.8);
    c[count - 7] = 11;
    h[count - 7] = 11;
    if (code === "600001") {
      c[count - 1] = 11;
      h[count - 1] = 11;
    }
    if (code === "600002") {
      c[count - 1] = 10.4;
      h[count - 1] = 11;
    }
    if (code === "600003") {
      c.fill(9);
      l.fill(8.8);
      c[count - 3] = 10 / 1.1;
      c[count - 2] = 10;
      c[count - 1] = 9.8;
      o[count - 1] = 10;
      h[count - 1] = 10;
    }
    if (code === "600004") {
      o[count - 2] = 10.9;
      h[count - 2] = 11;
      c[count - 1] = 9.4;
      o[count - 1] = 9;
      h[count - 1] = 9.5;
      l[count - 1] = 9;
    }
    codes.set(code, {
      dates: Uint32Array.from(dates, (_, i) => i),
      closes: Float64Array.from(c),
      opens: Float64Array.from(o),
      highs: Float64Array.from(h),
      lows: Float64Array.from(l),
      volumes: new Float64Array(count).fill(50000000),
      amounts: new Float64Array(count).fill(500000000),
      adjs: new Float64Array(count).fill(1),
      hasFactor: true,
    });
  }
  return { dates, dateIdx: new Map(dates.map((d, i) => [d, i])), codes };
}

test("新政策严格历史回放冻结独立配置，共用实际执行器且不继承旧参数", async () => {
  const db = localDatabase(),
    env = { DB: db };
  try {
    const papers = new PaperRepository(env),
      account = await papers.initialize(),
      record = await registerDragonConfig(db, defaultDragonConfig());
    const book = {
      ...account.book,
      ...dragonBookFields(record),
      activeStrategy: "legacy-must-not-run",
      riskLimits: { maxGrossExposure: 0, maxPositions: 0 },
    };
    await db
      .prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
      .bind(JSON.stringify(book))
      .run();
    const frozen = await freezeResearchConfiguration(env);
    assert.equal(frozen.strategy, null);
    assert.equal(frozen.riskLimits, undefined);
    assert.deepEqual(frozen.dragonConfig, record.config);
    assert.equal(frozen.selectionPolicyVersion, "dragon-risk-v1");
    const s = source(),
      frames = await framesFor("auction-dip");
    for (const f of frames) {
      delete f.payload.entryInputs.market.emotion;
      f.payload.entryInputs.market.cycle = { phase: "rising" };
      f.digest = await digestOf(f.payload);
    }
    const result = await evaluateArchivedInterval(
      fakeStore(s, frames),
      dataset(),
      frozen,
      "new-native-test",
    );
    assert.equal(result.blocked, false, JSON.stringify(result.days));
    assert.equal(result.plans[0].tradingPolicyVersion, "dragon-risk-v1");
    assert.ok(
      result.ledger.some(
        (r) => r.intent === "OPEN" && r.buyPoint === "auction-dip",
      ),
    );
    assert.equal(result.days[0].buyPoints["auction-dip"], "TRIGGERED");
    const repeated = await evaluateArchivedInterval(
      fakeStore(s, frames),
      dataset(),
      frozen,
      "new-native-replay",
    );
    assert.deepEqual(repeated.ledger, result.ledger);
    assert.deepEqual(repeated.book, result.book);
  } finally {
    db.close();
  }
});
