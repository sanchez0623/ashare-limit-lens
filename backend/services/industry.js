import { StockMetadataRepository } from "../storage/stock-metadata.js";
import { EM_SCORING_TAXONOMY, industryName } from "../domain/stock-metadata.js";
import { digestOf } from "../domain/research-lineage.js";

export async function loadIndustryMapping(env, options = {}) {
  if (!env?.DB) return new Map();
  const snapshot = await new StockMetadataRepository(env).snapshot(
    "stock_em",
    options,
  );
  if (
    options.id &&
    (!snapshot || (await digestOf(snapshot.records)) !== snapshot.digest)
  )
    throw new Error("冻结的东财行业快照缺失或摘要不一致");
  return new Map(
    (snapshot?.records ?? []).map((r) => [
      r.code,
      {
        ...r,
        industryName: r.emIndustry,
        metadataSnapshotId: snapshot.id,
        metadataFetchedAt: snapshot.fetchedAt,
      },
    ]),
  );
}

export function enrichWithIndustry(
  rows,
  mapping = new Map(),
  { canonical = false } = {},
) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const native = industryName(row.hybk);
    const info = mapping.get(row.c ?? row.code);
    if (canonical && info?.industryName)
      return {
        ...row,
        hybk: info.industryName,
        _industrySource: "eastmoney-metadata",
        _industrySnapshotId: info.metadataSnapshotId,
        ...(native && native !== info.industryName
          ? { _industryNative: native }
          : {}),
      };
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

export async function enrichMarketIndustries(
  env,
  market,
  { industrySnapshotId } = {},
) {
  const mapping = await loadIndustryMapping(
    env,
    industrySnapshotId ? { id: industrySnapshotId } : {},
  );
  const reference = mapping.values().next().value;
  // A published code-keyed EM snapshot is the common vocabulary for live
  // aggregation and new plans. Never apply a later snapshot to a historical day.
  const referenceDay = reference?.metadataFetchedAt
    ? new Date(Date.parse(reference.metadataFetchedAt) + 8 * 3600000)
        .toISOString()
        .slice(0, 10)
    : null;
  const canonical = !!referenceDay && referenceDay <= market.date;
  const applicableMapping =
    referenceDay && referenceDay > market.date ? new Map() : mapping;
  return {
    ...market,
    rows: enrichWithIndustry(market.rows, applicableMapping, { canonical }),
    brokenRows: enrichWithIndustry(market.brokenRows, applicableMapping, {
      canonical,
    }),
    industryContext: {
      scoringTaxonomy: EM_SCORING_TAXONOMY,
      source: canonical
        ? "eastmoney-code-snapshot-primary-v2"
        : "eastmoney-pool-with-same-taxonomy-fallback",
      mappingPolicy: canonical
        ? "CODE_SNAPSHOT_PRIMARY_V2"
        : "PROVIDER_NATIVE_V1",
      metadataFetchedAt: reference?.metadataFetchedAt ?? null,
      ...(canonical
        ? {
            industryNames: [
              ...new Set(
                [...mapping.values()]
                  .map((r) => r.industryName)
                  .filter(Boolean),
              ),
            ].sort(),
          }
        : {}),
      stockEmSnapshotId:
        applicableMapping.values().next().value?.metadataSnapshotId ?? null,
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
