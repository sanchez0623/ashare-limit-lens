import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { api } from "../backend/routes/api.js";
import { selectionSnapshotDigest } from "../backend/domain/signal-selection.js";
import { INTRADAY_ENTRY_RULES } from "../backend/domain/intraday-entry.js";
import { ENTRY_OBSERVER_ID } from "../backend/services/entry-observation.js";
import { entryObservationCandidates } from "../backend/services/entry-observation-candidates.js";

async function seed(
  DB,
  { accountId = ENTRY_OBSERVER_ID, date = "2026-10-23", count = 83 } = {},
) {
  const candidates = Array.from({ length: count }, (_, index) =>
    String(100000 + index),
  );
  const history = Object.fromEntries(
    candidates.map((code, index) => [
      code,
      {
        name: `冻结样本${index}`,
        sector: "机械",
        stockClass: index < 2 ? "relay-leader" : "strong-reversal",
        previousCloseCents: 1000,
        recentLimitUp: true,
        amount: index === 0 ? 1e8 : 4e8,
      },
    ]),
  );
  history["999999"] = { ...history[candidates[0]], name: "仅有历史不在观察池" };
  const stock = (code, index) => ({
    code,
    name: history[code].name,
    stockClass: history[code].stockClass,
    stockClassReason: "冻结分类依据",
    score: 90 - index,
    rawScore: 90.4 - index,
    deduction: 0,
    factors: [
      { name: "封板质量", value: 100, weight: 30, description: "冻结因子公式" },
    ],
    risks: [],
    buyPoint:
      index % 3 === 0
        ? {
            primary: { type: "limit-up-momentum", reason: "冻结首封依据" },
            all: [{ type: "limit-up-momentum", reason: "冻结首封依据" }],
          }
        : null,
  });
  const snapshot = {
    date,
    stocks: candidates.slice(0, -2).map(stock).reverse(),
    brokenStocks: [stock(candidates.at(-2), count - 2)],
    sectors: [],
  };
  const digest = await selectionSnapshotDigest(snapshot);
  await DB.prepare(
    "INSERT INTO strategy_signal_snapshots(digest,signal_date,payload) VALUES(?,?,?) ON CONFLICT DO NOTHING",
  )
    .bind(digest, date, JSON.stringify(snapshot))
    .run();
  const plan = {
    signalDate: date,
    createdAt: `${date}T09:02:14.557Z`,
    entryExecutionPolicy: {
      version: INTRADAY_ENTRY_RULES.version,
      rules: INTRADAY_ENTRY_RULES,
      sourceDate: date,
      history,
      candidates,
      firstNegMinPrevHeight: 3,
    },
    selectionAudit: {
      snapshotDigest: digest,
      candidates: [
        {
          code: candidates[0],
          status: "SKIPPED",
          reason: "原开盘计划不等于盘中条件",
        },
      ],
    },
  };
  await DB.prepare(
    "INSERT INTO shadow_plans(account_id,signal_date,payload,digest,created_at) VALUES(?,?,?,?,?)",
  )
    .bind(
      accountId,
      date,
      JSON.stringify(plan),
      `plan-${accountId}-${date}`,
      plan.createdAt,
    )
    .run();
  return { plan, snapshot, digest, candidates };
}

test("候选明细只读指定影子账户的冻结83只，保留顺序、分页、分类及历史依据", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const fixture = await seed(DB);
  await seed(DB, { accountId: "other-shadow", date: "2026-10-26", count: 5 });
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
  for (let page = 1; page <= 9; page++) {
    const response = await api(
      new Request(
        `http://localhost/api/paper/entry-observation/candidates?signalDate=2026-10-23&page=${page}&accountId=other-shadow`,
      ),
      env,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.page, page);
    assert.equal(result.total, 83);
    assert.equal(result.candidateTotal, 83);
    assert.equal(result.totalPages, 9);
    assert.equal(result.pageSize, 10);
    assert.equal(result.rows.length, page === 9 ? 3 : 10);
    assert.equal(result.signalDate, fixture.plan.signalDate);
    assert.equal(result.planDigest, `plan-${ENTRY_OBSERVER_ID}-2026-10-23`);
    seen.push(...result.rows.map((row) => row.code));
    if (page === 1) {
      const row = result.rows[0];
      assert.equal(row.rank, 1);
      assert.equal(row.score, 90);
      assert.equal(row.stockClassLabel, "连板龙头型");
      assert.equal(row.stockClassReason, "冻结分类依据");
      assert.equal(row.buyPoints.length, 1);
      assert.equal(row.buyPoints[0].reason, "冻结首封依据");
      assert.equal(row.scoring.factors[0].description, "冻结因子公式");
      assert.equal(row.readiness, "WAITING_TURNOVER");
      assert.equal(
        row.checks.find((check) => check.key === "amount").passed,
        false,
      );
      assert.equal(row.status, undefined);
      assert.equal(result.rows[1].readiness, "STATIC_READY");
      assert.equal(result.rows[1].buyPoints.length, 0);
      assert.deepEqual(
        result.summary.stockClasses.map(({ key, count }) => [key, count]),
        [
          ["relay-leader", 2],
          ["strong-reversal", 81],
        ],
      );
    } else if (page === 9) {
      assert.equal(result.rows[1].source, "broken");
      assert.equal(result.rows[2].source, "history");
      assert.equal(result.rows[2].score, null);
      assert.equal(result.rows[2].scoring, null);
      assert.match(result.rows[2].stockClassReason, /未保存/);
    }
  }
  assert.deepEqual(seen, fixture.candidates);
  assert.ok(queries.every((sql) => /^\s*SELECT\b/i.test(sql)));
  assert.equal((await entryObservationCandidates({ DB })).candidateTotal, 83);
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS n FROM paper_accounts").first()).n,
    0,
  );
  assert.equal(
    (await DB.prepare("SELECT COUNT(*) AS n FROM settings").first()).n,
    0,
  );
});

test("名称代码、股票类型、信号日买点联合筛选，分页越界归一且不改入池顺序", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  await seed(DB);
  const get = async (query) =>
    (
      await api(
        new Request(
          `http://localhost/api/paper/entry-observation/candidates?${query}`,
        ),
        { DB },
      )
    ).json();
  const result = await get(
    "q=冻结样本1&stockClass=strong-reversal&buyPoint=limit-up-momentum&pageSize=2&page=999",
  );
  assert.equal(result.candidateTotal, 83);
  assert.equal(result.total, 3);
  assert.equal(result.page, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].rank, 19);
  const noPoints = await get("stockClass=relay-leader&buyPoint=unclassified");
  assert.equal(noPoints.total, 1);
  assert.equal(noPoints.rows[0].code, "100001");
  assert.equal((await get("q=100001")).total, 1);
  const none = await get("q=找不到&page=99");
  assert.equal(none.page, 1);
  assert.equal(none.totalPages, 1);
  assert.deepEqual(none.rows, []);
  const invalid = await get("page=NaN&pageSize=Infinity");
  assert.equal(invalid.page, 1);
  assert.equal(invalid.pageSize, 10);
  const capped = await get("page=-3&pageSize=999");
  assert.equal(capped.page, 1);
  assert.equal(capped.pageSize, 100);
});

test("拒绝非法筛选和写入，缺少计划或原始快照时明确报错，不能回退到当前数据", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const get = (query = "", method = "GET") =>
    api(
      new Request(
        `http://localhost/api/paper/entry-observation/candidates${query}`,
        { method },
      ),
      { DB },
    );
  assert.equal((await get()).status, 404);
  for (const query of [
    "?signalDate=2026-02-30",
    "?signalDate=invalid",
    "?stockClass=invalid",
    "?buyPoint=invalid",
    `?q=${"x".repeat(65)}`,
  ])
    assert.equal((await get(query)).status, 400);
  assert.equal((await get("", "POST")).status, 405);
  const fixture = await seed(DB);
  assert.equal((await get("?signalDate=2026-10-22")).status, 404);
  // 归档表不可改写，读取适配器模拟损坏或丢失的快照。
  const readArchive = (payload) => ({
    DB: {
      prepare(sql) {
        if (!sql.includes("FROM strategy_signal_snapshots"))
          return DB.prepare(sql);
        return {
          bind() {
            return this;
          },
          async first() {
            return payload === null
              ? null
              : { payload, signal_date: fixture.plan.signalDate };
          },
        };
      },
    },
  });
  const corrupt = await api(
    new Request("http://localhost/api/paper/entry-observation/candidates"),
    readArchive(JSON.stringify({ ...fixture.snapshot, stocks: [] })),
  );
  assert.equal(corrupt.status, 503);
  assert.match((await corrupt.json()).error, /快照缺失或摘要不一致/);
  assert.equal(
    (
      await api(
        new Request("http://localhost/api/paper/entry-observation/candidates"),
        readArchive(null),
      )
    ).status,
    503,
  );
});
