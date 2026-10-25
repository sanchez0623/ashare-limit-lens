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
test("常驻循环保留独立轮询的失败结果：BLOCKED 必须写入运维事件", async () => {
  const db = localDatabase(),
    env = { DB: db };
  let runner;
  try {
    runner = startTradingRunner(env, async () => null, {
      // 周五 09:35 北京时间，处于连续竞价时段，走独立轮询分支。
      now: () => new Date("2026-01-02T01:35:00.000Z"),
      providers: {
        calendar: async () => ({ dates: ["2026-01-02"], benchmark: [] }),
        quotes: async () => ({}),
      },
    });
    await runner.ready;
    // 上一交易日未结算 → BLOCKED；旧实现把它丢成 SKIPPED，规则器收不到事实。
    const rows = await db
      .prepare(
        "SELECT type, rule_type, reason_code FROM operation_events ORDER BY ingest_seq",
      )
      .all();
    assert.equal(rows.results.length, 1);
    assert.equal(rows.results[0].rule_type, "SESSION_BLOCKED");
    assert.equal(rows.results[0].reason_code, "MISSING_SETTLEMENT");
  } finally {
    runner?.stop();
    db.close();
  }
});
test("除权不匹配：引擎拒收报价并留下结构化标记，报价恢复后清除", async () => {
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
      await repo.commitObservation(account.revision, step, obs);
      session = step.session;
    }
    account = await repo.account();
    const day = closing(dateAt(1));
    day.quotes["600002"] = { ...day.quotes["600001"] };
    const settled = closeSession(account.book, session, day);
    await repo.close(account.revision, settled, day);
    // 第二日已有持仓：昨收与冻结参考价严重不一致 → 疑似除权，报价被拒收。
    account = await repo.account();
    const hold = frozen([["HOLD", 0]], dateAt(1));
    await repo.savePlan(hold);
    session = openSession(account.book, hold, dateAt(2));
    const previous = account.book.positions[0].markCents;
    const mismatched = observation(
      dateAt(2),
      "10:00:00",
      previous,
      100000,
      previous,
      { previousCloseCents: Math.round(previous * 1.5) },
    );
    const rejected = advanceSession(account.book, session, mismatched);
    const flagged = rejected.session.orders.filter(
      (order) => order.holdCode === "CORPORATE_ACTION_UNVERIFIED",
    );
    assert.ok(
      flagged.length >= 1,
      "拒收报价必须留下结构化标记，否则系统仍报 RUNNING 且没有告警",
    );
    assert.ok(flagged.every((order) => order.reason.includes("除权")));
    // 报价恢复一致：标记清除，不会永久挂着误报。
    const restored = observation(
      dateAt(2),
      "10:00:10",
      previous,
      200000,
      previous,
    );
    const accepted = advanceSession(rejected.book, rejected.session, restored);
    assert.deepEqual(
      accepted.session.orders.filter((order) => order.holdCode),
      [],
      "报价恢复后不再持有除权标记",
    );
  } finally {
    db.close();
  }
});
test("事件写入与账户提交同事务：写入失败提交回滚，下轮重放补齐风险事实", async () => {
  const db = localDatabase(),
    env = { DB: db, TRADING_POLL_SECONDS: "3" };
  // 预置：前一日已结算并冻结计划，本日轮询才能走到账户提交路径。
  const repo = new RealtimeRepository(env);
  await baseline(repo);
  await repo.savePlan(frozen([["HOLD", 0]], dateAt(0)));
  const realPrepare = db.prepare.bind(db);
  let failEventWrite = true;
  // 让事务里的第一条事件写入失败：事件与账户状态在同一个 batch 里，
  // 必须整体回滚——退出钩子覆盖不了 SIGKILL/断电，只有同事务写入才能
  // 保证"已提交的账户风险"必然有对应事件。
  db.prepare = (sql) => {
    if (
      failEventWrite &&
      sql.includes("INSERT OR IGNORE INTO operation_events")
    ) {
      failEventWrite = false;
      return {
        bind: () => ({
          run: async () => {
            throw new Error("disk unavailable");
          },
          _run: () => {
            throw new Error("disk unavailable");
          },
        }),
      };
    }
    return realPrepare(sql);
  };
  let runner,
    calls = 0;
  try {
    runner = startTradingRunner(env, async () => null, {
      // 每次取时刻都前进 20 秒：让循环按最短间隔调度，测试不必等轮询周期。
      now: () =>
        new Date(Date.parse("2026-01-02T01:35:00.000Z") + ++calls * 20000),
      providers: {
        calendar: async () => ({
          dates: [dateAt(0), "2026-01-02"],
          benchmark: [],
        }),
        quotes: async () =>
          observation("2026-01-02", "09:30:00", 1000, 100000).quotes,
      },
    });
    await runner.ready;
    const sessions = await db
      .prepare("SELECT COUNT(*) AS n FROM paper_live_sessions")
      .first();
    assert.equal(
      Number(sessions.n),
      0,
      "事件写入失败时账户提交一并回滚，不留无事件的风险敞口",
    );
    // 提交失败轮次由 runner 以 ERROR 事实入账（缓冲补写），失败不静默。
    const first = await db
      .prepare(
        "SELECT type, rule_type FROM operation_events ORDER BY ingest_seq",
      )
      .all();
    assert.ok(
      first.results.some((row) => row.rule_type === "LOOP_FAILED"),
      `提交失败轮次必须以 RUNNER_FAILED 事实入账：${JSON.stringify(first.results)}`,
    );
    // 下一轮：账户提交成功，运行事实随同一事务落库。
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const second = await db
      .prepare(
        "SELECT type, rule_type FROM operation_events ORDER BY ingest_seq",
      )
      .all();
    assert.ok(
      second.results.length >= 2,
      `下轮提交成功后事实齐备，实际 ${JSON.stringify(second.results)}`,
    );
    const settled = await db
      .prepare("SELECT COUNT(*) AS n FROM paper_live_sessions")
      .first();
    assert.equal(Number(settled.n), 1, "下轮账户提交成功");
  } finally {
    runner?.stop();
    db.close();
  }
});
test("风险事实随账户提交同事务落库：已提交账户的回撤与保护退出阻塞必然有事件", async () => {
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
    await repo.savePlan(intent);
    let session = openSession(account.book, intent, dateAt(1));
    account = await repo.account();
    const obs = observation(dateAt(1), "09:30:00", 800, 100000, 1000, {
      // 前收一致（不触发除权拒收），但价格跌破止损 → 保护退出触发且
      // 跌停无法成交 → 保护退出阻塞；净值回撤超限。
      limitDownCents: 700,
    });
    const step = advanceSession(account.book, session, obs);
    const summary = {
      status: "RUNNING",
      drawdown: 0.2,
      drawdownBreached: true,
      blockedProtectiveExits: ["600001"],
      incompleteRecoveries: [],
      corporateActionHolds: [],
    };
    const events = buildOperationEvents(
      {
        source: "loop",
        result: summary,
        now: obs.observedAt,
        tradeDate: dateAt(1),
        sourceSequence: step.session.sequence,
      },
      "test-instance",
    );
    assert.ok(
      events.some((event) => event.ruleType === "DRAWDOWN_TRIPPED") &&
        events.some((event) => event.ruleType === "PROTECTIVE_EXIT_BLOCKED"),
      "风险事实已分类",
    );
    assert.equal(
      await repo.commitObservation(account.revision, step, obs, events),
      true,
    );
    const rows = await db
      .prepare(
        "SELECT rule_type, payload FROM operation_events WHERE rule_type IN ('DRAWDOWN_TRIPPED','PROTECTIVE_EXIT_BLOCKED')",
      )
      .all();
    const rules = rows.results.map((row) => row.rule_type).sort();
    assert.deepEqual(
      rules,
      ["DRAWDOWN_TRIPPED", "PROTECTIVE_EXIT_BLOCKED"],
      "账户提交成功时风险事件必然已在同一事务落库",
    );
  } finally {
    db.close();
  }
});
test("输家 CAS 批次不泄漏事件：账户提交失败时风险事件全部不落库", async () => {
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
    await repo.savePlan(intent);
    const session = openSession(account.book, intent, dateAt(1));
    const staleRevision = account.revision;
    // 两个重叠执行器读到同一 revision、各自产出事件；observedAt 不同
    // （独立轮询路径）→ 事件 ID 不同，INSERT OR IGNORE 无法兜底去重。
    const obsWinner = observation(dateAt(1), "09:30:00", 1000, 100000);
    const stepWinner = advanceSession(account.book, session, obsWinner);
    const eventsWinner = buildOperationEvents(
      {
        source: "loop",
        result: { status: "RUNNING", drawdown: 0.2, drawdownBreached: true },
        now: obsWinner.observedAt,
        tradeDate: dateAt(1),
        sourceSequence: stepWinner.session.sequence,
      },
      "test-instance",
    );
    assert.ok(eventsWinner.length >= 1, "赢家批次带事件");
    assert.equal(
      await repo.commitObservation(
        staleRevision,
        stepWinner,
        obsWinner,
        eventsWinner,
      ),
      true,
      "赢家先提交成功",
    );
    const obsLoser = observation(dateAt(1), "09:30:10", 990, 100000);
    const stepLoser = advanceSession(account.book, session, obsLoser);
    const eventsLoser = buildOperationEvents(
      {
        source: "loop",
        result: { status: "RUNNING", drawdown: 0.25, drawdownBreached: true },
        now: obsLoser.observedAt,
        tradeDate: dateAt(1),
        sourceSequence: stepLoser.session.sequence,
      },
      "test-instance",
    );
    assert.ok(
      eventsLoser.every(
        (event) => !eventsWinner.some((row) => row.id === event.id),
      ),
      "输家事件 ID 与赢家不同（observedAt 不同）",
    );
    // 输家：基于同一 revision 提交，账户 UPDATE 必输（changes=0）。
    // 修复前它携带的事件已随 batch 落库——这些是"从未成为权威状态"的
    // 风险事实，会制造幻影 incident 与重复通知。
    assert.equal(
      await repo.commitObservation(
        staleRevision,
        stepLoser,
        obsLoser,
        eventsLoser,
      ),
      false,
      "输家的账户提交失败",
    );
    const leaked = [];
    for (const event of eventsLoser) {
      const row = await db
        .prepare("SELECT id FROM operation_events WHERE id = ?")
        .bind(event.id)
        .first();
      if (row) leaked.push(event.id);
    }
    assert.deepEqual(
      leaked,
      [],
      "输家批次的事件不得落库：提交失败与事件写入同生共死",
    );
    // 赢家的事件原样保留。
    for (const event of eventsWinner) {
      const row = await db
        .prepare("SELECT id FROM operation_events WHERE id = ?")
        .bind(event.id)
        .first();
      assert.ok(row, `赢家事件 ${event.ruleType} 已落库`);
    }
  } finally {
    db.close();
  }
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
test("盘中实时盯市：未结算交易日的当日盈亏按账本现值实时计算，结算后回落已结算口径", async () => {
  const db = localDatabase(),
    env = { DB: db },
    repo = new RealtimeRepository(env);
  try {
    await baseline(repo);
    const settled = (await exportPaper(env)).equities.at(-1);
    assert.equal(settled.date, dateAt(0));
    assert.equal(settled.dailyPnlCents, 0);
    const intent = frozen([["OPEN", 1000]], dateAt(0));
    await repo.savePlan(intent);
    let account = await repo.account();
    let session = openSession(account.book, intent, dateAt(1));
    for (const [time, price, volume] of [
      ["09:30:00", 1000, 100000],
      ["09:30:05", 1000, 200000],
      ["09:40:00", 1100, 300000],
    ]) {
      const obs = observation(dateAt(1), time, price, volume);
      account = await repo.account();
      const step = advanceSession(account.book, session, obs);
      assert.equal(
        await repo.commitObservation(account.revision, step, obs),
        true,
      );
      session = step.session;
    }
    // 盘中：账本已被 1100 报价盯市但当日未结算，当日盈亏必须是实时值，
    // 而不是停留在上一结算日的数字。
    const intraday = await paperOverview(env);
    assert.equal(intraday.equity.date, dateAt(1));
    assert.equal(intraday.equity.source, "盘中实时盯市");
    assert.equal(intraday.equity.complete, false);
    assert.equal(intraday.lastSettled.date, dateAt(0));
    assert.equal(intraday.lastSettled.dailyPnlCents, settled.dailyPnlCents);
    assert.equal(
      intraday.equity.dailyPnlCents,
      intraday.book.equityCents - settled.equityCents,
    );
    assert.equal(
      intraday.equity.dailyReturn,
      intraday.equity.dailyPnlCents / settled.equityCents,
    );
    assert.ok(
      intraday.equity.dailyPnlCents > 0,
      "1100 盯市价相对建仓成本应产生正收益",
    );
    // 结算后：overview 回落到已结算记录，不再合成实时快照。
    account = await repo.account();
    const day = closing(dateAt(1), 1000, 1100);
    const result = closeSession(account.book, session, day);
    assert.equal(await repo.close(account.revision, result, day), true);
    const final = await paperOverview(env);
    assert.equal(final.equity.date, dateAt(1));
    assert.equal(final.equity.source, "腾讯实时模拟成交与收盘盯市");
    assert.equal(final.equity.dailyPnlCents, result.equity.dailyPnlCents);
    assert.equal(final.lastSettled.date, dateAt(1));
    assert.equal(final.lastSettled.dailyPnlCents, result.equity.dailyPnlCents);
    assert.equal((await verifyExport(await exportPaper(env))).passed, true);
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
