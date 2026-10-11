// 服务商适配接口（§6）：有限、可替换；HTTP 200 不等于业务成功，
// 按供应商业务响应判定；短超时；凭据不随重定向转发、不写日志。
const TIMEOUT_MS = 8000;

export function notificationChannels(env) {
  const channels = [];
  const feishuConfigured =
    typeof env?.FEISHU_WEBHOOK_URL === "string" &&
    env.FEISHU_WEBHOOK_URL.startsWith("https://");
  channels.push({
    ref: "feishu",
    name: "飞书机器人",
    configured: feishuConfigured,
  });
  return channels;
}

export function alertsEnabled(env) {
  return (
    env?.ALERTS_ENABLED !== "false" &&
    notificationChannels(env).some((c) => c.configured)
  );
}

// 超时覆盖到响应体读取完成：只给 fetch 设超时的话，响应头已到而 body 一直
// 不结束时读取会无限挂住分发器。
async function fetchJson(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

// 飞书自定义机器人：text 消息；可选加签密钥。签名 = Base64(HMAC-SHA256(
// key = "{timestamp}\n{secret}", msg = ""))，timestamp 与 sign 必须以查询
// 参数追加——webhook 自身没有查询串，直接拼 "&timestamp=" 会得到错误 URL，
// 配置签名密钥后必然发送失败。
async function sendFeishu({ config, text, eventId }) {
  let url = config.webhookUrl;
  if (config.secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(`${timestamp}\n${config.secret}`),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(""),
    );
    const sign = btoa(String.fromCharCode(...new Uint8Array(signature)));
    const signed = new URL(url);
    signed.searchParams.set("timestamp", String(timestamp));
    signed.searchParams.set("sign", sign);
    url = signed.toString();
  }
  let response, body;
  try {
    ({ response, body } = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        msg_type: "text",
        content: { text: eventId ? `${text}\n事件: ${eventId}` : text },
      }),
    }));
  } catch {
    // 网络异常与超时同样要消耗重试预算，不能抛出去绕过 maxAttempts。
    return { ok: false, retryable: true, reason: "NETWORK_ERROR" };
  }
  if (response.status === 429)
    return { ok: false, retryable: true, reason: "RATE_LIMITED" };
  if (!response.ok)
    return { ok: false, retryable: true, reason: `HTTP_${response.status}` };
  if (body === null)
    return { ok: false, retryable: true, reason: "INVALID_RESPONSE" };
  const code = body?.code ?? body?.StatusCode;
  if (code === 0) return { ok: true, providerRef: String(body.msgId ?? "") };
  // 配置错误（如密钥错误）不重复撞接口。
  const configError = code === 19021 || code === 9499 || code === 19020;
  return {
    ok: false,
    retryable: !configError,
    reason: configError ? "CONFIG_ERROR" : `PROVIDER_${code ?? "UNKNOWN"}`,
  };
}

export async function sendNotification({
  channelRef,
  env,
  safeMessage,
  eventId,
}) {
  if (channelRef === "feishu") {
    if (!env?.FEISHU_WEBHOOK_URL?.startsWith("https://"))
      return { ok: false, retryable: false, reason: "CHANNEL_NOT_CONFIGURED" };
    return sendFeishu({
      config: { webhookUrl: env.FEISHU_WEBHOOK_URL, secret: env.FEISHU_SECRET },
      text: safeMessage.text,
      eventId,
    });
  }
  return { ok: false, retryable: false, reason: "UNKNOWN_CHANNEL" };
}
