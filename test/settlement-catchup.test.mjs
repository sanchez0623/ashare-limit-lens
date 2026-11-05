import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { RealtimeRepository } from "../backend/storage/realtime.js";
import { runPaperDay } from "../backend/services/paper.js";
import { BASE_STRATEGY } from "../backend/domain/trading.js";
import { advanceSession, openSession } from "../backend/domain/realtime.js";
import { dateAt, order, plan as planFixture } from "./fixtures/trading.mjs";

// 合成观测：结构与实时轮询一致（domain/realtime.js advanceSession 输入）。
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
function heldBook() {
  const book = {
    initialCashCents: 100000000,
    cashCents: 99000000,
    realizedPnlCents: 0,
    feesCents: 0,
    equityCents: 100000000,
    peakEquityCents: 100000000,
    lastDate: dateAt(0),
    activeStrategy: "baseline-v1",
    positions: [
      {
        code: "600001",
        name: "合成样本",
        sector: "测试行业",
        heldDays: 1,
        markCents: 1000,
        markDate: dateAt(0),
        lots: [
          {
            acquiredDate: dateAt(-1),
            quantity: 1000,
            costCents: 1000000,
            priceCents: 1000,
          },
        ],
      },
    ],
    pendingOrders: [],
    pendingExits: [],
    pendingRecovery: [],
  };
  return book;
}
function quoteLine(previous, price, dateCompact) {
  // 合成腾讯 qt 实时行情：parseTencentQuotes 依赖的字段索引（3 收/4 昨收/
  // 5 开/6 量/33 高/34 低/47-48 涨跌停/30 时间戳）。两行各带一个结算日的
  // 时间戳，解析按观测日期过滤后各取所需。
  const fields = Array.from({ length: 50 }, () => "0");
  fields[1] = "合成样本";
  fields[2] = "600001";
  fields[3] = price;
  fields[4] = previous;
  fields[5] = price;
  fields[6] = "10000";
  fields[9] = price;
  fields[10] = "100";
  fields[19] = price;
  fields[20] = "100";
  fields[30] = `${dateCompact}150000`;
  fields[33] = price;
  fields[34] = price;
  fields[47] = String((Number(price) * 1.1).toFixed(2));
  fields[48] = String((Number(price) * 0.9).toFixed(2));
  return `v_sh600001="${fields.join("~")}"`;
}
function calendarStub(t, dates) {
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "qt.gtimg.cn")
      // 实时快照只给 D2（复刻"补结算历史日拿不到当天快照"的实战场景），
      // 缺失日 D1 的收盘价必须由历史日线兜底路径补齐。
      return new Response(quoteLine("10.00", "10.00", dateAt(2).replaceAll("-", "")));
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
// 复刻"盘中停摆"现场：D1 会话已开、成交与账户已按帧提交，但未结算。
async function crashMidSession(DB, repo, frozen) {
  const D1 = dateAt(1);
  let working = (await repo.account()).book;
  let session = openSession(working, frozen, D1);
  const fills = [];
  for (const [time, price, volume] of [
    ["09:34:50", 1000, 100000],
    ["09:35:00", 980, 110000],
    ["09:35:10", 980, 120000],
    ["09:35:20", 1020, 130000],
  ]) {
    const step = advanceSession(
      working,
      session,
      observation(D1, time, price, volume),
    );
    working = step.book;
    session = step.session;
    fills.push(...step.ledger);
  }
  const account = await repo.account();
  const committed = await new RealtimeRepository({ DB }).commitObservation(
    account.revision,
    { book: working, session, ledger: fills },
    observation(D1, "09:36:00", 1020, 120000),
  );
  assert.equal(committed, true, "账户 CAS 提交应成功");
  assert.equal((await repo.account()).book.lastDate, dateAt(0));
  assert.ok(fills.length > 0, "合成会话应产生成交");
}

test("盘中停摆漏日：收盘后结算下一交易日时自动补结算带成交的缺失日", async (t) => {
  const DB = localDatabase();
  // 07:10Z = 北京 15:10（D2 收盘后）。缺失日 D1 由递归补结算关闭（历史日
  // 线兜底行情），D2 自身因计划冻结截止已过走"仅重估结算"路径——与真实
  // 停摆两日的恢复场景一致。
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-01-03T07:10:00Z"),
  });
  calendarStub(t, [dateAt(-1), dateAt(0), dateAt(1), dateAt(2)]);
  try {
    const env = {
      DB,
      ALERTS_ENABLED: "false",
      QUAN_DATA_DIR: "/tmp/settlement-catchup-synthetic",
    };
    const repo = new PaperRepository(env);
    await repo.initialize();
    await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
      .bind(JSON.stringify(heldBook()))
      .run();
    // 冻结 signal_date=D0 的事前计划（开盘买单，供 D1 会话成交）。
    const frozen = {
      ...planFixture([order("OPEN", 1000)], dateAt(0)),
      strategy: BASE_STRATEGY,
    };
    await DB.prepare(
      "INSERT INTO paper_plans(signal_date,created_at,payload,digest) VALUES(?,?,?,?)",
    )
      .bind(
        frozen.signalDate,
        frozen.createdAt,
        JSON.stringify(frozen),
        await (await import("../backend/storage/paper.js")).digest(frozen),
      )
      .run();
    await crashMidSession(DB, repo, frozen);
    // 结算 D2：lastDate=D0 落后于上一交易日 D1，应先补结算 D1 再结算 D2。
    const response = await runPaperDay(env, dateAt(2));
    assert.equal(response.status, "SETTLED", JSON.stringify(response));
    assert.equal((await repo.account()).book.lastDate, dateAt(2));
    // D2 走"仅重估结算"路径：无执行会话、零成交，notice 如实声明，
    // 且不落会话行（当日从未存在执行会话）。
    assert.ok(
      response.notices.some((notice) => notice.includes("错过冻结窗口")),
      JSON.stringify(response.notices),
    );
    assert.equal(
      (
        await DB.prepare(
          "SELECT 1 FROM paper_live_sessions WHERE trade_date=?",
        ).bind(dateAt(2)).first()
      ) ?? null,
      null,
    );
    // 缺失日补结算后必须留下连续性锚点计划与当日计划。
    assert.ok(await repo.plan(dateAt(1)), "缺失日缺少锚点计划");
    assert.ok(await repo.plan(dateAt(2)), "当日缺少下一交易日计划");
  } finally {
    DB.close();
  }
});

test("收盘前缺日不重放：保持原样阻断，账户不跨日", async (t) => {
  const DB = localDatabase();
  // 06:00Z = 北京 14:00，仍在盘中。
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-01-02T06:00:00Z"),
  });
  calendarStub(t, [dateAt(-1), dateAt(0), dateAt(1), dateAt(2)]);
  try {
    const env = {
      DB,
      ALERTS_ENABLED: "false",
      QUAN_DATA_DIR: "/tmp/settlement-catchup-synthetic",
    };
    const repo = new PaperRepository(env);
    await repo.initialize();
    await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
      .bind(JSON.stringify(heldBook()))
      .run();
    const response = await runPaperDay(env, dateAt(2));
    assert.equal(response.status, "BLOCKED", JSON.stringify(response));
    assert.match(response.reason, /存在尚未结算的交易日/);
    assert.equal((await repo.account()).book.lastDate, dateAt(0));
    assert.equal(await repo.plan(dateAt(1)), null);
  } finally {
    DB.close();
  }
});
