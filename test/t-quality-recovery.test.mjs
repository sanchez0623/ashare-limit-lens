import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository, digest } from "../backend/storage/paper.js";
import { ShadowAccountRepository } from "../backend/storage/shadow.js";
import { preserveProgramSignal } from "../backend/storage/strategy-signals.js";
import {
  assertStoredProgramPlan,
  ensureFrozenTQuality,
} from "../backend/services/strategy-program-evidence.js";
import { freezePortfolioPlan } from "../backend/services/portfolio-runner.js";
import { buildTTradeRecords, runPaperDay } from "../backend/services/paper.js";
import {
  BASE_STRATEGY,
  createPlan,
  executePlan,
  newBook,
} from "../backend/domain/trading.js";
import {
  advanceSession,
  closeSession,
  openSession,
} from "../backend/domain/realtime.js";
import {
  buildTQualityEvidence,
  extractTTrades,
  summarizeTQuality,
} from "../backend/domain/t-quality.js";
import { selectionSnapshotDigest } from "../backend/domain/signal-selection.js";
import { dataset, dateAt, order, plan, snapshot } from "./fixtures/trading.mjs";

function source(date = dateAt(0)) {
  return {
    ...snapshot(date),
    downgradeRulesVersion: 1,
    tQualityRulesVersion: 1,
    market: { brokenRows: [] },
    stocks: [],
  };
}
function heldBook() {
  const book = newBook(100000);
  book.lastDate = dateAt(0);
  book.cashCents -= 1000000;
  book.positions = [
    {
      code: "600001",
      name: "合成样本",
      sector: "测试行业",
      lastScore: 75,
      heldDays: 1,
      markCents: 1000,
      lots: [
        {
          acquiredDate: dateAt(-1),
          quantity: 1000,
          costCents: 1000000,
          priceCents: 1000,
        },
      ],
    },
  ];
  return book;
}
function fill(
  date,
  sequence,
  side,
  quantity,
  priceCents,
  recovery = false,
  reverse = false,
) {
  return {
    id: `${date}:${sequence}`,
    date,
    sequence,
    code: "600001",
    side,
    quantity,
    priceCents,
    action: recovery
      ? side === "SELL"
        ? "REDUCE"
        : "ADD"
      : reverse
        ? "T_REVERSE"
        : "T_FORWARD",
    cashDeltaCents: (side === "SELL" ? 1 : -1) * priceCents * quantity - 501,
    ...(recovery ? { orderId: `${date}:600001:recovery` } : {}),
  };
}
function losses() {
  return [-2, -1].flatMap((index) => [
    fill(dateAt(index), 0, "BUY", 200, 1000),
    fill(dateAt(index), 1, "SELL", 200, 990),
  ]);
}
async function appendLedger(DB, fills, accountId = null) {
  for (const row of fills)
    await DB.prepare(
      accountId
        ? "INSERT INTO shadow_ledger(account_id,id,trade_date,payload) VALUES(?,?,?,?)"
        : "INSERT INTO paper_ledger(id,trade_date,payload) VALUES(?,?,?)",
    )
      .bind(
        ...(accountId ? [accountId] : []),
        row.id,
        row.date,
        JSON.stringify(row),
      )
      .run();
}
async function freezeInput(snap, book, fills = [], dates = []) {
  const records = extractTTrades(fills).records;
  return createPlan(snap, book, BASE_STRATEGY, "baseline-v1", snap.createdAt, {
    snapshotDigest: await selectionSnapshotDigest(snap),
    tQuality: summarizeTQuality(records, {
      signalDate: snap.date,
      tradingDates: dates,
    }),
    tQualityEvidence: buildTQualityEvidence(records, dates),
  });
}
async function archive(DB, snap) {
  await DB.prepare(
    "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
  )
    .bind(snap.date, snap.createdAt, JSON.stringify(snap))
    .run();
}
// 复刻升级前已保存计划、尚无独立副本的库，避免调用新版保存入口。
async function legacyPlan(DB, value, accountId = null) {
  await preserveProgramSignal(DB, value);
  await DB.prepare(
    accountId
      ? "INSERT INTO shadow_plans(account_id,signal_date,created_at,payload,digest) VALUES(?,?,?,?,?)"
      : "INSERT INTO paper_plans(signal_date,created_at,payload,digest) VALUES(?,?,?,?)",
  )
    .bind(
      ...(accountId ? [accountId] : []),
      value.signalDate,
      value.createdAt,
      JSON.stringify(value),
      await digest(value),
    )
    .run();
}
function calendarStub(t, dates) {
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("fqkline/get"))
      return new Response("synthetic missing quote", { status: 404 });
    const [code, , from, to] = url.searchParams.get("param").split(",");
    return Response.json({
      data: {
        [code]: {
          day: dates
            .filter((date) => date >= from && date <= to)
            .map((date) => [date, "10", "10", "11", "9", "100000"]),
        },
      },
    });
  });
}
async function counts(DB) {
  return {
    main: (await DB.prepare("SELECT COUNT(*) AS n FROM paper_plans").first()).n,
    shadow: (await DB.prepare("SELECT COUNT(*) AS n FROM shadow_plans").first())
      .n,
    anchor: (
      await DB.prepare("SELECT COUNT(*) AS n FROM frozen_t_quality").first()
    ).n,
  };
}

for (const shadow of [false, true]) {
  test(`${shadow ? "影子" : "主"}计划与质量副本原子冻结：第二条写入失败整体回滚，重试成功`, async () => {
    const DB = localDatabase();
    try {
      const repo = new PaperRepository({ DB }),
        shadows = new ShadowAccountRepository({ DB });
      await repo.initialize();
      const snap = source();
      await archive(DB, snap);
      const frozen = await freezeInput(snap, heldBook());
      const save = () =>
        shadow ? shadows.savePlan("candidate", frozen) : repo.savePlan(frozen);
      DB.exec(
        "CREATE TRIGGER fail_quality BEFORE INSERT ON frozen_t_quality BEGIN SELECT RAISE(ABORT,'synthetic interrupted anchor'); END",
      );
      await assert.rejects(save, /synthetic interrupted anchor/);
      assert.deepEqual(await counts(DB), { main: 0, shadow: 0, anchor: 0 });
      DB.exec("DROP TRIGGER fail_quality");
      await save();
      await assertStoredProgramPlan({ DB }, frozen, heldBook(), {
        tQualityScope: shadow ? "shadow:candidate" : "main",
      });
      assert.equal((await counts(DB)).anchor, 1);
    } finally {
      DB.close();
    }
  });
}

test("主账户盘后中断重试：账户已结算但计划写入失败，重入后补齐可执行计划", async (t) => {
  const DB = localDatabase();
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-01-01T07:10:00Z"),
  });
  calendarStub(t, [dateAt(-1), dateAt(0)]);
  try {
    const env = {
      DB,
      ALERTS_ENABLED: "false",
      QUAN_DATA_DIR: "/tmp/t-quality-synthetic-no-data",
    };
    const repo = new PaperRepository(env),
      snap = source();
    await repo.initialize();
    await archive(DB, snap);
    DB.exec(
      "CREATE TRIGGER fail_quality BEFORE INSERT ON frozen_t_quality BEGIN SELECT RAISE(ABORT,'synthetic interrupted anchor'); END",
    );
    const first = await runPaperDay(env, snap.date);
    assert.equal(first.status, "ERROR", JSON.stringify(first));
    assert.equal((await repo.account()).book.lastDate, snap.date);
    assert.equal(await repo.plan(snap.date), null);
    assert.equal((await counts(DB)).anchor, 0);
    DB.exec("DROP TRIGGER fail_quality");
    const retry = await runPaperDay(env, snap.date);
    assert.equal(retry.status, "SETTLED", JSON.stringify(retry));
    const frozen = await repo.plan(snap.date);
    await assertStoredProgramPlan(env, frozen, (await repo.account()).book);
    const again = await runPaperDay(env, snap.date);
    assert.equal(again.status, "SETTLED");
    assert.deepEqual(await counts(DB), { main: 1, shadow: 0, anchor: 1 });
  } finally {
    DB.close();
  }
});

test("主账户升级：已冻结旧计划在盘后重入时恢复质量副本", async (t) => {
  const DB = localDatabase();
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-01-01T07:10:00Z"),
  });
  calendarStub(t, [dateAt(-1), dateAt(0)]);
  try {
    const env = {
      DB,
      ALERTS_ENABLED: "false",
      QUAN_DATA_DIR: "/tmp/t-quality-synthetic-no-data",
    };
    const repo = new PaperRepository(env),
      snap = source();
    let account = await repo.initialize();
    await archive(DB, snap);
    const day = dataset(snap.date);
    await repo.settle(
      account.revision,
      executePlan(account.book, null, day),
      day,
    );
    account = await repo.account();
    const frozen = await freezeInput(snap, account.book);
    await legacyPlan(DB, frozen);
    assert.equal((await counts(DB)).anchor, 0);
    const response = await runPaperDay(env, snap.date);
    assert.equal(response.status, "SETTLED", JSON.stringify(response));
    assert.deepEqual(await repo.plan(snap.date), frozen, "恢复不改写旧计划");
    await assertStoredProgramPlan(env, frozen, account.book);
    assert.equal((await counts(DB)).anchor, 1);
  } finally {
    DB.close();
  }
});

test("影子升级与直接执行恢复：按账户和信号日回查，排除未来成交并保留日历缺失时的停手", async (t) => {
  const DB = localDatabase();
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("synthetic unavailable calendar");
  });
  try {
    const env = { DB },
      repo = new PaperRepository(env),
      shadows = new ShadowAccountRepository(env);
    await repo.initialize();
    const snap = source(),
      book = heldBook(),
      fills = losses();
    await archive(DB, snap);
    await shadows.ensureAccount("candidate", { kind: "CANDIDATE", book });
    await appendLedger(DB, fills, "candidate");
    const frozen = await freezeInput(snap, book, fills);
    await legacyPlan(DB, frozen, "candidate");
    await appendLedger(
      DB,
      [
        fill(dateAt(1), 0, "BUY", 200, 980),
        fill(dateAt(1), 1, "SELL", 200, 1020),
      ],
      "candidate",
    );
    const recovered = await freezePortfolioPlan(
      env,
      "candidate",
      {
        snapshot: snap,
        strategy: BASE_STRATEGY,
        strategyVersion: "baseline-v1",
        now: snap.createdAt,
      },
      { shadows },
    );
    assert.equal(recovered.tQuality.blocked, true);
    const options = { tQualityScope: "shadow:candidate" };
    await assertStoredProgramPlan(env, recovered, book, options);
    // 即便跳过盘后冻结入口，升级后的首帧执行也能独立恢复。
    await DB.prepare("DELETE FROM frozen_t_quality").run();
    await assertStoredProgramPlan(env, recovered, book, options);
    assert.equal((await counts(DB)).anchor, 1);
  } finally {
    DB.close();
  }
});

for (const shadow of [false, true]) {
  test(`${shadow ? "影子" : "主"}旧计划缺副本时，伪造空历史不能被补成可信证据`, async () => {
    const DB = localDatabase();
    try {
      const env = { DB },
        repo = new PaperRepository(env),
        snap = source(),
        book = heldBook();
      await repo.initialize();
      await archive(DB, snap);
      await appendLedger(DB, losses(), shadow ? "candidate" : null);
      const forged = await freezeInput(snap, book);
      await legacyPlan(DB, forged, shadow ? "candidate" : null);
      await assert.rejects(
        () =>
          assertStoredProgramPlan(env, forged, book, {
            tQualityScope: shadow ? "shadow:candidate" : "main",
          }),
        /与原始账本不一致/,
      );
      assert.equal((await counts(DB)).anchor, 0);
    } finally {
      DB.close();
    }
  });
}

test("旧计划恢复验证真实日历：合法窗口可恢复，伪造周末解除停手被拒绝", async (t) => {
  const DB = localDatabase();
  const signalDate = dateAt(5),
    realDates = [-2, -1, 0, 1, 4, 5].map(dateAt);
  calendarStub(t, realDates);
  try {
    const env = { DB },
      repo = new PaperRepository(env),
      snap = source(signalDate),
      book = heldBook();
    await repo.initialize();
    await archive(DB, snap);
    await appendLedger(DB, losses());
    const good = await freezeInput(snap, book, losses(), realDates);
    await legacyPlan(DB, good);
    await ensureFrozenTQuality(env, good, "main");
    await DB.prepare("DELETE FROM frozen_t_quality").run();
    const forged = await freezeInput(snap, book, losses(), [
      dateAt(2),
      dateAt(3),
      dateAt(5),
    ]);
    assert.equal(forged.tQuality.blocked, false);
    await DB.prepare("UPDATE paper_plans SET payload=?,digest=?")
      .bind(JSON.stringify(forged), await digest(forged))
      .run();
    await assert.rejects(
      () => ensureFrozenTQuality(env, forged, "main"),
      /与真实交易日历不一致/,
    );
    assert.equal((await counts(DB)).anchor, 0);
  } finally {
    DB.close();
  }
});

test("主计划竞争：后来的不同输入不能覆盖已保存计划的质量副本", async () => {
  const DB = localDatabase();
  try {
    const repo = new PaperRepository({ DB }),
      snap = source(),
      book = heldBook();
    await repo.initialize();
    await archive(DB, snap);
    const original = await freezeInput(snap, book, losses());
    const loser = await freezeInput(snap, book);
    await repo.savePlan(original);
    assert.deepEqual(await repo.savePlan(loser), original);
    await assertStoredProgramPlan({ DB }, original, book);
    assert.equal((await counts(DB)).anchor, 1);
  } finally {
    DB.close();
  }
});

for (const reverse of [false, true]) {
  test(`${reverse ? "反向" : "正向"}T跨三日分批恢复：落库均价、现金盈亏与完整重放一致，取整不累计`, async () => {
    const DB = localDatabase();
    try {
      const repo = new PaperRepository({ DB });
      await repo.initialize();
      const firstSide = reverse ? "SELL" : "BUY",
        secondSide = reverse ? "BUY" : "SELL";
      const days = [
        [
          fill(dateAt(1), 0, firstSide, 500, 981, false, reverse),
          fill(dateAt(1), 1, secondSide, 100, 1019, false, reverse),
        ],
        [
          fill(dateAt(2), 0, secondSide, 100, 1020, true),
          fill(dateAt(2), 1, secondSide, 100, 1020, true),
        ],
        [
          fill(dateAt(3), 0, secondSide, 100, 1020, true),
          fill(dateAt(3), 1, secondSide, 100, 1020, true),
        ],
      ];
      const history = [];
      for (const dayFills of days) {
        const date = dayFills[0].date,
          account = await repo.account();
        // 实时路径当日成交已写入账本；恢复查询必须排除当日，避免重复累计。
        await appendLedger(DB, dayFills);
        const records = buildTTradeRecords({
          fills: dayFills,
          openRecords: await repo.openTTradesByCodes(["600001"], date),
          now: `${date}T07:10:00Z`,
        });
        const data = dataset(date),
          result = executePlan(account.book, null, data);
        result.ledger = [];
        await repo.settle(account.revision, result, data, {
          tTradeRecords: records,
        });
        history.push(...dayFills);
        const expected = extractTTrades(history);
        const actual = (await repo.tTrades())[0];
        const projected = buildTQualityEvidence(expected.records, [])
          .records[0] ??
          // 未了结也独立核对精确累计的均价及总现金流。
          {
            ...expected.open[0],
            buy_price_cents: Math.round(
              expected.open[0]._buy_notional / expected.open[0].buy_quantity,
            ),
            sell_price_cents: Math.round(
              expected.open[0]._sell_notional / expected.open[0].sell_quantity,
            ),
          };
        assert.equal(actual.buy_price_cents, projected.buy_price_cents);
        assert.equal(actual.sell_price_cents, projected.sell_price_cents);
        assert.equal(actual.total_pnl_cents, projected.total_pnl_cents);
        assert.equal(actual.completed_date, projected.completed_date);
      }
      const final = (await repo.recentTTrades())[0];
      assert.equal(
        reverse ? final.buy_price_cents : final.sell_price_cents,
        1020,
      );
      assert.deepEqual(final, extractTTrades(history).records[0]);
    } finally {
      DB.close();
    }
  });
}

function observation(date, time, price, volume) {
  const timestamp = `${date}T${time}+08:00`;
  return {
    observedAt: new Date(timestamp).toISOString(),
    quotes: {
      600001: {
        date,
        timestamp,
        closeCents: price,
        openCents: 1000,
        previousCloseCents: 1000,
        volumeShares: volume,
        limitUpCents: 1100,
        limitDownCents: 900,
      },
    },
  };
}
test("实时真实执行路径：首日两买一卖、次日恢复卖出后，均价为1029分且重放一致", async () => {
  const DB = localDatabase();
  try {
    const repo = new PaperRepository({ DB }),
      book = heldBook(),
      allFills = [];
    await repo.initialize();
    await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
      .bind(JSON.stringify(book))
      .run();
    for (const [index, ticks] of [
      [
        1,
        [
          ["09:34:50", 1000, 100000],
          ["09:35:00", 980, 110000],
          ["09:35:10", 980, 120000],
          ["09:35:20", 1020, 130000],
        ],
      ],
      [
        2,
        [
          ["09:30:00", 1000, 100000],
          ["09:30:10", 1040, 110000],
        ],
      ],
    ]) {
      const account = await repo.account(),
        date = dateAt(index);
      const frozen = {
        ...plan(
          [order(index === 1 ? "T_FORWARD" : "HOLD", index === 1 ? 200 : 0)],
          dateAt(index - 1),
        ),
        strategy: BASE_STRATEGY,
      };
      let working = account.book,
        session = openSession(working, frozen, date);
      const fills = [];
      for (const [time, price, volume] of ticks) {
        const step = advanceSession(
          working,
          session,
          observation(date, time, price, volume),
        );
        working = step.book;
        session = step.session;
        fills.push(...step.ledger);
      }
      const data = dataset(date, "600001", { previousDate: dateAt(index - 1) });
      data.quotes = observation(date, "15:00:01", 1000, 1000000).quotes;
      const result = closeSession(working, session, data);
      result.ledger = fills;
      const records = buildTTradeRecords({
        fills,
        openRecords: await repo.openTTradesByCodes(["600001"], date),
        now: data.date,
      });
      await repo.settle(account.revision, result, data, {
        tTradeRecords: records,
      });
      allFills.push(...fills);
    }
    const stored = (await repo.recentTTrades())[0];
    assert.equal(stored.buy_price_cents, 981);
    assert.equal(stored.sell_price_cents, 1029);
    assert.equal(stored.total_pnl_cents, 7472);
    assert.deepEqual(stored, extractTTrades(allFills).records[0]);
  } finally {
    DB.close();
  }
});
