// Synthetic, in-memory research probe. No HTTP or production database access.
// Run from the project root: node docs/design/experiments/benchmark-strategy-kernel.mjs
import { performance } from "node:perf_hooks";
import {
  BASE_STRATEGY,
  newBook,
  createPlan,
} from "../../../backend/domain/trading.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../../../backend/domain/realtime.js";
import { snapshot, dataset, dateAt } from "../../../test/fixtures/trading.mjs";
const signalDate = dateAt(0),
  tradeDate = dateAt(1);
const definitions = [
  ["primary", BASE_STRATEGY],
  ["incumbent", BASE_STRATEGY],
  ["matched-baseline", BASE_STRATEGY],
  ["continuous-baseline", BASE_STRATEGY],
  ["candidate-a", { ...BASE_STRATEGY, minScore: 82, maxPositions: 3 }],
  ["candidate-b", { ...BASE_STRATEGY, minScore: 78, maxPositions: 5 }],
  ["candidate-c", { ...BASE_STRATEGY, maxHoldDays: 4, stopLoss: 0.055 }],
  [
    "candidate-d",
    {
      ...BASE_STRATEGY,
      weights: BASE_STRATEGY.weights.map(
        (w, i) => w + (i === 0 ? 2 : i === 5 ? -2 : 0),
      ),
      tSellRise: 0.025,
    },
  ],
];
let books = definitions.map(([id, strategy]) => {
  const book = { ...newBook(), lastDate: signalDate };
  const plan = createPlan(
    snapshot(signalDate),
    book,
    strategy,
    id,
    `${signalDate}T07:10:00.000Z`,
  );
  return { id, book, session: openSession(book, plan, tradeDate), fills: [] };
});
const timings = [];
const ids = new Set();
let collisions = 0,
  frameCount = 0;
const start = performance.now();
for (const [first, last] of [
  [570 * 60, 690 * 60],
  [780 * 60, 897 * 60 - 10],
]) {
  for (let second = first; second <= last; second += 10) {
    const time = `${String(Math.floor(second / 3600)).padStart(2, "0")}:${String(Math.floor(second / 60) % 60).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}`;
    const timestamp = `${tradeDate}T${time}+08:00`;
    const observation = {
      observedAt: new Date(timestamp).toISOString(),
      pollIntervalSeconds: 10,
      quotes: {},
    };
    for (const code of ["600001", "600002"])
      observation.quotes[code] = {
        date: tradeDate,
        timestamp,
        closeCents: 1000,
        openCents: 1000,
        previousCloseCents: 1000,
        volumeShares: 100000 + frameCount * 200000,
        limitUpCents: 1100,
        limitDownCents: 900,
      };
    const before = performance.now();
    books = books.map((item) => {
      const result = advanceSession(item.book, item.session, observation);
      for (const row of result.ledger) {
        if (ids.has(row.id)) collisions++;
        ids.add(row.id);
      }
      return {
        ...item,
        book: result.book,
        session: result.session,
        fills: [...item.fills, ...result.ledger],
      };
    });
    timings.push(performance.now() - before);
    frameCount++;
  }
}
const closing = { ...dataset(tradeDate, "600001"), executionMode: "realtime" };
closing.quotes["600002"] = { ...closing.quotes["600001"] };
for (const item of books) closeSession(item.book, item.session, closing);
const elapsed = performance.now() - start;
timings.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    node: process.version,
    portfolios: books.length,
    syntheticStocks: 2,
    frames: frameCount,
    engineCalls: frameCount * books.length,
    totalMs: Math.round(elapsed),
    frameMeanMs: Number(
      (timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(3),
    ),
    frameP95Ms: Number(timings[Math.floor(timings.length * 0.95)].toFixed(3)),
    frameMaxMs: Number(timings.at(-1).toFixed(3)),
    fills: books.reduce((n, b) => n + b.fills.length, 0),
    duplicateUnscopedLedgerIds: collisions,
    scope:
      "pure engine only; excludes HTTP, SQLite, full stock pool and Windows",
  }),
);
