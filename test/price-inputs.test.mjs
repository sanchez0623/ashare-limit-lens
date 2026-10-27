import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import {
  getPricesSnapshot,
  getPricesHistorical,
  clearCache,
} from "../backend/services/fuyao.js";
import { supplementPriceRows } from "../backend/services/price-supplement.js";
import {
  resolveDailyPriceInputs,
  datasetFromPriceRecords,
  verifiedPreviousRows,
} from "../backend/services/price-history.js";
import { buildIntradayContext } from "../backend/services/intraday-inputs.js";
import {
  saveSnapshot,
  buildSnapshotPayload,
} from "../backend/services/review.js";
import { analyze, normalize } from "../shared/scoring.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import { createDragonPlan } from "../backend/domain/dragon-risk.js";

const date = "2026-10-22";
const now = new Date(`${date}T16:00:00+08:00`);
const dates = [];
for (let i = 60; i >= 0; i--) {
  const d = new Date(now.getTime() - i * 86400000);
  if (![0, 6].includes(d.getUTCDay())) dates.push(d.toISOString().slice(0, 10));
}
const rawBars = dates.slice(-30).map((d, i, all) => {
  const split = i < 12;
  const close = split ? 20 : i === all.length - 1 ? 11 : 10;
  return {
    date_ms: Date.parse(`${d}T00:00:00+08:00`),
    open_price: close,
    high_price: close,
    low_price: close,
    close_price: close,
    volume: 50000000,
    turnover: close * 50000000,
  };
});
function provider(calls = []) {
  return async (code, options) => {
    calls.push({ code, ...options });
    return {
      timestamp: rawBars.at(-1).date_ms,
      thscode: code,
      interval: "1d",
      adjust: options.adjust,
      item: rawBars.map((r, i) => {
        const factor = options.adjust === "forward" && i < 12 ? 0.5 : 1;
        return {
          ...r,
          open_price: r.open_price * factor,
          high_price: r.high_price * factor,
          low_price: r.low_price * factor,
          close_price: r.close_price * factor,
        };
      }),
    };
  };
}
const raw = {
  c: "600001",
  n: "合成价格样本",
  hybk: "合成行业",
  p: 11000,
  zdp: 10,
  amount: 550000000,
  hs: 5,
  lbc: 3,
  fbt: 93000,
  lbt: 93000,
  zbc: 1,
};
const price = {
  ticker: "600001",
  thscode: "600001.SH",
  last_price: 11,
  prev_price: 10,
  open_price: 10.1,
  high_price: 11,
  low_price: 10,
};
const quote = {
  date,
  timestamp: `${date}T15:00:00+08:00`,
  closeCents: 1100,
  previousCloseCents: 1000,
  openCents: 1010,
  highCents: 1100,
  lowCents: 1000,
};

test("价格快照客户端分批保留元数据、不缓存实时价格；历史客户端固定日线和复权选项", async () => {
  const original = globalThis.fetch,
    key = process.env.FU_YAO_API_KEY;
  process.env.FU_YAO_API_KEY = "synthetic-price-key";
  clearCache();
  const calls = [];
  globalThis.fetch = async (address) => {
    const url = new URL(address);
    calls.push(url);
    return Response.json({
      code: 0,
      data: { timestamp: now.getTime(), item: [price] },
    });
  };
  try {
    const result = await getPricesSnapshot(["600001.SH", "600002.SH"], {
      limit: 1,
      retries: 0,
    });
    assert.equal(result.batches.length, 2);
    assert.equal(result.timestamp, now.getTime());
    assert.equal(result.ticker, undefined);
    await getPricesSnapshot(["600001.SH"]);
    assert.equal(calls.length, 3);
    await assert.rejects(getPricesSnapshot(["600001.SH"], { limit: 0 }));
    await getPricesHistorical("600001.SH", {
      start: now.getTime() - 86400000,
      end: now.getTime(),
      adjust: "forward",
    });
    assert.equal(calls.at(-1).searchParams.get("interval"), "1d");
    assert.equal(calls.at(-1).searchParams.get("adjust"), "forward");
  } finally {
    globalThis.fetch = original;
    clearCache();
    if (key === undefined) delete process.env.FU_YAO_API_KEY;
    else process.env.FU_YAO_API_KEY = key;
  }
});

test("当日价格补全核对逐股日期和价格，转换千分之一元，保留原字段及来源", async () => {
  const result = await supplementPriceRows(
    date,
    [raw, { ...raw, c: "600002", o: 10500, h: 11100 }],
    {
      now,
      prices: async () => ({
        timestamp: now.getTime(),
        item: [price, { ...price, ticker: "600002" }],
      }),
      quotes: async () => ({ 600001: quote, 600002: quote }),
    },
  );
  assert.equal(result.evidence.supplemented, 1);
  assert.equal(normalize(result.rows[0]).open, 10.1);
  assert.equal(normalize(result.rows[0]).high, 11);
  assert.equal(result.rows[0].p, raw.p);
  assert.equal(
    result.rows[0]._priceEvidence.verifiedQuoteTimestamp,
    quote.timestamp,
  );
  assert.equal(result.rows[1].o, 10500);
  assert.equal(result.rows[1].h, 11100);
  assert.equal(raw.o, undefined);
});

test("错日、矛盾价格和批次时间不能补造当日字段，补全失败仍返回原行情", async () => {
  for (const [batch, checked] of [
    [{ timestamp: now.getTime() - 86400000, item: [price] }, quote],
    [
      { timestamp: now.getTime(), item: [price] },
      { ...quote, date: "2026-10-21" },
    ],
    [
      { timestamp: now.getTime(), item: [price] },
      { ...quote, highCents: 1200 },
    ],
    [
      { timestamp: now.getTime(), item: [price] },
      { ...quote, timestamp: null },
    ],
  ]) {
    const result = await supplementPriceRows(date, [raw], {
      now,
      prices: async () => batch,
      quotes: async () => ({ 600001: checked }),
    });
    assert.equal(result.rows[0].o, undefined);
    assert.equal(result.evidence.supplemented, 0);
  }
  const failed = await supplementPriceRows(date, [raw], {
    now,
    prices: async () => {
      throw new Error("429");
    },
    quotes: async () => ({}),
  });
  assert.deepEqual(failed.rows, [raw]);
  assert.equal(failed.evidence.unavailable, true);
});

test("本地日线缺失时远端回补，配对复权到信号日，固化后重放无需联网", async () => {
  const DB = localDatabase(),
    calls = [];
  try {
    const result = await resolveDailyPriceInputs({ DB }, date, {
      rows: [raw],
      localDataset: null,
      history: provider(calls),
      now,
    });
    assert.equal(calls.length, 2);
    assert.equal(result.status.supplemented, 1);
    assert.equal(result.ma5ByCode.get("600001"), 10.2);
    assert.equal(result.featuresByCode.get("600001").ma20, 10.05);
    assert.equal(result.featuresByCode.get("600001").limitUp10d, true);
    assert.equal(result.eodRows.get("600001").prevClose, 10);
    const context = await buildIntradayContext(
      {},
      {
        date,
        stocks: [
          {
            code: raw.c,
            name: raw.n,
            sector: raw.hybk,
            height: 3,
            amount: raw.amount,
          },
        ],
      },
      { dailyInputs: result },
    );
    assert.equal(context.history["600001"].previousCloseCents, 1100);
    assert.equal(context.history["600001"].lastFourCloseSumCents, 4100);
    const offline = await resolveDailyPriceInputs({}, date, {
      frozenInputs: result.evidence,
      localDataset: null,
      history: async () => {
        throw new Error("离线禁止联网");
      },
      now,
    });
    assert.deepEqual(offline.eodRows, result.eodRows);
    assert.deepEqual(offline.ma5ByCode, result.ma5ByCode);
    const cached = await resolveDailyPriceInputs({ DB }, date, {
      rows: [raw],
      localDataset: null,
      history: async () => {
        throw new Error("不应重复请求");
      },
      now,
    });
    assert.equal(cached.status.supplemented, 1);
    assert.deepEqual(cached.featuresByCode, result.featuresByCode);
  } finally {
    DB.close();
  }
});

test("本地同日历史齐全时无需远端；本地截止昨日时用备用源覆盖候选股", async () => {
  const a = await resolveDailyPriceInputs({}, date, {
    codes: [raw.c],
    localDataset: null,
    history: provider(),
    now,
  });
  const complete = datasetFromPriceRecords(
    a.evidence.records.map((r) => r.record),
    date,
  );
  let calls = 0;
  const b = await resolveDailyPriceInputs({}, date, {
    codes: [raw.c],
    localDataset: complete,
    history: async () => {
      calls++;
      throw new Error("不应请求");
    },
    now,
  });
  assert.equal(calls, 0);
  assert.equal(b.ma5ByCode.get(raw.c), 10.2);
  const stale = structuredClone(complete);
  stale.dates.pop();
  stale.dateIdx.delete(date);
  const c = await resolveDailyPriceInputs({}, date, {
    codes: [raw.c],
    localDataset: stale,
    history: provider(),
    now,
  });
  assert.equal(c.status.supplemented, 1);
  assert.equal(c.eodRows.get(raw.c).close, 11);
});

test("远端错误日期、缺失复权配对和错误周期均拒绝；盘中不追取未收盘日线", async () => {
  for (const bad of [
    async (_, o) => ({
      ...(await provider()(raw.c, o)),
      item: [
        ...rawBars,
        { ...rawBars.at(-1), date_ms: Date.parse("2026-10-23T00:00:00+08:00") },
      ],
    }),
    async (_, o) => ({
      ...(await provider()(raw.c, o)),
      item: rawBars.slice(0, -1),
    }),
    async (_, o) => ({ ...(await provider()("600001.SH", o)), interval: "5m" }),
    async (_, o) => ({
      ...(await provider()("600001.SH", o)),
      thscode: "600002.SH",
    }),
  ]) {
    const result = await resolveDailyPriceInputs({}, date, {
      codes: [raw.c],
      localDataset: null,
      history: bad,
      now,
    });
    assert.equal(result.evidence.records.length, 0);
    assert.equal(result.ma5ByCode.size, 0);
  }
  let calls = 0;
  const result = await resolveDailyPriceInputs({}, date, {
    codes: [raw.c],
    localDataset: null,
    history: async () => {
      calls++;
    },
    now: new Date(`${date}T10:00:00+08:00`),
  });
  assert.equal(calls, 0);
  assert.equal(result.ma5ByCode.size, 0);
});

test("冻结输入摘要被篡改时拒绝；回补条数上限与缺失范围可见", async () => {
  const result = await resolveDailyPriceInputs({}, date, {
    codes: ["600001", "600002"],
    localDataset: null,
    history: provider(),
    now,
    maxCodes: 1,
  });
  assert.equal(result.status.requested, 2);
  assert.equal(result.status.supplemented, 1);
  assert.equal(result.status.limited, true);
  assert.deepEqual(result.status.pendingCodes, ["600002"]);
  const tampered = structuredClone(result.evidence);
  tampered.records[0].record.raw.at(-1).close = 99;
  await assert.rejects(
    resolveDailyPriceInputs({}, date, {
      frozenInputs: tampered,
      localDataset: null,
      now,
    }),
    /摘要/,
  );
  assert.equal(
    result.evidence.records[0].digest,
    await digestOf(result.evidence.records[0].record),
  );
});

test("日线逐股回补覆盖超过100只的完整名单，不截断第101只以后的资格依据", async () => {
  const codes = Array.from({ length: 122 }, (_, i) => String(600001 + i));
  const calls = [];
  const result = await resolveDailyPriceInputs({}, date, {
    codes,
    localDataset: null,
    history: provider(calls),
    now,
  });
  assert.equal(calls.length, 244);
  assert.equal(result.status.requested, 122);
  assert.equal(result.status.supplemented, 122);
  assert.equal(result.eodRows.size, 122);
  assert.deepEqual(result.status.pendingCodes, []);
  assert.equal(result.status.complete, true);
  assert.equal(result.status.limited, false);
});

test("回补重试先读全部缓存，单轮预算用于新数据，后续批次持续前进", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const calls = [];
  const options = {
    codes: ["600003", "600001", "600002"],
    localDataset: null,
    history: provider(calls),
    now,
    maxCodes: 1,
  };
  const a = await resolveDailyPriceInputs({ DB }, date, options);
  const b = await resolveDailyPriceInputs({ DB }, date, options);
  const c = await resolveDailyPriceInputs({ DB }, date, options);
  assert.deepEqual(
    [a.status.supplemented, b.status.supplemented, c.status.supplemented],
    [1, 2, 3],
  );
  assert.deepEqual(c.status.pendingCodes, []);
  assert.equal(c.status.limited, false);
  assert.equal(calls.length, 6);
  const cached = await resolveDailyPriceInputs({ DB }, date, {
    ...options,
    allowRemote: false,
  });
  assert.equal(cached.status.supplemented, 3);
  assert.equal(calls.length, 6);
});

test("尚未回补的数据不能被当成不合格而冻结不完整观察池", () => {
  assert.throws(
    () =>
      createDragonPlan(
        {
          dailyPriceSources: { pendingCodes: ["600101", "600102"] },
        },
        {},
        now.toISOString(),
      ),
    /尚有 2 只未处理/,
  );
});

test("尚未绑定计划的部分快照可在下轮完成回补，完成后的快照保持冻结", async (t) => {
  const DB = localDatabase();
  const OriginalDate = globalThis.Date,
    originalFetch = globalThis.fetch,
    originalKey = process.env.FU_YAO_API_KEY;
  t.after(() => {
    globalThis.Date = OriginalDate;
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FU_YAO_API_KEY;
    else process.env.FU_YAO_API_KEY = originalKey;
    clearCache();
    DB.close();
  });
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [now.getTime()]));
    }
    static now() {
      return now.getTime();
    }
  };
  process.env.FU_YAO_API_KEY = "synthetic-resume-key";
  clearCache();
  const codes = ["600001", "600002", "600003"];
  const market = {
    date,
    source: "synthetic",
    rows: codes.map((c) => ({ ...raw, c })),
    previous: [],
  };
  const partial = await resolveDailyPriceInputs({ DB }, date, {
    codes,
    localDataset: null,
    history: provider(),
    now,
    maxCodes: 1,
  });
  const snapshot = await buildSnapshotPayload(
    { DB },
    market,
    undefined,
    partial,
  );
  await DB.prepare(
    "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
  )
    .bind(date, snapshot.createdAt, JSON.stringify(snapshot))
    .run();
  let requests = 0;
  globalThis.fetch = async (address) => {
    const url = new URL(address);
    requests++;
    return Response.json({
      code: 0,
      data: await provider()(url.searchParams.get("thscode"), {
        adjust: url.searchParams.get("adjust"),
      }),
    });
  };
  await saveSnapshot({ DB }, { ...market, rows: [] }, []);
  const completed = await DB.prepare(
    "SELECT payload FROM snapshots WHERE trade_date=?",
  )
    .bind(date)
    .first();
  const value = JSON.parse(completed.payload);
  assert.equal(value.dailyPriceInputs.records.length, 3);
  assert.deepEqual(value.market.rows, market.rows);
  assert.deepEqual(value.dailyPriceSources.pendingCodes, []);
  assert.equal(value.dailyPriceSources.limited, false);
  assert.equal(requests, 4);
  await saveSnapshot({ DB }, { ...market, rows: [] });
  assert.equal(
    (
      await DB.prepare("SELECT payload FROM snapshots WHERE trade_date=?")
        .bind(date)
        .first()
    ).payload,
    completed.payload,
  );
  assert.equal(requests, 4);
});

test("备用源限流时停止继续回补，缺失股票保持无数据", async () => {
  let calls = 0;
  const result = await resolveDailyPriceInputs({}, date, {
    codes: ["600001", "600002", "600003", "600004"],
    localDataset: null,
    now,
    history: async () => {
      calls++;
      throw new Error("429 限流");
    },
  });
  assert.ok(calls <= 2);
  assert.equal(result.status.limited, true);
  assert.equal(result.ma5ByCode.size, 0);
  assert.equal(result.evidence.records.length, 0);
});

test("次日09:26仍可补齐信号日日线，09:30起不联网补造盘前依据", async () => {
  const calls = [];
  const ready = await resolveDailyPriceInputs({}, date, {
    codes: [raw.c],
    localDataset: null,
    history: provider(calls),
    now: new Date("2026-10-23T09:26:00+08:00"),
  });
  assert.equal(calls.length, 2);
  assert.equal(ready.evidence.records.length, 1);
  const late = await resolveDailyPriceInputs({}, date, {
    codes: [raw.c],
    localDataset: null,
    history: provider(calls),
    now: new Date("2026-10-23T09:30:00+08:00"),
  });
  assert.equal(calls.length, 2);
  assert.equal(late.evidence.records.length, 0);
});

test("昨日池当日价格不参与昨日买点判断，真实昨日价格优先且缺失时保持未知", () => {
  const previous = [
    normalize({ ...raw, p: 9400, o: 10000, zdp: 0, ylbc: 3, lbc: undefined }),
  ];
  const current = normalize({
    ...raw,
    p: 9400,
    o: 9000,
    h: 10000,
    zdp: -6,
    lbc: 0,
  });
  const eod = new Map([
    [
      raw.c,
      {
        prevOpen: 9,
        prevClose: 10,
        prevHigh: 10,
        prevChange: 10,
        prevBreaks: 1,
      },
    ],
  ]);
  const verified = verifiedPreviousRows(previous, eod);
  assert.equal(verified[0].close, 10);
  assert.equal(verified[0].open, 9);
  assert.equal(verifiedPreviousRows(previous, new Map())[0].close, null);
  const analysis = analyze([], 1, previous, undefined, {
    brokenRows: [current],
    previousPricesVerified: true,
    prevEodByCode: eod,
    lateSession: true,
  });
  assert.equal(
    analysis.brokenStocks[0].buyPoint.labels.includes("fake-neg-limit-dip"),
    false,
  );
  const realFake = new Map([
    [raw.c, { prevOpen: 10.5, prevClose: 10, prevChange: 0, prevBreaks: 1 }],
  ]);
  const good = analyze([], 1, previous, undefined, {
    brokenRows: [current],
    previousPricesVerified: true,
    prevEodByCode: Object.fromEntries(realFake),
  });
  assert.equal(
    good.brokenStocks[0].buyPoint.labels.includes("fake-neg-limit-dip"),
    true,
  );
});

test("盘后快照生产路径保存原始日线及来源，重复归档不追溯修改计划依据", async () => {
  const OriginalDate = globalThis.Date,
    originalFetch = globalThis.fetch,
    originalKey = process.env.FU_YAO_API_KEY;
  const DB = localDatabase();
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [now.getTime()]));
    }
    static now() {
      return now.getTime();
    }
  };
  process.env.FU_YAO_API_KEY = "synthetic-freeze-key";
  clearCache();
  let requests = 0;
  globalThis.fetch = async (address) => {
    const u = new URL(address);
    requests++;
    assert.equal(u.pathname, "/api/a-share/prices/historical");
    return Response.json({
      code: 0,
      data: await provider()(u.searchParams.get("thscode"), {
        adjust: u.searchParams.get("adjust"),
      }),
    });
  };
  try {
    const market = {
      date,
      source: "synthetic",
      rows: [{ ...raw, o: 11000, h: 11000 }],
      previous: [
        { ...raw, p: 11000, o: 11000, zdp: 10, ylbc: 2, lbc: undefined },
      ],
      brokenRows: [],
      broken: 0,
    };
    const result = await saveSnapshot({ DB }, market);
    assert.equal(result.saved, true);
    const saved = await DB.prepare(
      "SELECT payload FROM snapshots WHERE trade_date=?",
    )
      .bind(date)
      .first();
    const snapshot = JSON.parse(saved.payload);
    assert.equal(snapshot.dailyPriceInputs.records.length, 1);
    assert.equal(snapshot.previousPricesVerified, true);
    assert.equal(
      snapshot.intradayEntryContext.history[raw.c].previousCloseCents,
      1100,
    );
    assert.equal(requests, 2);
    const lateContext = await buildIntradayContext(
      { DB },
      {
        date,
        stocks: [
          {
            code: raw.c,
            name: raw.n,
            sector: raw.hybk,
            height: 3,
            amount: raw.amount,
          },
        ],
        dailyPriceInputs: {
          version: "fuyao-daily-v1",
          asOf: date,
          records: [],
        },
      },
    );
    assert.equal(lateContext.history[raw.c].previousCloseCents, 1100);
    assert.equal(lateContext.dataSources.supplemented, 1);
    await saveSnapshot({ DB }, { ...market, rows: [] });
    assert.equal(
      (
        await DB.prepare("SELECT payload FROM snapshots WHERE trade_date=?")
          .bind(date)
          .first()
      ).payload,
      saved.payload,
    );
    assert.equal(requests, 2);
  } finally {
    globalThis.Date = OriginalDate;
    globalThis.fetch = originalFetch;
    clearCache();
    DB.close();
    if (originalKey === undefined) delete process.env.FU_YAO_API_KEY;
    else process.env.FU_YAO_API_KEY = originalKey;
  }
});
