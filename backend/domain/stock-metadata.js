export const METADATA_KINDS = Object.freeze([
  "stock_list",
  "stock_em",
  "industry_sw",
]);
export const DATA_SCOPES = Object.freeze([...METADATA_KINDS, "all"]);
export const EM_SCORING_TAXONOMY = "EASTMONEY_NATIVE_V1";
export const ACTIVE_DATA_STATUSES = Object.freeze(["QUEUED", "RUNNING"]);
export const coreStockCode = (code) =>
  typeof code === "string" && /^(00|30|60)\d{4}$/.test(code);
export const industryName = (value) =>
  typeof value === "string" &&
  !["", "-", "--", "未知", "未分类"].includes(value.trim())
    ? value.trim()
    : null;

export class DataUpdateError extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export class DataUpdateCancelled extends Error {
  constructor() {
    super("更新已取消；未完成的数据未发布");
  }
}

// A full provider snapshot may lack classifications for some new listings. Keep
// those null and measure coverage; never translate another taxonomy into EM.
export function validateMetadataRecords(kind, records) {
  if (
    !METADATA_KINDS.includes(kind) ||
    !Array.isArray(records) ||
    !records.length
  )
    throw new DataUpdateError("数据为空，保留上一份有效快照");
  const byCode = new Map();
  for (const raw of records) {
    if (!coreStockCode(raw.code))
      throw new DataUpdateError("股票代码或范围无效");
    const record = {
      ...raw,
      code: raw.code,
      market: raw.code.startsWith("6") ? "SH" : "SZ",
    };
    if (kind === "stock_em" || kind === "stock_list") {
      if (typeof raw.name !== "string" || !raw.name.trim())
        throw new DataUpdateError("股票名称缺失");
      record.name = raw.name.trim();
      record.isSt = /ST/i.test(record.name);
      if (kind === "stock_em") record.emIndustry = industryName(raw.emIndustry);
      else {
        // A registry is an identity dataset. Never let a source's unrelated
        // industry fields become a scoring fallback through a merged record.
        delete record.emIndustry;
        delete record.industry;
        delete record.hybk;
        for (const field of Object.keys(record))
          if (field.startsWith("sw")) delete record[field];
      }
    } else {
      for (const field of ["swL1", "swL2", "swL3", "swCode"]) {
        if (typeof raw[field] !== "string" || !raw[field].trim())
          throw new DataUpdateError("申万层级或行业代码缺失");
        record[field] = raw[field].trim();
      }
    }
    const previous = byCode.get(record.code);
    if (previous) {
      const fields =
        kind === "stock_list"
          ? ["name"]
          : kind === "stock_em"
            ? ["name", "emIndustry"]
            : ["swL1", "swL2", "swL3", "swCode"];
      if (fields.some((field) => previous[field] !== record[field]))
        throw new DataUpdateError(
          `股票 ${record.code} 存在冲突的行业或名称，保留旧版`,
        );
    } else byCode.set(record.code, record);
  }
  const result = [...byCode.values()].sort((a, b) =>
    a.code.localeCompare(b.code),
  );
  if (kind === "stock_em" && result.every((r) => !r.emIndustry))
    throw new DataUpdateError("东财行业字段全部为空，保留旧版");
  return result;
}
