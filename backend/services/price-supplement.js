import { getPricesSnapshot } from "./fuyao.js";

const positive = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const samePrice = (yuan, cents) =>
  positive(yuan) &&
  Number.isFinite(cents) &&
  Math.abs(Math.round(yuan * 100) - cents) <= 1;
const dayOf = (stamp) =>
  Number.isFinite(Number(stamp)) && Number(stamp) > 0
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(Number(stamp)))
    : null;

// 快照只有批次就绪时间；用带逐股日期的腾讯报价验证，补全值不冒充成交时间。
export async function supplementPriceRows(
  date,
  rows,
  { prices = getPricesSnapshot, quotes, now = new Date() } = {},
) {
  const result = {
    rows,
    evidence: { source: "fuyao-prices-snapshot-v1", date, supplemented: 0 },
  };
  if (date !== dayOf(now.getTime()) || !quotes || !rows.length) return result;
  if (prices === getPricesSnapshot && !process.env.FU_YAO_API_KEY)
    return result;
  const codes = [
    ...new Set(rows.map((r) => r.c).filter((c) => /^\d{6}$/.test(c))),
  ];
  try {
    const [batch, checked] = await Promise.all([
      prices(
        codes.map((c) => `${c}.${c.startsWith("6") ? "SH" : "SZ"}`),
        { timeoutMs: 4000, retries: 0 },
      ),
      quotes(codes, date),
    ]);
    const batches = batch.batches ?? [batch];
    if (
      !batches.every(
        (b) =>
          dayOf(b.timestamp) === date && b.timestamp <= now.getTime() + 10000,
      )
    )
      return {
        ...result,
        evidence: {
          ...result.evidence,
          unavailable: true,
          reason: "快照日期未核对",
        },
      };
    const byCode = new Map(
      (batch.item ?? []).map((r) => [r.ticker ?? r.thscode?.split(".")[0], r]),
    );
    const observedAt = new Date().toISOString();
    result.rows = rows.map((row) => {
      const p = byCode.get(row.c),
        q = checked[row.c];
      if (
        !p ||
        q?.date !== date ||
        !q.timestamp?.startsWith(date) ||
        ![
          "last_price",
          "open_price",
          "high_price",
          "low_price",
          "prev_price",
        ].every((k) => positive(p[k])) ||
        p.high_price < Math.max(p.open_price, p.last_price) ||
        p.low_price > Math.min(p.open_price, p.last_price) ||
        !samePrice(p.last_price, q.closeCents) ||
        !samePrice(p.open_price, q.openCents) ||
        !samePrice(p.high_price, q.highCents) ||
        !samePrice(p.low_price, q.lowCents) ||
        !samePrice(p.prev_price, q.previousCloseCents) ||
        !samePrice(p.last_price, Number(row.p) / 10)
      )
        return row;
      const fields = {};
      if (!positive(row.o)) fields.o = Math.round(p.open_price * 1000);
      if (!positive(row.h)) fields.h = Math.round(p.high_price * 1000);
      if (!Object.keys(fields).length) return row;
      result.evidence.supplemented++;
      return {
        ...row,
        ...fields,
        _priceEvidence: {
          source: "fuyao-prices-snapshot-v1",
          date,
          observedAt,
          batchReadyAt: batch.timestamp,
          verifiedQuoteTimestamp: q.timestamp,
          fields: Object.keys(fields),
        },
      };
    });
  } catch {
    result.evidence.unavailable = true;
    result.evidence.reason = "价格补全源暂不可用，保留原始行情";
  }
  return result;
}
