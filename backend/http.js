export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !isNaN(date) && date.toISOString().slice(0, 10) === value;
}
export async function readJson(request, maxBytes = 12000) {
  const reader = request.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("请求内容过长");
      }
      chunks.push(value);
    }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("请求必须为有效 JSON");
  }
}
export function safeError(error) {
  const message = error instanceof Error ? error.message : "服务暂时不可用";
  if (
    /SQLITE|D1_|database|constraint|SELECT |INSERT |UPDATE |token|Bearer|API_KEY/i.test(
      message,
    )
  )
    return "存储或服务暂时不可用，请稍后重试";
  return message.slice(0, 250);
}
