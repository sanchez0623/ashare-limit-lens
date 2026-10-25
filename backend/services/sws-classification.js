// Node worker only; parsing an official BIFF workbook does not require Python.
import XLSX from "xlsx";
import { createHash } from "node:crypto";
import { DataUpdateError } from "../domain/stock-metadata.js";
export const SWS_CLASSIFICATION_URL =
  "https://www.swsresearch.com/swindex/pdf/SwClass2021/StockClassifyUse_stock.xls";
const fail = () => {
  throw new DataUpdateError(
    "申万官方分类变更文件格式异常或存在同日冲突，保留旧版",
  );
};
function timestamp(value) {
  if (typeof value === "number") {
    const parts = XLSX.SSF.parse_date_code(value);
    if (!parts) return fail();
    const pad = (n) => String(n).padStart(2, "0");
    return `${parts.y}-${pad(parts.m)}-${pad(parts.d)} ${pad(parts.H)}:${pad(parts.M)}:${pad(Math.floor(parts.S))}`;
  }
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(value.trim())
  )
    return fail();
  const result = value.trim().replace("T", " ");
  return result.length === 10
    ? `${result} 00:00:00`
    : result.length === 16
      ? `${result}:00`
      : result;
}
export function parseSwsClassifications(bytes, { date, codes } = {}) {
  const buffer = Buffer.from(bytes);
  if (
    buffer.length < 8 ||
    buffer.subarray(0, 8).toString("hex") !== "d0cf11e0a1b11ae1"
  )
    return fail();
  let rows;
  try {
    const book = XLSX.read(buffer, { type: "buffer", cellDates: false });
    rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], {
      header: 1,
      raw: true,
      defval: "",
    });
  } catch {
    return fail();
  }
  const headers = rows.shift(),
    columns = ["股票代码", "计入日期", "行业代码", "更新日期"].map((h) =>
      headers?.indexOf(h),
    );
  if (
    !rows.length ||
    columns.some((i) => i === undefined || i < 0) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date || "")
  )
    return fail();
  const result = new Map(),
    ambiguous = new Set(),
    wanted = codes ? new Set(codes) : null,
    digest = createHash("sha256").update(buffer).digest("hex");
  for (const row of rows) {
    const code = String(row[columns[0]]).padStart(6, "0");
    if (wanted && !wanted.has(code)) continue;
    const swCode = String(row[columns[2]]).padStart(6, "0"),
      effectiveAt = timestamp(row[columns[1]]),
      updatedAt = timestamp(row[columns[3]]);
    if (!/^\d{6}$/.test(code) || !/^\d{6}$/.test(swCode)) return fail();
    if (effectiveAt > `${date} 23:59:59`) continue;
    const previous = result.get(code);
    // Updated-at is an editing timestamp, not the industry's effective date.
    // A late edit to an old row must not restore an obsolete classification.
    if (previous && previous.effectiveAt > effectiveAt) continue;
    if (previous?.effectiveAt === effectiveAt && previous.swCode !== swCode)
      ambiguous.add(code);
    if (!previous || previous.effectiveAt < effectiveAt) ambiguous.delete(code);
    result.set(code, {
      swCode,
      effectiveAt,
      updatedAt,
      source: "sws-official-classification-history",
      sourceUrl: SWS_CLASSIFICATION_URL,
      documentSha256: digest,
    });
  }
  if (ambiguous.size) return fail();
  return result;
}
