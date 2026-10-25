// Deterministic release checks. These never write accounts or count as real-day evidence.
import {
  createDragonPlan,
  openDragonSession,
  advanceDragonSession,
} from "./dragon-risk.js";
import {
  defaultDragonConfig,
  normalizeDragonConfig,
} from "../../shared/dragon-risk-config.js";
import { defaultExecutionCostPolicy } from "../../shared/execution-cost.js";
import { newBook } from "./trading.js";
import { INTRADAY_ENTRY_VERSION } from "./intraday-entry.js";
import { digestOf, canonicalJson } from "./research-lineage.js";
import { executionEngineBuildDigest } from "./execution-build.js";

let cached;
export async function dragonSyntheticChecks() {
  cached ??= runChecks();
  return structuredClone(await cached);
}
async function runChecks() {
  const engineBuild = await executionEngineBuildDigest(),
    checks = [];
  const check = (name, value) => {
    checks.push({ name, passed: !!value });
    if (!value) throw new Error(name);
  };
  const signalDate = "2000-01-03",
    date = "2000-01-04";
  const history = {
    name: "合成行为检查",
    sector: "合成行业",
    stockClass: "relay-leader",
    amount: 500000000,
    recentLimitUp: true,
    previousCloseCents: 1000,
    previousOpenCents: 950,
    previousChange: 10,
    previousHeight: 3,
    previousTouchedLimit: true,
    lastFourCloseSumCents: 3600,
    previousVolumeShares: null,
  };
  const source = {
    date: signalDate,
    stocks: [],
    cycle: { phase: "rising" },
    intradayEntryContext: {
      version: INTRADAY_ENTRY_VERSION,
      asOf: signalDate,
      history: { 600001: history },
    },
  };
  const observation = (time, price, volume) => {
    const stamp = `${date}T${time}+08:00`;
    return {
      observedAt: stamp,
      quotes: {
        600001: {
          date,
          timestamp: stamp,
          closeCents: price,
          previousCloseCents: 1000,
          openCents: 940,
          highCents: Math.max(price, 1000),
          volumeShares: volume,
          limitUpCents: 1100,
          limitDownCents: 900,
          ask1Cents: price + 1,
          bid1Cents: price - 1,
          ask1Shares: 100000,
          bid1Shares: 100000,
          orderBookQuality: "OK",
          orderBookTimestamp: stamp,
        },
      },
      entryInputs: {
        market: {
          date,
          observedAt: stamp,
          cycle: { phase: "rising" },
          sectors: [{ name: "合成行业", score: 85 }],
          discoveries: [],
        },
        auction: {
          600001: {
            date,
            final: true,
            openCents: 940,
            previousCloseCents: 1000,
          },
        },
      },
    };
  };
  const fixture = async (held = false, adds = true) => {
    const config = defaultDragonConfig();
    config.operations.profitAdd = config.operations.lossAdd = adds;
    const book = {
      ...newBook(),
      lastDate: signalDate,
      tradingPolicyVersion: "dragon-risk-v1",
      dragonConfig: config,
      dragonConfigId: "synthetic-behavior-only",
      dragonConfigDigest: await digestOf(config),
      dragonEngineBuild: engineBuild,
    };
    if (held) {
      book.cashCents -= 1000000;
      book.positions = [
        {
          code: "600001",
          name: history.name,
          sector: history.sector,
          heldDays: 1,
          markCents: 1000,
          lots: [
            {
              quantity: 1000,
              costCents: 1000000,
              acquiredDate: signalDate,
              priceCents: 1000,
            },
          ],
          dragon: {
            id: `${signalDate}:600001`,
            startDate: signalDate,
            p0Cents: 1000,
            r0Cents: 40,
            stopCents: 960,
            highCents: 1000,
            initialQuantity: 1000,
            strategicQuantity: 1000,
            strategicCostCents: 1000000,
            stage: 0,
            holdDays: 4,
            buyPoint: "auction-dip",
            dayAction: signalDate,
          },
        },
      ];
    }
    const plan = createDragonPlan(source, book, `${signalDate}T08:00:00Z`, {
      executionCostPolicy: defaultExecutionCostPolicy(),
    });
    return { book, plan, session: openDragonSession(book, plan, date) };
  };
  const step = (f, o) => {
    const result = advanceDragonSession(f.book, f.session, o);
    f.book = result.book;
    f.session = result.session;
    return result;
  };
  try {
    let refused = false;
    try {
      normalizeDragonConfig({ ...defaultDragonConfig(), legacyFallback: true });
    } catch {
      refused = true;
    }
    check("strict-config", refused);
    const f = await fixture(),
      old = structuredClone(f.book);
    old.riskLimits = { maxGrossExposure: 0, maxPositions: 0 };
    const independent = createDragonPlan(source, old, f.plan.createdAt, {
      executionCostPolicy: f.plan.executionCostPolicy,
    });
    check(
      "legacy-isolation",
      canonicalJson(independent) === canonicalJson(f.plan),
    );
    check(
      "two-snapshot-gate",
      step(f, observation("09:31:00", 950, 1000000)).ledger.length === 0,
    );
    check(
      "observed-open",
      step(f, observation("09:31:10", 951, 11000000)).ledger.some(
        (l) => l.intent === "OPEN",
      ),
    );
    check(
      "duplicate-idempotence",
      step(f, observation("09:31:10", 951, 11000000)).ledger.length === 0,
    );
    check(
      "t-plus-one",
      step(f, observation("09:31:20", 910, 21000000)).ledger.length === 0 &&
        f.book.positions[0].dragon.exit,
    );
    for (const [intent, price] of [
      ["ADD_PROFIT", 1022],
      ["ADD_LOSS", 974],
    ]) {
      const add = await fixture(true);
      step(add, observation("09:31:00", price - 1, 1000000));
      const result = step(add, observation("09:31:10", price, 11000000));
      check(
        intent,
        result.ledger.some((l) => l.intent === intent) &&
          add.book.positions[0].dragon.r0Cents === 40 &&
          add.book.positions[0].dragon.stopCents === 960 &&
          step(add, observation("09:31:20", price, 21000000)).ledger.length ===
            0,
      );
    }
    for (const [direction, prices] of [
      ["FORWARD", [978, 979, 1008]],
      ["REVERSE", [1023, 1022, 990]],
    ]) {
      const t = await fixture(true, false);
      step(t, observation("10:01:00", prices[0], 1000000));
      const first = step(t, observation("10:01:10", prices[1], 11000000));
      const second = step(t, observation("10:01:20", prices[2], 21000000));
      check(
        `T_${direction}`,
        first.ledger.length === 1 &&
          second.ledger.length === 1 &&
          t.book.dragonTRecords?.at(-1)?.status === "COMPLETED" &&
          t.book.dragonTNetPnlCents ===
            first.ledger[0].cashDeltaCents + second.ledger[0].cashDeltaCents &&
          t.book.positions[0].dragon.strategicQuantity === 1000,
      );
    }
    return { version: "dragon-behavior-v1", engineBuild, passed: true, checks };
  } catch (error) {
    return {
      version: "dragon-behavior-v1",
      engineBuild,
      passed: false,
      checks,
      reason: error.message,
    };
  }
}
