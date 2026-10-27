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

test("盘中查询优先新行情，来源失败才读取已冻结的当日归档", async () => {
  const DB = localDatabase();
  try {
    await insertArchive(DB);
    let calls = 0;
    const live = { date: DATE, rows: [raw], source: "合成实时测试" };
    const displayed = await marketForDisplay({ DB }, DATE, {
      today: DATE,
      now: new Date(`${DATE}T10:00:00+08:00`),
      loadMarket: async () => {
        calls++;
        return live;
      },
    });
    // 行情本身保持引用不变，仅附加 MA5 供研究页首阴校验（未配置数据目录时为空对象）
    assert.equal(displayed.rows, live.rows);
    assert.equal(displayed.date, live.date);
    assert.deepEqual(displayed.ma5ByCode, {});
    assert.equal(calls, 1);
    const archive = await marketForDisplay({ DB }, DATE, {
      today: DATE,
      now: new Date(`${DATE}T10:00:00+08:00`),
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

test("15:05起当天优先展示冻结快照，来源波动不会改变已归档市场阶段", async () => {
  const DB = localDatabase();
  try {
    const saved = oldSnapshot();
    saved.marketSummary = {
      count: 55,
      height: 4,
      cycle: { phase: "climax", label: "高潮期", score: 0.69 },
    };
    await insertArchive(DB, saved);
    let calls = 0;
    for (const time of ["15:05:00", "21:00:00"]) {
      const displayed = await marketForDisplay({ DB }, DATE, {
        today: DATE,
        now: new Date(`${DATE}T${time}+08:00`),
        loadMarket: async () => {
          calls++;
          throw new Error("冻结后不应访问行情源");
        },
      });
      assert.equal(displayed.archived, true);
      assert.deepEqual(displayed.analysis.cycle, saved.marketSummary.cycle);
      assert.equal(displayed.archivedAt, saved.createdAt);
    }
    assert.equal(calls, 0);
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
      PRESETS.balanced,
      // saveSnapshot 仅在收盘后执行，冻结评分按尾盘时点标注 lateSession
      { lateSession: true },
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
    assert.equal(
      JSON.parse(before.payload).downgradeRulesVersion,
      1,
      "新信号显式冻结降级规则版本",
    );
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

const yesterdayRows = (height = 1) => [
  { c: raw.c, n: raw.n, ylbc: height },
  { c: "600002", n: "合成昨日二板", ylbc: 2 },
];
for (const fixture of [
  {
    name: "ylbc 昨日池正常晋级",
    date: "2026-09-21",
    previous: yesterdayRows(),
    promotion: 50,
  },
  {
    name: "有效样本无人晋级",
    date: "2026-09-22",
    previous: yesterdayRows(2),
    promotion: 0,
  },
  {
    name: "昨日样本缺失",
    date: "2026-09-23",
    previous: [],
    promotion: null,
    warning: /昨日涨停池未返回有效样本/,
  },
  {
    name: "昨日连板字段缺失",
    date: "2026-09-24",
    previous: [{ c: raw.c, n: raw.n }],
    promotion: null,
    warning: /昨日连板字段缺失或无效/,
  },
]) {
  test(`实时 API、盘后归档和历史展示一致：${fixture.name}`, async (t) => {
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse(`${fixture.date}T07:20:00.000Z`),
    });
    const DB = localDatabase(),
      originalFetch = globalThis.fetch,
      calls = [];
    globalThis.fetch = async (address) => {
      const url = new URL(address),
        endpoint = url.pathname.slice(1);
      calls.push({ endpoint, date: url.searchParams.get("date") });
      assert.ok(
        ["getTopicZTPool", "getTopicZBPool", "getYesterdayZTPool"].includes(
          endpoint,
        ),
      );
      const pool =
        endpoint === "getTopicZTPool"
          ? [raw]
          : endpoint === "getYesterdayZTPool"
            ? fixture.previous
            : [];
      return Response.json({
        rc: 0,
        data: { qdate: fixture.date.replaceAll("-", ""), pool },
      });
    };
    try {
      const response = await api(request(fixture.date), { DB });
      assert.equal(response.status, 200);
      const payload = await response.json();
      const live = analyze(
        payload.rows.map(normalize),
        payload.broken,
        payload.previous?.map(normalize) ?? null,
      );
      assert.equal(live.promotion, fixture.promotion);
      if (fixture.warning)
        assert.ok(
          payload.warnings.some((warning) => fixture.warning.test(warning)),
        );
      else assert.deepEqual(payload.warnings, []);
      assert.equal(
        (await saveSnapshot({ DB }, payload, PRESETS.balanced)).saved,
        true,
      );
      const stored = await DB.prepare(
        "SELECT payload FROM snapshots WHERE trade_date=?",
      )
        .bind(fixture.date)
        .first();
      assert.equal(
        JSON.parse(stored.payload).marketSummary.promotion,
        fixture.promotion,
      );
      const archive = await marketForDisplay({ DB }, fixture.date, {
        today: "2026-09-30",
      });
      assert.equal(archive.analysis.promotion, fixture.promotion);
      assert.notEqual(
        archive.promotionBackfilled,
        true,
        "新归档已保存正确统计，无需补算",
      );
      assert.equal(
        (
          await DB.prepare("SELECT payload FROM snapshots WHERE trade_date=?")
            .bind(fixture.date)
            .first()
        ).payload,
        stored.payload,
      );
      assert.equal(calls.length, 3, "历史展示直接读取归档，不增加行情请求");
      assert.ok(
        calls.every((call) => call.date === fixture.date.replaceAll("-", "")),
      );
    } finally {
      globalThis.fetch = originalFetch;
      DB.close();
    }
  });
}

for (const expected of [50, 0]) {
  test(`旧归档只在展示补算晋级率 ${expected}%，快照与冻结评分保持不变`, async () => {
    const DB = localDatabase();
    try {
      const snapshot = oldSnapshot();
      snapshot.marketSummary = {
        ...analyze([normalize(raw)], 2),
        promotion: null,
        previousCount: 2,
      };
      delete snapshot.marketSummary.stocks;
      delete snapshot.marketSummary.sectors;
      delete snapshot.marketSummary.emotion;
      snapshot.market = {
        rows: [raw],
        previous: yesterdayRows(expected === 50 ? 1 : 2),
        broken: 2,
      };
      await insertArchive(DB, snapshot);
      const before = await DB.prepare("SELECT payload FROM snapshots").first();
      for (let i = 0; i < 2; i++) {
        const archive = await marketForDisplay({ DB }, DATE, {
          today: "2026-10-12",
          loadMarket: async () => {
            throw new Error("历史补算不得联网");
          },
        });
        assert.equal(archive.analysis.promotion, expected);
        assert.equal(archive.analysis.previousCount, 2);
        assert.equal(archive.promotionBackfilled, true);
        assert.match(archive.warnings.join(" "), /由归档.*补算/);
        assert.deepEqual(archive.analysis.stocks, snapshot.stocks);
        assert.deepEqual(archive.analysis.sectors, snapshot.sectors);
        assert.equal(archive.analysis.emotion, snapshot.emotion);
        assert.equal(
          archive.analysis.sealRate,
          snapshot.marketSummary.sealRate,
        );
        assert.deepEqual(
          await DB.prepare("SELECT payload FROM snapshots").first(),
          before,
        );
      }
    } finally {
      DB.close();
    }
  });
}

test("旧归档已有晋级率包括 0% 时保留原值，不覆盖已冻结统计", async () => {
  const DB = localDatabase();
  try {
    const snapshot = oldSnapshot();
    snapshot.marketSummary = { promotion: 0, previousCount: 77 };
    snapshot.market = { rows: [raw], previous: yesterdayRows() };
    await insertArchive(DB, snapshot);
    const before = await DB.prepare("SELECT payload FROM snapshots").first();
    const archive = await marketForDisplay({ DB }, DATE, {
      today: "2026-10-12",
    });
    assert.equal(archive.analysis.promotion, 0);
    assert.equal(archive.analysis.previousCount, 77);
    assert.notEqual(archive.promotionBackfilled, true);
    assert.deepEqual(
      await DB.prepare("SELECT payload FROM snapshots").first(),
      before,
    );
  } finally {
    DB.close();
  }
});

for (const fixture of [
  { name: "无原始行情", market: undefined },
  { name: "无当日池", market: { previous: yesterdayRows() } },
  { name: "无昨日池", market: { rows: [raw] } },
  { name: "原始行无效", market: { rows: [null], previous: yesterdayRows() } },
  {
    name: "原始行情错日",
    market: { date: "2026-10-08", rows: [raw], previous: yesterdayRows() },
  },
  {
    name: "昨日连板数缺失",
    market: { rows: [raw], previous: [{ c: raw.c, n: raw.n }] },
  },
]) {
  test(`旧归档数据不足时保留空晋级率与明确提示：${fixture.name}`, async () => {
    const DB = localDatabase();
    try {
      const snapshot = { ...oldSnapshot(), market: fixture.market };
      await insertArchive(DB, snapshot);
      const before = await DB.prepare("SELECT payload FROM snapshots").first();
      const archive = await marketForDisplay({ DB }, DATE, {
        today: "2026-10-12",
      });
      assert.equal(archive.analysis.promotion, null);
      assert.notEqual(archive.promotionBackfilled, true);
      assert.match(archive.warnings.join(" "), /晋级率暂缺/);
      assert.deepEqual(archive.analysis.stocks, snapshot.stocks);
      assert.deepEqual(
        await DB.prepare("SELECT payload FROM snapshots").first(),
        before,
      );
    } finally {
      DB.close();
    }
  });
}
