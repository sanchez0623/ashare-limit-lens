import { completedPracticeCycles } from "./practice-review.js";
import { MARKET_ENVIRONMENT_POLICY as P } from "../../shared/market-environment.js";
import { resampleIndexMatrix } from "./research-statistics.js";
const mean = (a) => (a.length ? a.reduce((n, x) => n + x, 0) / a.length : null);
export async function environmentCalibration({
  events,
  fills,
  asOf,
  scope = "primary",
  paths = [],
  tradingDates = [],
  completeDates = [],
}) {
  const cutoff = new Date(`${asOf}T23:59:59+08:00`).toISOString();
  const rows = events.filter((e) => e.scope === scope && e.asOf <= cutoff);
  const ledger = fills.filter((f) => f.date <= asOf);
  const cycles = new Map(
    completedPracticeCycles(ledger)
      .filter((c) => c.closedDate <= asOf)
      .map((c) => [c.id, c]),
  );
  const groups = new Map(),
    open = [];
  const keyFor = (e, dimension, env) =>
    JSON.stringify([
      e.buyPoint,
      dimension,
      dimension === "strength"
        ? env?.strengthBand
        : dimension === "direction"
          ? env?.direction?.band
          : env?.fragility?.band,
      e.source.engineBuild,
      e.source.configDigest,
      e.source.feeDigest,
      e.source.prospective,
    ]);
  const get = (e, d, env) => {
    const key = keyFor(e, d, env);
    if (!groups.has(key))
      groups.set(key, {
        buyPoint: e.buyPoint,
        dimension: d,
        band: JSON.parse(key)[2] ?? "UNKNOWN",
        engineBuild: e.source.engineBuild,
        configDigest: e.source.configDigest,
        feeDigest: e.source.feeDigest,
        mode: e.source.prospective
          ? "FORWARD_OBSERVATION"
          : "REPLAY_DIAGNOSTIC",
        opportunities: 0,
        filledOpportunities: 0,
        blockingReasons: {},
        samples: [],
      });
    return groups.get(key);
  };
  const entries = rows.filter((e) => e.kind === "ENTRY");
  for (const e of rows.filter((e) => e.kind === "TRIGGER"))
    for (const d of ["strength", "direction", "fragility"]) {
      const g = get(e, d, e.environment);
      g.opportunities++;
      if (
        entries.some(
          (x) =>
            x.code === e.code &&
            x.buyPoint === e.buyPoint &&
            x.tradeDate === e.tradeDate,
        )
      )
        g.filledOpportunities++;
      const reasons = new Set(
        rows
          .filter(
            (x) =>
              x.kind === "DECISION" &&
              x.code === e.code &&
              x.tradeDate === e.tradeDate &&
              x.asOf >= e.asOf &&
              x.intent === "OPEN",
          )
          .map((x) => x.reason),
      );
      if (e.enabled === false) reasons.add("BUY_POINT_DISABLED");
      for (const reason of reasons)
        g.blockingReasons[reason] = (g.blockingReasons[reason] ?? 0) + 1;
    }
  for (const e of entries) {
    const c = cycles.get(e.cycleId);
    if (!c) {
      open.push({
        cycleId: e.cycleId,
        code: e.code,
        buyPoint: e.buyPoint,
        environment: e.environment,
      });
      continue;
    }
    const initial = ledger.filter(
        (f) => f.cycleId === c.id && (f.intent ?? f.action) === "OPEN",
      ),
      first = initial[0];
    const risk =
      e.initialRiskPerShareCents * initial.reduce((n, f) => n + f.quantity, 0);
    const from = Date.parse(first?.entryEvidence?.observedAt),
      last = ledger.filter((f) => f.cycleId === c.id).at(-1);
    const to = Date.parse(last?.entryEvidence?.observedAt);
    const observed = paths.filter(
      (p) =>
        p.code === e.code && Date.parse(p.at) >= from && Date.parse(p.at) <= to,
    );
    const expectedDays = tradingDates.filter(
      (d) => d >= c.openedDate && d <= c.closedDate,
    );
    const pathComplete =
      expectedDays.length > 0 &&
      expectedDays.every((d) => completeDates.includes(d)) &&
      observed.length > 1 &&
      observed.every(
        (p, i) =>
          !i ||
          p.date !== observed[i - 1].date ||
          p.segment !== observed[i - 1].segment ||
          Date.parse(p.at) - Date.parse(observed[i - 1].at) <= 20000,
      );
    const excursions = pathComplete
      ? observed.map(
          (p) => (p.priceCents - first.priceCents) / e.initialRiskPerShareCents,
        )
      : [];
    const sample = {
      ...c,
      netR: risk > 0 ? c.netPnlCents / risk : null,
      maeR: excursions.length ? Math.min(0, ...excursions) : null,
      mfeR: excursions.length ? Math.max(0, ...excursions) : null,
    };
    for (const d of ["strength", "direction", "fragility"])
      get(e, d, e.environment).samples.push(sample);
  }
  for (const g of groups.values()) {
    const samples = g.samples,
      dates = [...new Set(samples.map((s) => s.openedDate))].sort();
    Object.assign(g, {
      fillRate: g.opportunities
        ? g.filledOpportunities / g.opportunities
        : null,
      cycles: samples.length,
      entryDates: dates.length,
      netPnlCents: samples.reduce((n, s) => n + s.netPnlCents, 0),
      meanNetR: mean(samples.map((s) => s.netR).filter(Number.isFinite)),
      winRate: samples.length
        ? samples.filter((s) => s.netPnlCents > 0).length / samples.length
        : null,
      meanMaeR: mean(samples.map((s) => s.maeR).filter(Number.isFinite)),
      meanMfeR: mean(samples.map((s) => s.mfeR).filter(Number.isFinite)),
      interval: null,
    });
    g.status =
      g.mode === "FORWARD_OBSERVATION" &&
      samples.length >= P.minimumCycles &&
      dates.length >= P.minimumEntryDates
        ? "DESCRIPTIVE"
        : "INSUFFICIENT";
    if (
      g.status === "DESCRIPTIVE" &&
      samples.every((s) => Number.isFinite(s.netR))
    ) {
      const { matrix } = await resampleIndexMatrix({
        dates,
        blockLength: 5,
        resamples: 10000,
        seedInput: {
          version: P.version,
          asOf,
          buyPoint: g.buyPoint,
          dimension: g.dimension,
          band: g.band,
          scope,
        },
      });
      const daily = dates.map((d) =>
        samples.filter((s) => s.openedDate === d).map((s) => s.netR),
      );
      const estimates = matrix
        .map((indices) => mean(indices.flatMap((i) => daily[i])))
        .sort((a, b) => a - b);
      if (estimates[0] !== estimates.at(-1))
        g.interval = {
          level: 0.95,
          lower: estimates[Math.floor(estimates.length * 0.025)],
          upper: estimates[Math.floor(estimates.length * 0.975)],
          scope: "POINTWISE_DESCRIPTIVE",
        };
    }
    delete g.samples;
  }
  return {
    version: P.version,
    purpose: "DIAGNOSTIC",
    eligibleForPromotion: false,
    asOf,
    scope,
    groups: [...groups.values()],
    openCycles: open,
    note: "结构机会按首次触发环境统计，完整周期收益按首次实际建仓环境统计。分组为描述性相关，区间不是盈利概率，不自动启停买点。",
  };
}
