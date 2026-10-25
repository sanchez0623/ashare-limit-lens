import { sectorAnalysis } from "./scoring.js";

// Display-only projection: never feed a research grouping back into analyze(),
// trade plans or evidence metrics. Original stock objects are left untouched.
export function researchIndustryName(stock, taxonomy, metadata) {
  if (taxonomy === "EM") return stock.sector ?? null;
  const field = { SW1: "swL1", SW2: "swL2", SW3: "swL3" }[taxonomy];
  return field ? (metadata?.byCode?.[stock.code]?.[field] ?? null) : null;
}
export function researchIndustryGroups(
  analysis,
  taxonomy = "EM",
  metadata = null,
) {
  const stocks = analysis?.stocks ?? [];
  if (taxonomy === "EM")
    return {
      groups: analysis?.sectors ?? [],
      covered: stocks.length,
      uncovered: 0,
    };
  const rows = stocks.flatMap((stock) => {
    const sector = researchIndustryName(stock, taxonomy, metadata);
    return sector
      ? [
          {
            ...stock,
            sector,
            breaks: stock.breaks ?? null,
            first: stock.first ?? null,
          },
        ]
      : [];
  });
  return {
    groups: sectorAnalysis(rows),
    covered: rows.length,
    uncovered: stocks.length - rows.length,
  };
}
