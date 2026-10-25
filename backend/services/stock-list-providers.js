// Node worker only: public stock identities, independent of scoring taxonomies.
import XLSX from "xlsx";
import { safeError } from "../http.js";
import { metadataHttp } from "./metadata-providers.js";
import {
  coreStockCode,
  DataUpdateError,
  DataUpdateCancelled,
  validateMetadataRecords,
} from "../domain/stock-metadata.js";

const SSE = "https://query.sse.com.cn/sseQuery/commonQuery.do";
const SZSE = "https://www.szse.cn/api/report/ShowReport";
const SINA =
  "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/";
const fail = (message) => {
  throw new DataUpdateError(`${message}，保留旧版`);
};
const beijingDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const marketOf = (code) => (code.startsWith("6") ? "SH" : "SZ");
function listingDateOf(value) {
  const text =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value ?? "");
  const match = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/.exec(text);
  if (!match) return "";
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
    ? date
    : "";
}
function identity(code, name, market, source, seen) {
  if (
    !coreStockCode(code) ||
    marketOf(code) !== market ||
    typeof name !== "string" ||
    !name.trim() ||
    seen.has(code)
  )
    return fail(`${source}名册代码、名称、市场无效或重复`);
  seen.add(code);
  return { code, name: name.trim(), market, registrySource: source };
}

export function parseSseStockList(body, { date = beijingDate() } = {}) {
  const rows = body?.result,
    total = Number(body?.pageHelp?.total);
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    !Number.isSafeInteger(total) ||
    total !== rows.length
  )
    return fail("上交所名册为空或数量不完整");
  const seen = new Set();
  return rows.map((row) => {
    const record = identity(
      row.A_STOCK_CODE,
      row.SEC_NAME_CN,
      "SH",
      "sse",
      seen,
    );
    const listingDate = listingDateOf(row.LIST_DATE);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(listingDate) || listingDate > date)
      return fail("上交所上市日期缺失、异常或包含未上市股票");
    return { ...record, listingDate };
  });
}

export function parseSzseStockList(bytes, { date = beijingDate() } = {}) {
  const buffer = Buffer.from(bytes);
  if (
    buffer.length > 20000000 ||
    buffer.subarray(0, 4).toString("hex") !== "504b0304"
  )
    return fail("深交所未返回有效 XLSX 名册");
  let rows;
  try {
    const book = XLSX.read(buffer, { type: "buffer", cellDates: true });
    rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], {
      raw: true,
      defval: "",
    });
  } catch {
    return fail("深交所 XLSX 名册无法解析");
  }
  if (
    !rows.length ||
    !["板块", "A股代码", "A股简称", "A股上市日期"].every((key) =>
      Object.hasOwn(rows[0], key),
    )
  )
    return fail("深交所名册为空或字段变化");
  const seen = new Set();
  return rows.map((row) => {
    const raw = String(row["A股代码"]),
      code = /^\d{1,6}$/.test(raw) ? raw.padStart(6, "0") : raw;
    const record = identity(code, row["A股简称"], "SZ", "szse", seen);
    if (row["板块"] !== (code.startsWith("30") ? "创业板" : "主板"))
      return fail("深交所股票代码与板块不一致");
    const listingDate = listingDateOf(row["A股上市日期"]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(listingDate) || listingDate > date)
      return fail("深交所上市日期缺失、异常或包含未上市股票");
    return { ...record, listingDate };
  });
}

export async function fetchExchangeStockList(
  market,
  {
    request = metadataHttp(),
    check = async () => {},
    date = beijingDate(),
  } = {},
) {
  await check();
  if (market === "SH") {
    const url = new URL(SSE);
    url.search = new URLSearchParams({
      STOCK_TYPE: "1",
      REG_PROVINCE: "",
      CSRC_CODE: "",
      STOCK_CODE: "",
      sqlId: "COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L",
      COMPANY_STATUS: "2,4,5,7,8",
      type: "inParams",
      isPagination: "true",
      "pageHelp.cacheSize": "1",
      "pageHelp.beginPage": "1",
      "pageHelp.pageSize": "10000",
      "pageHelp.pageNo": "1",
      "pageHelp.endPage": "1",
    }).toString();
    const rows = parseSseStockList(await request(url.toString(), "上交所"), {
      date,
    });
    await check();
    return rows;
  }
  if (market !== "SZ") return fail("股票名册市场无效");
  const url = new URL(SZSE);
  url.search = new URLSearchParams({
    SHOWTYPE: "xlsx",
    CATALOGID: "1110",
    TABKEY: "tab1",
  }).toString();
  const rows = parseSzseStockList(
    await request(url.toString(), "深交所", "bytes"),
    { date },
  );
  await check();
  return rows;
}

export async function fetchSinaStockList({
  request = metadataHttp(),
  check = async () => {},
  progress = async () => {},
  pageSize = 100,
} = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
    return fail("新浪名册分页大小无效");
  const countUrl = `${SINA}Market_Center.getHQNodeStockCount?node=hs_a`;
  const count = async () => {
    await check();
    const value = await request(countUrl, "新浪");
    if (
      !(
        typeof value === "number" ||
        (typeof value === "string" && /^\d+$/.test(value))
      ) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) <= 0 ||
      Number(value) > 100000
    )
      return fail("新浪股票总数无效或为空");
    return Number(value);
  };
  const total = await count(),
    seen = new Set(),
    rows = [];
  let previousSymbol = "";
  for (let page = 1; seen.size < total; page++) {
    await check();
    const url = new URL(`${SINA}Market_Center.getHQNodeData`);
    url.search = new URLSearchParams({
      page: String(page),
      num: String(pageSize),
      sort: "symbol",
      asc: "1",
      node: "hs_a",
    }).toString();
    const body = await request(url.toString(), "新浪");
    const expected = Math.min(pageSize, total - seen.size);
    if (!Array.isArray(body) || body.length !== expected)
      return fail("新浪分页提前结束、截断或数量变化");
    for (const row of body) {
      const code = row?.code,
        symbol = row?.symbol;
      if (
        !/^\d{6}$/.test(code) ||
        !/^(sh|sz|bj)\d{6}$/.test(symbol) ||
        symbol.slice(2) !== code ||
        seen.has(code) ||
        symbol <= previousSymbol ||
        typeof row.name !== "string" ||
        !row.name.trim()
      )
        return fail("新浪名册代码重复、排序不稳定或字段异常");
      seen.add(code);
      previousSymbol = symbol;
      if (!coreStockCode(code)) continue;
      const market = symbol.startsWith("sh")
        ? "SH"
        : symbol.startsWith("sz")
          ? "SZ"
          : "BJ";
      rows.push(identity(code, row.name, market, "sina", new Set()));
    }
    await progress(`新浪股票名册：第 ${page} 页`, {
      kind: "stock_list",
      completed: seen.size,
      total,
      pages: page,
    });
  }
  if ((await count()) !== total) return fail("新浪股票总数在更新中变化");
  await check();
  return validateMetadataRecords("stock_list", rows);
}

export async function fetchStockRegistryMetadata({
  request = metadataHttp(),
  check = async () => {},
  progress = async () => {},
  date = beijingDate(),
} = {}) {
  const records = [],
    failed = [],
    warnings = [];
  for (const [market, label] of [
    ["SH", "上交所"],
    ["SZ", "深交所"],
  ]) {
    await check();
    await progress(`读取${label}股票名册`, {
      kind: "stock_list",
      completed: records.length,
      total: null,
    });
    try {
      records.push(
        ...(await fetchExchangeStockList(market, { request, check, date })),
      );
    } catch (error) {
      await check();
      if (error instanceof DataUpdateCancelled) throw error;
      failed.push(market);
      const reason = safeError(error).replace(
        /[，；]?保留旧版|旧版未替换|保留上一份有效快照/g,
        "",
      );
      warnings.push(
        `${label}名册不可用（${reason}），已使用新浪补齐${market === "SH" ? "沪市" : "深市"}名单`,
      );
    }
  }
  if (failed.length) {
    await progress("交易所名册未完整取得，读取新浪完整分页后补齐缺失市场", {
      kind: "stock_list",
      completed: records.length,
      total: null,
    });
    const sina = await fetchSinaStockList({ request, check, progress });
    records.push(...sina.filter((row) => failed.includes(row.market)));
  }
  if (
    !["SH", "SZ"].every((market) =>
      records.some((row) => row.market === market),
    )
  )
    return fail("沪深股票名册未完整取得");
  await check();
  return {
    records: validateMetadataRecords("stock_list", records),
    source: "exchanges-sina",
    warnings,
  };
}
