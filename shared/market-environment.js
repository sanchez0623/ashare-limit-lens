// Fixed engineering policy; no outcome inputs or automatic parameter fitting.
export const MARKET_ENVIRONMENT_POLICY = Object.freeze({
  version: "market-environment-v1",
  validation: "MANUAL_UNVERIFIED",
  quoteAgeMs: 15000,
  marketAgeMs: 90000,
  retainMs: 180000,
  minimumOrdinary: 5,
  minimumHigh: 3,
  minimumCoverage: 0.8,
  loss: -0.03,
  highLoss: -0.05,
  highBoards: 3,
  minimumCap: 0.25,
  confirmations: 3,
  confirmationMs: 60000,
  recoveryStep: 0.2,
  directionThreshold: 0.02,
  minimumCycles: 30,
  minimumEntryDates: 20,
  comparisonDays: 30,
  costMultipliers: Object.freeze([1, 1.5, 2]),
});
const P = MARKET_ENVIRONMENT_POLICY,
  finite = Number.isFinite;
const fresh = (stamp, at, age) =>
  finite(Date.parse(stamp)) &&
  Date.parse(stamp) <= at &&
  at - Date.parse(stamp) <= age;
const round = (n) => Math.round(n * 1e6) / 1e6;
export const isEnvironmentPolicy = (p) =>
  ["dragon-adaptive-risk-v3", "dragon-adaptive-risk-neutral-v1"].includes(
    p?.version,
  );
export function freezeEnvironmentCohort(snapshot) {
  return {
    signalDate: snapshot.date,
    knownAt: snapshot.createdAt,
    members: (snapshot.stocks ?? [])
      .map((s) => ({
        code: s.code,
        height: s.height ?? 0,
        closeCents:
          finite(s.close ?? s.price) && (s.close ?? s.price) > 0
            ? Math.round((s.close ?? s.price) * 100)
            : null,
      }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  };
}
export function assertEnvironmentCohort(cohort, plan) {
  if (
    !cohort ||
    cohort.signalDate !== plan.signalDate ||
    !Array.isArray(cohort.members) ||
    new Set(cohort.members.map((x) => x.code)).size !== cohort.members.length ||
    !fresh(cohort.knownAt, Date.parse(plan.createdAt), Infinity) ||
    cohort.members.some(
      (x) =>
        !/^\d{6}$/.test(x.code) ||
        !finite(x.height) ||
        x.height < 0 ||
        (x.closeCents !== null &&
          (!Number.isSafeInteger(x.closeCents) || x.closeCents <= 0)),
    )
  )
    throw new Error("市场环境盘前样本或可得时间无效");
}
function damage(members, quotes, date, at, minimum, loss) {
  const valid = members.flatMap((m) => {
    const q = quotes[m.code];
    if (
      !q ||
      !(m.closeCents > 0) ||
      q.date !== date ||
      !fresh(q.timestamp, at, P.quoteAgeMs) ||
      !(q.closeCents > 0) ||
      !(q.previousCloseCents > 0) ||
      Math.abs(q.previousCloseCents - m.closeCents) >
        Math.max(1, m.closeCents * 0.001)
    )
      return [];
    return [
      {
        code: m.code,
        timestamp: q.timestamp,
        closeCents: q.closeCents,
        change: q.closeCents / m.closeCents - 1,
      },
    ];
  });
  const coverage = members.length ? valid.length / members.length : 0;
  return {
    total: members.length,
    valid: valid.length,
    coverage,
    applicable: members.length >= minimum,
    value:
      members.length >= minimum && coverage >= P.minimumCoverage
        ? valid.filter((q) => q.change <= loss).length / valid.length
        : null,
    evidence: valid.map(({ code, timestamp, closeCents }) => ({
      code,
      timestamp,
      closeCents,
    })),
  };
}
export function advanceEnvironment(
  previous,
  { date, observedAt, market, quotes = {}, cohort, baseline },
) {
  const at = Date.parse(observedAt),
    prior = previous ?? { cap: 1, pending: null };
  if (!finite(at) || Date.parse(prior.asOf) >= at) return prior;
  const cohortKnown =
    cohort?.signalDate < date && fresh(cohort?.knownAt, at, Infinity);
  const ordinary = damage(
    cohortKnown ? cohort.members : [],
    quotes,
    date,
    at,
    P.minimumOrdinary,
    P.loss,
  );
  const high = damage(
    cohortKnown ? cohort.members.filter((m) => m.height >= P.highBoards) : [],
    quotes,
    date,
    at,
    P.minimumHigh,
    P.highLoss,
  );
  const m = market?.metrics;
  const marketKnown =
    market?.date === date &&
    fresh(market.observedAt, at, P.marketAgeMs) &&
    [m?.limitUp, m?.broken, m?.height].every((x) => finite(x) && x >= 0);
  const breaks = marketKnown
    ? m.limitUp + m.broken
      ? m.broken / (m.limitUp + m.broken)
      : 0
    : null;
  const complete =
    cohortKnown &&
    marketKnown &&
    ordinary.value !== null &&
    (!high.applicable || high.value !== null);
  const ratios = [breaks, ordinary.value, high.value].filter(finite);
  const value = ratios.length ? Math.max(...ratios) : null;
  const raw = value === null ? null : Math.max(P.minimumCap, 1 - value);
  const signature = JSON.stringify([
    marketKnown ? market.observedAt : null,
    ordinary.evidence,
    high.evidence,
  ]);
  let cap = prior.cap ?? 1,
    pending = prior.pending ?? null,
    validAt = prior.validAt ?? null;
  if (value !== null && signature !== prior.signature) {
    if (!validAt || at - Date.parse(validAt) > P.retainMs) {
      cap = 1;
      pending = null;
    }
    if (raw <= cap) {
      cap = raw;
      validAt = observedAt;
      pending = null;
    } else if (complete) {
      validAt = observedAt;
      pending ??= { since: observedAt, count: 0 };
      pending = { ...pending, count: pending.count + 1 };
      if (
        pending.count >= P.confirmations &&
        at - Date.parse(pending.since) >= P.confirmationMs
      )
        cap = Math.min(raw, cap + P.recoveryStep);
    } else pending = null;
  }
  const retained =
      !complete &&
      validAt &&
      at - Date.parse(validAt) <= P.retainMs &&
      (raw === null || cap < raw),
    partial = !complete && raw !== null && raw < 1,
    usable = complete || retained || partial;
  const delta = marketKnown
      ? (baseline?.trend?.fiveMinutes ?? baseline?.trend?.oneMinute ?? null)
      : null,
    strength =
      marketKnown && finite(baseline?.strength) ? baseline.strength : null;
  return {
    version: P.version,
    validation: P.validation,
    date,
    asOf: observedAt,
    strength,
    strengthBand:
      strength === null
        ? "UNKNOWN"
        : strength < 0.5
          ? "WEAK"
          : strength < 0.7
            ? "NORMAL"
            : "STRONG",
    direction: {
      value: delta,
      window: baseline?.trend?.fiveMinutes != null ? "5m" : "1m",
      band:
        delta === null
          ? "UNKNOWN"
          : delta > P.directionThreshold + 1e-9
            ? "IMPROVING"
            : delta < -P.directionThreshold - 1e-9
              ? "DETERIORATING"
              : "FLAT",
    },
    fragility: {
      value,
      complete,
      band: !complete
        ? "UNKNOWN"
        : value < 1 / 3
          ? "LOW"
          : value < 2 / 3
            ? "MID"
            : "HIGH",
      breaks,
      ordinary,
      high,
    },
    status: complete
      ? "CURRENT"
      : retained
        ? "RETAINED"
        : partial
          ? "PARTIAL_CURRENT"
          : "DEGRADED_BASELINE",
    cap: usable ? round(cap) : 1,
    validAt,
    pending,
    signature: value !== null ? signature : prior.signature,
    sources: {
      marketAt: marketKnown ? market.observedAt : null,
      cohortDate: cohort?.signalDate ?? null,
      cohortKnownAt: cohort?.knownAt ?? null,
    },
    budget: {
      baselineFactor: baseline?.applied ?? 0,
      newRiskFactor: Math.min(baseline?.applied ?? 0, usable ? cap : 1),
      protectionUnchanged: true,
    },
  };
}
