import test from "node:test";
import assert from "node:assert/strict";
import {
  getAuctionSnapshot,
  getAuctionOpportunities,
  clearCache,
} from "../backend/services/fuyao.js";
import {
  collectAuctionEvidence,
  verifyAuctionQuotes,
  computeIntradayHistory,
} from "../backend/services/intraday-inputs.js";

test("竞价机会分页与分组保留多条异动，实时快照不使用两分钟缓存", async () => {
  const previousFetch = globalThis.fetch,
    previousKey = process.env.FU_YAO_API_KEY;
  process.env.FU_YAO_API_KEY = "synthetic-test-key";
  clearCache();
  const calls = [];
  globalThis.fetch = async (address) => {
    const url = new URL(address);
    calls.push(url);
    if (url.pathname.endsWith("auction/snapshot"))
      return {
        json: async () => ({
          code: 0,
          data: {
            timestamp: 123,
            auction_phase: "closed",
            data_status: "final",
            item: [{ ticker: "600001" }],
          },
        }),
      };
    const page = Number(url.searchParams.get("page"));
    const codes = url.searchParams.get("thscodes").split(",");
    assert.ok(codes.length <= 50);
    return {
      json: async () => ({
        code: 0,
        data: {
          trade_date: "2026-10-22",
          item: [
            {
              ticker: codes[0].slice(0, 6),
              warn_type: String(page),
              bid_change_ratio: -0.06,
            },
          ],
          pagination: { has_next: page === 1 },
        },
      }),
    };
  };
  try {
    const codes = Array.from({ length: 51 }, (_, i) => `${600001 + i}.SH`);
    const result = await getAuctionOpportunities({
      date: "2026-10-22",
      thscodes: codes,
    });
    assert.equal(result.item.length, 4);
    assert.equal(result.truncated, false);
    assert.equal(result.item[0].bid_change_ratio, -0.06);
    assert.equal(calls.length, 4);
    await getAuctionSnapshot(["600001.SH"]);
    await getAuctionSnapshot(["600001.SH"]);
    assert.equal(
      calls.filter((url) => url.pathname.endsWith("auction/snapshot")).length,
      2,
    );
    const batches = await getAuctionSnapshot(
      Array.from({ length: 101 }, (_, i) => `${600001 + i}.SH`),
    );
    assert.equal(batches.auction_phase, "closed");
    assert.equal(batches.data_status, "final");
    assert.equal(batches.batches.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.FU_YAO_API_KEY;
    else process.env.FU_YAO_API_KEY = previousKey;
    clearCache();
  }
});
test("竞价终态兼容文档与实测枚举，当日开盘价必须交叉核对", async () => {
  const date = "2026-10-22";
  for (const [auction_phase, data_status] of [
    ["final", "ready"],
    ["closed", "final"],
  ]) {
    const evidence = await collectAuctionEvidence(date, ["600001"], {
      snapshot: async () => ({
        timestamp: Date.now(),
        auction_phase,
        data_status,
        item: [{ ticker: "600001", auction_price: 9.4, pre_close_price: 10 }],
      }),
      opportunities: async () => ({
        trade_date: "2026-10-21",
        item: [{ ticker: "600001" }],
      }),
      benchmark: async () => ({ date, item: [] }),
    });
    assert.equal(evidence.opportunities.length, 0);
    const quotes = {
      600001: {
        date,
        openCents: 940,
        previousCloseCents: 1000,
        timestamp: `${date}T09:30:00+08:00`,
      },
    };
    assert.equal(
      verifyAuctionQuotes({ auctionEvidence: evidence }, quotes, date).auction[
        "600001"
      ].final,
      true,
    );
    quotes["600001"].openCents = 941;
    assert.equal(
      Object.keys(
        verifyAuctionQuotes({ auctionEvidence: evidence }, quotes, date)
          .auction,
      ).length,
      0,
    );
  }
  const unavailable = await collectAuctionEvidence(date, ["600001"], {
    snapshot: async () => ({
      timestamp: Date.now(),
      auction_phase: "live",
      data_status: "not_ready",
      item: [],
    }),
    opportunities: async () => {
      throw new Error("synthetic timeout");
    },
    benchmark: async () => ({}),
  });
  assert.equal(unavailable.unavailable, true);
});
test("冻结历史使用真实昨日价和过去四日收盘，不读取未来日线", () => {
  const dataset = {
    dates: ["d0", "d1", "d2", "d3", "d4", "d5"],
    dateIdx: new Map([["d4", 4]]),
    codes: new Map([
      [
        "600001",
        {
          dates: new Uint32Array([0, 1, 2, 3, 4, 5]),
          closes: [8, 8.2, 8.5, 9, 10, 100],
          opens: [8, 8, 8, 9, 10.2, 100],
          highs: [8, 8.2, 8.5, 9, 10, 100],
          volumes: [1, 1, 1, 1, 1, 1],
          hasFactor: false,
        },
      ],
    ]),
  };
  const snapshot = {
    date: "d4",
    stocks: [
      {
        code: "600001",
        name: "合成样本",
        sector: "合成行业",
        height: 3,
        amount: 500000000,
        stockClass: "relay-leader",
      },
    ],
  };
  const features = new Map([
    ["600001", { limitUp10d: true, ma20: 8, amplitude20: 20 }],
  ]);
  const result = computeIntradayHistory(dataset, snapshot, new Map(), features);
  assert.equal(result["600001"].previousCloseCents, 1000);
  assert.equal(result["600001"].previousOpenCents, 1020);
  assert.equal(result["600001"].lastFourCloseSumCents, 3570);
  dataset.codes.get("600001").closes[5] = 100000;
  assert.deepEqual(
    computeIntradayHistory(dataset, snapshot, new Map(), features),
    result,
  );
  assert.deepEqual(
    computeIntradayHistory(dataset, snapshot, new Map(), new Map()),
    {},
  );
});
