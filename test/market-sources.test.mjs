import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { localDatabase } from "../scripts/local-db.mjs";
import { api } from "../backend/routes/api.js";
import { closeDB } from "../backend/services/tag-contribution.js";

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
// 同花顺只补全涨停原因等独有字段，失败不得影响行情返回，也不进入用户可见告警。
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

function endpointOf(address) {
  const url = new URL(address);
  if (url.hostname === "push2ex.eastmoney.com") return url.pathname.slice(1);
  return `ths:${url.pathname.replace("/api/a-share/special-data/", "")}`;
}

function installProvider(thsRespond) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (address) => {
    const url = new URL(address);
    const endpoint = endpointOf(address);
    calls.push(endpoint);
    // 东财用 qdate 回显请求日期，与生产契约一致；错日行情会被上层拒绝。
    const qdate = url.searchParams.get("date");
    if (endpoint === "getTopicZTPool")
      return Response.json({ rc: 0, data: { qdate, pool: [POOL_ROW] } });
    if (endpoint === "getTopicZBPool")
      return Response.json({ rc: 0, data: { qdate, pool: [] } });
    if (endpoint === "getYesterdayZTPool")
      return Response.json({ rc: 0, data: { qdate, pool: YESTERDAY_ROWS } });
    if (endpoint === "ths:limit-up-pool") return thsRespond();
    throw new Error(`unexpected provider call: ${endpoint}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function withThsSupplement(thsBody, run) {
  const originalKey = process.env.FU_YAO_API_KEY;
  process.env.FU_YAO_API_KEY = "sk-synthetic-supplement";
  const provider = installProvider(() => Response.json(thsBody));
  try {
    return await run(provider.calls);
  } finally {
    provider.restore();
    if (originalKey === undefined) delete process.env.FU_YAO_API_KEY;
    else process.env.FU_YAO_API_KEY = originalKey;
  }
}

test("同花顺补全失败时仍返回东财主数据，且不产生用户可见告警", async () => {
  const DB = localDatabase();
  try {
    await withThsSupplement(
      { code: 5003, message: "synthetic supplement failure" },
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
        // 炸板池/跌停池/连板天梯改回东财口径，不再请求同花顺
        assert.ok(
          !calls.some((endpoint) =>
            [
              "ths:limit-break-pool",
              "ths:limit-down-pool",
              "ths:limit-up-ladder",
            ].includes(endpoint),
          ),
          `同花顺只允许补全涨停原因，实际请求：${calls.join(",")}`,
        );
      },
    );
  } finally {
    DB.close();
  }
});

test("同花顺涨停原因补全成功时不改变东财口径与行数", async () => {
  const DB = localDatabase();
  try {
    await withThsSupplement(
      {
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
        assert.deepEqual(body.warnings, []);
      },
    );
  } finally {
    DB.close();
  }
});
