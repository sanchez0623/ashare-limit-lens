import test from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import {
  parseSseStockList,
  parseSzseStockList,
  fetchStockRegistryMetadata,
  fetchSinaStockList,
} from "../backend/services/stock-list-providers.js";
import { metadataHttp } from "../backend/services/metadata-providers.js";
import { localDatabase } from "../scripts/local-db.mjs";
import {
  StockMetadataRepository,
  metadataStatus,
} from "../backend/storage/stock-metadata.js";
import { runDataUpdateJob } from "../backend/services/data-updates.js";
import {
  DataUpdateCancelled,
  validateMetadataRecords,
} from "../backend/domain/stock-metadata.js";
import {
  loadIndustryMapping,
  enrichWithIndustry,
} from "../backend/services/industry.js";
import { api } from "../backend/routes/api.js";

const date = "2026-10-24";
const sseRows = [
  { A_STOCK_CODE: "600000", SEC_NAME_CN: "浦发银行", LIST_DATE: "19991110" },
  { A_STOCK_CODE: "601857", SEC_NAME_CN: "*ST样本", LIST_DATE: "2007-11-05" },
];
const sse = (rows) => ({ result: rows, pageHelp: { total: rows.length } });
function szse(
  rows = [
    {
      板块: "主板",
      A股代码: "000001",
      A股简称: "平安银行",
      A股上市日期: "1991-04-03",
      所属行业: "证监会分类不能用于东财",
    },
    {
      板块: "创业板",
      A股代码: "300001",
      A股简称: "特锐德",
      A股上市日期: new Date("2009-10-30T00:00:00Z"),
      所属行业: "另一种分类",
    },
  ],
) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), "A股列表");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}
const sinaRows = [
  { symbol: "bj920000", code: "920000", name: "范围外北交所" },
  { symbol: "sh600000", code: "600000", name: "新浪沪市名称" },
  { symbol: "sh688001", code: "688001", name: "范围外科创板" },
  { symbol: "sz000001", code: "000001", name: "*ST新浪样本" },
  { symbol: "sz300001", code: "300001", name: "特锐德" },
];
function sinaRequest(rows = sinaRows, { endTotal = rows.length } = {}) {
  let counts = 0;
  return async (url) => {
    if (url.includes("getHQNodeStockCount"))
      return String(++counts === 1 ? rows.length : endTotal);
    const u = new URL(url),
      page = Number(u.searchParams.get("page")),
      size = Number(u.searchParams.get("num"));
    assert.equal(u.searchParams.get("sort"), "symbol");
    assert.equal(u.searchParams.get("asc"), "1");
    return rows.slice((page - 1) * size, page * size);
  };
}
function sourceRequest({
  failSh = false,
  failSz = false,
  rows = sinaRows,
} = {}) {
  const sina = sinaRequest(rows);
  const calls = [];
  const request = async (url, label, format) => {
    calls.push({ url, label, format });
    if (url.includes("query.sse.com.cn")) {
      if (failSh) throw new Error("上交所连接中断");
      return sse(sseRows);
    }
    if (url.includes("www.szse.cn")) {
      if (failSz) throw new Error("深交所请求超时");
      return szse();
    }
    return sina(url);
  };
  return { request, calls };
}
function setup(t) {
  const DB = localDatabase(),
    env = { DB, DATA_UPDATE_RUNNER: "local" },
    repo = new StockMetadataRepository(env),
    owner = "registry-test";
  t.after(() => DB.close());
  return { DB, env, repo, owner };
}
async function publish(repo, owner, kind, records) {
  await repo.claimWorker(owner);
  await repo.createJob(kind);
  const job = await repo.claimJob(owner);
  const result = await repo.publish(kind, records, {
    jobId: job.id,
    owner,
    source: kind === "stock_list" ? "exchanges-sina" : "fixture",
  });
  await repo.finish(job.id, owner, "SUCCEEDED", { [kind]: result });
  return result;
}

test("SSE validates declared count, duplicates and listing dates while retaining ST identities", () => {
  const rows = parseSseStockList(sse(sseRows), { date });
  assert.equal(rows[0].listingDate, "1999-11-10");
  assert.equal(rows[1].name, "*ST样本");
  assert.equal(rows[0].registrySource, "sse");
  assert.throws(
    () => parseSseStockList({ ...sse(sseRows), pageHelp: { total: 3 } }),
    /数量不完整/,
  );
  assert.throws(() => parseSseStockList(sse([...sseRows, sseRows[0]])), /重复/);
  assert.throws(
    () =>
      parseSseStockList(sse([{ ...sseRows[0], LIST_DATE: "20261025" }]), {
        date,
      }),
    /未上市/,
  );
  assert.throws(
    () => parseSseStockList(sse([{ ...sseRows[0], A_STOCK_CODE: "000001" }])),
    /市场无效/,
  );
  assert.throws(
    () =>
      parseSseStockList(sse([{ ...sseRows[0], LIST_DATE: "20260230" }]), {
        date,
      }),
    /日期/,
  );
});

test("SZSE XLSX supports leading-zero and Excel date cells; source industry columns never enter the registry", () => {
  const rows = parseSzseStockList(szse(), { date });
  assert.deepEqual(
    rows.map((r) => r.code),
    ["000001", "300001"],
  );
  assert.equal(rows[1].listingDate, "2009-10-30");
  assert.equal(rows[0].registrySource, "szse");
  assert.equal(
    rows.some((r) => r.emIndustry || r.industry),
    false,
  );
  assert.throws(
    () => parseSzseStockList(Buffer.from("<html>验证码</html>")),
    /有效 XLSX/,
  );
  assert.throws(
    () => parseSzseStockList(szse([{ 代码: "000001" }])),
    /字段变化/,
  );
  assert.throws(
    () =>
      parseSzseStockList(
        szse([
          {
            板块: "主板",
            A股代码: "300001",
            A股简称: "错误",
            A股上市日期: "2009-10-30",
          },
        ]),
      ),
    /板块不一致/,
  );
});

test("Sina counts every source row before filtering, completes all pages and rechecks the total", async () => {
  const progress = [];
  const rows = await fetchSinaStockList({
    request: sinaRequest(),
    pageSize: 2,
    progress: async (_, p) => progress.push(p),
  });
  assert.deepEqual(
    rows.map((r) => r.code),
    ["000001", "300001", "600000"],
  );
  assert.equal(rows[0].isSt, true);
  assert.equal(progress.at(-1).completed, 5);
  assert.equal(progress.at(-1).pages, 3);
  await assert.rejects(
    fetchSinaStockList({ request: sinaRequest(), pageSize: 1000 }),
    /分页大小无效/,
  );
  await assert.rejects(
    fetchSinaStockList({
      request: sinaRequest(sinaRows, { endTotal: 6 }),
      pageSize: 2,
    }),
    /更新中变化/,
  );
});

test("Sina rejects empty, short, repeated, reordered or malformed pages", async () => {
  for (const rows of [
    [sinaRows[0], sinaRows[0]],
    [sinaRows[1], sinaRows[0]],
    [{ ...sinaRows[1], symbol: "sz600000" }],
    [{ ...sinaRows[1], name: "" }],
  ])
    await assert.rejects(
      fetchSinaStockList({ request: sinaRequest(rows), pageSize: 2 }),
    );
  await assert.rejects(
    fetchSinaStockList({
      request: async (url) => (url.includes("Count") ? "2" : []),
      pageSize: 2,
    }),
    /提前结束/,
  );
  await assert.rejects(
    fetchSinaStockList({
      request: async (url) => (url.includes("Count") ? "2" : [sinaRows[0]]),
      pageSize: 2,
    }),
    /截断/,
  );
  await assert.rejects(
    fetchSinaStockList({ request: async () => "0" }),
    /为空/,
  );
});

test("both exchange lists succeed without making any Sina request", async () => {
  const { request, calls } = sourceRequest();
  const result = await fetchStockRegistryMetadata({ request, date });
  assert.equal(result.records.length, 4);
  assert.deepEqual(result.warnings, []);
  assert.equal(calls.length, 2);
  assert.ok(
    result.records.every((r) => ["sse", "szse"].includes(r.registrySource)),
  );
});

test("a failed exchange uses only that market from one complete Sina crawl and keeps the other exchange's identities", async () => {
  const { request, calls } = sourceRequest({ failSz: true });
  const result = await fetchStockRegistryMetadata({ request, date });
  assert.equal(
    result.records.find((r) => r.code === "600000").name,
    "浦发银行",
  );
  assert.equal(
    result.records.filter((r) => r.registrySource === "sse").length,
    2,
  );
  assert.equal(
    result.records.filter((r) => r.registrySource === "sina").length,
    2,
  );
  assert.match(result.warnings[0], /深交所.*请求超时.*新浪/);
  assert.equal(calls.filter((r) => r.url.includes("StockCount")).length, 2);
});

test("failure of both exchanges triggers a single Sina crawl and never publishes one market alone", async () => {
  const { request, calls } = sourceRequest({ failSh: true, failSz: true });
  const result = await fetchStockRegistryMetadata({ request, date });
  assert.equal(result.records.length, 3);
  assert.equal(result.warnings.length, 2);
  assert.equal(calls.filter((r) => r.url.includes("getHQNodeData")).length, 1);
  const missing = sourceRequest({
    failSz: true,
    rows: [sinaRows[0], sinaRows[1]],
  });
  await assert.rejects(
    fetchStockRegistryMetadata({ request: missing.request, date }),
    /未完整取得/,
  );
});

test("cancellation on an exchange failure stops before fallback; cancellation during pagination stops the next request", async () => {
  let cancelled = false,
    calls = 0;
  const check = async () => {
    if (cancelled) throw new DataUpdateCancelled();
  };
  await assert.rejects(
    fetchStockRegistryMetadata({
      check,
      request: async () => {
        calls++;
        cancelled = true;
        throw new Error("连接失败");
      },
    }),
    DataUpdateCancelled,
  );
  assert.equal(calls, 1);
  cancelled = false;
  calls = 0;
  await assert.rejects(
    fetchSinaStockList({
      check,
      pageSize: 2,
      request: async (url) => {
        calls++;
        return sinaRequest()(url);
      },
      progress: async () => {
        cancelled = true;
      },
    }),
    DataUpdateCancelled,
  );
  assert.equal(calls, 2);
});

test("public providers send correct referers and never require an authorization header", async () => {
  const seen = [];
  const request = metadataHttp({
    intervalMs: 0,
    retries: 0,
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      if (url.includes("sse.com.cn")) return Response.json(sse(sseRows));
      return new Response(szse());
    },
  });
  await fetchStockRegistryMetadata({ request, date });
  assert.match(seen[0].options.headers.Referer, /www.sse.com.cn/);
  assert.match(seen[1].options.headers.Referer, /www.szse.cn/);
  for (const call of seen)
    assert.equal(
      Object.keys(call.options.headers).some((k) =>
        /token|authorization|key/i.test(k),
      ),
      false,
    );
});

test("registry names and coverage update independently while EM mappings and native scoring industries stay unchanged", async (t) => {
  const { env, repo, owner } = setup(t);
  const oldEm = await publish(repo, owner, "stock_em", [
    { code: "600000", name: "旧名称", emIndustry: "银行" },
  ]);
  await publish(repo, owner, "stock_list", [
    { code: "600000", name: "新名称", registrySource: "sse" },
    { code: "000001", name: "新股", registrySource: "sina" },
  ]);
  const status = await metadataStatus(env);
  assert.equal(status.stockList.sourceCount, 2);
  assert.equal(status.stockList.nameChanges, 0);
  assert.equal(status.stockList.sources.sina, 1);
  assert.equal(status.missingEm.count, 1);
  assert.equal(status.missingEm.coverage, 0.5);
  assert.equal(status.missingSw.count, 2);
  assert.equal((await repo.snapshot("stock_em")).id, oldEm.snapshotId);
  const mapping = await loadIndustryMapping(env);
  assert.equal(mapping.get("600000").industryName, "银行");
  assert.equal(
    enrichWithIndustry([{ c: "600000", hybk: "行情原行业" }], mapping)[0].hybk,
    "行情原行业",
  );
  const records = validateMetadataRecords("stock_list", [
    { code: "600000", name: "样本", emIndustry: "错误行业", swL1: "不能混入" },
  ]);
  assert.equal(records[0].emIndustry, undefined);
  assert.equal(records[0].swL1, undefined);
});

test("registry appends new identities, reports name changes and retains absent codes without treating them as delisted", async (t) => {
  const { repo, owner } = setup(t);
  await publish(repo, owner, "stock_list", [
    { code: "600000", name: "原名", registrySource: "sse" },
    { code: "000001", name: "暂缺样本", registrySource: "sina" },
  ]);
  const result = await publish(repo, owner, "stock_list", [
    { code: "600000", name: "*ST改名", registrySource: "sina" },
    { code: "300001", name: "新增", registrySource: "sina" },
  ]);
  assert.equal(result.added, 1);
  assert.equal(result.nameChanges, 1);
  assert.equal(result.industryChanges, 0);
  const snapshot = await repo.snapshot("stock_list");
  assert.equal(snapshot.records.length, 3);
  assert.equal(snapshot.byCode.get("000001").presentInSource, false);
  assert.equal(snapshot.byCode.get("600000").isSt, true);
});

test("all update publishes the registry and SW even when Eastmoney disconnects, retaining the previous EM snapshot", async (t) => {
  const { env, repo, owner } = setup(t);
  const previous = await publish(repo, owner, "stock_em", [
    { code: "600000", name: "浦发银行", emIndustry: "银行" },
  ]);
  await repo.createJob("all");
  const job = await repo.claimJob(owner);
  const result = await runDataUpdateJob(env, job, owner, {
    providers: {
      stock_list: () =>
        fetchStockRegistryMetadata({
          ...sourceRequest({ failSz: true }),
          date,
        }),
      stock_em: async () => {
        throw new Error("东财连接中断，保留旧版");
      },
      industry_sw: async () => [
        {
          code: "600000",
          swL1: "银行",
          swL2: "银行Ⅱ",
          swL3: "国有大行",
          swCode: "480101",
        },
      ],
    },
  });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.results.stock_list.status, "SUCCEEDED");
  assert.equal(result.results.industry_sw.status, "SUCCEEDED");
  assert.equal(result.results.stock_em.status, "FAILED");
  assert.equal(result.results.stock_list.sources.sina, 2);
  assert.equal(result.results.stock_list.warnings.length, 1);
  assert.equal((await repo.snapshot("stock_em")).id, previous.snapshotId);
});

test("a failed backup cannot replace an existing registry; old EM-only installations retain their coverage until initialization", async (t) => {
  const { env, repo, owner } = setup(t);
  await publish(repo, owner, "stock_em", [
    { code: "600000", name: "浦发银行", emIndustry: "银行" },
  ]);
  const legacy = await metadataStatus(env);
  assert.equal(legacy.stockList, null);
  assert.equal(legacy.stockListFallback, true);
  assert.equal(legacy.missingEm.coverage, 1);
  const old = await publish(repo, owner, "stock_list", [
    { code: "000001", name: "平安银行", registrySource: "szse" },
  ]);
  await repo.createJob("stock_list");
  const job = await repo.claimJob(owner);
  const result = await runDataUpdateJob(env, job, owner, {
    providers: {
      stock_list: () =>
        fetchStockRegistryMetadata({
          request: async () => {
            throw new Error("公开源连接失败");
          },
        }),
    },
  });
  assert.equal(result.status, "FAILED");
  assert.equal((await repo.snapshot("stock_list")).id, old.snapshotId);
});

test("the new registry scope uses the same origin checks, persistent jobs and duplicate submission rules", async (t) => {
  const { env, repo, owner } = setup(t);
  await repo.claimWorker(owner);
  const request = (origin = "http://local") =>
    new Request("http://local/api/data/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ scope: "stock_list" }),
    });
  assert.equal((await api(request("http://evil"), env)).status, 403);
  const created = await api(request(), env);
  assert.equal(created.status, 202);
  const job = (await created.json()).job;
  const repeated = await (await api(request(), env)).json();
  assert.equal(repeated.reused, true);
  assert.equal(repeated.job.id, job.id);
  assert.equal((await metadataStatus(env)).stockList, null);
});
