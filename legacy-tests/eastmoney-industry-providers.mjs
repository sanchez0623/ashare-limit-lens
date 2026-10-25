import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchEastmoneyIndustryBatches,
  fetchEastmoneyIndustryF10,
  fetchEastmoneyIndustryUpdate,
} from "../backend/services/eastmoney-industry-providers.js";
import { metadataHttp } from "../backend/services/metadata-providers.js";
import { DataUpdateCancelled } from "../backend/domain/stock-metadata.js";
import { localDatabase } from "../scripts/local-db.mjs";
import {
  StockMetadataRepository,
  metadataStatus,
} from "../backend/storage/stock-metadata.js";
import { runDataUpdateJob } from "../backend/services/data-updates.js";
import {
  loadIndustryMapping,
  enrichWithIndustry,
} from "../backend/services/industry.js";

const stocks = [
  { code: "000001", name: "平安银行" },
  { code: "601857", name: "中国石油" },
];
const nativeRows = [
  { f12: "000001", f13: 0, f14: "平安银行", f100: "银行Ⅱ" },
  { f12: "601857", f13: 1, f14: "中国石油", f100: "炼化及贸易" },
];
const f10Rows = [
  {
    SECUCODE: "000001.SZ",
    SECURITY_CODE: "000001",
    SECURITY_NAME_ABBR: "平安银行",
    SECURITY_TYPE_CODE: "058001001",
    BOARD_NAME_LEVEL: "银行-银行Ⅱ-股份制银行Ⅲ",
    EM2016: "金融-银行-股份制与城商行",
  },
  {
    SECUCODE: "601857.SH",
    SECURITY_CODE: "601857",
    SECURITY_NAME_ABBR: "中国石油",
    SECURITY_TYPE_CODE: "058001001",
    BOARD_NAME_LEVEL: "石油石化-炼化及贸易-炼油化工",
    EM2016: "化石能源-石油天然气-石油天然气开采",
  },
];
const batch = (rows) => ({ rc: 0, data: { total: rows.length, diff: rows } });
function f10Request(rows = f10Rows, { counts, urls = [] } = {}) {
  return async (url) => {
    const u = new URL(url);
    urls.push(u);
    const p = Number(u.searchParams.get("pageNumber")),
      size = Number(u.searchParams.get("pageSize")),
      total = counts?.[p - 1] ?? rows.length;
    return {
      success: true,
      code: 0,
      result: {
        count: total,
        pages: Math.ceil(total / size),
        data: rows.slice((p - 1) * size, p * size),
      },
    };
  };
}
function setup(t) {
  const DB = localDatabase(),
    env = { DB },
    repo = new StockMetadataRepository(env),
    owner = "em-industry-test";
  t.after(() => DB.close());
  return { DB, env, repo, owner };
}
async function publish(
  repo,
  owner,
  rows = nativeRows.map((r) => ({
    code: r.f12,
    name: r.f14,
    emIndustry: r.f100,
  })),
) {
  await repo.claimWorker(owner);
  await repo.createJob("stock_em");
  const job = await repo.claimJob(owner);
  const result = await repo.publish("stock_em", rows, {
    jobId: job.id,
    owner,
    source: "eastmoney-ulist-f100",
  });
  await repo.finish(job.id, owner, "SUCCEEDED", { stock_em: result });
  return result;
}

test("native batch queries use the registry and preserve f100 exactly, including Roman suffixes", async () => {
  const urls = [],
    progress = [];
  const rows = await fetchEastmoneyIndustryBatches({
    stocks,
    batchSize: 1,
    request: async (url) => {
      const u = new URL(url);
      urls.push(u);
      return batch(
        nativeRows.filter((r) => u.searchParams.get("secids").endsWith(r.f12)),
      );
    },
    progress: async (_, p) => progress.push(p),
  });
  assert.deepEqual(
    urls.map((u) => u.searchParams.get("secids")),
    ["0.000001", "1.601857"],
  );
  assert.ok(
    urls.every(
      (u) =>
        u.pathname === "/api/qt/ulist.np/get" &&
        u.searchParams.get("fields") === "f12,f13,f14,f100",
    ),
  );
  assert.deepEqual(
    rows.map((r) => r.emIndustry),
    ["银行Ⅱ", "炼化及贸易"],
  );
  assert.equal(progress.at(-1).completed, 2);
  assert.equal(progress.at(-1).total, 2);
  assert.ok(rows.every((r) => r.emIndustrySource === "eastmoney-ulist-f100"));
});

test("native batches reject partial, duplicate, unexpected, wrong-market and malformed rows", async () => {
  for (const rows of [
    [nativeRows[0]],
    [nativeRows[0], nativeRows[0]],
    [nativeRows[0], { ...nativeRows[1], f12: "600000" }],
    [nativeRows[0], { ...nativeRows[1], f13: 0 }],
    [nativeRows[0], { ...nativeRows[1], f100: undefined }],
    [nativeRows[0], { ...nativeRows[1], f14: "" }],
  ])
    await assert.rejects(
      fetchEastmoneyIndustryBatches({
        stocks,
        request: async () => batch(rows),
      }),
    );
  await assert.rejects(
    fetchEastmoneyIndustryBatches({
      stocks: [],
      request: async () => batch([]),
    }),
    /更新股票名册/,
  );
  await assert.rejects(
    fetchEastmoneyIndustryBatches({ stocks: [stocks[0], stocks[0]] }),
    /重复/,
  );
  await assert.rejects(
    fetchEastmoneyIndustryBatches({ stocks, batchSize: 201 }),
    /批量大小/,
  );
});

test("new unclassified listings stay null, but all-empty industry responses cannot publish", async () => {
  const rows = await fetchEastmoneyIndustryBatches({
    stocks,
    request: async () =>
      batch([nativeRows[0], { ...nativeRows[1], f100: null }]),
  });
  assert.equal(rows[1].emIndustry, null);
  await assert.rejects(
    fetchEastmoneyIndustryBatches({
      stocks,
      request: async () => batch(nativeRows.map((r) => ({ ...r, f100: "-" }))),
    }),
    /全部为空/,
  );
});

test("F10 uses the second current BOARD_NAME_LEVEL component, never EM2016 or third-level labels", async () => {
  const urls = [];
  const rows = await fetchEastmoneyIndustryF10({
    stocks,
    request: f10Request(f10Rows, { urls }),
    pageSize: 1,
  });
  assert.deepEqual(
    rows.map((r) => r.emIndustry),
    ["银行Ⅱ", "炼化及贸易"],
  );
  assert.equal(rows[1].emIndustryPath, "石油石化-炼化及贸易-炼油化工");
  assert.equal(rows[0].emIndustryField, "BOARD_NAME_LEVEL[1]");
  assert.ok(
    urls.every(
      (u) =>
        u.searchParams.get("reportName") === "RPT_F10_BASIC_ORGINFO" &&
        !u.searchParams.get("columns").includes("EM2016"),
    ),
  );
  assert.deepEqual(
    urls.map((u) => u.searchParams.get("pageNumber")),
    ["1", "2"],
  );
});

test("F10 validates the whole report but returns only exact code-and-market identities in the active registry", async () => {
  const other = {
    ...f10Rows[0],
    SECUCODE: "000003.SZ",
    SECURITY_CODE: "000003",
    SECURITY_NAME_ABBR: "已退市样本",
  };
  const rows = await fetchEastmoneyIndustryF10({
    stocks,
    request: f10Request([f10Rows[0], other, f10Rows[1]]),
    pageSize: 2,
  });
  assert.equal(rows.length, 2);
  assert.equal(
    rows.some((r) => r.code === "000003"),
    false,
  );
  await assert.rejects(
    fetchEastmoneyIndustryF10({
      stocks,
      request: f10Request([
        { ...f10Rows[0], SECUCODE: "000001.SH" },
        f10Rows[1],
      ]),
    }),
    /未覆盖完整/,
  );
});

test("F10 rejects changing totals, truncated pages, duplicate identities and missing target coverage", async () => {
  await assert.rejects(
    fetchEastmoneyIndustryF10({
      stocks,
      pageSize: 1,
      request: f10Request(f10Rows, { counts: [2, 3] }),
    }),
    /总数变化/,
  );
  await assert.rejects(
    fetchEastmoneyIndustryF10({
      stocks,
      request: async () => ({
        success: true,
        code: 0,
        result: { count: 2, pages: 1, data: [f10Rows[0]] },
      }),
    }),
    /数量不完整/,
  );
  await assert.rejects(
    fetchEastmoneyIndustryF10({
      stocks,
      request: f10Request([f10Rows[0], f10Rows[0]]),
    }),
    /重复/,
  );
  await assert.rejects(
    fetchEastmoneyIndustryF10({ stocks, request: f10Request([f10Rows[0]]) }),
    /未覆盖完整/,
  );
  await assert.rejects(
    fetchEastmoneyIndustryF10({
      stocks,
      request: async () => ({
        success: false,
        message: "do not echo credentials",
      }),
    }),
    /分页声明或格式/,
  );
});

test("missing, numeric or changed current industry paths are rejected instead of substituting old classifications", async () => {
  for (const path of [
    undefined,
    123,
    "金融-银行",
    "银行--股份制银行Ⅲ",
    "银行-银行Ⅱ-股份制银行Ⅲ-新层级",
  ])
    await assert.rejects(
      fetchEastmoneyIndustryF10({
        stocks,
        request: f10Request([
          { ...f10Rows[0], BOARD_NAME_LEVEL: path },
          f10Rows[1],
        ]),
      }),
    );
  const rows = await fetchEastmoneyIndustryF10({
    stocks,
    request: f10Request([
      f10Rows[0],
      { ...f10Rows[1], BOARD_NAME_LEVEL: null },
    ]),
  });
  assert.equal(rows[1].emIndustry, null);
});

test("transport failure after a partial native batch restarts the complete F10 dataset with correct source provenance", async () => {
  let nativeCalls = 0;
  const request = metadataHttp({
    intervalMs: 0,
    retries: 0,
    fetchImpl: async (url) => {
      if (url.includes("ulist.np")) {
        if (++nativeCalls === 1)
          return Response.json(
            batch([{ ...nativeRows[0], f14: "未完成批次名称" }]),
          );
        throw new TypeError("fetch failed", {
          cause: { code: "UND_ERR_SOCKET" },
        });
      }
      return Response.json(await f10Request()(url));
    },
  });
  const result = await fetchEastmoneyIndustryUpdate({
    stocks,
    batchSize: 1,
    request,
  });
  assert.equal(result.source, "eastmoney-f10-board-level2");
  assert.equal(result.records[0].name, "平安银行");
  assert.equal(result.warnings.length, 1);
  assert.equal(nativeCalls, 2);
});

test("HTTP 429/403 and invalid native datasets never switch endpoints", async () => {
  for (const status of [429, 403]) {
    const urls = [];
    await assert.rejects(
      fetchEastmoneyIndustryUpdate({
        stocks,
        request: metadataHttp({
          intervalMs: 0,
          retries: 0,
          fetchImpl: async (url) => {
            urls.push(url);
            return new Response("", { status });
          },
        }),
      }),
      new RegExp(`HTTP ${status}`),
    );
    assert.equal(urls.length, 1);
  }
  let calls = 0;
  await assert.rejects(
    fetchEastmoneyIndustryUpdate({
      stocks,
      request: async () => {
        calls++;
        return batch([nativeRows[0]]);
      },
    }),
    /数量不完整/,
  );
  assert.equal(calls, 1);
});

test("without an initialized registry the legacy list API remains compatible and transport errors explain the initialization step", async () => {
  const result = await fetchEastmoneyIndustryUpdate({
    request: async () => batch(nativeRows),
  });
  assert.equal(result.source, "eastmoney-clist-f100");
  assert.equal(result.records.length, 2);
  await assert.rejects(
    fetchEastmoneyIndustryUpdate({
      request: metadataHttp({
        intervalMs: 0,
        retries: 0,
        fetchImpl: async () => {
          throw new TypeError("fetch failed", {
            cause: { code: "UND_ERR_SOCKET" },
          });
        },
      }),
    }),
    /先更新股票名册/,
  );
});

test("cancellation interrupts native pagination and F10 fallback before returning publishable records", async () => {
  let cancelled = false,
    calls = 0;
  const check = async () => {
    if (cancelled) throw new DataUpdateCancelled();
  };
  await assert.rejects(
    fetchEastmoneyIndustryBatches({
      stocks,
      batchSize: 1,
      check,
      request: async () => {
        calls++;
        return batch([nativeRows[0]]);
      },
      progress: async () => {
        cancelled = true;
      },
    }),
    DataUpdateCancelled,
  );
  assert.equal(calls, 1);
  cancelled = false;
  await assert.rejects(
    fetchEastmoneyIndustryF10({
      stocks,
      pageSize: 1,
      check,
      request: f10Request(),
      progress: async () => {
        cancelled = true;
      },
    }),
    DataUpdateCancelled,
  );
});

test("fallback source, warnings and field provenance survive SQLite publication without rewriting valid raw industries", async (t) => {
  const { repo, env, owner } = setup(t);
  await repo.claimWorker(owner);
  await repo.createJob("stock_em");
  const job = await repo.claimJob(owner);
  const request = metadataHttp({
    intervalMs: 0,
    retries: 0,
    fetchImpl: async (url) => {
      if (url.includes("ulist.np"))
        throw new TypeError("fetch failed", {
          cause: { code: "UND_ERR_SOCKET" },
        });
      return Response.json(await f10Request()(url));
    },
  });
  const finished = await runDataUpdateJob(env, job, owner, {
    providers: {
      stock_em: (options) =>
        fetchEastmoneyIndustryUpdate({ ...options, stocks, request }),
    },
  });
  assert.equal(finished.status, "SUCCEEDED");
  assert.equal(finished.results.stock_em.source, "eastmoney-f10-board-level2");
  assert.equal(finished.results.stock_em.warnings.length, 1);
  const snapshot = await repo.snapshot("stock_em");
  assert.equal(snapshot.source, "eastmoney-f10-board-level2");
  assert.equal(snapshot.records[0].emIndustryField, "BOARD_NAME_LEVEL[1]");
  const mapping = await loadIndustryMapping(env);
  const rows = enrichWithIndustry(
    [
      { c: "000001", hybk: "有效原始缩写" },
      { c: "601857", hybk: null },
    ],
    mapping,
  );
  assert.equal(rows[0].hybk, "有效原始缩写");
  assert.equal(rows[1].hybk, "炼化及贸易");
  assert.equal((await metadataStatus(env)).stockEm.coverage, 1);
});

test("invalid native or F10 responses cannot replace the previous published industry snapshot", async (t) => {
  const { repo, env, owner } = setup(t);
  const previous = await publish(repo, owner);
  for (const provider of [
    () =>
      fetchEastmoneyIndustryUpdate({
        stocks,
        request: async () => batch([nativeRows[0]]),
      }),
    () =>
      fetchEastmoneyIndustryF10({ stocks, request: f10Request([f10Rows[0]]) }),
  ]) {
    await repo.createJob("stock_em");
    const job = await repo.claimJob(owner);
    const result = await runDataUpdateJob(env, job, owner, {
      providers: { stock_em: provider },
    });
    assert.equal(result.status, "FAILED");
    assert.equal((await repo.snapshot("stock_em")).id, previous.snapshotId);
  }
});
