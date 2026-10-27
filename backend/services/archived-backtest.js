import { digestOf } from "../domain/research-lineage.js";
import { newBook, createPlan } from "../domain/trading.js";
import {
  openSession,
  advanceSession,
  closeSession,
  marketClock,
} from "../domain/realtime.js";
import { INTRADAY_ENTRY_RULES } from "../domain/intraday-entry.js";
import { isDragon, isAdaptiveDragon } from "../domain/dragon-risk.js";
import {
  ADAPTIVE_RISK_POLICY,
  hasAdaptiveMarketEvidence,
} from "../../shared/adaptive-risk.js";
import {
  normalizeDragonConfig,
  DRAGON_REGIMES,
} from "../../shared/dragon-risk-config.js";
import {
  selectionPolicy,
  selectionSnapshotDigest,
} from "../domain/signal-selection.js";
import { verifyPolicyBundle } from "../storage/execution-cost.js";
import { executionEngineBuildDigest } from "../domain/execution-build.js";
import {
  extractTTrades,
  summarizeTQuality,
  buildTQualityEvidence,
  tQualityEnabledForSnapshot,
} from "../domain/t-quality.js";
import { BUY_POINT_TYPES } from "../../shared/buy-point-type.js";
import {
  ARCHIVED_OBSERVATIONS_MODEL,
  freezeResearchConfiguration,
  V5_RECONSTRUCTION_VERSION,
  V5_SCORING_VERSION,
} from "./v5-reconstruction.js";

const TYPES = Object.values(BUY_POINT_TYPES);
const AUCTION_TYPES = [
  BUY_POINT_TYPES.AUCTION_DIP,
  BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP,
];
const stamp = (date, time) => Date.parse(`${date}T${time}+08:00`);
const positive = (n) => Number.isFinite(n) && n > 0;
const ageOk = (time, now, age) =>
  Number.isFinite(Date.parse(time)) &&
  now >= Date.parse(time) &&
  now - Date.parse(time) <= age;
const during = (time) =>
  (time >= "09:30:00" && time <= "11:30:00") ||
  (time >= "13:00:00" && time < "14:57:00");

// Pure validator: the only price path accepted here is an original archived path.
export async function auditArchivedDay({
  date,
  snapshot,
  frames,
  plan,
  holdingCodes = [],
}) {
  const gaps = new Map();
  const add = (
    field,
    reason,
    { code = null, at = null, types = TYPES } = {},
  ) => {
    const key = `${code}:${field}`;
    const existing = gaps.get(key);
    if (existing) {
      existing.occurrences++;
      existing.lastAt = at;
      return;
    }
    gaps.set(key, {
      field,
      reason,
      code,
      firstAt: at,
      lastAt: at,
      occurrences: 1,
      types,
    });
  };
  const candidates = new Set([
    ...(plan?.entryExecutionPolicy?.candidates ?? []),
    ...holdingCodes,
  ]);
  for (const frame of frames)
    for (const discovery of frame.payload?.entryInputs?.market?.discoveries ??
      []) {
      if (snapshot?.intradayEntryContext?.history?.[discovery.code])
        candidates.add(discovery.code);
    }
  if (
    snapshot?.modelVersion !== V5_SCORING_VERSION ||
    snapshot?.reconstructionVersion !== V5_RECONSTRUCTION_VERSION
  )
    add("candidateVersion", "不是完整 V5 历史候选版本");
  if (snapshot?.candidateCoverage?.status !== "COMPLETE") {
    add("candidateCoverage", "候选输入完整性尚未通过");
    for (const issue of snapshot?.candidateCoverage?.issues ?? [])
      add(issue.field, issue.reason, { code: issue.code ?? null });
  }
  if (snapshot?.date >= date)
    add("signalDate", "必须由前一交易日信号生成执行计划");
  const sorted = frames; // Never sort, deduplicate, interpolate or fabricate a valid path.
  if (!sorted.length)
    add("archivedFrames", "缺少真实逐帧行情、盘口、竞价终态及同步市场输入");
  let lastSequence = null,
    lastAt = null,
    closingFrame = null;
  const times = [],
    quoteTimes = new Map();
  for (const frame of sorted) {
    const p = frame.payload,
      at = Date.parse(frame.observedAt),
      clock = Number.isFinite(at) ? marketClock(new Date(at)) : {};
    if (
      frame.tradeDate !== date ||
      clock.date !== date ||
      p?.observedAt !== frame.observedAt
    )
      add("frameDate", "行情帧日期或观测时间不一致", { at: frame.observedAt });
    if (
      !Number.isInteger(frame.sequence) ||
      frame.sequence < 1 ||
      (lastSequence !== null && frame.sequence !== lastSequence + 1)
    )
      add("sequence", "行情帧重复、倒序或缺号", { at: frame.observedAt });
    if (!Number.isFinite(at) || (lastAt !== null && at <= lastAt))
      add("observedAt", "行情帧观测时间重复或倒序", { at: frame.observedAt });
    if (
      frame.origin !== "REAL_QUOTE_ARCHIVE" ||
      (p?.observationQuality && p.observationQuality !== "realtime") ||
      !(p?.pollIntervalSeconds > 0 && p.pollIntervalSeconds <= 20)
    )
      add("frameOrigin", "分钟采样或来源不明的帧不能替代真实逐帧证据", {
        at: frame.observedAt,
      });
    if ((await digestOf(p)) !== frame.digest)
      add("frameDigest", "行情帧内容与原始摘要不一致", {
        at: frame.observedAt,
      });
    if (
      !p?.pool ||
      (await digestOf(p.pool)) !== p.poolDigest ||
      frame.poolDigest !== p.poolDigest
    )
      add("poolDigest", "行情股票池声明与摘要不一致", { at: frame.observedAt });
    if (p?.capture?.complete === false || p?.capture?.failedBatches?.length)
      add("capture", "联合行情采集批次不完整", { at: frame.observedAt });
    lastSequence = frame.sequence;
    lastAt = at;
    if (clock.time >= "15:00:00" && clock.time <= "15:05:00")
      closingFrame = frame;
    if (!during(clock.time)) continue;
    times.push(at);
    const market = p?.entryInputs?.market;
    if (
      !market ||
      market.date !== date ||
      !ageOk(
        market.observedAt,
        at,
        isAdaptiveDragon(plan)
          ? ADAPTIVE_RISK_POLICY.marketMaxAgeMs
          : INTRADAY_ENTRY_RULES.marketMaxAgeMs,
      ) ||
      (!isDragon(plan) &&
        (!Number.isFinite(market.emotion) ||
          !Number.isFinite(market.cycle?.maxGrossExposure))) ||
      (isDragon(plan) &&
        (isAdaptiveDragon(plan)
          ? !hasAdaptiveMarketEvidence(market)
          : !Object.hasOwn(DRAGON_REGIMES, market.cycle?.phase))) ||
      !Array.isArray(market.sectors) ||
      !Array.isArray(market.discoveries)
    )
      add("entryInputs.market", "缺少同步情绪、板块、周期或当时可见候选", {
        at: frame.observedAt,
      });
    // Only demand a dynamically discovered stock after its actual admission time.
    const visible = new Set([
      ...(plan?.entryExecutionPolicy?.candidates ?? []),
      ...holdingCodes,
    ]);
    for (const discovery of market?.discoveries ?? [])
      if (candidates.has(discovery.code)) visible.add(discovery.code);
    for (const code of candidates) {
      if (!visible.has(code) && !quoteTimes.has(code)) continue;
      const q = p?.quotes?.[code],
        history = snapshot?.intradayEntryContext?.history?.[code];
      if (!q) {
        add("quote", "候选或持仓缺少逐帧报价", { code, at: frame.observedAt });
        continue;
      }
      if (!(p.pool?.codes ?? []).includes(code))
        add("poolCodes", "报价不在归档股票池声明中", {
          code,
          at: frame.observedAt,
        });
      if (q.date !== date || !ageOk(q.timestamp, at, 15000))
        add("quote.timestamp", "报价缺失真实时间、跨日或过期", {
          code,
          at: frame.observedAt,
        });
      for (const field of [
        "closeCents",
        "previousCloseCents",
        "openCents",
        "highCents",
        "lowCents",
        "limitUpCents",
        "limitDownCents",
      ])
        if (!positive(q[field]))
          add(`quote.${field}`, "必要价格字段缺失", {
            code,
            at: frame.observedAt,
          });
      if (!Number.isFinite(q.volumeShares) || q.volumeShares < 0)
        add("quote.volumeShares", "累计成交量缺失", {
          code,
          at: frame.observedAt,
        });
      const prev = quoteTimes.get(code);
      if (
        prev &&
        during(clock.time) &&
        !(
          prev.time < stamp(date, "11:30:01") && at >= stamp(date, "13:00:00")
        ) &&
        at - prev.time > 20000
      )
        add("quote.gap", "逐股报价断流超过 20 秒", {
          code,
          at: frame.observedAt,
        });
      if (
        prev &&
        (Date.parse(q.timestamp) < prev.quoteAt || q.volumeShares < prev.volume)
      )
        add("quote.path", "报价时间倒序或累计量回退", {
          code,
          at: frame.observedAt,
        });
      quoteTimes.set(code, {
        time: at,
        quoteAt: Date.parse(q.timestamp),
        volume: q.volumeShares,
      });
      if (
        q.orderBookQuality !== "OK" ||
        !ageOk(q.orderBookTimestamp, at, 15000) ||
        !Number.isFinite(q.ask1Cents) ||
        !Number.isFinite(q.ask1Shares) ||
        !Number.isFinite(q.bid1Cents) ||
        !Number.isFinite(q.bid1Shares) ||
        q.ask1Cents < 0 ||
        q.ask1Shares < 0 ||
        q.bid1Cents < 0 ||
        q.bid1Shares < 0
      )
        add(
          "quote.orderBook",
          "缺少有效且同步的买卖盘口；零挂单只证明不可成交",
          { code, at: frame.observedAt },
        );
      if (
        history &&
        !(market?.sectors ?? []).some(
          (s) => s.name === history.sector && Number.isFinite(s.score),
        )
      )
        add("entryInputs.sector", "候选所属板块评分缺失", {
          code,
          at: frame.observedAt,
        });
      if (
        clock.time <= "10:00:00" &&
        history &&
        ["relay-leader", "strong-reversal"].includes(history.stockClass)
      ) {
        const auction = p.entryInputs?.auction?.[code];
        if (
          auction?.date !== date ||
          auction.final !== true ||
          auction.openCents !== q.openCents ||
          auction.previousCloseCents !== q.previousCloseCents
        )
          add(
            "entryInputs.auction",
            "缺少经当日报价核对的竞价终态；机会榜不能代替终态",
            { code, at: frame.observedAt, types: AUCTION_TYPES },
          );
      }
    }
  }
  for (const [start, end] of [
    ["09:30:00", "11:30:00"],
    ["13:00:00", "14:56:50"],
  ]) {
    const from = stamp(date, start),
      to = stamp(date, end),
      part = times.filter((t) => t >= from && t <= to);
    if (
      !part.length ||
      part[0] - from > 10000 ||
      to - part.at(-1) > 10000 ||
      part.some((t, i) => i && t - part[i - 1] > 20000)
    )
      add("sessionCoverage", `缺少 ${start}—${end} 的连续真实观测`);
  }
  if (!closingFrame)
    add("closingFrame", "缺少真实收盘帧，不能用最后一根分钟线盯市");
  else
    for (const code of candidates) {
      const q = closingFrame.payload.quotes?.[code];
      if (
        q?.date !== date ||
        !positive(q.closeCents) ||
        !ageOk(q.timestamp, stamp(date, "15:05:00"), 5 * 60000)
      )
        add("closingQuote", "缺少该股真实收盘报价", { code });
    }
  const missing = [...gaps.values()];
  return {
    date,
    signalDate: snapshot?.date ?? null,
    candidateCoverage: snapshot?.candidateCoverage ?? null,
    status: missing.length ? "UNVERIFIABLE" : "VERIFIABLE",
    frameCount: frames.length,
    codes: [...candidates].sort(),
    gaps: missing,
    buyPoints: Object.fromEntries(
      TYPES.map((type) => [
        type,
        missing.some((g) => g.types.includes(type))
          ? "UNVERIFIABLE"
          : "VERIFIABLE",
      ]),
    ),
    closingFrame,
  };
}

export function researchSnapshotView(snapshot) {
  // Explicit virtual research clock. The source record retains its actual import time.
  return {
    ...snapshot,
    importedAt: snapshot.createdAt,
    createdAt: snapshot.decisionAt,
    researchOnly: true,
  };
}
function initialResearchBook(configuration, firstSignalDate) {
  if (isDragon(configuration))
    return {
      ...newBook(configuration.initialCapital, configuration.fees),
      tradingPolicyVersion: configuration.tradingPolicyVersion,
      dragonConfig: normalizeDragonConfig(configuration.dragonConfig),
      dragonConfigId: configuration.dragonConfigId,
      dragonConfigDigest: configuration.dragonConfigDigest,
      dragonEngineBuild: configuration.dragonEngineBuild,
      feeModel: configuration.feeModel,
      feeConfigVersion: configuration.feeConfigVersion,
      lastDate: firstSignalDate,
      entryExecutionMode: "intraday-conditional",
      selectionPolicyVersion: configuration.selectionPolicyVersion,
    };
  return {
    ...newBook(configuration.initialCapital, configuration.fees),
    feeConfigVersion: configuration.feeConfigVersion ?? 1,
    riskLimitsVersion: configuration.riskLimitsVersion ?? 1,
    riskLimits: structuredClone(configuration.riskLimits),
    lastDate: firstSignalDate,
    entryExecutionMode: "intraday-conditional",
    selectionPolicyVersion: "signal-ranking-v5",
  };
}

// Evaluates in memory first. Nothing resembling P&L is published on a blocked interval.
export async function evaluateArchivedInterval(
  store,
  dataset,
  configuration,
  runId,
) {
  const scores = await store.listScores(dataset.id),
    byDate = new Map(scores.map((s) => [s.tradeDate, s.payload]));
  const dates = dataset.coverage.executionDates ?? [],
    signals = dataset.coverage.signalDates ?? [];
  const days = [],
    artifacts = [],
    ledger = [],
    equity = [],
    plans = [],
    tDates = [],
    scoreHistory = new Map();
  const globalGaps = [];
  if (!dates.length || dates.length !== signals.length)
    globalGaps.push({
      field: "calendar",
      reason: "缺少完整执行日及前一交易日配对",
    });
  const warmup = dataset.coverage.warmupDates ?? [];
  if (
    new Set(warmup).size < 21 ||
    warmup.some(
      (d, i) =>
        d >= signals[0] ||
        (i > 0 && d <= warmup[i - 1]) ||
        !(dataset.coverage.tradingDates ?? []).includes(d),
    )
  )
    globalGaps.push({
      field: "warmup",
      reason: "不足 21 个按序、已确认且早于信号日的交易日预热",
    });
  for (const issue of dataset.coverage.calendar?.issues ?? [])
    globalGaps.push(issue);
  let book = initialResearchBook(configuration, signals[0]),
    blocked = false;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i],
      signalDate = signals[i],
      original = byDate.get(signalDate);
    const snapshot = original ? researchSnapshotView(original) : null;
    const dayGaps = [];
    const calendar = dataset.coverage.tradingDates ?? [];
    if (
      calendar.indexOf(date) < 1 ||
      calendar[calendar.indexOf(date) - 1] !== signalDate
    )
      dayGaps.push({
        field: "calendarAdjacency",
        reason: "信号日不是执行日的前一交易日",
      });
    if (!snapshot)
      dayGaps.push({ field: "snapshot", reason: "缺少前一交易日 V5 候选快照" });
    const frames = await store.listArchivedFrames(dataset.id, date);
    let plan = null;
    if (snapshot)
      try {
        for (const row of [
          ...snapshot.stocks,
          ...(snapshot.brokenStocks ?? []),
          ...(snapshot.extraStocks ?? []),
        ])
          if (Number.isFinite(row.score)) scoreHistory.set(row.code, row.score);
        const records = extractTTrades(ledger).records;
        plan = createPlan(
          snapshot,
          { ...book, lastDate: signalDate },
          configuration.strategy,
          configuration.activeStrategy,
          `${signalDate}T07:15:00.000Z`,
          {
            executionCostPolicy: configuration.executionCostPolicy,
            selectionPolicy: selectionPolicy(
              configuration.selectionPolicyVersion ?? "signal-ranking-v5",
            ),
            snapshotDigest: await selectionSnapshotDigest(snapshot),
            exitContextFrozen: snapshot.researchExitInputs,
            originalScoreLookup: (code) => scoreHistory.get(code) ?? null,
            ...(tQualityEnabledForSnapshot(snapshot)
              ? {
                  tQuality: summarizeTQuality(records, {
                    signalDate,
                    tradingDates: tDates,
                  }),
                  tQualityEvidence: buildTQualityEvidence(records, tDates),
                }
              : {}),
          },
        );
      } catch (error) {
        dayGaps.push({ field: "plan", reason: String(error.message) });
      }
    const audit = await auditArchivedDay({
      date,
      snapshot,
      frames,
      plan,
      holdingCodes: book.positions.map((p) => p.code),
    });
    delete audit.closingFrame;
    audit.gaps.push(...dayGaps.map((g) => ({ ...g, types: TYPES })));
    if (audit.gaps.length || globalGaps.length) {
      audit.status = "UNVERIFIABLE";
      blocked = true;
      if (dayGaps.length || globalGaps.length)
        audit.buyPoints = Object.fromEntries(
          TYPES.map((type) => [type, "UNVERIFIABLE"]),
        );
    }
    days.push(audit);
    if (blocked || !plan) continue;
    try {
      book.lastDate = signalDate;
      let session = openSession(book, plan, date);
      const dayLedger = [];
      for (const frame of frames) {
        if (!during(marketClock(new Date(frame.observedAt)).time)) continue;
        const result = advanceSession(book, session, {
          ...frame.payload,
          frameSequence: frame.sequence,
          frameDigest: frame.digest,
        });
        book = result.book;
        session = result.session;
        dayLedger.push(...result.ledger);
      }
      const closing = frames
        .filter((f) => marketClock(new Date(f.observedAt)).time >= "15:00:00")
        .at(-1);
      const closed = closeSession(book, session, {
        date,
        // The legacy close kernel compares Shanghai clock strings. Convert the
        // representation only; the archived event instant and payload stay intact.
        quotes: Object.fromEntries(
          Object.entries(closing.payload.quotes).map(([code, q]) => [
            code,
            {
              ...q,
              timestamp:
                new Date(Date.parse(q.timestamp) + 8 * 3600000)
                  .toISOString()
                  .slice(0, -1) + "+08:00",
            },
          ]),
        ),
        source: "历史真实归档行情严格回放",
      });
      if (closed.notices.length) throw new Error(closed.notices.join("；"));
      book = closed.book;
      plans.push(plan);
      ledger.push(...dayLedger);
      equity.push({ tradeDate: date, ...closed.equity });
      tDates.push(date);
      audit.buyPoints = Object.fromEntries(
        TYPES.map((type) => [
          type,
          dayLedger.some((r) => r.buyPoint === type)
            ? "TRIGGERED"
            : "VERIFIED_NO_TRIGGER",
        ]),
      );
      artifacts.push({ date, plan, ledger: dayLedger, equity: equity.at(-1) });
    } catch (error) {
      blocked = true;
      audit.status = "UNVERIFIABLE";
      audit.gaps.push({
        field: "execution",
        reason: String(error.message),
        types: TYPES,
      });
    }
  }
  const isBlocked = blocked || !!globalGaps.length || !dates.length;
  // Do not expose even an initial, partial trajectory when any required day fails.
  return {
    blocked: isBlocked,
    days,
    globalGaps,
    ...(isBlocked
      ? { plans: [], ledger: [], equity: [], artifacts: [], book: null }
      : { plans, ledger, equity, artifacts, book }),
  };
}

export async function runArchivedBacktest(
  env,
  store,
  dataset,
  {
    name,
    strategy,
    fees,
    initialCapital,
    selectionPolicyVersion,
    executionCostPolicy,
  } = {},
) {
  if (
    strategy ||
    fees ||
    executionCostPolicy ||
    (initialCapital !== undefined && initialCapital !== 1000000) ||
    (selectionPolicyVersion && selectionPolicyVersion !== "signal-ranking-v5")
  )
    throw new Error(
      "严格回放固定当前主账户配置、V5、100 万空仓；本轮不接受调参",
    );
  if (!dataset.coverage.reconstructionVersion)
    throw new Error("严格回放需要 V5 历史候选重构数据集");
  const configuration = await freezeResearchConfiguration(env);
  if (
    (await digestOf(
      configuration.sourceWeights ?? configuration.strategy?.weights,
    )) !==
      (await digestOf(
        dataset.coverage.configuration?.sourceWeights ??
          dataset.coverage.configuration?.strategy?.weights,
      )) ||
    (await digestOf(configuration.buyPointParams)) !==
      (await digestOf(dataset.coverage.configuration?.buyPointParams))
  )
    throw new Error("当前评分配置与候选重构配置不同，请创建新数据集");
  if (!(await verifyPolicyBundle(configuration.executionCostPolicy)))
    throw new Error("成交成本政策摘要不一致");
  const runId = `bt-${crypto.randomUUID()}`,
    engineDigest = await executionEngineBuildDigest();
  const book = initialResearchBook(
    configuration,
    dataset.coverage.signalDates?.[0],
  );
  const initialBook = {
    ...book,
    configuration,
    datasetManifestDigest: dataset.manifestDigest,
    engineDigest,
    researchOnly: true,
  };
  await store.createBacktestRun({
    id: runId,
    datasetId: dataset.id,
    name: name ?? "V5 六类严格回放",
    strategyVersion: configuration.activeStrategy,
    strategyParams: isDragon(configuration)
      ? configuration.dragonConfig
      : configuration.strategy,
    paramsDigest: await digestOf(
      isDragon(configuration)
        ? configuration.dragonConfig
        : configuration.strategy,
    ),
    feeConfig: configuration.fees,
    feeDigest: await digestOf(configuration.fees),
    executionModel: ARCHIVED_OBSERVATIONS_MODEL,
    executionVersion: `archived-observations-v1+${engineDigest}`,
    initialBook,
  });
  let result;
  try {
    result = await evaluateArchivedInterval(
      store,
      dataset,
      configuration,
      runId,
    );
  } catch (error) {
    return store.finishBacktestRun(runId, "BLOCKED", {
      executionModel: ARCHIVED_OBSERVATIONS_MODEL,
      totalReturn: null,
      maxDrawdown: null,
      equity: [],
      fillCount: 0,
      globalGaps: [{ field: "preflight", reason: String(error.message) }],
      researchOnly: true,
    });
  }
  const coverage = {
    executionModel: ARCHIVED_OBSERVATIONS_MODEL,
    researchOnly: true,
    primaryShadowQualification: false,
    requestedRange: dataset.requestedRange,
    selectionPolicyVersion: configuration.selectionPolicyVersion,
    tradingPolicyVersion: configuration.tradingPolicyVersion ?? "legacy",
    entryExecutionMode: "intraday-conditional",
    datasetManifestDigest: dataset.manifestDigest,
    engineDigest,
    initialBookDigest: await digestOf(initialBook),
    days: result.days,
    globalGaps: result.globalGaps,
    totalReturn: null,
    maxDrawdown: null,
    equity: [],
    fillCount: 0,
    feesCents: null,
    notes: [
      "缺证据阻断整段收益；不使用五分钟线补造路径",
      "历史重构不构成主账户真实影子验证",
    ],
  };
  if (!result.blocked) {
    for (const a of result.artifacts) {
      await store.saveBacktestPlan(runId, a.plan.signalDate, a.plan);
      await store.appendBacktestLedger(runId, a.date, a.ledger);
      await store.saveBacktestEquity(runId, a.date, a.equity);
    }
    Object.assign(coverage, {
      totalReturn: result.book.equityCents / result.book.initialCashCents - 1,
      maxDrawdown: Math.max(0, ...result.equity.map((e) => e.drawdown)),
      equity: result.equity,
      fillCount: result.ledger.length,
      feesCents: result.book.feesCents,
      resultDigest: await executionResultDigest(result),
    });
  }
  return store.finishBacktestRun(
    runId,
    result.blocked ? "BLOCKED" : "READY",
    coverage,
  );
}

export async function archivedBacktestDetail(store, run) {
  const [plans, ledger, equity, dataset, integrity] = await Promise.all([
    store.listBacktestPlans(run.id),
    store.listBacktestLedger(run.id),
    store.listBacktestEquity(run.id),
    store.getDataset(run.datasetId),
    store.datasetIntegrity(run.datasetId),
  ]);
  const issues = [];
  if (
    !integrity?.verified ||
    dataset?.manifestDigest !== run.initialBook.datasetManifestDigest
  )
    issues.push("数据集摘要或内容不一致");
  if ((await digestOf(run.coverage)) !== run.digest)
    issues.push("回放报告摘要不一致");
  if ((await digestOf(run.initialBook)) !== run.coverage.initialBookDigest)
    issues.push("初始账本或冻结配置被修改");
  if (run.initialBook.engineDigest !== (await executionEngineBuildDigest()))
    issues.push("执行内核已变化，请创建新回放");
  if (
    (await digestOf(
      isDragon(run.initialBook.configuration)
        ? run.initialBook.configuration.dragonConfig
        : run.initialBook.configuration.strategy,
    )) !== run.paramsDigest ||
    (await digestOf(run.initialBook.configuration.fees)) !== run.feeDigest ||
    !(await verifyPolicyBundle(
      run.initialBook.configuration.executionCostPolicy,
    ))
  )
    issues.push("冻结配置摘要不一致");
  if (run.stage === "BLOCKED") {
    if (
      plans.length ||
      ledger.length ||
      equity.length ||
      run.coverage.totalReturn !== null ||
      run.coverage.equity?.length
    )
      issues.push("阻断结果含有不应发布的收益或成交");
    if (integrity?.verified) {
      const replay = await evaluateArchivedInterval(
        store,
        dataset,
        run.initialBook.configuration,
        run.id,
      );
      if (!replay.blocked) issues.push("当前证据不支持阻断声明");
    }
  } else if (integrity?.verified) {
    const replay = await evaluateArchivedInterval(
      store,
      dataset,
      run.initialBook.configuration,
      run.id,
    );
    if (
      replay.blocked ||
      (await executionResultDigest(replay)) !== run.coverage.resultDigest
    )
      issues.push("从原始帧重新执行的结果不一致");
    const clean = (rows) => rows.map(({ digest, ...payload }) => payload);
    if (
      (await executionResultDigest({
        plans: clean(plans),
        ledger: ledger.map(({ tradeDate, ...row }) => row),
        equity: clean(equity),
      })) !== run.coverage.resultDigest
    )
      issues.push("已保存计划、账本或净值与执行结果不一致");
  }
  return {
    run,
    plans,
    ledger,
    equity,
    verification: {
      verified: issues.length === 0,
      issues,
      totalReturn: run.coverage.totalReturn,
      researchOnly: true,
    },
  };
}
async function executionResultDigest({ plans, ledger, equity }) {
  return digestOf({
    plans,
    ledger: [...ledger].sort(
      (a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence,
    ),
    equity,
  });
}
