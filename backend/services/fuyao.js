// 同花顺金融数据 API 客户端
// 官方文档: https://fuyao.aicubes.cn/docs/api-reference/overview/
// 用途: 补全东财缺失字段（涨停原因、峰值封单、跌停池、竞价数据、盘中最高/最低）
// 策略: 东财优先，同花顺只做补全；补全失败不得阻塞或降级东财主数据。

const BASE = "https://fuyao.aicubes.cn";
const CACHE = new Map();
const CACHE_TTL = 120000; // 2 分钟缓存

// 从环境变量读取 API key，避免硬编码
// 生产环境设置: FU_YAO_API_KEY=sk-fuyao-xxx
// 延迟读取，支持运行时设置环境变量
function getApiKey() {
  return process.env.FU_YAO_API_KEY || "";
}

// 上海时区 00:00 毫秒戳 = UTC 前一天 16:00
export function shanghaiDayMs(dateStr) {
  // dateStr: "2026-10-16"
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1, 16, 0, 0)).getTime();
}

// 通用请求函数，处理 429 限流重试
// timeoutMs/retries 可由补全调用方收紧：补全场景宁可放弃，也不拖慢主行情。
async function request(
  path,
  params = {},
  {
    retries = 2,
    delayMs = 500,
    timeoutMs = 20000,
    cacheTtlMs = CACHE_TTL,
  } = {},
) {
  const apiKey = getApiKey();
  if (!apiKey) {
    // API key 未设置时，返回空数据而不是抛错，避免影响主流程
    return { item: [], total: 0, unavailable: true };
  }

  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  // 检查缓存
  const cacheKey = url.toString();
  const hit = CACHE.get(cacheKey);
  if (hit && cacheTtlMs > 0 && Date.now() - hit.time < cacheTtlMs) {
    return { ...hit.data, cached: true };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { "X-api-key": apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json();

      // 429 限流重试
      if (body.code === 429) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
          continue;
        }
        throw new Error("同花顺 API 限流，重试后仍失败");
      }

      // 业务错误
      if (body.code !== 0) {
        throw new Error(
          `同花顺 API 错误: code=${body.code}, message=${body.message}`,
        );
      }

      // 缓存成功响应
      if (CACHE.size >= 50) CACHE.delete(CACHE.keys().next().value);
      CACHE.set(cacheKey, { time: Date.now(), data: body.data });

      return { ...body.data, cached: false };
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  throw new Error("请求失败");
}

// 涨停池
export async function getLimitUpPool(
  dateStr,
  { size = 200, page = 1, ...options } = {},
) {
  const dateMs = shanghaiDayMs(dateStr);
  return request(
    "/api/a-share/special-data/limit-up-pool",
    { date_ms: dateMs, size, page },
    options,
  );
}

// 炸板池
export async function getLimitBreakPool(
  dateStr,
  { size = 200, page = 1, ...options } = {},
) {
  const dateMs = shanghaiDayMs(dateStr);
  return request(
    "/api/a-share/special-data/limit-break-pool",
    { date_ms: dateMs, size, page },
    options,
  );
}

// 跌停池
export async function getLimitDownPool(
  dateStr,
  { size = 200, ...options } = {},
) {
  const dateMs = shanghaiDayMs(dateStr);
  return request(
    "/api/a-share/special-data/limit-down-pool",
    { date_ms: dateMs, size },
    options,
  );
}

// 连板天梯（30 日，无入参）
export async function getLimitUpLadder(options = {}) {
  return request("/api/a-share/special-data/limit-up-ladder", {}, options);
}

// 行情快照（批量）
export async function getPricesSnapshot(
  thscodes,
  { limit = 100, ...options } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("快照分组大小无效");
  // 单次最多 100 个，需要分批
  const codes = Array.isArray(thscodes)
    ? thscodes
    : String(thscodes).split(",");
  if (!codes.length) return { item: [], total: 0 };
  if (codes.length <= limit) {
    return request(
      "/api/a-share/prices/snapshot",
      {
        thscodes: codes.join(","),
      },
      { ...options, cacheTtlMs: 0 },
    );
  }

  // 分批请求
  const results = [];
  const batches = [];
  for (let i = 0; i < codes.length; i += limit) {
    const batch = codes.slice(i, i + limit);
    const res = await request(
      "/api/a-share/prices/snapshot",
      {
        thscodes: batch.join(","),
      },
      { ...options, cacheTtlMs: 0 },
    );
    batches.push(res);
    results.push(...(res.item || []));
    await new Promise((r) => setTimeout(r, 300)); // 避免限流
  }
  return {
    ...batches[0],
    item: results,
    total: results.length,
    batches: batches.map((batch) => ({ timestamp: batch.timestamp })),
  };
}

export async function getPricesHistorical(
  thscode,
  { start, end, adjust = "none", ...options } = {},
) {
  if (
    !/^\d{6}\.(SH|SZ)$/.test(thscode) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    !["none", "forward"].includes(adjust)
  )
    throw new Error("日线请求参数无效");
  return request(
    "/api/a-share/prices/historical",
    {
      thscode,
      interval: "1d",
      start,
      end,
      adjust,
    },
    options,
  );
}

// 集合竞价快照
export async function getAuctionSnapshot(
  thscodes,
  { stage = "final", ...options } = {},
) {
  const codes = Array.isArray(thscodes)
    ? thscodes
    : String(thscodes).split(",");
  if (codes.length <= 100) {
    return request(
      "/api/a-share/auction/snapshot",
      {
        thscodes: codes.join(","),
        stage,
      },
      { ...options, cacheTtlMs: 0 },
    );
  }

  // 分批请求
  const results = [];
  const batches = [];
  for (let i = 0; i < codes.length; i += 100) {
    const batch = codes.slice(i, i + 100);
    const res = await request(
      "/api/a-share/auction/snapshot",
      {
        thscodes: batch.join(","),
        stage,
      },
      { ...options, cacheTtlMs: 0 },
    );
    batches.push(res);
    results.push(...(res.item || []));
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    ...batches[0],
    item: results,
    total: results.length,
    batches: batches.map(({ timestamp, auction_phase, data_status }) => ({
      timestamp,
      auction_phase,
      data_status,
    })),
    ...(batches.some(
      (b) =>
        b.auction_phase !== batches[0].auction_phase ||
        b.data_status !== batches[0].data_status,
    )
      ? { data_status: "not_ready" }
      : {}),
  };
}

// 短线风向标竞价基准（历史可查）
export async function getShortTermBenchmark(dateStr, options = {}) {
  return request(
    "/api/a-share/auction/short-term-benchmark",
    {
      date: dateStr,
    },
    options,
  );
}

export async function getAuctionOpportunityDates(options = {}) {
  return request(
    "/api/a-share/special-data/auction-opportunity-dates",
    {},
    options,
  );
}

export async function getAuctionOpportunities({
  date,
  thscodes = [],
  exclude_st = true,
  maxPages = 50,
  deadlineMs = 4000,
  ...options
} = {}) {
  const codes = Array.isArray(thscodes)
    ? thscodes
    : String(thscodes).split(",");
  const groups = codes.length
    ? Array.from({ length: Math.ceil(codes.length / 50) }, (_, i) =>
        codes.slice(i * 50, i * 50 + 50),
      )
    : [[]];
  const deadline = Date.now() + deadlineMs;
  const groupsResult = await Promise.all(
    groups.map(async (group) => {
      const items = [];
      let metadata = {},
        truncated = false;
      for (let page = 1; page <= maxPages; page++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const response = await request(
          "/api/a-share/special-data/auction-stock-opportunities",
          {
            date,
            thscodes: group.length ? group.join(",") : undefined,
            exclude_st,
            page,
            size: 20,
          },
          {
            ...options,
            timeoutMs: Math.max(
              1,
              Math.min(options.timeoutMs ?? 4000, remaining),
            ),
            retries: 0,
            cacheTtlMs: 10000,
          },
        );
        metadata = response;
        items.push(...(response.item ?? []));
        if (!response.pagination?.has_next) break;
        if (page === maxPages) truncated = true;
      }
      return { ...metadata, item: items, truncated };
    }),
  );
  return {
    ...groupsResult[0],
    item: groupsResult.flatMap((r) => r.item),
    truncated: groupsResult.some((r) => r.truncated),
  };
}

// 清除缓存
export function clearCache() {
  CACHE.clear();
}

// 获取缓存统计
export function getCacheStats() {
  return { size: CACHE.size, ttl: CACHE_TTL };
}
