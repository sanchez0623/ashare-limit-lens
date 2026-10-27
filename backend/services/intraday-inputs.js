import { loadIndustryMapping } from "./industry.js";
import { marketData } from "./market.js";
import {
  getAuctionSnapshot,
  getAuctionOpportunities,
  getShortTermBenchmark,
} from "./fuyao.js";
import { analyze, normalize } from "../../shared/scoring.js";
import { classifyStock } from "../../shared/stock-class.js";
import { INTRADAY_ENTRY_VERSION } from "../domain/intraday-entry.js";
import { marketClock } from "../domain/realtime.js";
import { resolveDailyPriceInputs } from "./price-history.js";
import { ADAPTIVE_RISK_POLICY } from "../../shared/adaptive-risk.js";
import { industryContinuation } from "../storage/industry-continuation.js";

export function computeIntradayHistory(
  dataset,
  snapshot,
  metadata,
  featuresByCode,
) {
  const end = dataset.dateIdx.get(snapshot.date);
  if (end === undefined) return {};
  const archived = new Map(
    [
      ...(snapshot.stocks ?? []),
      ...(snapshot.brokenStocks ?? []),
      ...(snapshot.extraStocks ?? []),
    ].map((s) => [s.code, s]),
  );
  const history = {};
  for (const [code, series] of dataset.codes) {
    if (!/^(00|30|60)\d{4}$/.test(code)) continue;
    let p = series.dates.length - 1;
    while (p >= 0 && series.dates[p] > end) p--;
    if (p < 4 || series.dates[p] !== end) continue;
    const row = archived.get(code);
    const info = metadata.get(code);
    const name = row?.name ?? info?.name;
    const sector = row?.sector ?? info?.industryName;
    if (!name || !sector || /ST|退/i.test(name)) continue;
    const features = featuresByCode.get(code);
    if (!features) continue;
    const base = series.hasFactor ? series.adjs[p] : 1;
    if (!(base > 0)) continue;
    const priceAt = (values, i) => {
      const factor = series.hasFactor ? series.adjs[i] / base : 1;
      return Number.isFinite(values?.[i]) && factor > 0
        ? Math.round(values[i] * factor * 100)
        : null;
    };
    const previousCloseCents = priceAt(series.closes, p);
    const priorClose = priceAt(series.closes, p - 1);
    const previousOpenCents = priceAt(series.opens, p);
    const previousHighCents = priceAt(series.highs, p);
    const lastFour = Array.from({ length: 4 }, (_, i) =>
      priceAt(series.closes, p - i),
    );
    if (!previousCloseCents || !priorClose || lastFour.some((v) => v === null))
      continue;
    const classification =
      row?.stockClass ??
      classifyStock({
        row: {
          code,
          sector,
          price: previousCloseCents / 100,
          isLimitUp: false,
          height: row?.height ?? 0,
          amount: row?.amount ?? null,
        },
        sectorMaxHeight: null,
        history: features,
      })?.stockClass;
    if (
      !classification ||
      classification === "mediocre" ||
      (features.limitUp10d !== true && !(row?.height > 0))
    )
      continue;
    const rawAmount = series.amounts?.[p];
    const amount = Number.isFinite(row?.amount)
      ? row.amount
      : Number.isFinite(rawAmount) && rawAmount > 0
        ? rawAmount
        : null;
    // Parquet 量的单位未经证实，不直接用作股份。与归档成交额交叉核对后才启用量能过滤。
    const volume = series.volumes[p];
    const volumeVerified =
      amount > 0 &&
      volume > 0 &&
      amount / ((volume * previousCloseCents) / 100) > 0.7 &&
      amount / ((volume * previousCloseCents) / 100) < 1.3;
    history[code] = {
      name,
      sector,
      stockClass: classification,
      recentLimitUp: true,
      amount,
      previousCloseCents,
      previousOpenCents,
      previousChange: (previousCloseCents / priorClose - 1) * 100,
      previousHeight: row?.height ?? 0,
      previousTouchedLimit:
        previousHighCents >=
        Math.round(priorClose * (code.startsWith("30") ? 1.2 : 1.1)),
      lastFourCloseSumCents: lastFour.reduce((n, v) => n + v, 0),
      previousVolumeShares: volumeVerified ? volume : null,
    };
  }
  return history;
}

export async function buildIntradayContext(
  env,
  snapshot,
  { firstNegMinPrevHeight = 3, dailyInputs } = {},
) {
  const context = {
    version: INTRADAY_ENTRY_VERSION,
    asOf: snapshot.date,
    firstNegMinPrevHeight,
    history: {},
    ...((snapshot.industryContext?.stockEmSnapshotId ??
    snapshot.market?.industryContext?.stockEmSnapshotId)
      ? {
          industrySnapshotId:
            snapshot.industryContext?.stockEmSnapshotId ??
            snapshot.market?.industryContext?.stockEmSnapshotId,
        }
      : {}),
  };
  try {
    const inputs =
      dailyInputs ??
      (await resolveDailyPriceInputs(env, snapshot.date, {
        rows: [
          ...(snapshot.stocks ?? []),
          ...(snapshot.brokenStocks ?? []),
          ...(snapshot.extraStocks ?? []),
          ...(snapshot.market?.previous ?? []),
        ],
        frozenInputs: snapshot.dailyPriceInputs?.records?.length
          ? snapshot.dailyPriceInputs
          : null,
      }));
    for (const dataset of inputs.datasets)
      Object.assign(
        context.history,
        computeIntradayHistory(
          dataset,
          snapshot,
          await loadIndustryMapping(
            env,
            context.industrySnapshotId
              ? { id: context.industrySnapshotId }
              : {},
          ),
          inputs.featuresByCode,
        ),
      );
    // 新快照已有顶层原始历史；延迟准备的旧快照才在上下文中携带，避免重复保存。
    if (!snapshot.dailyPriceInputs?.records?.length)
      context.priceHistoryInputs = inputs.evidence;
    context.dataSources = inputs.status;
    if (!Object.keys(context.history).length)
      return {
        ...context,
        unavailable: true,
        reason: "本地或备用日线尚未覆盖信号日，或候选资格不足",
      };
  } catch {
    context.unavailable = true;
  }
  return context;
}

export async function collectEntryMarket(
  date,
  { provider = marketData, env, industrySnapshotId } = {},
) {
  const market = await provider(date, env, {
    cacheTtlMs: ADAPTIVE_RISK_POLICY.marketIntervalMs,
    cacheScope: "intraday",
    ...(industrySnapshotId ? { industrySnapshotId } : {}),
  });
  if (market.date !== date) throw new Error("盘中候选行情日期不一致");
  if (
    industrySnapshotId &&
    market.industryContext?.stockEmSnapshotId !== industrySnapshotId
  )
    throw new Error("盘中行业来源与冻结计划版本不一致");
  const analysis = analyze(market.rows.map(normalize), market.broken, null);
  const previous = (market.previous ?? []).map(normalize);
  const premiums = previous.map((s) => s.change).filter(Number.isFinite);
  const brokenBySector = new Map();
  for (const row of market.brokenRows ?? []) {
    const s = normalize(row);
    brokenBySector.set(s.sector, (brokenBySector.get(s.sector) ?? 0) + 1);
  }
  const sectors = new Map(
    analysis.sectors.map((s) => [
      s.name,
      {
        name: s.name,
        score: s.score,
        count: s.count,
        height: s.height,
        coverage: s.coverage,
        broken:
          market.broken === null ? null : (brokenBySector.get(s.name) ?? 0),
      },
    ]),
  );
  for (const [name, broken] of brokenBySector)
    if (!sectors.has(name))
      sectors.set(name, {
        name,
        score: 0,
        count: 0,
        height: 0,
        coverage: 100,
        broken,
      });
  const sectorsComplete =
    Array.isArray(market.rows) && Array.isArray(market.brokenRows);
  // A known industry with no limit-up or broken-board stocks has zero activity;
  // it is not a failed industry lookup. Only an explicit complete source and
  // the published code-bound vocabulary can establish this zero.
  if (
    sectorsComplete &&
    market.industryContext?.mappingPolicy === "CODE_SNAPSHOT_PRIMARY_V2"
  )
    for (const name of market.industryContext.industryNames ?? [])
      if (!sectors.has(name))
        sectors.set(name, {
          name,
          score: 0,
          count: 0,
          height: 0,
          coverage: 100,
          broken: 0,
        });
  return {
    date,
    observedAt: market.fetchedAt,
    emotion: analysis.emotion,
    cycle: analysis.cycle,
    metrics: {
      limitUp: analysis.count,
      broken: market.broken,
      height: analysis.height,
      first: analysis.first,
      relay: analysis.relay,
      premium: premiums.length
        ? premiums.reduce((sum, v) => sum + v, 0) / premiums.length
        : null,
      premiumCoverage: previous.length ? premiums.length / previous.length : 0,
    },
    sectorsComplete,
    ...(market.industryContext
      ? { industryContext: market.industryContext }
      : {}),
    sectors: [...sectors.values()],
    discoveries: [...market.rows, ...(market.brokenRows ?? [])]
      .map(normalize)
      .map((s) => ({
        code: s.code,
        name: s.name,
        sector: s.sector,
        amount: s.amount,
        height: s.height,
        turnover: s.turnover,
      })),
  };
}

const auctionEvidenceCache = new Map();
export async function collectAuctionEvidence(
  date,
  codes,
  {
    snapshot = getAuctionSnapshot,
    opportunities = getAuctionOpportunities,
    benchmark = getShortTermBenchmark,
  } = {},
) {
  if (!codes.length)
    return {
      date,
      rows: {},
      opportunities: [],
      benchmark: [],
      unavailable: true,
    };
  const cacheable =
    snapshot === getAuctionSnapshot &&
    opportunities === getAuctionOpportunities &&
    benchmark === getShortTermBenchmark;
  const cacheKey = `${date}:${[...codes].sort().join(",")}`;
  const hit = cacheable ? auctionEvidenceCache.get(cacheKey) : null;
  if (hit && (!hit.value.unavailable || Date.now() - hit.time < 60000))
    return structuredClone(hit.value);
  const thscodes = codes.map((c) => `${c}.${c.startsWith("6") ? "SH" : "SZ"}`);
  const outcomes = await Promise.allSettled([
    snapshot(thscodes, { stage: "final", timeoutMs: 4000, retries: 0 }),
    opportunities({
      date,
      thscodes,
      exclude_st: true,
      timeoutMs: 4000,
      retries: 0,
    }),
    benchmark(date, { timeoutMs: 4000, retries: 0 }),
  ]);
  const value = (i) =>
    outcomes[i].status === "fulfilled" ? outcomes[i].value : null;
  const data = value(0);
  const final =
    data &&
    ["final", "closed"].includes(data.auction_phase) &&
    ["ready", "final"].includes(data.data_status);
  const result = {
    date,
    retrievedAt: new Date().toISOString(),
    // 响应 timestamp 是组装时间，不是竞价行情时间。开盘价必须再由当天腾讯报价核对。
    rows: Object.fromEntries(
      (data?.item ?? []).map((r) => [
        r.ticker ?? r.thscode?.slice(0, 6),
        {
          final: !!final,
          openCents: Math.round(Number(r.auction_price) * 100),
          previousCloseCents: Math.round(Number(r.pre_close_price) * 100),
          amountCny: r.auction_amount ?? null,
        },
      ]),
    ),
    opportunities: value(1)?.trade_date === date ? value(1).item : [],
    benchmark: value(2)?.date === date ? value(2).item : [],
    unavailable: !final,
  };
  if (cacheable) {
    if (auctionEvidenceCache.size >= 20)
      auctionEvidenceCache.delete(auctionEvidenceCache.keys().next().value);
    auctionEvidenceCache.set(cacheKey, { value: result, time: Date.now() });
  }
  return result;
}

export async function collectIntradayInputs(
  plan,
  date,
  codes,
  { providers = {}, now = new Date(), env } = {},
) {
  if (!plan?.entryExecutionPolicy) return null;
  // 注入行情意味着持久帧/历史重放；严禁在重放时补拉今天的上游数据。
  if (providers.entryInputs)
    return typeof providers.entryInputs === "function"
      ? providers.entryInputs(codes, date)
      : providers.entryInputs;
  if (providers.quotes) return null;
  const continuation = plan.entryExecutionPolicy.industrySnapshotId
    ? null
    : await industryContinuation(env?.DB, plan);
  const results = await Promise.allSettled([
    collectEntryMarket(date, {
      env,
      industrySnapshotId:
        plan.entryExecutionPolicy.industrySnapshotId ??
        continuation?.industrySnapshotId,
    }),
    now.getTime() + 8 * 3600000 - Date.parse(`${date}T00:00:00Z`) < 10 * 3600000
      ? collectAuctionEvidence(date, codes)
      : Promise.resolve(null),
  ]);
  return {
    market: results[0].status === "fulfilled" ? results[0].value : null,
    auctionEvidence:
      results[1].status === "fulfilled" ? results[1].value : null,
  };
}

export function verifyAuctionQuotes(inputs, quotes, date) {
  if (!inputs) return null;
  const auction = { ...(inputs.auction ?? {}) };
  const evidence = inputs.auctionEvidence;
  if (evidence?.date === date)
    for (const [code, row] of Object.entries(evidence.rows ?? {})) {
      const quote = quotes[code];
      if (
        row.final &&
        quote?.date === date &&
        quote.openCents === row.openCents &&
        quote.previousCloseCents === row.previousCloseCents
      )
        auction[code] = {
          ...row,
          date,
          verifiedByQuoteTimestamp: quote.timestamp,
        };
    }
  return { ...inputs, auction };
}

// 盘前仅采集，不推进任何账户或订单；成交仍在连续竞价中独立确认。
export async function observePreopenAuction(
  env,
  now = new Date(),
  providers = {},
) {
  const clock = marketClock(now);
  if (
    clock.time < "09:15:00" ||
    clock.time >= "09:30:00" ||
    [0, 6].includes(clock.weekday)
  )
    return null;
  const requested = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='intraday-entry-observation-request'",
  ).first();
  const primary = await env.DB.prepare(
    "SELECT state FROM paper_accounts WHERE id='primary'",
  ).first();
  const book = primary && JSON.parse(primary.state);
  if (!requested && book?.entryExecutionMode !== "intraday-conditional")
    return null;
  const key = `intraday-auction-observation:${clock.date}`;
  const previous = await env.DB.prepare(
    "SELECT value FROM settings WHERE key=?",
  )
    .bind(key)
    .first();
  if (
    previous &&
    now.getTime() - Date.parse(JSON.parse(previous.value).observedAt) < 30000
  )
    return null;
  const source = await env.DB.prepare(
    "SELECT payload FROM snapshots WHERE trade_date=?",
  )
    .bind(book?.lastDate)
    .first();
  const snapshot = source && JSON.parse(source.payload);
  const codes = [
    ...new Set(
      [...(snapshot?.stocks ?? []), ...(snapshot?.brokenStocks ?? [])].map(
        (s) => `${s.code}.${s.code.startsWith("6") ? "SH" : "SZ"}`,
      ),
    ),
  ].slice(0, 200);
  if (!codes.length || providers.quotes) return null;
  const data = await getAuctionSnapshot(codes, {
    stage: clock.time < "09:25:00" ? "live" : "final",
    timeoutMs: 4000,
    retries: 0,
  });
  await env.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  )
    .bind(
      key,
      JSON.stringify({ date: clock.date, observedAt: now.toISOString(), data }),
    )
    .run();
  return { observed: true, date: clock.date };
}
