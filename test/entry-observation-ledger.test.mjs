import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { api } from "../backend/routes/api.js";
import { ShadowAccountRepository } from "../backend/storage/shadow.js";
import { ENTRY_OBSERVER_ID } from "../backend/services/entry-observation.js";
import { entryObservationLedger } from "../backend/services/entry-observation-ledger.js";

async function insertFill(DB, accountId, id, date, sequence) {
  const fill = { id, date, sequence, name: "合成样本", quantity: 100 };
  await DB.prepare(
    "INSERT INTO shadow_ledger(account_id,id,trade_date,payload) VALUES(?,?,?,?)",
  )
    .bind(accountId, id, date, JSON.stringify(fill))
    .run();
}

test("影子成交按日期与数值序号服务端分页，同股分批成交不合并、不混入其他账户", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const date = "2026-10-23";
  for (let sequence = 0; sequence < 25; sequence++)
    await insertFill(DB, ENTRY_OBSERVER_ID, `fill-${sequence}`, date, sequence);
  await insertFill(DB, ENTRY_OBSERVER_ID, "fill-10-z", date, 10);
  await insertFill(DB, ENTRY_OBSERVER_ID, "legacy", date, undefined);
  await insertFill(DB, ENTRY_OBSERVER_ID, "old", "2026-10-22", 99);
  await insertFill(DB, "other-shadow", "fill-24", date, 1000);
  await DB.prepare(
    "INSERT INTO paper_ledger(id,trade_date,payload) VALUES(?,?,?)",
  )
    .bind(
      "fill-24",
      date,
      JSON.stringify({ id: "primary-only", sequence: 1000 }),
    )
    .run();

  const queries = [];
  const env = {
    DB: {
      prepare(sql) {
        queries.push(sql);
        return DB.prepare(sql);
      },
    },
  };
  const seen = [];
  for (let page = 1; page <= 3; page++) {
    const response = await api(
      new Request(
        `http://localhost/api/paper/entry-observation/ledger?date=${date}&page=${page}&accountId=other-shadow`,
      ),
      env,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.total, 27);
    assert.equal(result.totalPages, 3);
    assert.equal(result.pageSize, 10);
    assert.equal(result.date, date);
    assert.equal(result.page, page);
    assert.equal(result.rows.length, page === 3 ? 7 : 10);
    seen.push(...result.rows.map((row) => row.id));
  }
  const expected = Array.from({ length: 25 }, (_, i) => `fill-${24 - i}`);
  expected.splice(expected.indexOf("fill-10"), 0, "fill-10-z");
  expected.splice(expected.indexOf("fill-0"), 0, "legacy");
  assert.deepEqual(seen, expected);
  assert.ok(queries.every((sql) => /^\s*SELECT\b/i.test(sql)));
  assert.ok(
    queries
      .filter((sql) => /SELECT payload/i.test(sql))
      .every((sql) => /LIMIT \? OFFSET \?/.test(sql)),
  );

  const repo = new ShadowAccountRepository({ DB });
  assert.equal((await repo.ledgerPage(ENTRY_OBSERVER_ID)).total, 28);
  assert.equal(
    (await repo.ledgerPage(ENTRY_OBSERVER_ID, { page: 999, date })).page,
    3,
  );
  for (const withDate of [true, false]) {
    const plan = await DB.prepare(
      `EXPLAIN QUERY PLAN SELECT payload FROM shadow_ledger WHERE account_id = ?${withDate ? " AND trade_date = ?" : ""}
       ORDER BY trade_date DESC, COALESCE(CAST(json_extract(payload, '$.sequence') AS INTEGER), 0) DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(ENTRY_OBSERVER_ID, ...(withDate ? [date] : []), 10, 10)
      .all();
    assert.ok(
      plan.results.some((row) => row.detail.includes("idx_shadow_ledger_page")),
    );
    assert.ok(plan.results.every((row) => !row.detail.includes("TEMP B-TREE")));
  }
});

test("影子成交接口处理空页、越界、非法页码与日期，拒绝写入", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const get = (query = "", method = "GET") =>
    api(
      new Request(
        `http://localhost/api/paper/entry-observation/ledger${query}`,
        { method },
      ),
      { DB },
    );
  assert.deepEqual(await (await get()).json(), {
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 1,
    date: "",
    rows: [],
    pnl: null,
  });
  await insertFill(DB, ENTRY_OBSERVER_ID, "only", "2026-10-23", 0);
  for (const query of [
    "?page=NaN&pageSize=Infinity",
    "?page=abc&pageSize=abc",
  ]) {
    const result = await (await get(query)).json();
    assert.equal(result.page, 1);
    assert.equal(result.pageSize, 10);
    assert.equal(result.rows.length, 1);
  }
  const capped = await (await get("?page=-2&pageSize=999")).json();
  assert.equal(capped.page, 1);
  assert.equal(capped.pageSize, 100);
  const decimal = await (await get("?page=2.9&pageSize=1.8")).json();
  assert.equal(decimal.page, 1);
  assert.equal(decimal.pageSize, 1);
  const empty = await (await get("?date=2026-10-22&page=100")).json();
  assert.equal(empty.page, 1);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.rows, []);
  for (const date of ["2026-02-30", "invalid", "2026-10-23' OR 1=1--"])
    assert.equal((await get(`?date=${encodeURIComponent(date)}`)).status, 400);
  assert.equal((await get("", "POST")).status, 405);
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS n FROM paper_accounts").first()).n,
    0,
  );
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS n FROM settings").first()).n,
    0,
  );
});

async function seedPnlAccount(DB, initialBook, book, fills) {
  await new ShadowAccountRepository({ DB }).ensureAccount(ENTRY_OBSERVER_ID, {
    kind: "INTRADAY_OBSERVATION",
    book,
  });
  for (const [date, initial] of [
    ["2026-10-23", initialBook],
    ["2026-10-26", { ...book, equityCents: 99999999 }],
  ]) {
    await DB.prepare(
      "INSERT INTO shadow_sessions(account_id,trade_date,payload,digest) VALUES(?,?,?,?)",
    )
      .bind(
        ENTRY_OBSERVER_ID,
        date,
        JSON.stringify({ date, initialBook: initial }),
        "synthetic",
      )
      .run();
  }
  for (const fill of fills) {
    await DB.prepare(
      "INSERT INTO shadow_ledger(account_id,id,trade_date,payload) VALUES(?,?,?,?)",
    )
      .bind(ENTRY_OBSERVER_ID, fill.id, fill.date, JSON.stringify(fill))
      .run();
  }
}
function pnlFixture() {
  const initial = {
    initialCashCents: 1000000,
    cashCents: 900000,
    equityCents: 900000,
    realizedPnlCents: -100000,
    positions: [],
  };
  const position = (code, quantity, costCents, markCents) => ({
    code,
    name: "合成样本",
    lots: [{ quantity, costCents }],
    markCents,
    markDate: "2026-10-26",
  });
  const book = {
    ...initial,
    cashCents: 765500,
    equityCents: 901500,
    realizedPnlCents: -94340,
    positions: [
      position("600001", 60, 60060, 1100),
      position("600003", 100, 80100, 700),
    ],
  };
  const fills = [
    {
      id: "a-buy",
      code: "600001",
      date: "2026-10-23",
      sequence: 0,
      cashDeltaCents: -100100,
    },
    {
      id: "b-buy",
      code: "600002",
      date: "2026-10-23",
      sequence: 1,
      cashDeltaCents: -50100,
    },
    {
      id: "c-buy",
      code: "600003",
      date: "2026-10-23",
      sequence: 2,
      cashDeltaCents: -80100,
    },
    {
      id: "a-sell",
      code: "600001",
      date: "2026-10-26",
      sequence: 0,
      cashDeltaCents: 47900,
    },
    {
      id: "b-sell",
      code: "600002",
      date: "2026-10-26",
      sequence: 1,
      cashDeltaCents: 47900,
    },
  ];
  return { initial, book, fills };
}

test("盈亏跨页和日期保持完整账户口径，覆盖卖出、已清仓、费用及继承的历史亏损", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const f = pnlFixture();
  await seedPnlAccount(DB, f.initial, f.book, f.fills);
  await insertFill(DB, "other-shadow", "a-buy", "2026-10-23", 999);
  const pages = [];
  for (let page = 1; page <= 3; page++)
    pages.push(
      await entryObservationLedger(
        { DB },
        { date: "2026-10-23", page, pageSize: 1 },
      ),
    );
  assert.ok(pages.every((p) => p.pnl.totalPnlCents === 1500));
  assert.ok(pages.every((p) => p.pnl.unrealizedPnlCents === -4160));
  assert.ok(pages.every((p) => p.pnl.baselineEquityCents === 900000));
  assert.ok(pages.every((p) => p.stocks.length === 3));
  assert.deepEqual(pages[0].stocks, pages[1].stocks);
  assert.equal(pages[0].pnl.totalReturn, 1500 / 900000);
  assert.equal(pages[0].pnl.baselineDate, "2026-10-23");
  const stocks = new Map(
    pages.map((p) => [p.rows[0].code, p.rows[0].stockPnl]),
  );
  assert.equal(stocks.get("600001").totalPnlCents, 13800);
  assert.equal(stocks.get("600001").unrealizedPnlCents, 5940);
  assert.equal(stocks.get("600001").unrealizedReturn, 5940 / 60060);
  assert.equal(stocks.get("600001").markDate, "2026-10-26");
  assert.equal(stocks.get("600002").totalPnlCents, -2200);
  assert.equal(stocks.get("600002").quantity, 0);
  assert.equal(stocks.get("600002").markCents, null);
  assert.equal(stocks.get("600003").totalPnlCents, -10100);
  assert.equal(
    [...stocks.values()].reduce((sum, stock) => sum + stock.totalPnlCents, 0),
    1500,
  );
  const empty = await entryObservationLedger({ DB }, { date: "2026-10-27" });
  assert.equal(empty.rows.length, 0);
  assert.deepEqual(empty.pnl, pages[0].pnl);
  assert.deepEqual(empty.stocks, pages[0].stocks);
  const all = await entryObservationLedger({ DB });
  assert.equal(all.rows.filter((row) => row.code === "600001").length, 2);
  assert.ok(
    all.rows
      .filter((row) => row.code === "600001")
      .every((row) => row.stockPnl.totalPnlCents === 13800),
  );
});

test("同股五笔分批买入各按成交成本和费用计算盈亏，汇总单列且不受分页影响", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const initial = {
    cashCents: 100000000,
    equityCents: 100000000,
    positions: [],
  };
  const quantities = [200, 1700, 1700, 3000, 2500];
  const costs = [181712, 1544199, 1547599, 2709673, 2268145];
  const expected = [8888, 75901, 72501, 149327, 114355];
  const fills = quantities.map((quantity, i) => ({
    id: `batch-${i}`,
    date: "2026-10-23",
    sequence: i,
    code: "000530",
    name: "分批样本",
    side: "BUY",
    quantity,
    cashDeltaCents: -costs[i],
  }));
  const book = {
    ...initial,
    cashCents: 91748672,
    equityCents: 100420972,
    positions: [
      {
        code: "000530",
        name: "分批样本",
        markCents: 953,
        markDate: "2026-10-23",
        lots: quantities.map((quantity, i) => ({
          acquiredDate: "2026-10-23",
          quantity,
          costCents: costs[i],
        })),
      },
    ],
  };
  await seedPnlAccount(DB, initial, book, fills);
  const result = await entryObservationLedger({ DB }, { date: "2026-10-23" });
  assert.equal(result.stocks.length, 1);
  assert.equal(result.stocks[0].totalPnlCents, 420972);
  assert.equal(result.stocks[0].quantity, 9100);
  const byId = new Map(result.rows.map((r) => [r.id, r.fillPnl]));
  for (let i = 0; i < 5; i++) {
    assert.equal(byId.get(`batch-${i}`).pnlCents, expected[i]);
    assert.equal(byId.get(`batch-${i}`).remainingQuantity, quantities[i]);
    assert.equal(byId.get(`batch-${i}`).return, expected[i] / costs[i]);
  }
  assert.equal(
    result.rows.reduce((sum, r) => sum + r.fillPnl.pnlCents, 0),
    result.stocks[0].totalPnlCents,
  );
  const page = await entryObservationLedger({ DB }, { page: 3, pageSize: 1 });
  assert.equal(page.rows[0].fillPnl.pnlCents, 72501);
  assert.deepEqual(page.stocks, result.stocks);
});

test("卖出按数值成交序号先进先出抵扣批次，逐笔成本舍入与剩余浮盈和已实现盈亏不重复", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const initial = { cashCents: 1000000, equityCents: 1000000, positions: [] };
  const book = {
    ...initial,
    cashCents: 943800,
    equityCents: 1048800,
    positions: [
      {
        code: "600001",
        markCents: 1050,
        markDate: "2026-10-26",
        lots: [{ acquiredDate: "2026-10-23", quantity: 100, costCents: 92250 }],
      },
    ],
  };
  await seedPnlAccount(DB, initial, book, [
    {
      id: "first",
      code: "600001",
      date: "2026-10-23",
      sequence: 2,
      side: "BUY",
      quantity: 300,
      cashDeltaCents: -270500,
    },
    {
      id: "second",
      code: "600001",
      date: "2026-10-23",
      sequence: 10,
      side: "BUY",
      quantity: 200,
      cashDeltaCents: -184501,
    },
    {
      id: "sell",
      code: "600001",
      date: "2026-10-26",
      sequence: 0,
      side: "SELL",
      quantity: 400,
      cashDeltaCents: 398801,
      basisCents: 362751,
    },
  ]);
  const result = await entryObservationLedger({ DB });
  const pnl = new Map(result.rows.map((r) => [r.id, r.fillPnl]));
  assert.equal(pnl.get("first").remainingQuantity, 0);
  assert.equal(pnl.get("first").pnlCents, 0);
  assert.equal(pnl.get("second").remainingQuantity, 100);
  assert.equal(pnl.get("second").pnlCents, 12750);
  assert.equal(pnl.get("sell").kind, "REALIZED");
  assert.equal(pnl.get("sell").pnlCents, 36050);
  assert.equal(
    result.rows.reduce((sum, r) => sum + r.fillPnl.pnlCents, 0),
    48800,
  );
  assert.equal(result.stocks[0].totalPnlCents, 48800);
});

test("缺估值或批次与账本不一致时不编造本笔盈利，缺成交字段保持未知", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const initial = { cashCents: 1000000, equityCents: 1000000, positions: [] };
  const book = {
    ...initial,
    positions: [
      {
        code: "600001",
        markCents: null,
        lots: [
          { acquiredDate: "2026-10-23", quantity: 100, costCents: 100500 },
        ],
      },
    ],
  };
  await seedPnlAccount(DB, initial, book, [
    {
      id: "buy",
      code: "600001",
      date: "2026-10-23",
      sequence: 0,
      side: "BUY",
      quantity: 100,
      cashDeltaCents: -100500,
    },
  ]);
  let result = await entryObservationLedger({ DB });
  assert.equal(result.rows[0].fillPnl.pnlCents, null);
  assert.equal(result.rows[0].fillPnl.return, null);
  book.positions[0].markCents = 1100;
  book.positions[0].lots[0].costCents = 100501;
  await DB.prepare("UPDATE shadow_accounts SET state=? WHERE account_id=?")
    .bind(JSON.stringify(book), ENTRY_OBSERVER_ID)
    .run();
  result = await entryObservationLedger({ DB });
  assert.equal(result.rows[0].fillPnl.pnlCents, null);
});

test("同日卖出先消耗继承底仓，保留当天新批次，个股汇总剔除观察前浮盈", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const initial = {
    cashCents: 900000,
    equityCents: 1000000,
    positions: [
      {
        code: "600001",
        markCents: 1000,
        lots: [{ acquiredDate: "2026-10-22", quantity: 100, costCents: 90000 }],
      },
    ],
  };
  const book = {
    cashCents: 894900,
    equityCents: 1014900,
    positions: [
      {
        code: "600001",
        markCents: 1200,
        lots: [
          { acquiredDate: "2026-10-23", quantity: 100, costCents: 110000 },
        ],
      },
    ],
  };
  await seedPnlAccount(DB, initial, book, [
    {
      id: "buy",
      date: "2026-10-23",
      sequence: 0,
      code: "600001",
      side: "BUY",
      quantity: 100,
      cashDeltaCents: -110000,
    },
    {
      id: "sell",
      date: "2026-10-23",
      sequence: 1,
      code: "600001",
      side: "SELL",
      quantity: 100,
      cashDeltaCents: 104900,
      basisCents: 90000,
    },
  ]);
  const result = await entryObservationLedger({ DB });
  const pnl = new Map(result.rows.map((r) => [r.id, r.fillPnl]));
  assert.equal(pnl.get("buy").remainingQuantity, 100);
  assert.equal(pnl.get("buy").pnlCents, 10000);
  assert.equal(pnl.get("sell").pnlCents, 14900);
  assert.equal(result.stocks[0].totalPnlCents, 14900);
  assert.equal(result.pnl.totalPnlCents, 14900);
});

test("继承持仓以观察起始市值为基准，避免历史浮盈成为观察期收益；缺现金流不编造个股盈亏", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const initial = {
    cashCents: 880000,
    equityCents: 1000000,
    positions: [
      {
        code: "600001",
        markCents: 1200,
        lots: [{ quantity: 100, costCents: 100000 }],
      },
    ],
  };
  const book = {
    cashCents: 931900,
    equityCents: 997900,
    positions: [
      {
        code: "600001",
        markCents: 1100,
        markDate: "2026-10-26",
        lots: [{ quantity: 60, costCents: 60000 }],
      },
    ],
  };
  await seedPnlAccount(DB, initial, book, [
    {
      id: "sell",
      date: "2026-10-26",
      code: "600001",
      sequence: 0,
      cashDeltaCents: 51900,
    },
  ]);
  const result = await entryObservationLedger({ DB });
  assert.equal(result.pnl.totalPnlCents, -2100);
  assert.equal(result.rows[0].stockPnl.totalPnlCents, -2100);
  assert.equal(result.rows[0].stockPnl.unrealizedPnlCents, 6000);
  await DB.prepare(
    "INSERT INTO shadow_ledger(account_id,id,trade_date,payload) VALUES(?,?,?,?)",
  )
    .bind(
      ENTRY_OBSERVER_ID,
      "incomplete",
      "2026-10-23",
      JSON.stringify({ code: "600001", date: "2026-10-23" }),
    )
    .run();
  assert.ok(
    (await entryObservationLedger({ DB })).rows.every(
      (row) => row.stockPnl.totalPnlCents === null,
    ),
  );
});

test("读取期间影子账户版本变化会重读，持续变化时拒绝拼接过期盈亏", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const f = pnlFixture();
  await seedPnlAccount(DB, f.initial, f.book, f.fills);
  let reads = 0,
    alwaysChanging = false;
  const env = {
    DB: {
      prepare(sql) {
        const statement = DB.prepare(sql);
        if (!/^SELECT revision FROM shadow_accounts/.test(sql))
          return statement;
        return {
          bind(...args) {
            statement.bind(...args);
            return this;
          },
          async first() {
            const row = await statement.first();
            return {
              ...row,
              revision:
                row.revision + (alwaysChanging || ++reads === 1 ? 1 : 0),
            };
          },
        };
      },
    },
  };
  assert.equal((await entryObservationLedger(env)).pnl.totalPnlCents, 1500);
  assert.equal(reads, 2);
  alwaysChanging = true;
  await assert.rejects(() => entryObservationLedger(env), /影子账户正在更新/);
});
