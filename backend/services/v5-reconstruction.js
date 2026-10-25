import fs from "node:fs";
import path from "node:path";
import { digestOf } from "../domain/research-lineage.js";
import { analyze, PRESETS } from "../../shared/scoring.js";
import { feesForBook } from "../../shared/fees.js";
import { riskLimitsForBook } from "../../shared/risk-limits.js";
import { BASE_STRATEGY } from "../domain/trading.js";
import { PaperRepository } from "../storage/paper.js";
import { latestPolicyBundle } from "../storage/execution-cost.js";
import { QuoteFrameRepository } from "../storage/quotes.js";
import {
  getLimitUpPool,
  getLimitBreakPool,
  getAuctionOpportunityDates,
  getPricesHistorical,
} from "./fuyao.js";
import { readBuyPointParams } from "./review.js";
import {
  dailyDataDir,
  loadDailyDataset,
  computeMa5ByCode,
  computeStockFeaturesByCode,
  computeEodRowsWithPrev,
  computeExitEodRowsByCode,
} from "./daily-closes.js";
import { buildEodCandidates } from "./eod-candidates.js";
import {
  verifiedPreviousRows,
  PRICE_HISTORY_VERSION,
  cleanPriceHistoryBars,
  validatePriceHistoryRecord,
} from "./price-history.js";
import { computeIntradayHistory } from "./intraday-inputs.js";
import { INTRADAY_ENTRY_VERSION } from "../domain/intraday-entry.js";
import { isDragon, DRAGON_RULES } from "../domain/dragon-risk.js";
import { loadDragonConfig } from "../storage/dragon-risk.js";
import { executionEngineBuildDigest } from "../domain/execution-build.js";
import { phaseShiftOf, sectorDropsOf } from "./exit-context.js";
import { DOWNGRADE_RULES_VERSION } from "../../shared/downgrade.js";
import { T_QUALITY_RULES_VERSION } from "../domain/t-quality.js";

export const V5_RECONSTRUCTION_VERSION = "v5-reconstruction-v1";
export const V5_SCORING_VERSION = "rules-v5-historical-v1";
export const ARCHIVED_OBSERVATIONS_MODEL = "ARCHIVED_OBSERVATIONS_V1";
const id = (p) => `${p}-${crypto.randomUUID()}`;
const finite = (v) =>
  v != null && Number.isFinite(Number(v)) ? Number(v) : null;
const supported = (code) => /^(00|30|60)\d{4}$/.test(code);
async function fileContentDigest(filePath) {
  const hash = await crypto.subtle.digest("SHA-256", fs.readFileSync(filePath));
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function readResearchParquet(filePath) {
  const [{ parquetReadObjects }, { compressors }] = await Promise.all([
    import("hyparquet"),
    import("hyparquet-compressors"),
  ]);
  const bytes = fs.readFileSync(filePath);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return parquetReadObjects({
    file: {
      byteLength: buffer.byteLength,
      slice: (s, e) => buffer.slice(s, e),
    },
    compressors,
  });
}

export async function freezeResearchConfiguration(env) {
  const repository = new PaperRepository(env);
  const account = await repository.account();
  if (!account) throw new Error("主账户不存在，无法冻结研究配置");
  if (isDragon(account.book)) {
    const record = await loadDragonConfig(env.DB, account.book.dragonConfigId);
    if (
      record.digest !== account.book.dragonConfigDigest ||
      record.digest !== (await digestOf(account.book.dragonConfig)) ||
      record.engineBuild !== account.book.dragonEngineBuild ||
      record.engineBuild !== (await executionEngineBuildDigest())
    )
      throw new Error("新政策研究配置、摘要或执行版本不一致，请先重新验证");
    return {
      frozenAt: new Date().toISOString(),
      source: "PRIMARY_CONFIGURATION",
      accountRevision: account.revision,
      tradingPolicyVersion: account.book.tradingPolicyVersion,
      dragonConfig: structuredClone(account.book.dragonConfig),
      dragonConfigId: account.book.dragonConfigId,
      dragonConfigDigest: account.book.dragonConfigDigest,
      dragonEngineBuild: account.book.dragonEngineBuild,
      activeStrategy: account.book.dragonConfigId,
      strategy: null,
      sourceWeights: structuredClone(PRESETS.balanced),
      fees: feesForBook(account.book),
      feeModel: account.book.feeModel,
      feeConfigVersion: account.book.feeConfigVersion,
      executionCostPolicy: await latestPolicyBundle(env.DB),
      buyPointParams: {
        firstNegMinPrevHeight: DRAGON_RULES.firstNegMinPrevHeight,
      },
      initialCapital: 1000000,
      selectionPolicyVersion: account.book.tradingPolicyVersion,
      entryExecutionMode: "intraday-conditional",
    };
  }
  const strategy = await repository.strategy(account.book);
  return {
    frozenAt: new Date().toISOString(),
    source: "PRIMARY_CONFIGURATION",
    accountRevision: account.revision,
    activeStrategy: account.book.activeStrategy,
    strategy: strategy ?? BASE_STRATEGY,
    fees: feesForBook(account.book),
    riskLimits: riskLimitsForBook(account.book),
    feeConfigVersion: account.book.feeConfigVersion ?? 1,
    riskLimitsVersion: account.book.riskLimitsVersion ?? 1,
    executionCostPolicy: await latestPolicyBundle(env.DB),
    buyPointParams: await readBuyPointParams(env),
    initialCapital: 1000000,
    selectionPolicyVersion: "signal-ranking-v5",
    entryExecutionMode: "intraday-conditional",
  };
}

// A successful empty page is distinct from a missing, truncated or inconsistent list.
export async function fetchCompleteHistoricalPool(fetchPage, date) {
  const pages = [],
    rows = [],
    seen = new Set();
  let expectedTotal = null,
    expectedPages = null;
  for (let page = 1; page <= 1000; page++) {
    const response = await fetchPage(date, {
      page,
      size: 200,
      cacheTtlMs: 0,
      timeoutMs: 15000,
      retries: 1,
    });
    if (response?.unavailable || !Array.isArray(response?.item))
      throw new Error("历史名单不可用");
    const p = response.pagination;
    if (
      !p ||
      !Number.isInteger(p.total) ||
      p.total < 0 ||
      !Number.isInteger(p.pages) ||
      p.pages < 0 ||
      p.page !== page
    )
      throw new Error("历史名单缺少可验证的分页元数据");
    if (page === 1) {
      expectedTotal = p.total;
      expectedPages = Math.max(1, p.pages);
    }
    if (p.total !== expectedTotal || Math.max(1, p.pages) !== expectedPages)
      throw new Error("历史名单分页总数变化");
    // timestamp is assembly time, never a historical event time.
    if (response.date && response.date !== date)
      throw new Error("历史名单响应日期不一致");
    if (
      response.date_ms &&
      new Date(response.date_ms + 8 * 3600000).toISOString().slice(0, 10) !==
        date
    )
      throw new Error("历史名单日期戳不一致");
    for (const row of response.item) {
      const code = row.ticker ?? row.thscode?.slice(0, 6);
      if (!/^\d{6}$/.test(code ?? "") || seen.has(code))
        throw new Error("历史名单重复或无效股票代码");
      seen.add(code);
      rows.push(row);
    }
    pages.push(response);
    if (page === expectedPages) {
      if (rows.length !== expectedTotal)
        throw new Error("历史名单分页数量不完整");
      return {
        date,
        rows,
        pages,
        complete: true,
        dateConfidence: "SOURCE_REPORTED",
        retrievedAt: new Date().toISOString(),
      };
    }
  }
  throw new Error("历史名单分页超过安全上限，不能声明完整");
}

// Only dated daily bars may supply OHLC; today's latest snapshot is never consulted.
export function historicalPoolRows(pool, eodRows, metadata, kind) {
  return pool.rows
    .filter((r) => supported(r.ticker ?? r.thscode?.slice(0, 6)))
    .map((raw) => {
      const code = raw.ticker ?? raw.thscode.slice(0, 6),
        bar = eodRows.get(code),
        info = metadata.get(code);
      const sourcePrice = finite(raw.last_price);
      return {
        code,
        name: raw.name ?? info?.name ?? null,
        sector: raw.industry_name ?? info?.industryName ?? "未分类",
        price: bar?.close ?? null,
        open: bar?.open ?? null,
        high: bar?.high ?? null,
        change: bar?.change ?? null,
        amount: finite(raw.turnover) ?? info?.amount ?? null,
        floatCap: finite(raw.float_market_cap),
        seal: finite(raw.seal_money),
        turnover: finite(raw.turnover_ratio_pct),
        first: null,
        last: null,
        breaks: finite(raw.open_times),
        height: kind === "MAIN" ? finite(raw.continue_day_cnt) : null,
        limitUpReason: raw.limit_up_reason ?? null,
        themes: [],
        maxSealMoney: finite(raw.max_seal_money),
        isSt: raw.is_st ?? /ST|退/i.test(raw.name ?? ""),
        isNew: raw.is_new ?? null,
        priceEvidence: {
          date: pool.date,
          source: "DATED_DAILY",
          sourcePrice,
          matches:
            bar && sourcePrice > 0
              ? Math.abs(bar.close - sourcePrice) <= 0.011
              : null,
        },
      };
    });
}

export function reconstructV5Snapshot({
  date,
  previousDate,
  dataset,
  pools,
  previousPools,
  metadata,
  configuration,
  createdAt = new Date().toISOString(),
}) {
  const { rowsByCode: eodRows } = computeEodRowsWithPrev(dataset, date);
  const { ma5ByCode } = computeMa5ByCode(dataset, date);
  const { featuresByCode } = computeStockFeaturesByCode(dataset, date);
  const datedMetadata = new Map(metadata);
  const end = dataset.dateIdx.get(date);
  for (const [code, series] of dataset.codes) {
    let p = series.dates.length - 1;
    while (p >= 0 && series.dates[p] > end) p--;
    if (p >= 0 && series.dates[p] === end && datedMetadata.has(code))
      datedMetadata.set(code, {
        ...datedMetadata.get(code),
        amount: finite(series.amounts?.[p]),
      });
  }
  const rows = pools.main
    ? historicalPoolRows(pools.main, eodRows, datedMetadata, "MAIN")
    : [];
  const brokenRows = pools.broken
    ? historicalPoolRows(pools.broken, eodRows, datedMetadata, "BROKEN")
    : [];
  const prevDaily = computeEodRowsWithPrev(dataset, previousDate).rowsByCode;
  const previousRaw = previousPools?.main
    ? historicalPoolRows(previousPools.main, prevDaily, datedMetadata, "MAIN")
    : null;
  const previous = verifiedPreviousRows(previousRaw, eodRows);
  const firstNegMinPrevHeight =
    configuration.buyPointParams.firstNegMinPrevHeight;
  const extras = buildEodCandidates({
    previous: previous ?? [],
    eodRows,
    ma5ByCode,
    existingCodes: new Set([...rows, ...brokenRows].map((r) => r.code)),
    stockInfoByCode: datedMetadata,
    firstNegMinPrevHeight,
  });
  const weights =
    configuration.sourceWeights ??
    configuration.strategy?.weights ??
    PRESETS.balanced;
  const analysis = analyze(
    rows,
    pools.broken ? brokenRows.length : null,
    previous,
    weights,
    {
      ma5ByCode,
      historyByCode: featuresByCode,
      lateSession: true,
      firstNegMinPrevHeight,
      brokenRows: pools.broken ? brokenRows : null,
      extraCandidates: extras,
      prevEodByCode: eodRows,
      previousPricesVerified: true,
    },
  );
  const { stocks, brokenStocks, extraStocks, sectors, ...summary } = analysis;
  const snapshot = {
    date,
    createdAt,
    decisionAt: `${date}T07:10:00.000Z`,
    source: "HISTORICAL_RECONSTRUCTED",
    modelVersion: V5_SCORING_VERSION,
    reconstructionVersion: V5_RECONSTRUCTION_VERSION,
    weights,
    previousPricesVerified: true,
    stocks,
    brokenStocks,
    extraStocks,
    sectors,
    emotion: analysis.emotion,
    cycle: analysis.cycle,
    marketSummary: summary,
    downgradeRulesVersion: DOWNGRADE_RULES_VERSION,
    tQualityRulesVersion: T_QUALITY_RULES_VERSION,
    market: {
      rows,
      brokenRows,
      broken: pools.broken ? brokenRows.length : null,
      previous,
      fetchedAt: createdAt,
    },
  };
  snapshot.intradayEntryContext = {
    version: INTRADAY_ENTRY_VERSION,
    asOf: date,
    firstNegMinPrevHeight,
    history: computeIntradayHistory(
      dataset,
      snapshot,
      datedMetadata,
      featuresByCode,
    ),
  };
  snapshot.researchExitInputs = {
    features: Object.fromEntries(featuresByCode),
    eodRows: Object.fromEntries(
      computeExitEodRowsByCode(dataset, date).rowsByCode,
    ),
    breaks: Object.fromEntries(
      brokenRows
        .filter((r) => r.breaks !== null)
        .map((r) => [r.code, r.breaks]),
    ),
    sectorDrops: [
      ...sectorDropsOf(
        stocks,
        (previous ?? []).map((r) => ({ hybk: r.sector, ylbc: r.height })),
      ).keys(),
    ],
    phaseShift: false,
  };
  const issues = [];
  for (const key of ["main", "broken"])
    if (!pools[key])
      issues.push({
        field: `${key}Pool`,
        reason: "名单缺失，不能解释为空名单",
      });
  if (!previousPools?.main)
    issues.push({ field: "previousPool", reason: "前一交易日名单缺失" });
  for (const row of [...rows, ...brokenRows]) {
    const missing = [
      "price",
      "open",
      "high",
      "change",
      "amount",
      "turnover",
      "floatCap",
      "seal",
      "first",
      "last",
      "breaks",
      "height",
    ].filter((k) => row[k] === null);
    if (missing.length)
      issues.push({
        code: row.code,
        field: missing.join(","),
        reason: "历史特征不足",
      });
    if (row.priceEvidence.matches === false)
      issues.push({
        code: row.code,
        field: "daily.close",
        reason: "历史池价格与同日未复权日线不一致",
      });
  }
  // Current metadata is useful for reconstruction, but cannot establish historical membership.
  const metadataIssues = [...datedMetadata.values()].some(
    (m) => m.pointInTimeVerified !== true,
  );
  if (metadataIssues)
    issues.push({
      field: "historicalName,industry,listingStatus",
      reason: "名称、行业或退市状态缺少完整时点历史，候选覆盖不能声明完整",
    });
  if (!eodRows.size)
    issues.push({ field: "daily", reason: "信号日日线不可用" });
  const candidateCoverage = {
    date,
    previousDate,
    status: issues.length ? "PARTIAL" : "COMPLETE",
    counts: {
      stocks: stocks.length,
      brokenStocks: brokenStocks?.length ?? 0,
      extraStocks: extraStocks?.length ?? 0,
      daily: eodRows.size,
      eligible: Object.keys(snapshot.intradayEntryContext.history).length,
    },
    issues,
  };
  snapshot.candidateCoverage = candidateCoverage;
  return { snapshot, candidateCoverage };
}

export function rawDailyRows(dataset, date) {
  const end = dataset.dateIdx.get(date),
    rows = [];
  for (const [code, s] of dataset.codes) {
    let p = s.dates.length - 1;
    while (p >= 0 && s.dates[p] > end) p--;
    if (p < 0 || s.dates[p] !== end) continue;
    rows.push({
      code,
      date,
      open: finite(s.opens[p]),
      high: finite(s.highs[p]),
      low: finite(s.lows[p]),
      close: finite(s.closes[p]),
      volume: finite(s.volumes[p]),
      amount: finite(s.amounts?.[p]),
      adjustmentFactor: s.hasFactor ? finite(s.adjs[p]) : null,
    });
  }
  return rows;
}

export async function fetchResearchDailyRecord(
  code,
  start,
  end,
  provider = getPricesHistorical,
) {
  const thscode = `${code}.${code.startsWith("6") ? "SH" : "SZ"}`,
    responses = [];
  for (const adjust of ["none", "forward"]) {
    const response = await provider(thscode, {
      start: Date.parse(`${start}T00:00:00+08:00`),
      end: Date.parse(`${end}T23:59:59+08:00`),
      adjust,
      retries: 1,
      timeoutMs: 15000,
    });
    if (
      response.unavailable ||
      (response.thscode && response.thscode !== thscode) ||
      (response.interval && response.interval !== "1d") ||
      (response.adjust && response.adjust !== adjust)
    )
      throw new Error("历史日线标的、周期或复权口径不一致");
    responses.push({
      response,
      bars: cleanPriceHistoryBars(response.item, end),
    });
  }
  const asOf = responses[0].bars.at(-1)?.date;
  const record = {
    version: PRICE_HISTORY_VERSION,
    code,
    asOf,
    source: "FUYAO_HISTORICAL_RESEARCH",
    observedAt: new Date().toISOString(),
    requestedRange: { start, end },
    raw: responses[0].bars,
    adjusted: responses[1].bars,
  };
  validatePriceHistoryRecord(record, asOf, code);
  return { record, responses: responses.map((r) => r.response) };
}

export function withResearchDailyRecords(dataset, records) {
  const dates = [
    ...new Set([
      ...dataset.dates,
      ...records.flatMap((r) => r.raw.map((b) => b.date)),
    ]),
  ].sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i])),
    codes = new Map();
  for (const [code, s] of dataset.codes)
    codes.set(code, {
      ...s,
      dates: Uint32Array.from(s.dates, (i) => dateIdx.get(dataset.dates[i])),
    });
  for (const record of records) {
    const local = dataset.codes.get(record.code),
      raw = record.raw;
    // A fallback must reconcile with existing raw bars before replacing this code's window.
    if (local)
      for (const b of raw) {
        const i = dataset.dateIdx.get(b.date),
          p = local.dates.indexOf(i);
        if (p >= 0 && Math.abs(local.closes[p] - b.close) > 0.011)
          throw new Error(`${record.code} 历史备用日线与本地同日收盘价不一致`);
      }
    codes.set(record.code, {
      dates: Uint32Array.from(raw, (b) => dateIdx.get(b.date)),
      opens: Float64Array.from(raw, (b) => b.open),
      highs: Float64Array.from(raw, (b) => b.high),
      lows: Float64Array.from(raw, (b) => b.low),
      closes: Float64Array.from(raw, (b) => b.close),
      volumes: Float64Array.from(raw, (b) => b.volume),
      amounts: Float64Array.from(raw, (b) => b.amount),
      adjs: Float64Array.from(
        raw,
        (b, i) => record.adjusted[i].close / b.close,
      ),
      hasFactor: true,
    });
  }
  return { dates, dateIdx, codes };
}

export async function runV5Import(
  env,
  job,
  { jobs, store, executorId, round, options = {} },
) {
  const guard = async () => {
    if (!(await jobs.stillOwner(job.id, executorId)))
      throw new Error("历史执行器已失去任务所有权");
  };
  const apply = (result) => {
    if (result?.applied === false) throw new Error("历史数据集所有权已转移");
    return result;
  };
  let datasetId = job.datasetId;
  if (job.kind === "OBSERVATIONS") {
    if (!datasetId) {
      const source = await store.getDataset(job.statusPayload.datasetId);
      if (
        !source?.coverage.reconstructionVersion ||
        source.kind !== "V5_RECONSTRUCTION" ||
        source.coverage.observationsImportedAt
      )
        throw new Error("OBSERVATIONS 需要 V5 候选重构数据集");
      if (
        source.requestedRange.start !== job.requestedRange.start ||
        source.requestedRange.end !== job.requestedRange.end
      )
        throw new Error("归档帧区间必须与源候选数据集完全相同");
      datasetId = (await store.cloneForObservations(source.id)).id;
      if (!(await jobs.claimDataset(job.id, datasetId)))
        throw new Error("历史数据集已被认领");
    }
    const owner = await store.acquireDatasetOwnership(
      datasetId,
      { executorId, round },
      job.id,
    );
    if (!owner?.granted) throw new Error("历史数据集所有权不可用");
    await jobs.progressJob(job.id, executorId, {
      stage: "DOWNLOADING",
      datasetId,
    });
    const source = await store.getDataset(datasetId),
      frames = new QuoteFrameRepository(env),
      perDay = [];
    for (const date of source.coverage.executionDates) {
      await guard();
      const copied = await frames.framesForDate(date);
      for (const frame of copied) {
        if ((await digestOf(frame.payload)) !== frame.digest)
          throw new Error(`${date} 原始行情帧摘要不一致`);
        apply(
          await store.saveArchivedFrame(
            datasetId,
            {
              ...frame,
              origin: "REAL_QUOTE_ARCHIVE",
              importedAt: job.createdAt,
            },
            owner,
          ),
        );
      }
      perDay.push({ date, frames: copied.length });
    }
    const coverage = {
      ...source.coverage,
      sourceDatasetId: job.statusPayload.datasetId,
      executionModel: ARCHIVED_OBSERVATIONS_MODEL,
      observationsImportedAt: new Date().toISOString(),
      observations: perDay,
    };
    apply(await store.updateDatasetCoverage(datasetId, coverage, owner));
    return jobs.finishJob(job.id, executorId, {
      stage: perDay.every((d) => d.frames > 0) ? "READY" : "BLOCKED",
      datasetId,
      statusPayload: {
        observations: perDay,
        reason: perDay.some((d) => !d.frames)
          ? "真实逐帧归档缺失；严格回放须另行完整预检"
          : null,
      },
    });
  }
  const dir = dailyDataDir(env);
  if (!dir) throw new Error("V5 历史重构需要 QUAN_DATA_DIR");
  let dataset = options.localDataset ?? (await loadDailyDataset(dir));
  const sourceFiles =
    options.sourceFiles ??
    Object.fromEntries(
      await Promise.all(
        [
          "daily.parquet",
          "adj_factor.parquet",
          "trade_calendar.parquet",
          "stock_basic.parquet",
          "stock_industry.parquet",
        ].map(async (name) => [
          name,
          await fileContentDigest(path.join(dir, name)),
        ]),
      ),
    );
  const [calendarRows, basics, industries] =
    options.referenceRows ??
    (await Promise.all(
      [
        "trade_calendar.parquet",
        "stock_basic.parquet",
        "stock_industry.parquet",
      ].map((name) => readResearchParquet(path.join(dir, name))),
    ));
  const localOpenDates = calendarRows
    .filter((r) => Number(r.is_open) === 1)
    .map((r) => r.date);
  const calendarEvidence =
    options.calendarEvidence ??
    (options.referenceRows
      ? { dates: localOpenDates, latest_date: localOpenDates.at(-1) }
      : await getAuctionOpportunityDates({ cacheTtlMs: 0, retries: 1 }));
  const upstreamDates = Array.isArray(calendarEvidence.dates)
    ? calendarEvidence.dates
    : [];
  const allDates = [
    ...new Set([...localOpenDates, ...dataset.dates, ...upstreamDates]),
  ]
    .filter((d) => d <= job.requestedRange.end)
    .sort();
  const executionDates = allDates.filter(
    (d) => d >= job.requestedRange.start && d <= job.requestedRange.end,
  );
  if (!executionDates.length) throw new Error("请求区间没有已确认交易日");
  const calendarThrough = [
    localOpenDates.at(-1),
    calendarEvidence.latest_date,
    dataset.dates.at(-1),
  ]
    .filter(Boolean)
    .sort()
    .at(-1);
  if (job.requestedRange.end > calendarThrough)
    throw new Error("交易日历证据未覆盖请求结束日");
  const firstIndex = allDates.indexOf(executionDates[0]);
  if (firstIndex < 23)
    throw new Error("缺少首个执行日前至少 21 个交易日预热历史");
  const signalDates = executionDates.map(
    (d) => allDates[allDates.indexOf(d) - 1],
  );
  const warmupDates = allDates.slice(firstIndex - 23, firstIndex - 1);
  const metadata = new Map(
    basics.map((r) => [
      r.code,
      {
        name: r.name,
        listDate: r.list_date,
        delisted: r.delisted,
        pointInTimeVerified: r.pointInTimeVerified === true,
      },
    ]),
  );
  for (const r of industries)
    if (metadata.has(r.code))
      Object.assign(metadata.get(r.code), {
        industryName: r.sw_l1,
        industrySnapshot: r.snapshot_date,
      });
  let prior = datasetId ? await store.getDataset(datasetId) : null;
  if (
    prior?.coverage.sourceFiles &&
    (await digestOf(prior.coverage.sourceFiles)) !==
      (await digestOf(sourceFiles))
  )
    throw new Error(
      "本地历史源已变化；保留旧数据集，请新建导入，不能在续传时混用输入",
    );
  const configuration =
    prior?.coverage.configuration ??
    options.configuration ??
    (await freezeResearchConfiguration(env));
  const calendarIssues = executionDates
    .filter((d) => !dataset.dateIdx.has(d))
    .map((date) => ({
      date,
      field: "dailyDate",
      reason: "交易日存在但全市场日线缺失",
    }));
  for (const date of executionDates)
    if (!localOpenDates.includes(date) && !upstreamDates.includes(date))
      calendarIssues.push({
        date,
        field: "tradingCalendar",
        reason: "只有股票日线，缺少独立交易日历日期交叉核对",
      });
  let coverage = {
    ...prior?.coverage,
    reconstructionVersion: V5_RECONSTRUCTION_VERSION,
    scoringVersion: V5_SCORING_VERSION,
    executionModel: "V5_RECONSTRUCTION_V1",
    configuration,
    sourceFiles,
    executionDates,
    signalDates,
    warmupDates,
    calendar: {
      source: "local-trade-calendar",
      dates: allDates.filter(
        (d) => d >= warmupDates[0] && d <= job.requestedRange.end,
      ),
      issues: calendarIssues,
    },
    tradingDates: allDates.filter(
      (d) => d >= warmupDates[0] && d <= job.requestedRange.end,
    ),
    metadataConfidence: {
      name: "CURRENT_SNAPSHOT_UNVERIFIED",
      industry: "CURRENT_SNAPSHOT_UNVERIFIED",
      delisting: "CURRENT_SNAPSHOT_UNVERIFIED",
      universe: "SURVIVORSHIP_NOT_VERIFIED",
    },
    adjustment: "raw OHLC + dated factors; indicators rebased to signal date",
    dailyCoverage: [],
    candidateCoverage: [],
    failedDates: [],
    observedStart: signalDates[0],
    observedEnd: signalDates.at(-1),
  };
  if (!datasetId) {
    datasetId = id("hds");
    if (!(await jobs.claimDataset(job.id, datasetId)))
      throw new Error("历史数据集已被认领");
    await store.createDatasetVersion({
      id: datasetId,
      provider: "local-fuyao-v5",
      kind: job.kind,
      executionModel: coverage.executionModel,
      requestedStart: job.requestedRange.start,
      requestedEnd: job.requestedRange.end,
      coverage,
    });
  }
  coverage.calendar.source =
    "LOCAL_CALENDAR_CROSSCHECKED_WITH_DAILY_AND_FUYAO_DATES";
  coverage.calendar.localCalendarThrough = localOpenDates.at(-1);
  coverage.calendar.upstreamThrough = calendarEvidence.latest_date ?? null;
  const owner = await store.acquireDatasetOwnership(
    datasetId,
    { executorId, round },
    job.id,
  );
  if (!owner?.granted) throw new Error("历史数据集所有权不可用");
  await jobs.progressJob(job.id, executorId, {
    stage: "DOWNLOADING",
    datasetId,
  });
  const poolDates = [allDates[firstIndex - 2], ...signalDates];
  const poolByDate = new Map(),
    done = await store.completedChunkKeys(job.id);
  if (!done.has("reference-metadata"))
    apply(
      await store.saveChunk(
        job.id,
        {
          chunkKey: "reference-metadata",
          datasetId,
          requestRange: `${job.requestedRange.start}..${job.requestedRange.end}`,
          rows: basics.length,
          stage: "DONE",
          raw: {
            calendarRows: calendarRows.map((r) => ({
              ...r,
              is_open: Number(r.is_open),
            })),
            calendarEvidence,
            basics,
            industries,
            sourceFiles,
          },
        },
        owner,
      ),
    );
  const providers = options.poolProviders ?? {
    main: getLimitUpPool,
    broken: getLimitBreakPool,
  };
  for (const date of [
    ...new Set([...warmupDates, ...signalDates, ...executionDates]),
  ].sort()) {
    await guard();
    if (!done.has(`daily:${date}`)) {
      const rows = rawDailyRows(dataset, date);
      apply(
        await store.saveDailyInputs(
          datasetId,
          date,
          {
            normalized: rows,
            provenance: {
              source: "LOCAL_DAILY_PARQUET",
              tradeDate: date,
              importedAt: job.createdAt,
              virtualDecisionAt: `${date}T07:10:00.000Z`,
              adjustment: coverage.adjustment,
            },
          },
          owner,
        ),
      );
      apply(
        await store.saveChunk(
          job.id,
          {
            chunkKey: `daily:${date}`,
            datasetId,
            requestRange: date,
            actualRange: rows.length ? date : null,
            rows: rows.length,
            stage: "DONE",
            raw: { date, rows },
          },
          owner,
        ),
      );
    }
    const stored = await store.getDailyInput(datasetId, date);
    const observedCodes = new Set(
      (stored?.normalized ?? []).map((r) => r.code),
    );
    const unverifiedAbsentCodes = basics
      .filter(
        (r) =>
          supported(r.code) &&
          r.list_date <= date &&
          !observedCodes.has(r.code),
      )
      .map((r) => r.code);
    coverage.dailyCoverage.push({
      date,
      rows: stored?.normalized.length ?? 0,
      role: signalDates.includes(date)
        ? "SIGNAL"
        : executionDates.includes(date)
          ? "EXECUTION"
          : "WARMUP",
      unverifiedAbsentCodes,
      note: "无当日日线且缺少时点停牌/退市证明的代码，不能直接当作停牌",
    });
  }
  for (const date of [...new Set(poolDates)].sort()) {
    await guard();
    const pools = {};
    for (const [kind, provider] of Object.entries(providers)) {
      const key = `pool:${kind}:${date}`;
      const refs = done.has(key) ? await store.datasetChunkRefs(datasetId) : [];
      const ref = refs.find((r) => r.chunkKey === key);
      try {
        if (ref) {
          pools[kind] = JSON.parse(
            fs.readFileSync(
              path.join(path.dirname(store.path), ref.artifactRef),
              "utf8",
            ),
          );
          if ((await digestOf(pools[kind])) !== ref.rawDigest)
            throw new Error("已下载历史名单摘要不一致");
        } else {
          pools[kind] = await fetchCompleteHistoricalPool(provider, date);
          apply(
            await store.saveChunk(
              job.id,
              {
                chunkKey: key,
                datasetId,
                requestRange: date,
                actualRange: date,
                rows: pools[kind].rows.length,
                stage: "DONE",
                raw: pools[kind],
              },
              owner,
            ),
          );
        }
      } catch (error) {
        coverage.failedDates.push({
          date,
          kind,
          reason: String(error.message),
        });
      }
    }
    poolByDate.set(date, pools);
    // Refresh lease and persist progress after each complete date for safe restart.
    if (
      !(await jobs.progressJob(job.id, executorId, {
        stage: "DOWNLOADING",
        datasetId,
      }))
    )
      throw new Error("历史执行器已被接管");
    options.onProgress?.({
      phase: "POOLS",
      date,
      done: poolByDate.size,
      total: poolDates.length,
    });
  }
  const missingCodes = new Set();
  for (const [date, pools] of poolByDate)
    for (const pool of Object.values(pools))
      for (const row of pool.rows) {
        const code = row.ticker ?? row.thscode?.slice(0, 6),
          series = dataset.codes.get(code),
          index = dataset.dateIdx.get(date);
        if (supported(code) && (!series || !series.dates.includes(index)))
          missingCodes.add(code);
      }
  coverage.historicalDailySupplement = {
    requestedCodes: [...missingCodes].sort(),
    succeeded: [],
    failed: [],
  };
  const supplemental = [];
  for (const code of [...missingCodes].sort()) {
    await guard();
    const key = `historical-daily:${code}`;
    try {
      const ref = (await store.datasetChunkRefs(datasetId)).find(
        (r) => r.chunkKey === key,
      );
      const raw = ref
        ? JSON.parse(
            fs.readFileSync(
              path.join(path.dirname(store.path), ref.artifactRef),
              "utf8",
            ),
          )
        : await fetchResearchDailyRecord(
            code,
            warmupDates[0],
            job.requestedRange.end,
            options.dailyProvider,
          );
      if (ref && (await digestOf(raw)) !== ref.rawDigest)
        throw new Error("历史日线原始块摘要不一致");
      const supplemented = withResearchDailyRecords(dataset, [raw.record]);
      if (!ref)
        apply(
          await store.saveChunk(
            job.id,
            {
              chunkKey: key,
              datasetId,
              requestRange: `${warmupDates[0]}..${job.requestedRange.end}`,
              actualRange: `${raw.record.raw[0].date}..${raw.record.asOf}`,
              rows: raw.record.raw.length,
              stage: "DONE",
              raw,
            },
            owner,
          ),
        );
      dataset = supplemented;
      supplemental.push(raw.record);
      coverage.historicalDailySupplement.succeeded.push(code);
    } catch (error) {
      coverage.historicalDailySupplement.failed.push({
        code,
        reason: String(error.message),
      });
    }
  }
  if (supplemental.length)
    coverage.historicalDailySupplement.note =
      "备用日线原始/前复权成对归档；按信号日切片计算，不补造缺失日期";
  await jobs.progressJob(job.id, executorId, { stage: "SCORING", datasetId });
  const paramsDigest = await digestOf({
    configuration,
    scoringVersion: V5_SCORING_VERSION,
  });
  let previousSnapshot = null;
  const existingScores = new Map(
    (await store.listScores(datasetId)).map((s) => [s.tradeDate, s]),
  );
  for (const date of signalDates) {
    await guard();
    const previousDate = allDates[allDates.indexOf(date) - 1];
    const result = reconstructV5Snapshot({
      date,
      previousDate,
      dataset,
      pools: poolByDate.get(date) ?? {},
      previousPools: poolByDate.get(previousDate),
      metadata,
      configuration,
      createdAt: job.createdAt,
    });
    result.snapshot.researchExitInputs.phaseShift = phaseShiftOf(
      result.snapshot.cycle?.phase,
      previousSnapshot?.cycle?.phase,
    );
    if (
      existingScores.has(date) &&
      existingScores.get(date).digest !== (await digestOf(result.snapshot))
    )
      throw new Error(
        "已保存评分输入发生变化，请新建版本，不能覆盖既有历史结果",
      );
    apply(
      await store.saveScore(
        datasetId,
        date,
        V5_SCORING_VERSION,
        paramsDigest,
        result.snapshot,
        owner,
      ),
    );
    coverage.candidateCoverage.push(result.candidateCoverage);
    previousSnapshot = result.snapshot;
    options.onProgress?.({
      phase: "SCORING",
      date,
      counts: result.candidateCoverage.counts,
    });
  }
  coverage.completedAt = new Date().toISOString();
  apply(await store.updateDatasetCoverage(datasetId, coverage, owner));
  return jobs.finishJob(job.id, executorId, {
    stage:
      coverage.failedDates.length ||
      coverage.candidateCoverage.some((d) => d.status !== "COMPLETE")
        ? "PARTIAL"
        : "READY",
    datasetId,
    statusPayload: {
      reason: "候选重构已归档；完整性与执行证据分别验收，不能视为收益回测",
      candidateDays: signalDates.length,
      failedDates: coverage.failedDates,
    },
  });
}
