import { StockMetadataRepository } from "../storage/stock-metadata.js";
import { EM_SCORING_TAXONOMY, industryName } from "../domain/stock-metadata.js";

export async function loadIndustryMapping(env) {
  if (!env?.DB) return new Map();
  const snapshot = await new StockMetadataRepository(env).snapshot("stock_em");
  return new Map(
    (snapshot?.records ?? []).map((r) => [
      r.code,
      {
        ...r,
        industryName: r.emIndustry,
        metadataSnapshotId: snapshot.id,
      },
    ]),
  );
}

export function enrichWithIndustry(rows, mapping = new Map()) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const native = industryName(row.hybk);
    const info = mapping.get(row.c ?? row.code);
    if (native) return { ...row };
    return {
      ...row,
      hybk: info?.industryName ?? null,
      _industrySource: info?.industryName
        ? "eastmoney-metadata"
        : "unavailable",
      ...(info?.industryName
        ? { _industrySnapshotId: info.metadataSnapshotId }
        : {}),
    };
  });
}

export async function enrichMarketIndustries(env, market) {
  const mapping = await loadIndustryMapping(env);
  return {
    ...market,
    rows: enrichWithIndustry(market.rows, mapping),
    brokenRows: enrichWithIndustry(market.brokenRows, mapping),
    industryContext: {
      scoringTaxonomy: EM_SCORING_TAXONOMY,
      source: "eastmoney-pool-with-same-taxonomy-fallback",
      stockEmSnapshotId:
        mapping.values().next().value?.metadataSnapshotId ?? null,
    },
  };
}

export async function researchIndustryMetadata(env, codes) {
  if (!env?.DB)
    return {
      snapshotId: null,
      fetchedAt: null,
      taxonomy: "SW2021",
      byCode: {},
    };
  const snapshot = await new StockMetadataRepository(env).snapshot(
    "industry_sw",
  );
  const byCode = {};
  for (const code of new Set(codes)) {
    const r = snapshot?.byCode.get(code);
    if (r)
      byCode[code] = {
        swL1: r.swL1,
        swL2: r.swL2,
        swL3: r.swL3,
        swCode: r.swCode,
      };
  }
  return {
    snapshotId: snapshot?.id ?? null,
    fetchedAt: snapshot?.fetchedAt ?? null,
    taxonomy: "SW2021",
    basis: "CURRENT_CLASSIFICATION_EXPLORATION_ONLY",
    byCode,
  };
}
