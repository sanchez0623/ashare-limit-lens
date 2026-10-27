import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { localDatabase } from "../scripts/local-db.mjs";
import { api } from "../backend/routes/api.js";
import { closeDB } from "../backend/services/tag-contribution.js";
import { marketData } from "../backend/services/market.js";
import { clearCache } from "../backend/services/fuyao.js";

// 标签收益库指向临时文件：本文件会注入涨停原因，不能污染真实 data/tag-contribution.db。
const TAG_DB_PATH = join(
  tmpdir(),
  `limit-lens-tag-contribution-${process.pid}.db`,
);
process.env.TAG_CONTRIBUTION_DB_PATH = TAG_DB_PATH;
test.after(() => {
  closeDB();
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    rmSync(`${TAG_DB_PATH}${suffix}`, { force: true });
});

// 数据源契约：东财是涨停池/炸板池/昨日涨停池的唯一主源；
// 同花顺补全四个源（涨停原因/炸板开板次数/跌停池/连板天梯），失败不得影响
// 行情返回，也不进入用户可见告警。
const POOL_ROW = {
  c: "600001",
  n: "合成测试样本",
  p: 10000,
  hybk: "测试行业",
  amount: 1e8,
  fund: 1e7,
  hs: 8,
  fbt: 93500,
  lbt: 93500,
  zbc: 0,
  lbc: 2,
};
const YESTERDAY_ROWS = [
  { c: "600001", n: "合成测试样本", ylbc: 1 },
  { c: "600002", n: "合成昨日二板", ylbc: 2 },
];

const THS_ENDPOINTS = [
  "ths:limit-up-pool",
  "ths:limit-break-pool",
  "ths:limit-down-pool",
  "ths:limit-up-ladder",
];

function endpointOf(address) {
  const url = new URL(address);
  if (url.hostname === "push2ex.eastmoney.com") return url.pathname.slice(1);
  return `ths:${url.pathname.replace("/api/a-share/special-data/", "")}`;
}

// thsRespond(endpoint) -> 响应体对象；按端点区分成功/失败。
function installProvider(thsRespond) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (address) => {
    const url = new URL(address);
    const endpoint = endpointOf(address);
    calls.push(endpoint);
    const qdate = url.searchParams.get("date");
    if (endpoint === "getTopicZTPool")
      return Response.json({ rc: 0, data: { qdate, pool: [POOL_ROW] } });
    if (endpoint === "getTopicZBPool")
      return Response.json({ rc: 0, data: { qdate, pool: [] } });
    if (endpoint === "getYesterdayZTPool")
      return Response.json({ rc: 0, data: { qdate, pool: YESTERDAY_ROWS } });
    if (endpoint.startsWith("ths:")) return Response.json(thsRespond(endpoint));
    throw new Error(`unexpected provider call: ${endpoint}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function withThsSupplement(thsRespond, run) {
  clearCache();
  const originalKey = process.env.FU_YAO_API_KEY;
  process.env.FU_YAO_API_KEY = "sk-synthetic-supplement";
  const provider = installProvider(thsRespond);
  try {
    return await run(provider.calls);
  } finally {
    clearCache();
    provider.restore();
    if (originalKey === undefined) delete process.env.FU_YAO_API_KEY;
    else process.env.FU_YAO_API_KEY = originalKey;
  }
}

test("盘中30秒缓存与展示两分钟缓存独立，缓存命中不重写采集时间，空炸板池保留零", async () => {
  const DB = localDatabase(),
    originalNow = Date.now;
  const started = originalNow();
  let elapsed = 0;
  Date.now = () => started + elapsed;
  try {
    await withThsSupplement(
      () => ({ code: 0, data: { item: [], total: 0 } }),
      async (calls) => {
        const day = "2026-09-24",
          options = { cacheScope: "intraday", cacheTtlMs: 30000 };
        const displayed = await marketData(day, { DB });
        const original = await marketData(day, { DB }, options);
        assert.equal(calls.filter((c) => c === "getTopicZTPool").length, 2);
        elapsed = 25000;
        const cached = await marketData(day, { DB }, options);
        assert.equal(cached.cached, true);
        assert.equal(cached.fetchedAt, original.fetchedAt);
        assert.equal(cached.broken, 0);
        assert.deepEqual(cached.brokenRows, []);
        elapsed = 31000;
        assert.equal((await marketData(day, { DB }, options)).cached, false);
        assert.equal(calls.filter((c) => c === "getTopicZTPool").length, 3);
        assert.equal(
          (await marketData(day, { DB })).fetchedAt,
          displayed.fetchedAt,
        );
        assert.equal(calls.filter((c) => c === "getTopicZTPool").length, 3);
      },
    );
  } finally {
    Date.now = originalNow;
    DB.close();
  }
});

test("同花顺四路补全全部失败时仍返回东财主数据，零用户可见告警", async () => {
  const DB = localDatabase();
  try {
    await withThsSupplement(
      () => ({ code: 5003, message: "synthetic supplement failure" }),
      async (calls) => {
        const response = await api(
          new Request("http://localhost/api/market?date=2026-09-25"),
          { DB },
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.date, "2026-09-25");
        assert.equal(body.rows.length, 1, "东财涨停池行数不得因补全失败而变化");
        assert.equal(body.rows[0].c, POOL_ROW.c);
        assert.equal(body.source, "东方财富公开行情");
        assert.deepEqual(body.warnings, [], "补全失败不得进入用户可见告警");
        assert.equal(body.thsData.available, false);
        assert.equal(body.thsData.supplementedCount, 0);
        assert.equal(body.thsData.limitDownPool, null);
        assert.equal(body.thsData.limitUpLadder, null);
        // 四路同花顺补全都应被请求（跌停池/连板天梯重新接回）
        for (const ep of THS_ENDPOINTS)
          assert.ok(
            calls.includes(ep),
            `${ep} 应被请求，实际：${calls.join(",")}`,
          );
      },
    );
  } finally {
    DB.close();
  }
});

test("同花顺补全成功：涨停原因注入、跌停池与连板天梯落入 thsData", async () => {
  const DB = localDatabase();
  try {
    await withThsSupplement(
      (endpoint) => {
        if (endpoint === "ths:limit-up-pool")
          return {
            code: 0,
            data: {
              item: [
                {
                  ticker: POOL_ROW.c,
                  limit_up_reason: "新能源+储能",
                  max_seal_money: 987654321,
                  is_st: false,
                  is_new: false,
                },
              ],
              total: 1,
            },
          };
        if (endpoint === "ths:limit-down-pool")
          return {
            code: 0,
            data: {
              item: [
                {
                  ticker: "000002",
                  name: "跌停样本",
                  last_price: 9.8,
                  price_change_ratio_pct: -10,
                },
              ],
              total: 1,
            },
          };
        if (endpoint === "ths:limit-up-ladder")
          return {
            code: 0,
            data: {
              item: [
                {
                  date: "2026-09-28",
                  boards: { two_board: [], three_board: [] },
                },
              ],
            },
          };
        // 炸板池：空（无匹配）
        return { code: 0, data: { item: [], total: 0 } };
      },
      async () => {
        const response = await api(
          new Request("http://localhost/api/market?date=2026-09-28"),
          { DB },
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.rows.length, 1, "补全不得增删东财涨停池行");
        assert.equal(body.rows[0].c, POOL_ROW.c);
        assert.equal(body.rows[0].limitUpReason, "新能源+储能");
        assert.equal(body.rows[0].maxSealMoney, 987654321);
        assert.equal(body.source, "东方财富公开行情（同花顺补全涨停原因）");
        assert.equal(body.thsData.supplementedCount, 1);
        assert.equal(body.thsData.available, true);
        assert.equal(body.thsData.limitDownPool?.length, 1);
        assert.equal(body.thsData.limitDownPool[0].ticker, "000002");
        assert.equal(body.thsData.limitUpLadder?.length, 1);
        assert.deepEqual(body.warnings, []);
      },
    );
  } finally {
    DB.close();
  }
});
