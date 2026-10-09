// Retry a transient public-provider failure once; never replace missing data with fixtures.
export async function publicFetch(url, timeout = 12000) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" },
        signal: AbortSignal.timeout(timeout),
      });
      if (response.ok) return response;
      lastError = new Error(`公开行情 HTTP ${response.status}`);
      if (response.status === 404) break;
    } catch {
      lastError = new Error("公开行情请求超时或连接失败");
    }
  }
  throw lastError;
}
