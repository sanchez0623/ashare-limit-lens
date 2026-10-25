// Node worker only. Both routes use Eastmoney's current industry taxonomy.
import { metadataHttp, fetchEastmoneyMetadata } from "./metadata-providers.js";
import {
  coreStockCode,
  industryName,
  DataUpdateError,
  validateMetadataRecords,
} from "../domain/stock-metadata.js";

const BATCH_URL = "https://push2.eastmoney.com/api/qt/ulist.np/get";
const F10_URL = "https://datacenter.eastmoney.com/securities/api/data/v1/get";
const fail = (message) => {
  throw new DataUpdateError(`${message}，保留旧版`);
};
function universe(stocks) {
  if (!Array.isArray(stocks) || !stocks.length)
    return fail("东财批量行业需要先更新股票名册");
  const seen = new Set();
  for (const row of stocks) {
    if (!coreStockCode(row?.code) || seen.has(row.code))
      return fail("行业查询名册代码无效或重复");
    seen.add(row.code);
  }
  return [...seen].sort();
}
const secucode = (code) => `${code}.${code.startsWith("6") ? "SH" : "SZ"}`;

export async function fetchEastmoneyIndustryBatches({
  stocks,
  request = metadataHttp(),
  check = async () => {},
  progress = async () => {},
  batchSize = 200,
} = {}) {
  const codes = universe(stocks),
    records = [];
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200)
    return fail("东财行业批量大小无效");
  const batches = Math.ceil(codes.length / batchSize);
  for (let offset = 0; offset < codes.length; offset += batchSize) {
    await check();
    const chunk = codes.slice(offset, offset + batchSize),
      expected = new Set(chunk),
      url = new URL(BATCH_URL);
    url.search = new URLSearchParams({
      fltt: "2",
      invt: "2",
      fields: "f12,f13,f14,f100",
      secids: chunk
        .map((code) => `${code.startsWith("6") ? 1 : 0}.${code}`)
        .join(","),
    }).toString();
    const body = await request(url.toString(), "东财");
    if (
      body?.rc !== 0 ||
      !Array.isArray(body.data?.diff) ||
      body.data.total !== chunk.length ||
      body.data.diff.length !== chunk.length
    )
      return fail("东财批量行业数量不完整或格式变化");
    for (const row of body.data.diff) {
      if (
        !expected.delete(row?.f12) ||
        Number(row.f13) !== (row.f12.startsWith("6") ? 1 : 0) ||
        typeof row.f14 !== "string" ||
        !row.f14.trim() ||
        !Object.hasOwn(row, "f100") ||
        !(row.f100 === null || typeof row.f100 === "string")
      )
        return fail("东财批量行业返回未请求、重复或无效股票字段");
      records.push({
        code: row.f12,
        name: row.f14,
        emIndustry: row.f100,
        emIndustrySource: "eastmoney-ulist-f100",
        emIndustryField: "f100",
      });
    }
    await progress(`东财原生行业：第 ${offset / batchSize + 1}/${batches} 批`, {
      kind: "stock_em",
      completed: records.length,
      total: codes.length,
      batches: offset / batchSize + 1,
    });
  }
  await check();
  return validateMetadataRecords("stock_em", records);
}

export async function fetchEastmoneyIndustryF10({
  stocks,
  request = metadataHttp(),
  check = async () => {},
  progress = async () => {},
  pageSize = 500,
} = {}) {
  const codes = universe(stocks),
    expected = new Map(codes.map((code) => [secucode(code), code])),
    seen = new Set(),
    records = new Map();
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500)
    return fail("东财 F10 分页大小无效");
  let total = null,
    pages = null,
    received = 0;
  for (let page = 1; page <= 1000; page++) {
    await check();
    const url = new URL(F10_URL);
    url.search = new URLSearchParams({
      reportName: "RPT_F10_BASIC_ORGINFO",
      columns:
        "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,SECURITY_TYPE_CODE,BOARD_NAME_LEVEL",
      source: "HSF10",
      client: "PC",
      pageSize: String(pageSize),
      pageNumber: String(page),
      filter: '(SECURITY_TYPE_CODE="058001001")',
      sortColumns: "SECUCODE",
      sortTypes: "1",
    }).toString();
    const body = await request(url.toString(), "东财 F10"),
      result = body?.result;
    if (
      body?.success !== true ||
      body.code !== 0 ||
      !Array.isArray(result?.data) ||
      !Number.isInteger(result.count) ||
      result.count <= 0 ||
      result.count > 100000 ||
      !Number.isInteger(result.pages) ||
      result.pages !== Math.ceil(result.count / pageSize)
    )
      return fail("东财 F10 名单为空、分页声明或格式异常");
    if (total !== null && (total !== result.count || pages !== result.pages))
      return fail("东财 F10 分页总数变化");
    total = result.count;
    pages = result.pages;
    if (result.data.length !== Math.min(pageSize, total - received))
      return fail("东财 F10 分页数量不完整");
    received += result.data.length;
    for (const row of result.data) {
      if (
        typeof row?.SECUCODE !== "string" ||
        !row.SECUCODE ||
        seen.has(row.SECUCODE) ||
        row.SECURITY_TYPE_CODE !== "058001001"
      )
        return fail("东财 F10 证券标识重复或范围异常");
      seen.add(row.SECUCODE);
      // The full report also contains delisted and other-market identities.
      // Only the separately published active registry defines our target set.
      const code = expected.get(row.SECUCODE);
      if (!code) continue;
      if (
        row.SECURITY_CODE !== code ||
        typeof row.SECURITY_NAME_ABBR !== "string" ||
        !row.SECURITY_NAME_ABBR.trim() ||
        !Object.hasOwn(row, "BOARD_NAME_LEVEL") ||
        !(
          row.BOARD_NAME_LEVEL === null ||
          typeof row.BOARD_NAME_LEVEL === "string"
        )
      )
        return fail("东财 F10 股票代码、名称或行业字段异常");
      const path = industryName(row.BOARD_NAME_LEVEL),
        levels = path?.split("-").map((s) => s.trim());
      if (
        levels &&
        (levels.length !== 3 || levels.some((s) => !industryName(s)))
      )
        return fail("东财 F10 当前行业层级格式变化");
      records.set(code, {
        code,
        name: row.SECURITY_NAME_ABBR,
        emIndustry: levels?.[1] ?? null,
        emIndustrySource: "eastmoney-f10-board-level2",
        emIndustryField: "BOARD_NAME_LEVEL[1]",
        emIndustryPath: path,
      });
    }
    await progress(`东财 F10 当前行业：第 ${page}/${pages} 页`, {
      kind: "stock_em",
      completed: received,
      total,
      pages: page,
      targetCovered: records.size,
      targetTotal: codes.length,
    });
    if (page === pages) {
      if (
        received !== total ||
        seen.size !== total ||
        records.size !== codes.length
      )
        return fail("东财 F10 行业未覆盖完整目标名册");
      await check();
      return validateMetadataRecords("stock_em", [...records.values()]);
    }
  }
  return fail("东财 F10 分页超过上限");
}

export async function fetchEastmoneyIndustryUpdate(options = {}) {
  const { stocks, check = async () => {}, progress = async () => {} } = options;
  if (!stocks?.length) {
    try {
      return {
        records: await fetchEastmoneyMetadata(options),
        source: "eastmoney-clist-f100",
      };
    } catch (error) {
      if (error.transportFailure)
        error.message += "；请先更新股票名册，以启用东财批量行业接口";
      throw error;
    }
  }
  try {
    return {
      records: await fetchEastmoneyIndustryBatches(options),
      source: "eastmoney-ulist-f100",
    };
  } catch (error) {
    // Switch only for transport failures, never to route around HTTP 429/403
    // or to hide duplicate, truncated or semantically invalid responses.
    if (!error.transportFailure) throw error;
    await check();
    await progress("东财批量连接失败，改用 F10 数据中心完整读取当前二级行业", {
      kind: "stock_em",
      completed: 0,
      total: null,
    });
    return {
      records: await fetchEastmoneyIndustryF10(options),
      source: "eastmoney-f10-board-level2",
      warnings: [
        "东财批量接口连接失败，本次通过 F10 数据中心发布相同口径的当前二级行业",
      ],
    };
  }
}
