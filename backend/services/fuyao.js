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
  { retries = 2, delayMs = 500, timeoutMs = 20000 } = {},
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
  if (hit && Date.now() - hit.time < CACHE_TTL) {
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
          await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
          continue;
        }
        throw new Error("同花顺 API 限流，重试后仍失败");
      }

      // 业务错误
      if (body.code !== 0) {
        throw new Error(`同花顺 API 错误: code=${body.code}, message=${body.message}`);
      }

      // 缓存成功响应
      if (CACHE.size >= 50) CACHE.delete(CACHE.keys().next().value);
      CACHE.set(cacheKey, { time: Date.now(), data: body.data });

      return { ...body.data, cached: false };
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  throw new Error("请求失败");
}

// 涨停池
export async function getLimitUpPool(dateStr, { size = 200, ...options } = {}) {
  const dateMs = shanghaiDayMs(dateStr);
  return request(
    "/api/a-share/special-data/limit-up-pool",
    { date_ms: dateMs, size },
    options,
  );
}

// 炸板池
export async function getLimitBreakPool(dateStr, { size = 200 } = {}) {
  const dateMs = shanghaiDayMs(dateStr);
  return request("/api/a-share/special-data/limit-break-pool", { date_ms: dateMs, size });
}

// 跌停池
export async function getLimitDownPool(dateStr, { size = 200 } = {}) {
  const dateMs = shanghaiDayMs(dateStr);
  return request("/api/a-share/special-data/limit-down-pool", { date_ms: dateMs, size });
}

// 连板天梯（30 日）
export async function getLimitUpLadder() {
  return request("/api/a-share/special-data/limit-up-ladder");
}

// 行情快照（批量）
export async function getPricesSnapshot(thscodes, { limit = 100 } = {}) {
  // 单次最多 100 个，需要分批
  const codes = Array.isArray(thscodes) ? thscodes : String(thscodes).split(",");
  if (codes.length <= limit) {
    return request("/api/a-share/prices/snapshot", { thscodes: codes.join(",") });
  }

  // 分批请求
  const results = [];
  for (let i = 0; i < codes.length; i += limit) {
    const batch = codes.slice(i, i + limit);
    const res = await request("/api/a-share/prices/snapshot", { thscodes: batch.join(",") });
    results.push(...(res.item || []));
    await new Promise(r => setTimeout(r, 300)); // 避免限流
  }
  return { ...results[0], item: results, total: results.length };
}

// 集合竞价快照
export async function getAuctionSnapshot(thscodes, { stage = "final" } = {}) {
  const codes = Array.isArray(thscodes) ? thscodes : String(thscodes).split(",");
  if (codes.length <= 100) {
    return request("/api/a-share/auction/snapshot", { thscodes: codes.join(","), stage });
  }

  // 分批请求
  const results = [];
  for (let i = 0; i < codes.length; i += 100) {
    const batch = codes.slice(i, i + 100);
    const res = await request("/api/a-share/auction/snapshot", { thscodes: batch.join(","), stage });
    results.push(...(res.item || []));
    await new Promise(r => setTimeout(r, 300));
  }
  return { ...results[0], item: results, total: results.length };
}

// 短线风向标竞价基准（历史可查）
export async function getShortTermBenchmark(dateStr) {
  return request("/api/a-share/auction/short-term-benchmark", { date: dateStr });
}

// 清除缓存
export function clearCache() {
  CACHE.clear();
}

// 获取缓存统计
export function getCacheStats() {
  return { size: CACHE.size, ttl: CACHE_TTL };
}
