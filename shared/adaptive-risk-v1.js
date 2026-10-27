// Frozen v1 behavior for existing plans and observations; new plans use v2.
import { classifySentimentCycle } from "./sentiment-cycle.js";

// Engineering defaults, not an estimate of future returns. Changing any value
// requires a new policy version; the complete policy is frozen in every plan.
export const ADAPTIVE_RISK_POLICY = Object.freeze({
  version: "dragon-adaptive-risk-v1",
  marketIntervalMs: 30000,
  marketMaxAgeMs: 90000,
  quoteMaxAgeMs: 15000,
  quoteGapMs: 20000,
  confirmationCount: 3,
  confirmationMs: 60000,
  recoveryStep: 0.2,
  shortWindowMs: 60000,
  longWindowMs: 300000,
  strengthFloor: 0.3,
  strengthFull: 1,
  trendShortWeight: 0.4,
  trendLongWeight: 0.6,
  overheatPenalty: 0.3,
  sectorFloor: 35,
  sectorFull: 85,
  sectorBreakPenalty: 0.3,
  stockVolatilityWeight: 0.35,
  stockDrawdownWeight: 0.4,
  stockFallWeight: 0.25,
  stockVolumePenalty: 0.15,
  openMinimum: 0.15,
  profitAddMinimum: 0.5,
  lossAddMinimum: 0.75,
  tMinimum: 0.35,
});

const P = ADAPTIVE_RISK_POLICY;
const clamp = (n, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const round = (n) => Math.round(n * 1e6) / 1e6;
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const ageOk = (stamp, now, age) =>
  Number.isFinite(Date.parse(stamp)) &&
  now >= Date.parse(stamp) &&
  now - Date.parse(stamp) <= age;
function segment(stamp, date) {
  const ms = Date.parse(stamp);
  if (!Number.isFinite(ms)) return null;
  const local = new Date(ms + 8 * 3600000).toISOString();
  if (local.slice(0, 10) !== date) return null;
  const time = local.slice(11, 19);
  return time >= "09:30:00" && time <= "11:30:00"
    ? "AM"
    : time >= "13:00:00" && time < "14:57:00"
      ? "PM"
      : null;
}
const emptyLayer = () => ({
  applied: 0,
  protectionApplied: null,
  raw: null,
  ready: false,
  valid: false,
  observedAt: null,
  warming: null,
  pending: null,
  samples: [],
  coverage: 0,
  reasons: ["等待连续有效观测"],
});
function ensureLayer(layers, name) {
  if (!Object.hasOwn(layers, name))
    Object.defineProperty(layers, name, {
      value: emptyLayer(),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return layers[name];
}
export function initialAdaptiveRisk(date) {
  return {
    version: P.version,
    date,
    observedAt: null,
    segment: null,
    market: emptyLayer(),
    sectors: {},
    stocks: {},
  };
}
export function hasAdaptiveMarketEvidence(market) {
  return (
    !!market &&
    [
      market.metrics?.limitUp,
      market.metrics?.broken,
      market.metrics?.height,
    ].every((v) => finite(v) && v >= 0) &&
    market.sectorsComplete === true &&
    Array.isArray(market.sectors) &&
    market.sectors.every(
      (s) =>
        typeof s.name === "string" &&
        [s.score, s.count, s.broken].every((v) => finite(v) && v >= 0),
    )
  );
}
function resetLayer(layer) {
  layer.ready = false;
  layer.valid = false;
  layer.warming = layer.pending = null;
  layer.samples = [];
  layer.protectionApplied = null;
}
function missing(layer, reason) {
  layer.valid = false;
  layer.ready = false;
  layer.warming = layer.pending = null;
  layer.reasons = [reason];
  layer.protectionApplied = null;
  layer.samples = [];
  layer.trend = null;
}
function baseline(samples, at, windowMs, tolerance) {
  const target = at - windowMs;
  return (
    samples.findLast(
      (s) =>
        Date.parse(s.at) <= target && target - Date.parse(s.at) <= tolerance,
    ) ?? null
  );
}
function trends(layer, sample, value, tolerance) {
  const now = Date.parse(sample.at);
  const one = baseline(layer.samples, now, P.shortWindowMs, tolerance);
  const five = baseline(layer.samples, now, P.longWindowMs, tolerance);
  return {
    oneMinute: one ? round(value(sample) - value(one)) : null,
    fiveMinutes: five ? round(value(sample) - value(five)) : null,
  };
}
function trendPenalty(trend) {
  return clamp(
    Math.max(0, -(trend.oneMinute ?? 0)) * P.trendShortWeight +
      Math.max(0, -(trend.fiveMinutes ?? 0)) * P.trendLongWeight,
    0,
    0.4,
  );
}
function updateLayer(
  layer,
  sample,
  raw,
  coverage,
  reasons,
  maxGap,
  protectionKnown,
) {
  const at = Date.parse(sample.at),
    previous = Date.parse(layer.observedAt);
  if (at <= previous) return;
  if (Number.isFinite(previous) && at - previous > maxGap) resetLayer(layer);
  layer.observedAt = sample.at;
  layer.valid = true;
  layer.raw = round(clamp(raw));
  layer.coverage = round(coverage);
  layer.protectionKnown = protectionKnown;
  layer.reasons = reasons;
  layer.samples.push(sample);
  layer.samples = layer.samples.filter(
    (s) => at - Date.parse(s.at) <= P.longWindowMs + maxGap,
  );
  layer.warming ??= { since: sample.at, count: 0 };
  layer.warming.count++;
  if (
    layer.warming.count >= P.confirmationCount &&
    at - Date.parse(layer.warming.since) >= P.confirmationMs
  )
    layer.ready = true;
  // An observed deterioration always clamps the stored ceiling immediately.
  if (layer.raw <= layer.applied) {
    layer.applied = layer.raw;
    layer.pending = null;
  } else {
    layer.pending ??= { since: sample.at, count: 0 };
    layer.pending.count++;
    if (
      layer.ready &&
      layer.pending.count >= P.confirmationCount &&
      at - Date.parse(layer.pending.since) >= P.confirmationMs
    )
      layer.applied = round(
        Math.min(layer.raw, layer.applied + P.recoveryStep),
      );
  }
  // Warm-up limits new risk; it must not manufacture a reason to liquidate an
  // inherited holding. Existing exposure uses independently observed ceilings.
  if (layer.ready && protectionKnown) {
    if (layer.protectionApplied == null || layer.raw <= layer.protectionApplied)
      layer.protectionApplied = layer.raw;
    else if (
      layer.pending &&
      layer.pending.count >= P.confirmationCount &&
      at - Date.parse(layer.pending.since) >= P.confirmationMs
    )
      layer.protectionApplied = round(
        Math.min(layer.raw, layer.protectionApplied + P.recoveryStep),
      );
  }
}

function updateMarket(state, market, now) {
  const layer = state.market;
  const stamp = market?.observedAt;
  const m = market?.metrics;
  if (
    market?.date !== state.date ||
    !ageOk(stamp, now, P.marketMaxAgeMs) ||
    segment(stamp, state.date) !== state.segment ||
    ![m?.limitUp, m?.broken, m?.height].every((v) => finite(v) && v >= 0)
  ) {
    missing(layer, "市场数据缺失、过期或关键指标不完整，暂停新增");
    for (const s of Object.values(state.sectors))
      missing(s, "板块同步市场数据不可用");
    return;
  }
  // Cached snapshots retain their original timestamp and never add evidence.
  if (Date.parse(stamp) <= Date.parse(layer.observedAt)) return;
  const cycle = classifySentimentCycle(m);
  const score = cycle.score;
  const sample = { ...m, at: stamp, score };
  const trend = trends(layer, sample, (s) => s.score, P.marketMaxAgeMs);
  const overheat = clamp((m.height - 5) / 4) * clamp((m.limitUp - 40) / 80);
  const premiumKnown = finite(m.premium) && m.premiumCoverage >= 0.5;
  const coverage = premiumKnown ? 1 : 0.9;
  const strength = clamp(
    (score - P.strengthFloor) / (P.strengthFull - P.strengthFloor),
  );
  const raw =
    strength *
    (1 - P.overheatPenalty * overheat) *
    (1 - trendPenalty(trend)) *
    coverage;
  updateLayer(
    layer,
    sample,
    raw,
    coverage,
    [
      `短线强度 ${(score * 100).toFixed(0)}；涨停 ${m.limitUp}、炸板 ${m.broken}、最高 ${m.height} 板`,
      premiumKnown
        ? `昨日涨停股溢价 ${m.premium.toFixed(2)}%`
        : "昨日涨停溢价覆盖不足，预算额外收紧",
      trend.oneMinute == null
        ? "1 分钟趋势预热中"
        : `1 分钟强度变化 ${(trend.oneMinute * 100).toFixed(1)}`,
      trend.fiveMinutes == null
        ? "5 分钟趋势预热中"
        : `5 分钟强度变化 ${(trend.fiveMinutes * 100).toFixed(1)}`,
      ...(overheat > 0 ? ["连板高度与涨停集聚出现过热，连续收紧预算"] : []),
    ],
    P.marketMaxAgeMs,
    premiumKnown,
  );
  layer.trend = trend;
  layer.strength = score;
  layer.overheat = round(overheat);
  layer.phase = cycle.phase; // explanation only; never used as a budget lookup
  layer.label = cycle.label;
  const sectors = new Map((market.sectors ?? []).map((s) => [s.name, s]));
  for (const name of new Set([
    ...Object.keys(state.sectors),
    ...sectors.keys(),
  ])) {
    const local = ensureLayer(state.sectors, name);
    const s =
      sectors.get(name) ??
      (market.sectorsComplete ? { score: 0, count: 0, broken: 0 } : null);
    if (!s || ![s.score, s.count, s.broken].every((v) => finite(v) && v >= 0)) {
      missing(local, "板块数据不完整，暂停该板块新增");
      continue;
    }
    const next = {
      at: stamp,
      score: s.score / 100,
      count: s.count,
      broken: s.broken,
    };
    const t = trends(local, next, (v) => v.score, P.marketMaxAgeMs);
    const breaks = s.count + s.broken > 0 ? s.broken / (s.count + s.broken) : 0;
    const factor =
      clamp((s.score - P.sectorFloor) / (P.sectorFull - P.sectorFloor)) *
      (1 - P.sectorBreakPenalty * breaks) *
      (1 - trendPenalty(t));
    updateLayer(
      local,
      next,
      factor,
      1,
      [
        `板块分 ${s.score}；涨停 ${s.count}、炸板 ${s.broken}`,
        ...(t.oneMinute != null
          ? [`1 分钟强度变化 ${(t.oneMinute * 100).toFixed(1)}`]
          : ["板块趋势预热中"]),
      ],
      P.marketMaxAgeMs,
      true,
    );
    local.trend = t;
  }
}

function updateStock(layer, quote, now, date, stopLoss) {
  if (
    quote?.date !== date ||
    !ageOk(quote?.timestamp, now, P.quoteMaxAgeMs) ||
    !finite(quote?.closeCents) ||
    quote.closeCents <= 0 ||
    !finite(quote?.volumeShares) ||
    quote.volumeShares < 0
  ) {
    missing(layer, "个股有效报价缺失或过期，暂停该股新增");
    return;
  }
  const at = Date.parse(quote.timestamp);
  if (at <= Date.parse(layer.observedAt)) return;
  const previous = layer.samples.at(-1);
  if (previous && quote.volumeShares < previous.volume) {
    missing(layer, "累计成交量倒退，等待重新确认");
    layer.samples = [];
    return;
  }
  if (previous && at - Date.parse(previous.at) > P.quoteGapMs)
    resetLayer(layer);
  const sample = {
    at: quote.timestamp,
    price: quote.closeCents,
    volume: quote.volumeShares,
  };
  const recent = [...layer.samples, sample].filter(
    (s) => at - Date.parse(s.at) <= P.longWindowMs,
  );
  const one = baseline(recent, at, P.shortWindowMs, P.quoteGapMs);
  const five = baseline(layer.samples, at, P.longWindowMs, P.quoteGapMs);
  const return1 = one ? sample.price / one.price - 1 : 0;
  const drawdown = 1 - sample.price / Math.max(...recent.map((s) => s.price));
  const returns = recent
    .slice(1)
    .map((s, i) => Math.log(s.price / recent[i].price));
  const volatility = Math.sqrt(returns.reduce((sum, r) => sum + r * r, 0));
  const volumes = recent
    .slice(1)
    .map((s, i) => Math.max(0, s.volume - recent[i].volume));
  const average =
    volumes.length > 3
      ? volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1)
      : 0;
  const volumeBurst = average > 0 ? volumes.at(-1) / average : 1;
  const fall = clamp(-return1 / (stopLoss / 2));
  const pressure =
    P.stockVolatilityWeight * clamp(volatility / stopLoss) +
    P.stockDrawdownWeight * clamp(drawdown / stopLoss) +
    P.stockFallWeight * fall +
    P.stockVolumePenalty * clamp((volumeBurst - 3) / 3) * fall;
  updateLayer(
    layer,
    sample,
    1 - pressure,
    1,
    [
      `观察窗口回撤 ${(drawdown * 100).toFixed(2)}%，波动 ${(volatility * 100).toFixed(2)}%`,
      one
        ? `1 分钟涨跌 ${(return1 * 100).toFixed(2)}%，增量成交量 ${volumeBurst.toFixed(1)} 倍`
        : "个股短窗趋势预热中",
    ],
    P.quoteGapMs,
    true,
  );
  layer.trend = {
    oneMinute: one ? round(return1) : null,
    fiveMinutes: five ? round(sample.price / five.price - 1) : null,
  };
}

// Mutates only the caller's cloned session state. No wall clock, IO, or randomness.
export function advanceAdaptiveRisk(
  state,
  { observedAt, market, quotes = {}, sectors = {}, stopLoss = 0.04 },
) {
  const now = Date.parse(observedAt),
    nextSegment = segment(observedAt, state.date);
  if (
    !nextSegment ||
    !Number.isFinite(now) ||
    now <= Date.parse(state.observedAt)
  )
    return state;
  if (
    state.segment !== nextSegment ||
    (state.observedAt && now - Date.parse(state.observedAt) > P.quoteGapMs)
  ) {
    for (const layer of [
      state.market,
      ...Object.values(state.sectors),
      ...Object.values(state.stocks),
    ])
      resetLayer(layer);
  }
  state.segment = nextSegment;
  state.observedAt = observedAt;
  for (const [code, sector] of Object.entries(sectors)) {
    if (sector) ensureLayer(state.sectors, sector);
    ensureLayer(state.stocks, code);
    state.stocks[code].sector = sector;
  }
  updateMarket(state, market, now);
  for (const [code, layer] of Object.entries(state.stocks)) {
    const quote = quotes[code];
    if (quote) updateStock(layer, quote, now, state.date, stopLoss);
    else if (!ageOk(layer.observedAt, now, P.quoteMaxAgeMs))
      missing(layer, "个股报价过期，暂停新增");
  }
  return state;
}

function usable(state, layer, at, maxAge) {
  return (
    !!layer?.valid &&
    layer.ready &&
    segment(at, state.date) === state.segment &&
    ageOk(layer.observedAt, Date.parse(at), maxAge)
  );
}

export function adaptiveEntryOrderDecision(
  config,
  state,
  {
    code,
    sector,
    intent = "OPEN",
    paused = false,
    missingHoldingQuotes = false,
  } = {},
) {
  if (
    paused ||
    (intent === "ADD_PROFIT" && !config.operations.profitAdd) ||
    (intent === "ADD_LOSS" && !config.operations.lossAdd)
  )
    return "CANCEL";
  const at = state?.observedAt;
  const layers = [
    [state?.market, P.marketMaxAgeMs],
    [state?.sectors[sector], P.marketMaxAgeMs],
    [state?.stocks[code], P.quoteMaxAgeMs],
  ];
  if (
    !state ||
    segment(at, state.date) !== state.segment ||
    layers.some(
      ([layer, age]) =>
        !layer?.valid ||
        !finite(layer.raw) ||
        !ageOk(layer.observedAt, Date.parse(at), age),
    )
  )
    return "WAIT";
  const threshold =
    intent === "OPEN"
      ? P.openMinimum
      : intent === "ADD_PROFIT"
        ? P.profitAddMinimum
        : P.lossAddMinimum;
  // Freshly observed deterioration may cancel immediately, including during
  // recovery. Missing data and confirmation counters are not risk observations.
  if (Math.min(...layers.map(([layer]) => layer.raw)) < threshold)
    return "CANCEL";
  if (missingHoldingQuotes || layers.some(([layer]) => !layer.ready))
    return "WAIT";
  const e = adaptiveEffective(config, state, { code, sector });
  const allowed =
    intent === "OPEN"
      ? e.open
      : intent === "ADD_PROFIT"
        ? e.profitAdd
        : e.lossAdd;
  return allowed ? "READY" : "WAIT";
}
export function adaptiveEffective(
  config,
  state,
  { code, sector, observedAt = state?.observedAt, paused = false } = {},
) {
  const m = state?.market;
  const marketOk = !!state && usable(state, m, observedAt, P.marketMaxAgeMs);
  const local = sector ? state?.sectors[sector] : null;
  const stock = code ? state?.stocks[code] : null;
  const marketFactor = marketOk ? m.applied : 0;
  const sectorFactor = sector
    ? usable(state, local, observedAt, P.marketMaxAgeMs)
      ? local.applied
      : 0
    : 1;
  const stockFactor = code
    ? usable(state, stock, observedAt, P.quoteMaxAgeMs)
      ? stock.applied
      : 0
    : 1;
  const factor = Math.min(marketFactor, sectorFactor, stockFactor);
  const knownProtection = (layer, maxAge) =>
    state && usable(state, layer, observedAt, maxAge) && layer.protectionKnown
      ? layer.protectionApplied
      : null;
  const marketProtection = knownProtection(m, P.marketMaxAgeMs);
  const sectorProtection = sector
    ? knownProtection(local, P.marketMaxAgeMs)
    : null;
  const stockProtection = code ? knownProtection(stock, P.quoteMaxAgeMs) : null;
  const known = (values) => values.filter((v) => v != null);
  const sectorProtectionFactors = known([marketProtection, sectorProtection]);
  const stockProtectionFactors = known([
    marketProtection,
    sectorProtection,
    stockProtection,
  ]);
  return {
    factor: round(factor),
    marketFactor,
    sectorFactor,
    stockFactor,
    entryRisk: paused ? 0 : config.risk.entryRisk * factor,
    portfolioRisk: paused ? 0 : config.risk.portfolioRisk * marketFactor,
    grossWeight: marketOk ? config.risk.grossWeight * marketFactor : null,
    sectorWeight:
      config.risk.sectorWeight * Math.min(marketFactor, sectorFactor),
    stockWeight: config.risk.stockWeight * factor,
    open: !paused && factor >= P.openMinimum,
    profitAdd:
      !paused && config.operations.profitAdd && factor >= P.profitAddMinimum,
    lossAdd: !paused && config.operations.lossAdd && factor >= P.lossAddMinimum,
    tForward: !paused && config.operations.tForward && factor >= P.tMinimum,
    tReverse: !paused && config.operations.tReverse && factor >= P.tMinimum,
    protection: {
      grossWeight:
        marketProtection != null
          ? config.risk.grossWeight * marketProtection
          : null,
      sectorWeight:
        sector && sectorProtectionFactors.length
          ? config.risk.sectorWeight * Math.min(...sectorProtectionFactors)
          : null,
      stockWeight:
        code && stockProtectionFactors.length
          ? config.risk.stockWeight * Math.min(...stockProtectionFactors)
          : null,
    },
  };
}

export function adaptiveRiskView(
  config,
  state,
  { observedAt = state?.observedAt, paused = false } = {},
) {
  if (!state) return null;
  const layerView = (layer, maxAge) => ({
    observedAt: layer.observedAt,
    raw: layer.raw,
    factor: usable(state, layer, observedAt, maxAge) ? layer.applied : 0,
    available: usable(state, layer, observedAt, maxAge),
    coverage: layer.coverage,
    warming: layer.warming,
    pending: layer.pending,
    reasons: layer.reasons,
    trend: layer.trend ?? null,
  });
  return {
    version: state.version,
    date: state.date,
    observedAt: state.observedAt,
    scope: "沪深主板与创业板短线生态",
    engineeringDefaults: true,
    market: {
      ...layerView(state.market, P.marketMaxAgeMs),
      phase: state.market.phase ?? "unknown",
      label: state.market.label ?? "数据不足",
      strength: state.market.strength ?? null,
      overheat: state.market.overheat ?? null,
    },
    effective: adaptiveEffective(config, state, { observedAt, paused }),
    sectors: Object.fromEntries(
      Object.entries(state.sectors).map(([name, layer]) => [
        name,
        {
          ...layerView(layer, P.marketMaxAgeMs),
          effective: adaptiveEffective(config, state, {
            sector: name,
            observedAt,
            paused,
          }),
        },
      ]),
    ),
    stocks: Object.fromEntries(
      Object.entries(state.stocks).map(([code, layer]) => [
        code,
        {
          ...layerView(layer, P.quoteMaxAgeMs),
          sector: layer.sector,
          effective: adaptiveEffective(config, state, {
            code,
            sector: layer.sector,
            observedAt,
            paused,
          }),
        },
      ]),
    ),
    history: state.market.samples.map((s) => ({ at: s.at, strength: s.score })),
  };
}
