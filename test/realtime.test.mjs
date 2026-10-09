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
import { parseTencentQuotes } from "../backend/services/market.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
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
test("评分自动生成意图，系统自主处理成交及部分减仓的跨日剩余量", async () => {
  const db = localDatabase(),
    repo = new RealtimeRepository({ DB: db });
  try {
    await baseline(repo);
    let account = await repo.account();
    const intent = createPlan(
      snapshot(dateAt(0)),
      account.book,
      BASE_STRATEGY,
      "baseline-v1",
      `${dateAt(0)}T07:10:00.000Z`,
    );
    assert.ok(intent.orders.every((o) => o.action === "OPEN"));
    await repo.savePlan(intent);
    let session = openSession(account.book, intent, dateAt(1));
    for (const [time, volume] of [
      ["09:30:00", 100000],
      ["09:30:05", 3000000],
    ]) {
      const obs = observation(dateAt(1), time, 1000, volume);
      obs.quotes["600002"] = { ...obs.quotes["600001"] };
      account = await repo.account();
      const step = advanceSession(account.book, session, obs);
      assert.equal(
        await repo.commitObservation(account.revision, step, obs),
        true,
      );
      session = step.session;
    }
    account = await repo.account();
    assert.equal(account.book.positions.length, 2);
    const day = closing(dateAt(1));
    day.quotes["600002"] = { ...day.quotes["600001"] };
    const result = closeSession(account.book, session, day);
    await repo.close(account.revision, result, day);
    assert.equal(
      (await verifyExport(await exportPaper({ DB: db }))).passed,
      true,
    );
    // Keep the second holding's closing data for each multi-stock day.
    const reduceIntent = frozen([["REDUCE", 1000]], dateAt(1));
    await repo.savePlan(reduceIntent);
    account = await repo.account();
    session = openSession(account.book, reduceIntent, dateAt(2));
    let reductionFills = [];
    for (const [time, volume] of [
      ["10:00:00", 100000],
      ["10:00:05", 140000],
    ]) {
      const obs = observation(dateAt(2), time, 1000, volume);
      account = await repo.account();
      const step = advanceSession(account.book, session, obs);
      await repo.commitObservation(account.revision, step, obs);
      session = step.session;
      reductionFills.push(...step.ledger);
    }
    account = await repo.account();
    const reduceDay = closing(dateAt(2));
    reduceDay.quotes["600002"] = { ...reduceDay.quotes["600001"] };
    const reduced = closeSession(account.book, session, reduceDay);
    await repo.close(account.revision, reduced, reduceDay);
    assert.equal(reductionFills[0].quantity, 400);
    assert.equal(reduced.book.pendingOrders[0].quantity, 600);
    const hold = frozen([["HOLD", 0]], dateAt(2));
    await repo.savePlan(hold);
    account = await repo.account();
    session = openSession(account.book, hold, dateAt(3));
    let remaining = [];
    for (const [time, volume] of [
      ["10:00:00", 100000],
      ["10:00:05", 200000],
    ]) {
      const obs = observation(dateAt(3), time, 1000, volume);
      account = await repo.account();
      const step = advanceSession(account.book, session, obs);
      await repo.commitObservation(account.revision, step, obs);
      session = step.session;
      remaining.push(...step.ledger);
    }
    account = await repo.account();
    const lastDay = closing(dateAt(3));
    lastDay.quotes["600002"] = { ...lastDay.quotes["600001"] };
    const completed = closeSession(account.book, session, lastDay);
    await repo.close(account.revision, completed, lastDay);
    assert.equal(remaining[0].quantity, 600);
    assert.equal(completed.book.pendingOrders.length, 0);
    assert.equal(
      (await verifyExport(await exportPaper({ DB: db }))).passed,
      true,
    );
  } finally {
    db.close();
  }
});
test("尾盘恢复做 T 第二腿允许亏损成交，不留下假完成的新增敞口", async () => {
  const db = localDatabase(),
    repo = new RealtimeRepository({ DB: db });
  try {
    await baseline(repo);
    await cycle(repo, [["OPEN", 1000]], 1, [
      ["09:30:00", 1000, 100000],
      ["09:30:05", 1000, 200000],
    ]);
    const result = await cycle(
      repo,
      [["T_FORWARD", 200]],
      2,
      [
        ["09:40:00", 980, 100000],
        ["09:40:05", 980, 200000],
        ["14:50:00", 970, 400000],
        ["14:50:05", 970, 500000],
      ],
      970,
    );
    assert.equal(qty(result.result.book), 1000);
    assert.deepEqual(
      result.fills.map((f) => f.side),
      ["BUY", "SELL"],
    );
    assert.ok(result.fills[1].realizedPnlCents < 0);
    assert.equal(result.result.book.pendingRecovery.length, 0);
  } finally {
    db.close();
  }
});
test("常驻循环无需网页触发就执行盘后任务，并写入心跳", async () => {
  const db = localDatabase(),
    env = { DB: db };
  let calls = 0,
    runner;
  try {
    runner = startTradingRunner(
      env,
      async () => {
        calls++;
        return {
          paper: { status: "SETTLED", nextPlan: {} },
          snapshot: { saved: true },
        };
      },
      { now: () => new Date("2026-01-02T08:00:00.000Z") },
    );
    await runner.ready;
    assert.equal(calls, 1);
    assert.equal((await new RealtimeRepository(env).health()).automatic, true);
  } finally {
    runner?.stop();
    db.close();
  }
});
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
test("完整轮次一：建仓部分成交与重启续单 → 加仓 → 减仓 → 清仓，逐日独立重放", async () => {
  const db = localDatabase(),
    repo = new RealtimeRepository({ DB: db });
  try {
    await baseline(repo);
    const opened = await cycle(repo, [["OPEN", 1000]], 1, [
      ["09:30:00", 1000, 100000],
      ["09:30:05", 1000, 130000],
      ["09:30:10", 1000, 160000],
      ["09:30:15", 1000, 200000],
    ]);
    assert.deepEqual(
      opened.fills.map((f) => f.quantity),
      [300, 300, 400],
    );
    assert.equal(qty(opened.result.book), 1000);
    assert.equal(
      opened.result.session.orders.find((o) => o.action === "OPEN").status,
      "FILLED",
    );
    const added = await cycle(repo, [["ADD", 500]], 2, [
      ["09:30:00", 1000, 100000],
      ["09:30:05", 1000, 200000],
    ]);
    assert.equal(qty(added.result.book), 1500);
    const reduced = await cycle(repo, [["REDUCE", 700]], 3, [
      ["10:00:00", 1000, 100000],
      ["10:00:05", 1000, 200000],
    ]);
    assert.equal(qty(reduced.result.book), 800);
    const exited = await cycle(repo, [["EXIT", 800]], 4, [
      ["14:00:00", 1000, 100000],
      ["14:00:05", 1000, 200000],
    ]);
    assert.equal(qty(exited.result.book), 0);
    assert.equal(exited.bundle.ledger.length, 6);
    assert.equal(
      exited.result.book.equityCents - exited.result.book.initialCashCents,
      exited.result.book.realizedPnlCents,
    );
    for (const f of exited.bundle.ledger)
      assert.deepEqual(
        f.feeBreakdown,
        transactionFees(f.notionalCents, f.side, f.feeConfig),
      );
  } finally {
    db.close();
  }
});
test("完整轮次二：底仓 → 正向 T → 反向 T → 清仓，两腿按观测先后并可重放", async () => {
  const db = localDatabase(),
    repo = new RealtimeRepository({ DB: db });
  try {
    await baseline(repo);
    await cycle(repo, [["OPEN", 1000]], 1, [
      ["09:30:00", 1000, 100000],
      ["09:30:05", 1000, 200000],
    ]);
    const forward = await cycle(repo, [["T_FORWARD", 200]], 2, [
      ["09:40:00", 980, 100000],
      ["09:40:05", 980, 200000],
      ["09:40:10", 1020, 300000],
    ]);
    assert.deepEqual(
      forward.fills.map((f) => f.side),
      ["BUY", "SELL"],
    );
    assert.equal(qty(forward.result.book), 1000);
    const reverse = await cycle(repo, [["T_REVERSE", 200]], 3, [
      ["09:40:00", 1020, 100000],
      ["09:40:05", 1020, 200000],
      ["09:40:10", 980, 300000],
    ]);
    assert.deepEqual(
      reverse.fills.map((f) => f.side),
      ["SELL", "BUY"],
    );
    assert.equal(qty(reverse.result.book), 1000);
    const exit = await cycle(repo, [["EXIT", 1000]], 4, [
      ["09:30:00", 1000, 100000],
      ["09:30:05", 1000, 200000],
    ]);
    assert.equal(qty(exit.result.book), 0);
    assert.ok(exit.result.book.realizedPnlCents > 0);
  } finally {
    db.close();
  }
});
test("完整轮次三：当日新仓止损受 T+1 阻塞 → 次日跌停重试 → 解锁后清仓", async () => {
  const db = localDatabase(),
    repo = new RealtimeRepository({ DB: db });
  try {
    await baseline(repo);
    const day1 = await cycle(
      repo,
      [["OPEN", 1000]],
      1,
      [
        ["09:30:00", 1000, 100000],
        ["09:30:05", 1000, 200000],
        ["09:30:10", 930, 300000],
      ],
      930,
    );
    assert.equal(day1.fills.length, 1);
    assert.equal(qty(day1.result.book), 1000);
    assert.equal(day1.result.book.pendingExits.length, 1);
    const day2 = await cycle(
      repo,
      [["HOLD", 0]],
      2,
      [
        ["09:30:00", 837, 100000],
        ["09:30:05", 837, 200000],
        ["09:30:10", 850, 300000],
      ],
      850,
    );
    assert.equal(day2.fills.length, 1);
    assert.equal(qty(day2.result.book), 0);
    assert.equal(day2.result.book.pendingExits.length, 0);
  } finally {
    db.close();
  }
});
test("完整轮次四：反向 T 第二腿涨停阻塞 → 如实结算减仓 → 次日自动恢复底仓 → 清仓", async () => {
  const db = localDatabase(),
    repo = new RealtimeRepository({ DB: db });
  try {
    await baseline(repo);
    await cycle(repo, [["OPEN", 1000]], 1, [
      ["09:30:00", 1000, 100000],
      ["09:30:05", 1000, 200000],
    ]);
    const blocked = await cycle(
      repo,
      [["T_REVERSE", 200]],
      2,
      [
        ["09:40:00", 1020, 100000],
        ["09:40:05", 1020, 200000],
        ["14:50:00", 1100, 400000],
        ["14:50:05", 1100, 500000],
      ],
      1100,
    );
    assert.equal(qty(blocked.result.book), 800);
    assert.equal(blocked.result.book.pendingRecovery[0].quantity, 200);
    const continuation = createPlan(
      snapshot(dateAt(2), [1100, 1000]),
      blocked.result.book,
      BASE_STRATEGY,
      "baseline-v1",
      `${dateAt(2)}T07:10:00.000Z`,
    );
    assert.equal(
      continuation.orders.find((o) => o.code === "600001").recovery,
      true,
    );
    assert.equal(
      continuation.orders.find((o) => o.code === "600001").quantity,
      200,
    );
    const riskBook = structuredClone(blocked.result.book);
    riskBook.positions[0].heldDays = 6;
    const riskPlan = createPlan(
      snapshot(dateAt(2), [1100, 1000]),
      riskBook,
      BASE_STRATEGY,
      "baseline-v1",
      `${dateAt(2)}T07:10:00.000Z`,
    );
    assert.equal(
      riskPlan.orders.find((o) => o.code === "600001").action,
      "EXIT",
    );
    assert.equal(
      openSession(riskBook, riskPlan, dateAt(3)).orders.some(
        (o) => o.code === "600001" && o.recovery,
      ),
      false,
    );
    const recovered = await cycle(
      repo,
      [["HOLD", 0]],
      3,
      [
        ["09:30:00", 1100, 100000],
        ["09:30:05", 1100, 200000],
      ],
      1100,
    );
    assert.equal(qty(recovered.result.book), 1000);
    assert.equal(recovered.result.book.pendingRecovery.length, 0);
    assert.equal(recovered.fills[0].action, "ADD");
    const exited = await cycle(
      repo,
      [["EXIT", 1000]],
      4,
      [
        ["09:30:00", 1100, 100000],
        ["09:30:05", 1100, 200000],
      ],
      1100,
    );
    assert.equal(qty(exited.result.book), 0);
  } finally {
    db.close();
  }
});
test("重复/陈旧报价不成交，断线累计量不当作新流动性，开盘窗口到期不追买", () => {
  let book = newBook();
  book.lastDate = dateAt(0);
  let session = openSession(
    book,
    frozen([["OPEN", 1000]], dateAt(0)),
    dateAt(1),
  );
  let result = advanceSession(
    book,
    session,
    observation(dateAt(1), "09:30:00"),
  );
  book = result.book;
  session = result.session;
  result = advanceSession(
    book,
    session,
    observation(dateAt(1), "09:30:05", 1000, 200000),
  );
  book = result.book;
  session = result.session;
  assert.equal(result.ledger.length, 1);
  result = advanceSession(
    book,
    session,
    observation(dateAt(1), "09:30:05", 1000, 300000),
  );
  assert.equal(result.ledger.length, 0);
  const stale = observation(dateAt(1), "09:30:10", 1000, 300000);
  stale.observedAt = new Date(`${dateAt(1)}T09:31:00+08:00`).toISOString();
  result = advanceSession(book, session, stale);
  assert.equal(result.ledger.length, 0);
  const newBookState = newBook();
  newBookState.lastDate = dateAt(0);
  session = openSession(
    newBookState,
    frozen([["OPEN", 1000]], dateAt(0)),
    dateAt(1),
  );
  result = advanceSession(
    newBookState,
    session,
    observation(dateAt(1), "09:30:00"),
  );
  result = advanceSession(
    result.book,
    result.session,
    observation(dateAt(1), "09:31:00", 1000, 10000000),
  );
  assert.equal(result.ledger.length, 0);
  result = advanceSession(
    result.book,
    result.session,
    observation(dateAt(1), "09:36:00", 1000, 20000000),
  );
  assert.equal(result.ledger.length, 0);
  assert.equal(result.session.orders[0].status, "EXPIRED");
});
test("实时 CAS 防止两个执行器重复成交；活动账本可重放，篡改报价被检测", async () => {
  const db = localDatabase(),
    repo = new RealtimeRepository({ DB: db });
  try {
    await baseline(repo);
    const intent = frozen([["OPEN", 1000]], dateAt(0));
    await repo.savePlan(intent);
    let account = await repo.account();
    let session = openSession(account.book, intent, dateAt(1));
    const first = observation(dateAt(1), "09:30:00");
    let result = advanceSession(account.book, session, first);
    await repo.commitObservation(account.revision, result, first);
    account = await repo.account();
    session = await repo.session(dateAt(1));
    const obs = observation(dateAt(1), "09:30:05", 1000, 200000);
    result = advanceSession(account.book, session, obs);
    assert.deepEqual(
      await Promise.all([
        repo.commitObservation(account.revision, result, obs),
        repo.commitObservation(account.revision, result, obs),
      ]),
      [true, false],
    );
    const bundle = await exportPaper({ DB: db });
    assert.equal(bundle.ledger.length, 1);
    assert.equal((await verifyExport(bundle)).passed, true);
    bundle.realtimeObservations[0].observations[1].payload.quotes[
      "600001"
    ].closeCents = 1001;
    assert.equal((await verifyExport(bundle)).passed, false);
  } finally {
    db.close();
  }
});
test("腾讯 HTTP 字段解析检查日期、GBK 字段、手数换算和时区；轮询服务自动执行而非客户端提交成交", async () => {
  const fields = Array(60).fill("");
  Object.assign(fields, {
    1: "合成样本",
    3: "10.00",
    4: "10.00",
    5: "10.00",
    6: "1000",
    30: "20260102093000",
    33: "10.01",
    34: "9.99",
    47: "11",
    48: "9",
  });
  const text = `v_sh600001="${fields.join("~")}";`;
  const quotes = parseTencentQuotes(text, dateAt(1));
  assert.equal(quotes["600001"].volumeShares, 100000);
  assert.equal(quotes["600001"].timestamp, `${dateAt(1)}T09:30:00+08:00`);
  assert.deepEqual(parseTencentQuotes(text, dateAt(0)), {});
  const db = localDatabase(),
    env = { DB: db, TRADING_RUNNER: "server" },
    repo = new RealtimeRepository(env);
  try {
    await baseline(repo);
    await repo.savePlan(frozen([["OPEN", 1000]], dateAt(0)));
    const calendar = async () => ({ dates: [dateAt(0), dateAt(1)] });
    let result = await pollTrading(
      env,
      new Date(`${dateAt(1)}T09:30:00+08:00`),
      { calendar, quotes: async () => quotes },
    );
    assert.equal(result.fills, 0);
    result = await pollTrading(env, new Date(`${dateAt(1)}T09:30:05+08:00`), {
      calendar,
      quotes: async () =>
        observation(dateAt(1), "09:30:05", 1000, 200000).quotes,
    });
    assert.equal(result.fills, 1);
    assert.equal(qty((await repo.account()).book), 1000);
    assert.equal((await repo.health()).automatic, true);
  } finally {
    db.close();
  }
});
