function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}
export async function digestOf(value) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function eventDigest({
  sequence,
  eventType,
  createdAt,
  payload,
  previousDigest,
}) {
  return digestOf({ sequence, eventType, createdAt, payload, previousDigest });
}
export function sampleKey({ namespace, experimentId, role, outcomeDate }) {
  return `${namespace}:${experimentId}:${role}:${outcomeDate}`;
}
