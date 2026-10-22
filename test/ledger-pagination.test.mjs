import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { paperOverview } from "../backend/services/paper.js";
import { auditLedger } from "../backend/domain/trading.js";
import { api } from "../backend/routes/api.js";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

async function insertFill(db, id, date, sequence, fields = {}) {
  const fill = {
    id,
    date,
    sequence,
    code: "600001",
    name: "合成样本",
    side: "BUY",
    cashDeltaCents: -100,
    realizedPnlCents: 0,
    feeCents: 1,
    ...fields,
  };
  await db
    .prepare(
      "INSERT INTO paper_ledger (id, trade_date, payload) VALUES (?, ?, ?)",
    )
    .bind(id, date, JSON.stringify(fill))
    .run();
  return fill;
}

test("账本分页：按日期和数值序号倒序，重复序号与旧记录稳定排序，不漏页不重页", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const repo = new PaperRepository({ DB });
  for (const [id, date, sequence] of [
    ["old", "2026-10-20", 100],
    ["legacy", "2026-10-21", undefined],
    ["fill-2", "2026-10-21", 2],
    ["fill-10-a", "2026-10-21", 10],
    ["fill-10-b", "2026-10-21", 10],
    ["latest", "2026-10-22", 1],
  ])
    await insertFill(DB, id, date, sequence);

  const expected = [
    "latest",
    "fill-10-b",
    "fill-10-a",
    "fill-2",
    "legacy",
    "old",
  ];
  const seen = [];
  for (let page = 1; page <= 3; page++) {
    const result = await repo.ledgerPage({ page, pageSize: 2 });
    assert.equal(result.total, 6);
    assert.equal(result.totalPages, 3);
    assert.equal(result.page, page);
    seen.push(...result.rows.map((row) => row.id));
  }
  assert.deepEqual(seen, expected);
  const filtered = await repo.ledgerPage({
    date: "2026-10-21",
    page: 2,
    pageSize: 3,
  });
  assert.equal(filtered.total, 4);
  assert.deepEqual(
    filtered.rows.map((row) => row.id),
    ["legacy"],
  );
  assert.deepEqual(filtered.dates, ["2026-10-22", "2026-10-21", "2026-10-20"]);
  assert.equal((await repo.ledgerPage({ page: 999, pageSize: 2 })).page, 3);

  const plan = await DB.prepare(
    `EXPLAIN QUERY PLAN SELECT payload FROM paper_ledger
     ORDER BY trade_date DESC, COALESCE(CAST(json_extract(payload, '$.sequence') AS INTEGER), 0) DESC, id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(2, 2)
    .all();
  assert.ok(
    plan.results.some((row) => row.detail.includes("idx_paper_ledger_page")),
  );
  assert.ok(plan.results.every((row) => !row.detail.includes("TEMP B-TREE")));
});

test("账本分页接口：默认值、非法页码、空结果、日期校验及只读请求", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const get = (query = "", method = "GET") =>
    api(new Request(`http://localhost/api/paper/ledger${query}`, { method }), {
      DB,
    });
  const empty = await (await get()).json();
  assert.deepEqual(empty, {
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 1,
    date: "",
    dates: [],
    rows: [],
  });
  await insertFill(DB, "only", "2026-10-21", 1);
  for (const query of ["?page=NaN&pageSize=Infinity", "?page=abc&pageSize=abc"])
    assert.deepEqual(
      await (await get(query)).json(),
      await (await get()).json(),
    );
  const capped = await (await get("?page=-2&pageSize=999")).json();
  assert.equal(capped.page, 1);
  assert.equal(capped.pageSize, 100);
  const decimal = await (await get("?page=2.9&pageSize=1.8")).json();
  assert.equal(decimal.page, 1);
  assert.equal(decimal.pageSize, 1);
  const noMatch = await (await get("?date=2026-10-20&page=100")).json();
  assert.equal(noMatch.page, 1);
  assert.equal(noMatch.total, 0);
  assert.deepEqual(noMatch.rows, []);
  for (const date of ["2026-02-30", "invalid", "2026-10-21' OR 1=1--"])
    assert.equal((await get(`?date=${encodeURIComponent(date)}`)).status, 400);
  assert.equal((await get("", "POST")).status, 405);
  // 独立分页接口不初始化账户、不请求行情、不依赖概览或收益曲线。
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS n FROM paper_accounts").first()).n,
    0,
  );
});

test("账本摘要与完整账本审计一致；概览不再读取成交明细列表", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const repo = new PaperRepository({ DB });
  const { book } = await repo.initialize();
  const fills = [
    await insertFill(DB, "buy", "2026-10-20", 1, { name: "旧名" }),
    await insertFill(DB, "sell-win", "2026-10-21", 2, {
      name: "新名",
      side: "SELL",
      cashDeltaCents: 120,
      realizedPnlCents: 20,
    }),
    await insertFill(DB, "sell-loss", "2026-10-20", 3, {
      code: "600002",
      side: "SELL",
      cashDeltaCents: 80,
      realizedPnlCents: -20,
    }),
  ];
  const { totals, stockPnl } = await repo.ledgerSummary();
  assert.deepEqual(
    auditLedger(book.initialCashCents, [totals], book, []),
    auditLedger(book.initialCashCents, fills, book, []),
  );
  assert.deepEqual(
    stockPnl.map((row) => [
      row.code,
      row.name,
      row.sellCount,
      row.winCount,
      row.lossCount,
      row.realizedPnlCents,
    ]),
    [
      ["600001", "新名", 1, 1, 0, 20],
      ["600002", "合成样本", 1, 0, 1, -20],
    ],
  );
  const queries = [];
  const trackedDB = {
    ...DB,
    prepare(sql) {
      queries.push(sql);
      return DB.prepare(sql);
    },
  };
  const overview = await paperOverview({ DB: trackedDB }, 0, {
    ledgerPage: 2,
    ledgerPageSize: 1,
  });
  assert.equal(overview.ledgerMeta.page, 2);
  assert.equal(overview.ledgerMeta.total, 3);
  assert.equal(overview.ledger.length, 1);
  assert.equal(overview.plan, null);
  assert.equal(overview.run, null);
  assert.deepEqual(
    overview.audit,
    auditLedger(book.initialCashCents, fills, book, []),
  );
  const detailQueries = queries.filter((sql) =>
    /SELECT (?:\*|payload) FROM paper_ledger/i.test(sql),
  );
  assert.equal(detailQueries.length, 1);
  assert.match(detailQueries[0], /LIMIT \? OFFSET \?/);
});

test("超过十万条历史成交仍可分页和汇总，末页不受旧读取上限影响", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  await DB.prepare(
    `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100005)
     INSERT INTO paper_ledger (id, trade_date, payload)
     SELECT printf('fill-%06d', i), '2026-10-21',
       json_object('id', printf('fill-%06d', i), 'date', '2026-10-21', 'sequence', i,
         'code', '600001', 'name', '合成样本', 'side', 'BUY',
         'cashDeltaCents', -100, 'realizedPnlCents', 0, 'feeCents', 1)
     FROM n`,
  ).run();
  const repo = new PaperRepository({ DB });
  const last = await repo.ledgerPage({ page: 10001, pageSize: 10 });
  assert.equal(last.total, 100005);
  assert.equal(last.totalPages, 10001);
  assert.deepEqual(
    last.rows.map((row) => row.sequence),
    [5, 4, 3, 2, 1],
  );
  assert.equal((await repo.ledgerSummary()).totals.feeCents, 100005);
});

let browserBundle;
async function browserFixture(t) {
  const DB = localDatabase();
  t.after(() => DB.close());
  const overview = await paperOverview({ DB });
  browserBundle ??= (
    await build({
      entryPoints: ["frontend/paper.js"],
      bundle: true,
      format: "cjs",
      write: false,
    })
  ).outputFiles[0].text;
  const elements = new Map(),
    listeners = new Map(),
    requests = [];
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        value: "",
        innerHTML: "",
        textContent: "",
        disabled: false,
        attributes: {},
        setAttribute(key, value) {
          this.attributes[key] = value;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
      });
    return elements.get(id);
  };
  const module = { exports: {} };
  runInNewContext(browserBundle, {
    module,
    exports: module.exports,
    AbortSignal,
    URLSearchParams,
    structuredClone,
    document: {
      hidden: false,
      getElementById: element,
      querySelectorAll: () => [],
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
    },
    window: { addEventListener() {} },
    setInterval() {},
    fetch(url) {
      return new Promise((resolve, reject) =>
        requests.push({
          url: new URL(url, "http://localhost"),
          reject,
          resolve: (result) => resolve(Response.json(result)),
        }),
      );
    },
  });
  const meta = (page, date = "") => ({
    page,
    pageSize: 10,
    total: 30,
    totalPages: 3,
    date,
    dates: ["2026-10-21"],
    rows: [
      {
        date: "2026-10-21",
        name: `第${page}页样本`,
        code: "600001",
        action: "OPEN",
        side: "BUY",
        quantity: 100,
        priceCents: 1000,
        feeCents: 1,
        cashDeltaCents: -100001,
        feeBreakdown: {},
      },
    ],
  });
  const initial = { ...overview, ledgerMeta: meta(1) };
  const client = module.exports.initializePaper();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  requests[0].resolve(initial);
  await flush();
  assert.equal(element("paper-message").textContent, "");
  return {
    element,
    requests,
    client,
    meta,
    initial,
    flush,
    click(page) {
      const button = { disabled: false, dataset: { page: String(page) } };
      listeners.get("click")({ target: { closest: () => button } });
    },
  };
}

test("前端翻页只请求账本，晚到的自动刷新不能覆盖当前页；筛选从第一页查询", async (t) => {
  const f = await browserFixture(t);
  const background = f.client.refresh();
  f.click(2);
  assert.equal(f.requests[2].url.pathname, "/api/paper/ledger");
  assert.equal(f.requests[2].url.searchParams.get("page"), "2");
  assert.equal(f.element("paper-ledger-date-filter").disabled, true);
  f.requests[2].resolve(f.meta(2));
  await f.flush();
  f.requests[1].resolve(f.initial);
  await background;
  assert.match(f.element("paper-ledger-pager").innerHTML, /第 2 \/ 3 页/);
  assert.match(f.element("paper-ledger-rows").innerHTML, /第2页样本/);
  assert.equal(f.element("paper-ledger-date-filter").disabled, false);

  const filter = f.element("paper-ledger-date-filter");
  filter.value = "2026-10-21";
  filter.onchange();
  assert.equal(f.requests[3].url.pathname, "/api/paper/ledger");
  assert.equal(f.requests[3].url.searchParams.get("page"), "1");
  assert.equal(f.requests[3].url.searchParams.get("date"), "2026-10-21");
  f.requests[3].resolve({
    ...f.meta(1, filter.value),
    rows: [],
    total: 0,
    totalPages: 1,
  });
  await f.flush();
  assert.match(f.element("paper-ledger-rows").innerHTML, /该日期无成交记录/);
  assert.equal(filter.value, "2026-10-21");
});

test("前端丢弃过期翻页响应，加载失败恢复已显示页面与筛选状态", async (t) => {
  const f = await browserFixture(t);
  f.click(2);
  f.click(3);
  f.requests[2].resolve(f.meta(3));
  await f.flush();
  f.requests[1].resolve(f.meta(2));
  await f.flush();
  assert.match(f.element("paper-ledger-pager").innerHTML, /第 3 \/ 3 页/);
  assert.match(f.element("paper-ledger-rows").innerHTML, /第3页样本/);
  const filter = f.element("paper-ledger-date-filter");
  filter.value = "2026-10-21";
  filter.onchange();
  f.requests[3].reject(new Error("连接中断"));
  await f.flush();
  assert.equal(filter.disabled, false);
  assert.equal(filter.value, "");
  assert.match(f.element("paper-ledger-pager").innerHTML, /第 3 \/ 3 页/);
  assert.match(
    f.element("paper-message").textContent,
    /成交账本加载失败：连接中断/,
  );
});
