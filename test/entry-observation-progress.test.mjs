import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { api } from "../backend/routes/api.js";
import { entryObservationProgress } from "../backend/services/entry-observation-progress.js";
import { ENTRY_OBSERVER_ID } from "../backend/services/entry-observation.js";
import {
  initializeEntryObservation,
  renderEntryObservationProgress,
} from "../frontend/entry-observation.js";

test("影子进度 GET 在未启动时只读，不登记、不初始化账户、不生成核验", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const queries = [];
  const env = {
    DB: {
      prepare(sql) {
        queries.push(sql);
        return DB.prepare(sql);
      },
    },
  };
  const response = await api(
    new Request("http://localhost/api/paper/entry-observation"),
    env,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.requested, false);
  assert.equal(result.status, "NOT_STARTED");
  assert.equal(result.session, null);
  assert.equal(result.executor.running, false);
  assert.ok(queries.length > 0);
  assert.ok(queries.every((sql) => /^\s*SELECT\b/i.test(sql)));
});

test("进度只返回指定影子账户的最新会话，服务心跳不能当成影子行情", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  for (const [accountId, date, sequence] of [
    [ENTRY_OBSERVER_ID, "2026-10-22", 999],
    [ENTRY_OBSERVER_ID, "2026-10-23", 415],
    ["other-shadow", "2026-10-26", 5000],
  ]) {
    await DB.prepare(
      "INSERT INTO shadow_sessions(account_id,trade_date,payload,digest) VALUES(?,?,?,?)",
    )
      .bind(
        accountId,
        date,
        JSON.stringify({
          date,
          signalDate: "2026-10-22",
          status: "OPEN",
          sequence,
          fillCount: 5,
          lastObservedAt: "2026-10-23T02:39:26.365Z",
          initialBook: { privateFixture: true },
        }),
        "fixture",
      )
      .run();
  }
  await DB.prepare(
    "INSERT INTO paper_executor_health(id,payload) VALUES('primary',?)",
  )
    .bind(
      JSON.stringify({
        automatic: true,
        status: "MARKET_CLOSED",
        checkedAt: "2026-10-23T07:11:51.975Z",
        pollIntervalSeconds: 10,
      }),
    )
    .run();
  const result = await entryObservationProgress(
    { DB },
    new Date("2026-10-23T07:12:00Z"),
  );
  assert.equal(result.executor.running, true);
  assert.deepEqual(result.session, {
    date: "2026-10-23",
    signalDate: "2026-10-22",
    status: "OPEN",
    sequence: 415,
    fillCount: 5,
    lastObservedAt: "2026-10-23T02:39:26.365Z",
  });
  assert.equal(result.readiness, null);
  assert.equal(
    (await entryObservationProgress({ DB }, new Date("2026-10-23T07:20:00Z")))
      .executor.stale,
    true,
  );
});

test("周末空会话不覆盖上个交易日，跨到下一交易日仍保留完整历史成交入口", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  for (const [date, fillCount] of [
    ["2026-10-23", 5],
    ["2026-10-24", 0],
  ])
    await DB.prepare(
      "INSERT INTO shadow_sessions(account_id,trade_date,payload,digest) VALUES(?,?,?,?)",
    )
      .bind(
        ENTRY_OBSERVER_ID,
        date,
        JSON.stringify({ date, fillCount, status: "OPEN" }),
        "fixture",
      )
      .run();
  for (let index = 0; index < 5; index++)
    await DB.prepare(
      "INSERT INTO shadow_ledger(account_id,id,trade_date,payload) VALUES(?,?,?,?)",
    )
      .bind(
        ENTRY_OBSERVER_ID,
        `old-${index}`,
        "2026-10-23",
        JSON.stringify({ id: `old-${index}`, date: "2026-10-23" }),
      )
      .run();
  await DB.prepare(
    "INSERT INTO shadow_ledger(account_id,id,trade_date,payload) VALUES(?,?,?,?)",
  )
    .bind("other-shadow", "other", "2026-10-24", "{}")
    .run();
  const weekend = await entryObservationProgress(
    { DB },
    new Date("2026-10-24T11:00:00+08:00"),
  );
  assert.equal(weekend.session.date, "2026-10-23");
  assert.deepEqual(weekend.ledger, { total: 5, latestTradeDate: "2026-10-23" });
  await DB.prepare(
    "INSERT INTO shadow_sessions(account_id,trade_date,payload,digest) VALUES(?,?,?,?)",
  )
    .bind(
      ENTRY_OBSERVER_ID,
      "2026-10-26",
      JSON.stringify({ fillCount: 0, status: "OPEN" }),
      "fixture",
    )
    .run();
  const next = await entryObservationProgress(
    { DB },
    new Date("2026-10-26T09:31:00+08:00"),
  );
  assert.equal(next.session.date, "2026-10-26");
  assert.deepEqual(next.ledger, weekend.ledger);
  const html = renderEntryObservationProgress(next);
  assert.match(html, /data-entry-ledger-date=""/);
  assert.match(html, /全部历史成交 · 5 笔/);
  assert.match(html, /data-entry-ledger-date="2026-10-26"/);
});

function browserFixture(t, requested = true) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        open: false,
        disabled: false,
        textContent: "",
        innerHTML: "",
        setAttribute() {},
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
          this.onclose?.();
        },
      });
    return elements.get(id);
  };
  const original = globalThis.document;
  globalThis.document = { getElementById: element };
  t.after(() => {
    globalThis.document = original;
  });
  const calls = [];
  let started = 0;
  initializeEntryObservation({
    getObservation: () => ({ requested }),
    onStarted: async () => {
      started++;
    },
    request: (path, body) =>
      new Promise((resolve, reject) => {
        calls.push({ path, body, resolve, reject });
      }),
  });
  return {
    element,
    calls,
    started: () => started,
    flush: () => new Promise(setImmediate),
  };
}

test("点击查看立即打开窗口，只发 GET，失败可在原处刷新重试", async (t) => {
  const f = browserFixture(t);
  const dialog = f.element("paper-entry-observation-dialog");
  const detail = f.element("paper-entry-observation-detail");
  const refresh = f.element("paper-entry-observation-refresh");
  f.element("paper-entry-observe").onclick();
  assert.equal(dialog.open, true);
  assert.match(detail.textContent, /正在读取/);
  assert.equal(refresh.disabled, true);
  assert.equal(f.calls[0].body, undefined);
  f.element("paper-entry-observe").onclick();
  assert.equal(f.calls.length, 1);
  f.calls[0].reject(new Error("连接中断"));
  await f.flush();
  assert.match(detail.textContent, /连接中断/);
  assert.equal(refresh.disabled, false);
  refresh.onclick();
  f.calls[1].resolve({ requested: true, candidates: 81, status: "OBSERVING" });
  await f.flush();
  assert.match(detail.innerHTML, /81 只/);
  assert.match(detail.innerHTML, /尚无核验报告/);
  assert.equal(f.started(), 0);
  f.element("paper-entry-observation-close").onclick();
  assert.equal(dialog.open, false);
});

test("首次启动仍登记观察，随后只读进度；旧版本报告不能显示当前通过", async (t) => {
  const f = browserFixture(t, false);
  f.element("paper-entry-observe").onclick();
  assert.deepEqual(f.calls[0].body, {});
  f.calls[0].resolve({ requested: true });
  await f.flush();
  assert.equal(f.started(), 1);
  assert.equal(f.calls[1].body, undefined);
  f.calls[1].resolve({ requested: true });
  await f.flush();
  const html = renderEntryObservationProgress({
    message: "<script>unsafe</script>",
    ready: false,
    readiness: { passed: true, coverage: true, replayPassed: false },
  });
  assert.match(html, /报告对应旧执行版本/);
  assert.match(html, /全天有效行情覆盖<\/dt><dd>通过/);
  assert.match(html, /账本重放<\/dt><dd>未通过/);
  assert.ok(!html.includes("<script>"));
});

const candidatePage = (page, fields = {}) => ({
  signalDate: "2026-10-23",
  frozenAt: "2026-10-23T09:02:14Z",
  candidateTotal: 83,
  total: 83,
  page,
  pageSize: 10,
  totalPages: 9,
  rules: {
    maxPremarketCandidates: 100,
    maxCandidates: 200,
    minTurnoverCny: 3e8,
    confirmationQuotes: 2,
    windows: {
      "limit-up-momentum": [
        ["09:30:00", "10:30:00"],
        ["13:00:00", "14:30:00"],
      ],
    },
  },
  summary: {
    stockClasses: [
      { label: "强势反包型", count: 81 },
      { label: "连板龙头型", count: 2 },
    ],
    buyPoints: [{ label: "待盘中识别", count: 59 }],
  },
  rows: [
    {
      rank: page * 10 - 9,
      code: "000001",
      name: `第${page}页候选`,
      sector: "机械",
      stockClassLabel: "强势反包型",
      stockClassReason: "近10日有涨停基因",
      buyPoints: [],
      score: 90,
      amountCny: 1e8,
      sourceLabel: "信号日涨停池",
      entryReason: "冻结分数排序",
      checks: [{ label: "成交额准入", passed: false, value: "门槛3亿" }],
      readiness: "WAITING_TURNOVER",
      readinessReason: "待盘中确认成交额",
    },
  ],
  ...fields,
});
function openCandidates(f, date = "2026-10-23") {
  f.element("paper-entry-observation-detail").onclick({
    target: { closest: () => ({ dataset: { entryCandidatesDate: date } }) },
  });
}
function clickCandidatePage(f, page) {
  f.element("paper-entry-candidates-pager").onclick({
    target: {
      closest: () => ({
        disabled: false,
        dataset: { entryCandidatePage: String(page) },
      }),
    },
  });
}

test("83只入口打开独立候选弹窗，固定信号日分页并展示分类和入池依据", async (t) => {
  const f = browserFixture(t);
  f.element("paper-entry-observe").onclick();
  f.calls[0].resolve({
    requested: true,
    signalDate: "2026-10-23",
    candidates: 83,
  });
  await f.flush();
  assert.match(
    f.element("paper-entry-observation-detail").innerHTML,
    /83 只 · 查看候选明细/,
  );
  openCandidates(f);
  assert.equal(f.element("paper-entry-candidates-dialog").open, true);
  assert.equal(f.element("paper-entry-observation-dialog").open, true);
  assert.equal(f.element("paper-entry-ledger-dialog").open, false);
  const query = new URL(f.calls[1].path, "http://localhost");
  assert.equal(query.pathname, "/api/paper/entry-observation/candidates");
  assert.equal(query.searchParams.get("signalDate"), "2026-10-23");
  assert.equal(query.searchParams.get("pageSize"), "10");
  assert.equal(f.calls[1].body, undefined);
  f.calls[1].resolve(candidatePage(1));
  await f.flush();
  const rows = f.element("paper-entry-candidates-rows");
  assert.match(rows.innerHTML, /强势反包型/);
  assert.match(rows.innerHTML, /待盘中识别/);
  assert.match(rows.innerHTML, /待盘中成交额确认/);
  assert.match(
    f.element("paper-entry-candidates-rules").innerHTML,
    /同分代码升序/,
  );
  assert.match(
    f.element("paper-entry-candidates-rules").innerHTML,
    /午后仅回封/,
  );
  clickCandidatePage(f, 9);
  assert.equal(
    new URL(f.calls[2].path, "http://localhost").searchParams.get("page"),
    "9",
  );
  clickCandidatePage(f, 2);
  assert.equal(f.calls.length, 3);
  f.calls[2].resolve(candidatePage(9));
  await f.flush();
  assert.match(
    f.element("paper-entry-candidates-pager").innerHTML,
    /第 9 \/ 9 页 · 共 83 只/,
  );
  assert.equal(f.element("paper-entry-candidates-scroll").scrollTop, 0);
  clickCandidatePage(f, 8);
  f.calls[3].reject(new Error("暂时断开"));
  await f.flush();
  assert.match(rows.innerHTML, /第9页候选/);
  assert.match(
    f.element("paper-entry-candidates-message").textContent,
    /暂时断开/,
  );
  f.element("paper-entry-candidates-refresh").onclick();
  assert.equal(
    new URL(f.calls[4].path, "http://localhost").searchParams.get("page"),
    "9",
  );
  f.calls[4].resolve(candidatePage(9));
  await f.flush();
  f.element("paper-entry-candidates-close").onclick();
  assert.equal(f.element("paper-entry-candidates-dialog").open, false);
  assert.equal(f.element("paper-entry-observation-dialog").open, true);
});

test("候选联合筛选回到第一页，过时请求和关闭后的响应不会覆盖新结果", async (t) => {
  const f = browserFixture(t);
  openCandidates(f);
  f.element("paper-entry-candidates-search").value = " 冻结股 ";
  f.element("paper-entry-candidates-class").value = "strong-reversal";
  f.element("paper-entry-candidates-buy-point").value = "unclassified";
  f.element("paper-entry-candidates-filter").onsubmit({ preventDefault() {} });
  const query = new URL(f.calls[1].path, "http://localhost").searchParams;
  assert.equal(query.get("page"), "1");
  assert.equal(query.get("q"), "冻结股");
  assert.equal(query.get("stockClass"), "strong-reversal");
  assert.equal(query.get("buyPoint"), "unclassified");
  f.calls[1].resolve(candidatePage(1, { total: 0, totalPages: 1, rows: [] }));
  await f.flush();
  f.calls[0].resolve(candidatePage(1));
  await f.flush();
  assert.match(f.element("paper-entry-candidates-rows").innerHTML, /没有匹配/);
  f.element("paper-entry-candidates-reset").onclick();
  assert.equal(f.element("paper-entry-candidates-search").value, "");
  assert.equal(
    new URL(f.calls[2].path, "http://localhost").searchParams.has("q"),
    false,
  );
  f.element("paper-entry-candidates-close").onclick();
  openCandidates(f, "2026-10-26");
  f.calls[3].resolve(
    candidatePage(1, {
      signalDate: "2026-10-26",
      rows: [{ ...candidatePage(1).rows[0], name: "<script>unsafe</script>" }],
    }),
  );
  await f.flush();
  f.calls[2].reject(new Error("已过时的失败"));
  await f.flush();
  assert.ok(
    !f.element("paper-entry-candidates-rows").innerHTML.includes("<script>"),
  );
  assert.match(
    f.element("paper-entry-candidates-summary").textContent,
    /2026-10-26/,
  );
  assert.equal(f.element("paper-entry-candidates-message").textContent, "");
});

const ledgerPage = (page, date = "2026-10-23", fields = {}) => ({
  date,
  page,
  pageSize: 10,
  total: 25,
  totalPages: 3,
  rows: [
    {
      date,
      time: "09:33:46",
      code: "000001",
      name: `第${page}页合成样本`,
      action: "OPEN",
      side: "BUY",
      buyPoint: "auction-dip",
      quantity: 2500,
      priceCents: 907,
      notionalCents: 2267500,
      feeCents: 645,
      cashDeltaCents: -2268145,
      ...fields,
    },
  ],
});
function clickLedgerPage(f, page) {
  f.element("paper-entry-ledger-pager").onclick({
    target: {
      closest: () => ({
        disabled: false,
        dataset: { entryLedgerPage: String(page) },
      }),
    },
  });
}
function openLedger(f, date = "2026-10-23") {
  f.element("paper-entry-observation-detail").onclick({
    target: { closest: () => ({ dataset: { entryLedgerDate: date } }) },
  });
}

test("历史成交默认查全部日期，按日查询从第一页开始，旧翻页响应不能覆盖新日期", async (t) => {
  const f = browserFixture(t);
  openLedger(f, "");
  assert.equal(
    new URL(f.calls[0].path, "http://localhost").searchParams.get("date"),
    "",
  );
  f.calls[0].resolve({ ...ledgerPage(1), date: "" });
  await f.flush();
  assert.match(
    f.element("paper-entry-ledger-summary").textContent,
    /全部交易日/,
  );
  assert.match(f.element("paper-entry-ledger-rows").innerHTML, /2026-10-23/);
  clickLedgerPage(f, 2);
  f.element("paper-entry-ledger-date").value = "2026-10-24";
  f.element("paper-entry-ledger-filter").onsubmit({ preventDefault() {} });
  const filteredQuery = new URL(f.calls[2].path, "http://localhost")
    .searchParams;
  assert.equal(filteredQuery.get("date"), "2026-10-24");
  assert.equal(filteredQuery.get("page"), "1");
  f.calls[2].resolve({
    ...ledgerPage(1, "2026-10-24"),
    total: 0,
    totalPages: 1,
    rows: [],
  });
  await f.flush();
  f.calls[1].resolve({ ...ledgerPage(2), date: "" });
  await f.flush();
  assert.match(
    f.element("paper-entry-ledger-summary").textContent,
    /2026-10-24/,
  );
  assert.match(f.element("paper-entry-ledger-rows").innerHTML, /全部日期/);
  assert.doesNotMatch(f.element("paper-entry-ledger-rows").innerHTML, /第2页/);
  f.element("paper-entry-ledger-all-dates").onclick();
  assert.equal(f.element("paper-entry-ledger-date").value, "");
  assert.equal(
    new URL(f.calls[3].path, "http://localhost").searchParams.get("date"),
    "",
  );
  assert.equal(
    new URL(f.calls[3].path, "http://localhost").searchParams.get("page"),
    "1",
  );
  f.calls[3].resolve({ ...ledgerPage(1), date: "", total: 5, totalPages: 1 });
  await f.flush();
  assert.match(f.element("paper-entry-ledger-rows").innerHTML, /2026-10-23/);
});

test("点击影子成交数打开独立弹窗，每次只请求所选交易日的一页，翻页失败保留当前页", async (t) => {
  const f = browserFixture(t);
  f.element("paper-entry-observe").onclick();
  f.calls[0].resolve({
    requested: true,
    session: { date: "2026-10-23", fillCount: 5 },
  });
  await f.flush();
  assert.match(
    f.element("paper-entry-observation-detail").innerHTML,
    /data-entry-ledger-date="2026-10-23"/,
  );
  assert.match(
    f.element("paper-entry-observation-detail").innerHTML,
    /5 笔 · 查看明细/,
  );
  openLedger(f);
  assert.equal(f.element("paper-entry-ledger-dialog").open, true);
  assert.equal(f.element("paper-entry-observation-dialog").open, true);
  const query = new URL(f.calls[1].path, "http://localhost");
  assert.equal(query.pathname, "/api/paper/entry-observation/ledger");
  assert.equal(query.searchParams.get("date"), "2026-10-23");
  assert.equal(query.searchParams.get("pageSize"), "10");
  assert.equal(query.searchParams.get("page"), "1");
  assert.equal(f.calls[1].body, undefined);
  f.calls[1].resolve(ledgerPage(1));
  await f.flush();
  const rows = f.element("paper-entry-ledger-rows");
  const pager = f.element("paper-entry-ledger-pager");
  assert.match(rows.innerHTML, /早盘竞价低吸/);
  assert.match(rows.innerHTML, /22,675\.00/);
  assert.match(rows.innerHTML, /6\.45/);
  assert.match(pager.innerHTML, /第 1 \/ 3 页 · 共 25 笔/);
  clickLedgerPage(f, 2);
  assert.equal(
    new URL(f.calls[2].path, "http://localhost").searchParams.get("page"),
    "2",
  );
  assert.match(pager.innerHTML, /disabled/);
  clickLedgerPage(f, 3);
  assert.equal(f.calls.length, 3);
  f.calls[2].resolve(ledgerPage(2));
  await f.flush();
  assert.match(rows.innerHTML, /第2页合成样本/);
  assert.match(pager.innerHTML, /第 2 \/ 3 页/);
  clickLedgerPage(f, 3);
  f.calls[3].reject(new Error("连接中断"));
  await f.flush();
  assert.match(rows.innerHTML, /第2页合成样本/);
  assert.match(pager.innerHTML, /第 2 \/ 3 页/);
  assert.match(f.element("paper-entry-ledger-message").textContent, /连接中断/);
  assert.equal(f.element("paper-entry-ledger-refresh").disabled, false);
  f.element("paper-entry-ledger-close").onclick();
  assert.equal(f.element("paper-entry-ledger-dialog").open, false);
  assert.equal(f.element("paper-entry-observation-dialog").open, true);
});

test("关闭重开后丢弃旧响应，页数很大时精简页码，空结果与出错可重试", async (t) => {
  const f = browserFixture(t);
  openLedger(f);
  f.element("paper-entry-ledger-close").onclick();
  openLedger(f, "2026-10-26");
  f.calls[1].resolve({
    ...ledgerPage(9000, "2026-10-26", { name: "<script>unsafe</script>" }),
    totalPages: 10000,
    total: 100000,
  });
  await f.flush();
  f.calls[0].resolve(ledgerPage(1));
  await f.flush();
  const rows = f.element("paper-entry-ledger-rows");
  const pager = f.element("paper-entry-ledger-pager");
  assert.ok(!rows.innerHTML.includes("<script>"));
  assert.match(rows.innerHTML, /2026-10-26/);
  assert.match(pager.innerHTML, /第 9000 \/ 10000 页/);
  assert.ok(
    (pager.innerHTML.match(/data-entry-ledger-page=/g) ?? []).length <= 7,
  );
  openLedger(f);
  f.calls[2].reject(new Error("服务暂不可用"));
  await f.flush();
  assert.match(
    f.element("paper-entry-ledger-message").textContent,
    /服务暂不可用/,
  );
  f.element("paper-entry-ledger-refresh").onclick();
  f.calls[3].resolve({
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 1,
    rows: [],
  });
  await f.flush();
  assert.match(rows.innerHTML, /暂无影子模拟成交/);
  assert.match(pager.innerHTML, /第 1 \/ 1 页 · 共 0 笔/);
});

test("明细显示不同批次盈亏，个股与账户汇总单独展示且翻页不重复累加", async (t) => {
  const f = browserFixture(t);
  const pnl = {
    baselineDate: "2026-10-23",
    baselineEquityCents: 97118010,
    equityCents: 97538982,
    totalPnlCents: 420972,
    totalReturn: 420972 / 97118010,
    unrealizedPnlCents: 420972,
    updatedAt: "2026-10-23T09:02:14.709Z",
  };
  const stockPnl = {
    code: "000001",
    name: "汇总样本",
    quantity: 9100,
    markCents: 953,
    markDate: "2026-10-23",
    totalPnlCents: 420972,
    unrealizedPnlCents: 420972,
    unrealizedReturn: 420972 / 8251328,
  };
  const fillPnl = {
    kind: "UNREALIZED",
    remainingQuantity: 2500,
    pnlCents: 114355,
    return: 114355 / 2268145,
  };
  openLedger(f);
  f.calls[0].resolve({
    ...ledgerPage(1, "2026-10-23", { stockPnl, fillPnl }),
    pnl,
    stocks: [stockPnl],
  });
  await f.flush();
  const metrics = f.element("paper-entry-ledger-pnl");
  const rows = f.element("paper-entry-ledger-rows");
  assert.match(metrics.innerHTML, /观察期总体盈亏/);
  assert.match(metrics.innerHTML, /\+4,209\.72/);
  assert.match(metrics.innerHTML, /\+0\.43%/);
  assert.match(metrics.innerHTML, /975,389\.82/);
  assert.match(metrics.innerHTML, /971,180\.10/);
  assert.match(metrics.innerHTML, /17:02:14/);
  assert.match(rows.innerHTML, /9\.53/);
  assert.match(rows.innerHTML, /估值日 2026-10-23/);
  assert.match(rows.innerHTML, /本批剩余 2500 股/);
  assert.match(rows.innerHTML, /\+1,143\.55/);
  assert.match(rows.innerHTML, /\+5\.04%/);
  assert.doesNotMatch(rows.innerHTML, /\+4,209\.72/);
  const stocks = f.element("paper-entry-ledger-stocks");
  assert.match(stocks.innerHTML, /个股盈亏汇总 · 1 只/);
  assert.match(stocks.innerHTML, /\+4,209\.72/);
  assert.equal(f.element("paper-entry-ledger-pnl-note").hidden, false);
  const initialMetrics = metrics.innerHTML;
  const initialStocks = stocks.innerHTML;
  clickLedgerPage(f, 2);
  f.calls[1].resolve({
    ...ledgerPage(2, "2026-10-23", {
      stockPnl,
      fillPnl: { ...fillPnl, remainingQuantity: 1700, pnlCents: 72501 },
    }),
    pnl,
    stocks: [stockPnl],
  });
  await f.flush();
  assert.equal(metrics.innerHTML, initialMetrics);
  assert.match(rows.innerHTML, /第2页合成样本/);
  assert.match(rows.innerHTML, /\+725\.01/);
  assert.doesNotMatch(rows.innerHTML, /\+1,143\.55|\+4,209\.72/);
  assert.equal(stocks.innerHTML, initialStocks);
  clickLedgerPage(f, 3);
  f.calls[2].reject(new Error("连接中断"));
  await f.flush();
  assert.equal(metrics.innerHTML, initialMetrics);
  assert.equal(stocks.innerHTML, initialStocks);
});

test("负盈亏、已清仓和估值缺失分别显示，不把未知金额当成零", async (t) => {
  const f = browserFixture(t);
  openLedger(f);
  const result = ledgerPage(1, "2026-10-23", {
    stockPnl: { quantity: 0, totalPnlCents: -2200, markCents: null },
    fillPnl: { kind: "REALIZED", pnlCents: -2200, return: -0.02 },
    side: "SELL",
  });
  result.rows.push({
    ...result.rows[0],
    side: "BUY",
    fillPnl: { kind: "UNREALIZED", remainingQuantity: 0, pnlCents: 0 },
    stockPnl: null,
  });
  result.rows.push({ ...result.rows[0], fillPnl: null, stockPnl: null });
  result.pnl = {
    totalPnlCents: -1500,
    totalReturn: -0.0015,
    unrealizedPnlCents: -1000,
  };
  f.calls[0].resolve(result);
  await f.flush();
  assert.match(
    f.element("paper-entry-ledger-pnl").innerHTML,
    /class="down">¥ -15\.00/,
  );
  assert.match(
    f.element("paper-entry-ledger-rows").innerHTML,
    /class="down">-22\.00/,
  );
  assert.match(
    f.element("paper-entry-ledger-rows").innerHTML,
    /本笔卖出已实现/,
  );
  assert.match(f.element("paper-entry-ledger-rows").innerHTML, /本批已卖出/);
  assert.match(
    f.element("paper-entry-ledger-rows").innerHTML,
    /暂无本笔盈亏记录/,
  );
  assert.match(f.element("paper-entry-ledger-rows").innerHTML, /<td>—<\/td>/);
});
