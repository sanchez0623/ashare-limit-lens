import test from "node:test";
import assert from "node:assert/strict";
import {
  newBook,
  executePlan,
  BASE_STRATEGY,
  totalQuantity,
  transactionFees,
  createPlan,
} from "../backend/domain/trading.js";
import { replayStrategy } from "../backend/domain/validation.js";
import { startTradingRunner } from "../scripts/trading-runner.mjs";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../backend/domain/realtime.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import { pollTrading } from "../backend/services/realtime.js";
import { buildOperationEvents } from "../backend/services/alerts.js";
import { parseTencentQuotes } from "../backend/services/market.js";
import {
  exportPaper,
  verifyExport,
  paperOverview,
} from "../backend/services/paper.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { dateAt, dataset, order, plan, snapshot } from "./fixtures/trading.mjs";

function frozen(actions, date, reference = 1000) {
  return {
    ...plan(
      actions.map((a) =>
        order(a[0], a[1], {
          referenceCents: reference,
          maxPriceCents: Math.round(reference * 1.04),
          stopCents: Math.round(reference * 0.94),
          takeProfitCents: Math.round(reference * 1.12),
          buyTriggerCents: Math.round(reference * 0.98),
          sellTriggerCents: Math.round(reference * 1.02),
        }),
      ),
      date,
    ),
    strategy: BASE_STRATEGY,
  };
}
function observation(
  date,
  time,
  price = 1000,
  volume = 100000,
  previous = 1000,
  extra = {},
) {
  const timestamp = `${date}T${time}+08:00`;
  return {
    observedAt: new Date(timestamp).toISOString(),
    quotes: {
      600001: {
        date,
        timestamp,
        closeCents: price,
        openCents: previous,
        previousCloseCents: previous,
        volumeShares: volume,
        limitUpCents: Math.round(previous * 1.1),
        limitDownCents: Math.round(previous * 0.9),
        ...extra,
      },
    },
  };
}
function closing(date, previous = 1000, price = 1000) {
  return {
    ...dataset(date, "600001", {
      previous,
      close: price,
      previousDate: dateAt(Number(date.slice(-2)) - 2),
    }),
    executionMode: "realtime",
    quotes: observation(date, "15:00:03", price, 10000000, previous).quotes,
  };
}
const qty = (book) => book.positions.reduce((n, p) => n + totalQuantity(p), 0);

test("实时 AI 重放不以日线补造收益，缺少实时覆盖时禁止验证通过", () => {
  const pair = { snapshot: snapshot(dateAt(0)), dataset: closing(dateAt(1)) };
  const result = replayStrategy([pair], BASE_STRATEGY);
  assert.equal(result.covered, false);
  assert.equal(result.fillCount, 0);
});
async function baseline(repo) {
  const account = await repo.initialize();
  const day = dataset(dateAt(0));
  assert.equal(
    await repo.settle(
      account.revision,
      executePlan(account.book, null, day),
      day,
    ),
    true,
  );
}
async function cycle(repo, actions, index, ticks, closePrice = 1000) {
  let account = await repo.account();
  const previous = account.book.positions[0]?.markCents || 1000;
  const intent = frozen(actions, dateAt(index - 1), previous);
  await repo.savePlan(intent);
  let session = openSession(account.book, intent, dateAt(index));
  const fills = [];
  for (const [time, price, volume, extra] of ticks) {
    account = await repo.account();
    const obs = observation(
      dateAt(index),
      time,
      price,
      volume,
      previous,
      extra,
    );
    const result = advanceSession(account.book, session, obs);
    assert.equal(
      await repo.commitObservation(account.revision, result, obs),
      true,
    );
    // Simulate a process restart after every poll: reload both account and orders from SQLite.
    session = await new RealtimeRepository({ DB: repo.db }).session(
      dateAt(index),
    );
    fills.push(...result.ledger);
  }
  account = await repo.account();
  const day = closing(dateAt(index), previous, closePrice);
  const result = closeSession(account.book, session, day);
  assert.equal(await repo.close(account.revision, result, day), true);
  const bundle = await exportPaper({ DB: repo.db });
  assert.deepEqual((await verifyExport(bundle)).checks, {
    cash: true,
    equity: true,
    pnl: true,
    fees: true,
    hashes: true,
    replay: true,
  });
  return { result, fills, bundle };
}
