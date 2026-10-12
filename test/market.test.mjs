import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { api } from "../backend/routes/api.js";
import { marketForDisplay } from "../backend/services/market-display.js";
import { getPool } from "../backend/services/market.js";
import { saveSnapshot } from "../backend/services/review.js";
import { analyze, normalize, PRESETS } from "../shared/scoring.js";

const DATE = "2026-10-09";
const raw = {
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
function oldSnapshot() {
  const scored = analyze([normalize(raw)], 2);
  scored.stocks[0].score = 71;
  scored.sectors[0].score = 83;
  return {
    date: DATE,
    createdAt: `${DATE}T07:10:00.000Z`,
    source: "合成归档测试",
    weights: PRESETS.balanced,
    stocks: scored.stocks,
    sectors: scored.sectors,
    emotion: 69,
  };
}
async function insertArchive(DB, snapshot = oldSnapshot(), date = DATE) {
  await DB.prepare(
    "INSERT INTO snapshots (trade_date,created_at,payload) VALUES (?,?,?)",
  )
    .bind(date, snapshot.createdAt, JSON.stringify(snapshot))
    .run();
}
const request = (date) =>
  new Request(`http://localhost/api/market?date=${date}`);

test("历史 API 优先读取旧快照：上游不可用时保留冻结评分，不改写归档", async () => {
  const DB = localDatabase();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("synthetic provider unavailable");
  };
  try {
    const snapshot = oldSnapshot();
    await insertArchive(DB, snapshot);
    await DB.prepare("INSERT INTO settings (key,value) VALUES ('weights',?)")
      .bind(JSON.stringify(PRESETS.relay))
      .run();
    const response = await api(request(DATE), { DB });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(calls, 0);
    assert.equal(payload.archived, true);
    assert.equal(payload.date, DATE);
    assert.deepEqual(payload.analysis.stocks, snapshot.stocks);
    assert.deepEqual(payload.analysis.sectors, snapshot.sectors);
    assert.equal(payload.analysis.emotion, 69);
    assert.equal(payload.analysis.count, 1);
    assert.equal(payload.analysis.sealRate, null);
    assert.equal(payload.analysis.emotionCoverage, null);
    assert.equal(payload.rows, null);
    const stored = await DB.prepare("SELECT payload FROM snapshots").first();
    assert.deepEqual(JSON.parse(stored.payload), snapshot);
  } finally {
    globalThis.fetch = originalFetch;
    DB.close();
  }
});

test("历史无归档且上游返回其他日期：拒绝错日行情并说明归档缺失", async () => {
  const DB = localDatabase();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ rc: 0, data: { qdate: "20261012", pool: [raw] } });
  try {
    const response = await api(request("2026-10-08"), { DB });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.match(payload.error, /2026-10-08 尚无盘后归档/);
    assert.match(payload.error, /请求 2026-10-08，来源 2026-10-12/);
    assert.equal(payload.rows, undefined);
    assert.equal(
      (await DB.prepare("SELECT COUNT(*) AS n FROM snapshots").first()).n,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
    DB.close();
  }
});

test("无归档但来源日期匹配时仍可查询公开历史，不补造盘后快照", async () => {
  const DB = localDatabase();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const date = new URL(url).searchParams.get("date");
    return Response.json({ rc: 0, data: { qdate: date, pool: [raw] } });
  };
  try {
    const response = await api(request("2026-10-07"), { DB });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.date, "2026-10-07");
    assert.deepEqual(payload.rows, [raw]);
    assert.notEqual(payload.archived, true);
    assert.equal(
      (await DB.prepare("SELECT COUNT(*) AS n FROM snapshots").first()).n,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
    DB.close();
  }
});

test("当天查询仍优先新行情，来源失败才读取已冻结的当日归档", async () => {
  const DB = localDatabase();
  try {
    await insertArchive(DB);
    let calls = 0;
    const live = { date: DATE, rows: [raw], source: "合成实时测试" };
    assert.equal(
      await marketForDisplay({ DB }, DATE, {
        today: DATE,
        loadMarket: async () => {
          calls++;
          return live;
        },
      }),
      live,
    );
    assert.equal(calls, 1);
    const archive = await marketForDisplay({ DB }, DATE, {
      today: DATE,
      loadMarket: async () => {
        throw new Error("synthetic source failed");
      },
    });
    assert.equal(archive.archived, true);
    assert.equal(archive.analysis.stocks[0].score, 71);
  } finally {
    DB.close();
  }
});

test("归档自身日期不一致时拒绝展示，不把错误快照当所选日期", async () => {
  const DB = localDatabase();
  try {
    await insertArchive(DB, { ...oldSnapshot(), date: "2026-10-08" });
    let called = false;
    await assert.rejects(
      marketForDisplay({ DB }, DATE, {
        today: "2026-10-12",
        loadMarket: async () => {
          called = true;
        },
      }),
      /历史归档日期或内容不一致/,
    );
    assert.equal(called, false);
  } finally {
    DB.close();
  }
});

test("新盘后快照同时归档原始行情与统计，重复保存不改写已冻结判断", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse(`${DATE}T07:20:00.000Z`),
  });
  const DB = localDatabase();
  try {
    const market = {
      date: DATE,
      source: "合成盘后测试",
      fetchedAt: `${DATE}T07:19:00.000Z`,
      rows: [raw, { ...raw, c: "600002", n: "ST合成样本" }],
      broken: 2,
      previous: [{ ...raw, lbc: 1 }],
    };
    const first = await saveSnapshot({ DB }, market, PRESETS.balanced);
    assert.equal(first.saved, true);
    const expected = analyze(
      market.rows.map(normalize),
      market.broken,
      market.previous.map(normalize),
    );
    const archive = await marketForDisplay({ DB }, DATE, {
      today: "2026-10-12",
      loadMarket: async () => {
        throw new Error("archive must not require provider");
      },
    });
    assert.deepEqual(archive.analysis, expected);
    assert.deepEqual(archive.rows, market.rows);
    assert.equal(archive.broken, 2);
    assert.equal(archive.analysis.promotion, 100);
    const before = await DB.prepare("SELECT payload FROM snapshots").first();
    const repeated = await saveSnapshot(
      { DB },
      { ...market, rows: [] },
      PRESETS.relay,
    );
    assert.equal(repeated.existing, true);
    assert.deepEqual(
      await DB.prepare("SELECT payload FROM snapshots").first(),
      before,
    );
  } finally {
    DB.close();
  }
});
