// Imported only by the Node worker, never by the server/browser bundle.
import { load } from "cheerio";
import { swsOfficialFetch } from "./sws-official-fetch.js";
import {
  parseSwsClassifications,
  SWS_CLASSIFICATION_URL,
} from "./sws-classification.js";
import {
  coreStockCode,
  DataUpdateError,
  DataUpdateCancelled,
  validateMetadataRecords,
} from "../domain/stock-metadata.js";
const SW_ROOT = "https://legulegu.com/stockdata/sw-industry-overview";
const LIXINGER_BASE = "https://open.lixinger.com/api/cn/";
const EM_ENDPOINTS = [
  "https://push2delay.eastmoney.com/api/qt/clist/get",
  "https://push2.eastmoney.com/api/qt/clist/get",
];
const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DataUpdateCancelled());
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DataUpdateCancelled());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
export function metadataHttp({
  fetchImpl = fetch,
  signal,
  check = async () => {},
  intervalMs,
  timeoutMs = 12000,
  retries = 2,
  retryBaseMs = 1500,
  rateLimitMs = 60000,
  maxRetryWaitMs = 300000,
  states = new Map(),
  onRetry = async () => {},
  now = Date.now,
  sleep = wait,
  random = Math.random,
} = {}) {
  return async (url, label, format = "json", { json } = {}) => {
    const host = new URL(url).host,
      baseInterval = intervalMs ?? (label === "申万" ? 2500 : 1000);
    if (!states.has(host))
      states.set(host, {
        gate: Promise.resolve(),
        lastStarted: null,
        notBefore: 0,
        interval: baseInterval,
      });
    const state = states.get(host);
    for (let attempt = 0; attempt <= retries; attempt++) {
      await check();
      if (signal?.aborted) throw new DataUpdateCancelled();
      const slot = state.gate.then(async () => {
        // Recheck after sleeping: another request may have extended the host's
        // cooldown while this one was queued. A new job shares this state too.
        for (;;) {
          const delay =
            Math.max(
              state.notBefore,
              state.lastStarted === null
                ? 0
                : state.lastStarted + state.interval,
            ) - now();
          if (delay <= 0) break;
          await sleep(delay, signal);
          await check();
        }
        state.lastStarted = now();
      });
      state.gate = slot.catch(() => {});
      await slot;
      await check();
      try {
        const fetchRequest =
          fetchImpl === fetch && new URL(url).hostname === "www.swsresearch.com"
            ? swsOfficialFetch
            : fetchImpl;
        const response = await fetchRequest(url, {
          ...(json ? { method: "POST", body: JSON.stringify(json) } : {}),
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
            Accept: format === "json" ? "application/json" : "text/html",
            ...(json
              ? {
                  "Content-Type": "application/json",
                  "Accept-Encoding": "gzip, deflate, br",
                }
              : {}),
            ...(label === "东财"
              ? { Referer: "https://quote.eastmoney.com/" }
              : label === "上交所"
                ? {
                    Referer:
                      "https://www.sse.com.cn/assortment/stock/list/share/",
                  }
                : label === "深交所"
                  ? {
                      Referer:
                        "https://www.szse.cn/market/product/stock/list/index.html",
                    }
                  : label === "新浪"
                    ? { Referer: "https://finance.sina.com.cn/" }
                    : label === "申万"
                      ? { Referer: SW_ROOT }
                      : {}),
          },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const error = new DataUpdateError(
            response.status === 429
              ? `${label}接口限流（HTTP 429）`
              : `${label}接口 HTTP ${response.status}`,
            502,
          );
          error.httpStatus = response.status;
          error.retryable = response.status === 429 || response.status >= 500;
          const retryAfter = response.headers.get("retry-after");
          error.retryAfterMs =
            retryAfter === null
              ? 0
              : /^\s*\d+(?:\.\d+)?\s*$/.test(retryAfter)
                ? Number(retryAfter) * 1000
                : Math.max(0, Date.parse(retryAfter) - now()) || 0;
          await response.body?.cancel();
          throw error;
        }
        return format === "json"
          ? await response.json()
          : format === "bytes"
            ? await response.arrayBuffer()
            : await response.text();
      } catch (error) {
        if (signal?.aborted) throw new DataUpdateCancelled();
        const failure = metadataRequestError(error, label, timeoutMs),
          limited = error.httpStatus === 429,
          backoff = (limited ? rateLimitMs : retryBaseMs) * 2 ** attempt,
          delay = Math.max(
            error.retryAfterMs || 0,
            backoff + Math.floor(random() * backoff * 0.2),
          );
        if (limited || error.retryAfterMs) {
          state.notBefore = Math.max(state.notBefore, now() + delay);
          if (limited)
            state.interval = Math.min(
              15000,
              Math.max(baseInterval, state.interval * 2),
            );
        }
        if (
          error.retryable === false ||
          attempt === retries ||
          delay > maxRetryWaitMs
        ) {
          failure.message += `（已尝试 ${attempt + 1} 次），保留旧版`;
          throw failure;
        }
        const retryAt = new Date(
          Math.max(now() + delay, state.notBefore),
        ).toISOString();
        await onRetry({
          label,
          host,
          reason: failure.message,
          attempt: attempt + 1,
          maxRetries: retries,
          retryAt,
          delayMs: Math.max(delay, state.notBefore - now()),
        });
        await sleep(delay, signal);
      }
    }
  };
}
function metadataRequestError(error, label, timeoutMs) {
  if (error instanceof DataUpdateError) return error;
  const code = error.cause?.code || error.code,
    timedOut =
      error.name === "TimeoutError" || /TIMEOUT|ETIMEDOUT/.test(code || "");
  let reason = "连接失败";
  if (timedOut) reason = `请求超时（${timeoutMs / 1000} 秒）`;
  else if (["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"].includes(code))
    reason = `连接中断（远端关闭连接，${code}）`;
  else if (["ENOTFOUND", "EAI_AGAIN"].includes(code))
    reason = `域名解析失败（${code}）`;
  else if (error instanceof SyntaxError) reason = "返回内容不是有效 JSON";
  const failure = new DataUpdateError(`${label}${reason}`, 502);
  // Only transport failures may select another public endpoint from the same
  // provider. Never route around an HTTP rate limit or access rejection.
  failure.transportFailure = !(error instanceof SyntaxError);
  return failure;
}

// The bulk API returns the taxonomy and all memberships in two requests. Only
// current third-level industries produce stock assignments; first/second level
// memberships are supersets and historical, unknown codes are ignored.
export function buildLixingerSwRecords(
  industries,
  memberships,
  { resolutions = new Map() } = {},
) {
  if (
    !Array.isArray(industries) ||
    !industries.length ||
    !Array.isArray(memberships) ||
    !memberships.length
  )
    throw new DataUpdateError("理杏仁行业目录或全量成分为空，保留旧版");
  const catalog = new Map();
  for (const item of industries) {
    if (
      !/^\d{6}$/.test(item?.stockCode) ||
      !["one", "two", "three"].includes(item.level) ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      catalog.has(item.stockCode) ||
      (item.source && item.source !== "sw_2021")
    )
      throw new DataUpdateError(
        "理杏仁申万目录格式异常、重复或口径不符，保留旧版",
      );
    catalog.set(item.stockCode, { ...item, name: item.name.trim() });
  }
  const byIndustry = new Map();
  for (const item of memberships) {
    if (
      !/^\d{6}$/.test(item?.stockCode) ||
      !Array.isArray(item.constituents) ||
      byIndustry.has(item.stockCode)
    )
      throw new DataUpdateError("理杏仁全量行业成分格式异常或重复，保留旧版");
    byIndustry.set(item.stockCode, item.constituents);
  }
  const leaves = [...catalog.values()].filter((r) => r.level === "three"),
    records = [];
  if (!leaves.length)
    throw new DataUpdateError("理杏仁申万三级目录缺失，保留旧版");
  for (const leaf of leaves) {
    const root = catalog.get(`${leaf.stockCode.slice(0, 2)}0000`),
      parent = catalog.get(`${leaf.stockCode.slice(0, 4)}00`),
      members = byIndustry.get(leaf.stockCode);
    if (root?.level !== "one" || parent?.level !== "two" || !members)
      throw new DataUpdateError(
        `理杏仁 ${leaf.name} 层级或成分缺失，名单不完整，保留旧版`,
      );
    const seen = new Set();
    for (const member of members) {
      const code = member?.stockCode;
      if (!/^\d{6}$/.test(code) || seen.has(code))
        throw new DataUpdateError(
          `理杏仁 ${leaf.name} 股票代码无效或重复，保留旧版`,
        );
      seen.add(code);
      if (!coreStockCode(code)) continue;
      records.push({
        code,
        name:
          typeof member.stockName === "string"
            ? member.stockName
            : member.stockName?.cmn_hans_cn,
        swL1: root.name,
        swL2: parent.name,
        swL3: leaf.name,
        swL1Code: root.stockCode,
        swL2Code: parent.stockCode,
        swCode: leaf.stockCode,
      });
    }
  }
  const candidates = new Map();
  for (const record of records) {
    if (!candidates.has(record.code)) candidates.set(record.code, []);
    candidates.get(record.code).push(record);
  }
  const conflicts = [...candidates]
    .filter(([, items]) => items.length > 1)
    .map(([code, items]) => ({ code, name: items[0].name, candidates: items }));
  const unresolved = conflicts.filter(
    ({ code, candidates }) =>
      !candidates.some((r) => r.swCode === resolutions.get(code)?.swCode),
  );
  // Parent memberships contain historical identities whose old L3 codes are
  // absent from the current taxonomy. They may be excluded only when the
  // official history confirms that; a missing current L3 remains a hard error.
  const parentOnly = new Map();
  for (const item of catalog.values()) {
    if (item.level === "three") continue;
    const members = byIndustry.get(item.stockCode);
    if (!members) throw new DataUpdateError("理杏仁申万父级成分缺失，保留旧版");
    const seen = new Set();
    for (const member of members) {
      const code = member?.stockCode;
      if (!/^\d{6}$/.test(code) || seen.has(code))
        throw new DataUpdateError("理杏仁申万父级股票代码无效或重复，保留旧版");
      seen.add(code);
      if (coreStockCode(code) && !candidates.has(code))
        parentOnly.set(code, { code });
    }
  }
  const unchecked = [...parentOnly.values()].filter(({ code }) => {
    const official = resolutions.get(code);
    return !official || catalog.has(official.swCode);
  });
  if (unresolved.length || unchecked.length)
    throw new DataUpdateError(
      `理杏仁申万存在 ${unresolved.length} 只股票多归属、${unchecked.length} 只仅有父级归属，未通过官方完整性核验，保留旧版`,
      502,
      {
        conflicts: unresolved,
        parentOnly: unchecked,
        verificationCodes: [
          ...new Set([
            ...unresolved.map((r) => r.code),
            ...unchecked.map((r) => r.code),
          ]),
        ],
      },
    );
  const selected = [...candidates].map(([code, items]) => {
    if (items.length === 1) return items[0];
    const resolution = resolutions.get(code),
      chosen = items.find((r) => r.swCode === resolution.swCode);
    return {
      ...chosen,
      swVerification: {
        ...resolution,
        verifiedAt: new Date().toISOString(),
        rejectedIndustryCodes: items
          .filter((r) => r !== chosen)
          .map((r) => r.swCode),
      },
    };
  });
  const validated = validateMetadataRecords("industry_sw", selected);
  // Every selected current L3 must agree with both parent membership sets.
  for (const record of validated) {
    for (const code of [record.swL1Code, record.swL2Code]) {
      const members = byIndustry.get(code);
      if (!members || !members.some((r) => r.stockCode === record.code))
        throw new DataUpdateError("理杏仁申万父级与三级归属不一致，保留旧版");
    }
  }
  return validated;
}

export async function fetchLixingerShenwanMetadata({
  token,
  request = metadataHttp({ timeoutMs: 20000 }),
  check = async () => {},
  progress = async () => {},
  date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()),
} = {}) {
  if (typeof token !== "string" || !token.trim())
    throw new DataUpdateError(
      "未配置理杏仁接口凭证；请在本项目 .env 配置后重启服务",
      503,
    );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new DataUpdateError("申万分类查询日期格式错误");
  const get = async (path, payload) => {
    await check();
    const response = await request(
      `${LIXINGER_BASE}${path}`,
      "理杏仁",
      "json",
      { json: { token: token.trim(), ...payload } },
    );
    if (
      response?.code !== 1 ||
      !Array.isArray(response.data) ||
      !response.data.length
    )
      throw new DataUpdateError(
        "理杏仁未返回有效申万数据，请检查接口授权、日期及服务状态，保留旧版",
        502,
      );
    return response.data;
  };
  await progress("理杏仁批量：读取申万 2021 行业目录（1/2）", {
    kind: "industry_sw",
    completed: 0,
    total: 2,
  });
  const industries = await get("industry", { source: "sw_2021" });
  await progress("理杏仁批量：读取全市场行业成分（2/2）", {
    kind: "industry_sw",
    completed: 1,
    total: 2,
  });
  const memberships = await get("industry/constituents/sw_2021", { date });
  await check();
  let records,
    requestCount = 2;
  try {
    records = buildLixingerSwRecords(industries, memberships);
  } catch (error) {
    if (!error.details?.verificationCodes) throw error;
    await check();
    await progress(
      `理杏仁 ${error.details.conflicts.length} 只股票多归属、${error.details.parentOnly.length} 只仅有父级归属，按申万官方变更记录核验`,
      { kind: "industry_sw", completed: 2, total: 3 },
    );
    const bytes = await request(SWS_CLASSIFICATION_URL, "申万官方", "bytes"),
      resolutions = parseSwsClassifications(bytes, {
        date,
        codes: error.details.verificationCodes,
      });
    await check();
    records = buildLixingerSwRecords(industries, memberships, { resolutions });
    requestCount++;
  }
  await progress("理杏仁全量申万归属校验完成", {
    kind: "industry_sw",
    completed: requestCount,
    total: requestCount,
  });
  return records;
}
export async function fetchEastmoneyMetadata({
  request = metadataHttp(),
  check = async () => {},
  progress = async () => {},
  pageSize = 100,
  endpoints = EM_ENDPOINTS,
} = {}) {
  for (let i = 0; i < endpoints.length; i++) {
    try {
      return await fetchEastmoneyPages({
        request,
        check,
        progress,
        pageSize,
        endpoint: endpoints[i],
      });
    } catch (error) {
      if (!error.transportFailure || i === endpoints.length - 1) throw error;
      await check();
      await progress("东财连接失败，切换同源备用地址并重新读取完整名单", {
        kind: "stock_em",
        completed: 0,
        total: null,
      });
    }
  }
}
async function fetchEastmoneyPages({
  request,
  check,
  progress,
  pageSize,
  endpoint,
}) {
  const records = [],
    seen = new Set();
  let total = null;
  for (let page = 1; page <= 1000; page++) {
    await check();
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
      pn: String(page),
      pz: String(pageSize),
      po: "1",
      np: "1",
      fltt: "2",
      invt: "2",
      fid: "f12",
      fs: "m:0+t:6,m:0+t:80,m:1+t:2",
      fields: "f12,f13,f14,f100",
    }).toString();
    const body = await request(url.toString(), "东财");
    if (
      body?.rc !== 0 ||
      !Array.isArray(body.data?.diff) ||
      !Number.isInteger(body.data.total) ||
      body.data.total <= 0 ||
      body.data.total > 100000
    )
      throw new DataUpdateError("东财名单为空或字段格式变化，保留旧版");
    if (total !== null && total !== body.data.total)
      throw new DataUpdateError("东财分页总数在更新中变化，请重试，旧版未替换");
    total = body.data.total;
    if (!body.data.diff.length)
      throw new DataUpdateError("东财分页提前结束，旧版未替换");
    for (const r of body.data.diff) {
      if (
        !coreStockCode(r.f12) ||
        Number(r.f13) !== (r.f12.startsWith("6") ? 1 : 0)
      )
        throw new DataUpdateError("东财返回股票范围或市场字段异常");
      if (seen.has(r.f12))
        throw new DataUpdateError(
          "东财分页出现重复股票，名单不完整，旧版未替换",
        );
      seen.add(r.f12);
      records.push({ code: r.f12, name: r.f14, emIndustry: r.f100 });
    }
    await progress(`东财股票与行业：第 ${page} 页`, {
      kind: "stock_em",
      completed: seen.size,
      total,
      pages: page,
    });
    if (seen.size > total)
      throw new DataUpdateError("东财股票数量超过声明总数，旧版未替换");
    if (seen.size === total)
      return validateMetadataRecords("stock_em", records);
  }
  throw new DataUpdateError("东财分页超过上限，旧版未替换");
}
export function parseSwTree(html) {
  const $ = load(html);
  const sections = [1, 2, 3].map((level) => {
    const container = $(`#level${level}Items`),
      codes = container.find(".lg-industries-item-chinese-title").toArray(),
      names = container.find(".lg-industries-item-number").toArray();
    if (!codes.length || codes.length !== names.length)
      throw new DataUpdateError("申万行业树格式变化，旧版未替换");
    return codes.map((el, i) => {
      const code = $(el).text().trim(),
        text = $(names[i]).text().trim(),
        match = /^(.*?)\((\d+)\)(?:\[(.*?)\])?\s*$/.exec(text);
      if (!/^\d{6}\.SI$/.test(code) || !match)
        throw new DataUpdateError("申万行业代码或名称格式变化");
      return {
        code,
        name: match[1].trim(),
        expected: Number(match[2]),
        parent: (match[3] ?? "").trim(),
      };
    });
  });
  const [l1, l2, l3] = sections,
    first = new Map(l1.map((r) => [r.name, r])),
    second = new Map(l2.map((r) => [r.name, r])),
    seen = new Set();
  return l3.map((leaf) => {
    const parent = second.get(leaf.parent),
      root = first.get(parent?.parent);
    if (!parent || !root || seen.has(leaf.code))
      throw new DataUpdateError("申万行业层级缺失或重复，旧版未替换");
    seen.add(leaf.code);
    return {
      ...leaf,
      swL1: root.name,
      swL2: parent.name,
      swL3: leaf.name,
      swL1Code: root.code,
      swL2Code: parent.code,
      swCode: leaf.code,
    };
  });
}
export function parseSwMembers(html, leaf) {
  const $ = load(html);
  let table, headers;
  $("table").each((_, el) => {
    const cells = $(el)
      .find("tr")
      .first()
      .find("th,td")
      .toArray()
      .map((c) => $(c).text().trim());
    if (
      cells.some((c) => c.includes("代码")) &&
      cells.some((c) => /简称|名称/.test(c))
    ) {
      table = $(el);
      headers = cells;
      return false;
    }
  });
  if (!table)
    throw new DataUpdateError(`申万 ${leaf.name} 成分页格式变化，旧版未替换`);
  const codeIndex = headers.findIndex((c) => c.includes("代码")),
    nameIndex = headers.findIndex((c) => /简称|名称/.test(c)),
    memberCodes = [],
    records = [];
  table
    .find("tr")
    .slice(1)
    .each((_, tr) => {
      const cells = $(tr).find("td"),
        match = /(?:^|[^\d])(\d{6})(?!\d)/.exec(
          cells.eq(codeIndex).text().trim(),
        );
      if (!match) return;
      memberCodes.push(match[1]);
      if (!coreStockCode(match[1])) return;
      records.push({
        code: match[1],
        name: cells.eq(nameIndex).text().trim(),
        swL1: leaf.swL1,
        swL2: leaf.swL2,
        swL3: leaf.swL3,
        swL1Code: leaf.swL1Code,
        swL2Code: leaf.swL2Code,
        swCode: leaf.swCode,
      });
    });
  // Count the complete source table, including stocks outside our market scope,
  // before filtering. A truncated but otherwise valid HTML page must not publish.
  if (
    memberCodes.length !== leaf.expected ||
    new Set(memberCodes).size !== memberCodes.length
  )
    throw new DataUpdateError(
      `申万 ${leaf.name} 成分数量不完整或重复（预期 ${leaf.expected}，收到 ${memberCodes.length}），旧版未替换`,
    );
  return records;
}
export async function fetchShenwanMetadata({
  request = metadataHttp(),
  check = async () => {},
  progress = async () => {},
} = {}) {
  const leaves = parseSwTree(await request(SW_ROOT, "申万", "text"));
  await progress("申万行业树已读取", {
    kind: "industry_sw",
    completed: 0,
    total: leaves.length,
  });
  const records = [];
  let completed = 0;
  // Serial requests also ensure that no second member request is already in
  // flight when the site asks us to pause with HTTP 429.
  for (const leaf of leaves) {
    await check();
    if (leaf.expected > 0) {
      const html = await request(
        `https://legulegu.com/stockdata/index-composition?industryCode=${encodeURIComponent(leaf.code)}`,
        "申万",
        "text",
      );
      records.push(...parseSwMembers(html, leaf));
    }
    completed++;
    await progress(`申万：${leaf.name}（${completed}/${leaves.length}）`, {
      kind: "industry_sw",
      completed,
      total: leaves.length,
    });
  }
  await check();
  return validateMetadataRecords("industry_sw", records);
}
