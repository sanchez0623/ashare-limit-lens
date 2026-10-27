import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import {
  requestManualExit,
  prepareManualExitPlan,
} from "../backend/services/manual-exits.js";
import {
  pendingManualExitRequests,
  assertManualExitReferences,
  exportedManualExitReferences,
} from "../backend/storage/manual-exits.js";
import {
  registerDragonConfig,
  dragonBookFields,
} from "../backend/storage/dragon-risk.js";
import { defaultDragonConfig } from "../shared/dragon-risk-config.js";
import { latestPolicyBundle } from "../backend/storage/execution-cost.js";
import { newBook } from "../backend/domain/trading.js";
import {
  createDragonPlan,
  openDragonSession,
  advanceDragonSession,
} from "../backend/domain/dragon-risk.js";
import { selectionSnapshotDigest } from "../backend/domain/signal-selection.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import { snapshot } from "./fixtures/trading.mjs";

const date = "2026-10-26",
  tradeDate = "2026-10-27";
const now = new Date(`${date}T19:00:00+08:00`),
  later = new Date(now.getTime() + 60000);
async function fixture(t) {
  const DB = localDatabase();
  t.after(() => DB.close());
  const env = { DB },
    papers = new PaperRepository(env);
  await papers.initialize();
  const record = await registerDragonConfig(DB, defaultDragonConfig(), null, {
    origin: "MANUAL",
    validationMode: "MANUAL_UNVERIFIED",
  });
  const source = snapshot(date),
    first = source.stocks[0];
  const book = {
    ...newBook(),
    ...dragonBookFields(record),
    lastDate: date,
    tradingCycleId: "manual-exit-test",
    dragonTransition: {
      state: "ACTIVE",
      configId: record.id,
      candidate: false,
    },
    cashCents: 99485800,
    equityCents: 100003300,
    positions: [
      {
        code: first.code,
        name: first.name,
        sector: first.sector,
        markCents: 1725,
        markDate: date,
        heldDays: 1,
        lots: [
          {
            acquiredDate: date,
            quantity: 300,
            costCents: 514200,
            priceCents: 1712,
          },
        ],
        dragon: {
          id: `${date}:${first.code}`,
          startDate: date,
          p0Cents: 1714,
          r0Cents: 69,
          stopCents: 1645,
          initialQuantity: 300,
          strategicQuantity: 300,
          strategicCostCents: 514200,
          stage: 0,
          highCents: 1756,
          holdDays: 3,
          buyPoint: "broken-board-dip",
          dayAction: date,
        },
      },
    ],
  };
  source.intradayEntryContext = {
    version: "intraday-entry-v1",
    asOf: date,
    history: Object.fromEntries(
      source.stocks.map((row) => [
        row.code,
        {
          name: row.name,
          sector: row.sector,
          stockClass: "relay-leader",
          recentLimitUp: true,
          amount: 500000000,
          previousCloseCents: 1725,
          previousOpenCents: 1700,
          previousChange: 6,
          previousHeight: 3,
          previousTouchedLimit: true,
          lastFourCloseSumCents: 6500,
        },
      ]),
    ),
  };
  await DB.prepare(
    "UPDATE paper_accounts SET state=?,revision=revision+1 WHERE id='primary'",
  )
    .bind(JSON.stringify(book))
    .run();
  await DB.prepare(
    "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
  )
    .bind(date, source.createdAt, JSON.stringify(source))
    .run();
  const plan = createDragonPlan(source, book, now.toISOString(), {
    executionCostPolicy: await latestPolicyBundle(DB),
    snapshotDigest: await selectionSnapshotDigest(source),
  });
  await papers.savePlan(plan);
  return { DB, env, papers, book, source, plan, code: first.code };
}
const observation = (code, seconds, volume, bidShares = 300, price = 1725) => {
  const at = new Date(
    Date.parse(`${tradeDate}T09:30:00+08:00`) + seconds * 1000,
  ).toISOString();
  return {
    observedAt: at,
    quotes: {
      [code]: {
        date: tradeDate,
        timestamp: at,
        closeCents: price,
        previousCloseCents: 1725,
        openCents: 1725,
        highCents: 1898,
        lowCents: 1700,
        limitUpCents: 1898,
        limitDownCents: 1553,
        volumeShares: volume,
        amountCny: (volume * price) / 100,
        bid1Cents: price - 1,
        ask1Cents: price,
        bid1Shares: bidShares,
        ask1Shares: 10000,
        orderBookQuality: "OK",
        orderBookTimestamp: at,
      },
    },
  };
};

test("用户清仓独立留痕、冻结EXIT300股并保留源计划；预约本身不改份额现金", async (t) => {
  const f = await fixture(t);
  const result = await requestManualExit(f.env, {
    code: f.code,
    tradeDate,
    reason: "用户要求结束受影响持仓",
    now,
  });
  assert.equal(result.request.quantity, 300);
  assert.deepEqual((await f.papers.account()).book, f.book);
  assert.equal(
    (await requestManualExit(f.env, { code: f.code, tradeDate, now })).changed,
    false,
  );
  await assert.rejects(
    assertManualExitReferences(f.DB, f.plan, "main", f.book),
    /尚未冻结/,
  );
  const prepared = await prepareManualExitPlan(f.env, later),
    plan = await f.papers.plan(date);
  assert.equal(prepared.status, "PREPARED");
  assert.equal(plan.orders[0].action, "EXIT");
  assert.equal(plan.orders[0].quantity, 300);
  assert.equal(
    plan.selectionAudit.snapshotDigest,
    f.plan.selectionAudit.snapshotDigest,
  );
  assert.deepEqual(
    plan.entryExecutionPolicy.candidates,
    f.plan.entryExecutionPolicy.candidates,
  );
  assert.deepEqual((await f.papers.account()).book, f.book);
  assert.equal((await prepareManualExitPlan(f.env, later)).changed, false);
  await assert.rejects(
    f.DB.prepare("DELETE FROM paper_manual_exit_requests").run(),
    /不可删除/,
  );
  assert.equal(
    await exportedManualExitReferences({ manualExitRequests: [] }, plan),
    false,
  );
  assert.equal(
    await exportedManualExitReferences(
      {
        manualExitRequests: [
          { payload: result.request, digest: await digestOf(result.request) },
        ],
      },
      plan,
    ),
    true,
  );
});

test("次日保护退出不等待市场预热，首帧只立量基准，后续按盘口成交；卖完当日不买回", async (t) => {
  const f = await fixture(t);
  const request = await requestManualExit(f.env, {
    code: f.code,
    tradeDate,
    now,
  });
  await prepareManualExitPlan(f.env, later);
  const plan = await f.papers.plan(date);
  let book = f.book,
    session = openDragonSession(book, plan, tradeDate),
    rows = [];
  for (const [seconds, volume, price] of [
    [0, 1000000, 1725],
    [10, 1050000, 1725],
    [20, 1100000, 1830],
    [30, 1150000, 1830],
  ]) {
    const step = advanceDragonSession(
      book,
      session,
      observation(f.code, seconds, volume, 300, price),
    );
    if (seconds === 0) assert.equal(step.ledger.length, 0);
    rows.push(...step.ledger);
    book = step.book;
    session = step.session;
  }
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.side === "SELL"));
  assert.equal(
    rows.reduce((n, row) => n + row.quantity, 0),
    300,
  );
  assert.ok(
    rows.every((row) => row.manualExitRequestId === request.request.id),
  );
  assert.equal(book.positions.length, 0);
  assert.equal(
    book.cashCents,
    f.book.cashCents + rows.reduce((n, row) => n + row.cashDeltaCents, 0),
  );
  assert.ok(
    Object.values(session.practice.decisions).some(
      (row) => row.reasonCode === "MANUAL_EXIT",
    ),
  );
  assert.equal((await pendingManualExitRequests(f.DB, book)).length, 0);
});

test("买盘只有100股就部分清仓，余量继续处理；T+1和跌停约束不被人工指令绕过", async (t) => {
  const f = await fixture(t);
  await requestManualExit(f.env, { code: f.code, tradeDate, now });
  await prepareManualExitPlan(f.env, later);
  const plan = await f.papers.plan(date);
  let step = advanceDragonSession(
    f.book,
    openDragonSession(f.book, plan, tradeDate),
    observation(f.code, 0, 1000000),
  );
  step = advanceDragonSession(
    step.book,
    step.session,
    observation(f.code, 10, 1050000, 100),
  );
  assert.equal(step.ledger[0].quantity, 100);
  assert.equal(step.book.positions[0].lots[0].quantity, 200);
  assert.equal((await pendingManualExitRequests(f.DB, step.book)).length, 1);
  step = advanceDragonSession(
    step.book,
    step.session,
    observation(f.code, 20, 1100000),
  );
  assert.equal(step.ledger[0].quantity, 200);
  assert.equal(step.book.positions.length, 0);
  const t1Book = structuredClone(f.book);
  t1Book.positions[0].lots[0].acquiredDate = tradeDate;
  let blocked = advanceDragonSession(
    t1Book,
    openDragonSession(t1Book, plan, tradeDate),
    observation(f.code, 0, 1000000),
  );
  blocked = advanceDragonSession(
    blocked.book,
    blocked.session,
    observation(f.code, 10, 1050000),
  );
  assert.equal(blocked.ledger.length, 0);
  let locked = advanceDragonSession(
    f.book,
    openDragonSession(f.book, plan, tradeDate),
    observation(f.code, 0, 1000000, 300, 1553),
  );
  locked = advanceDragonSession(
    locked.book,
    locked.session,
    observation(f.code, 10, 1050000, 300, 1553),
  );
  assert.equal(locked.ledger.length, 0);
});

test("已开始的计划或错误清仓日期拒绝修改，未来新持仓不重复套用旧指令", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    requestManualExit(f.env, { code: f.code, tradeDate: date, now }),
    /开盘前预约/,
  );
  await requestManualExit(f.env, { code: f.code, tradeDate, now });
  const future = structuredClone(f.book);
  future.positions[0].dragon.id = `2026-10-28:${f.code}`;
  assert.equal((await pendingManualExitRequests(f.DB, future)).length, 0);
  await f.DB.prepare(
    "INSERT INTO paper_live_sessions(trade_date,payload,digest) VALUES(?,?,?)",
  )
    .bind(tradeDate, JSON.stringify({ plan: f.plan }), "synthetic")
    .run();
  await assert.rejects(prepareManualExitPlan(f.env, later), /已开始执行/);
});
