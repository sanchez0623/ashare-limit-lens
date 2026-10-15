import {
  BASE_STRATEGY,
  createPlan,
  newBook,
  totalQuantity,
} from "../domain/trading.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../domain/realtime.js";
import { DEFAULT_FEES, normalizeFees } from "../../shared/fees.js";
import {
  defaultExecutionCostPolicy,
  normalizeExecutionCostPolicy,
} from "../../shared/execution-cost.js";
import { verifyPolicyBundle } from "../storage/execution-cost.js";
import { digestOf } from "../domain/research-lineage.js";
import {
  selectionPolicy as policyForVersion,
  selectionPolicyForBook,
  selectionPolicyFields,
  selectionSnapshotDigest,
  selectionPolicyDigest,
  frozenSelectionPolicy,
} from "../domain/signal-selection.js";
import {
  HISTORICAL_EXECUTION_MODEL,
  HISTORICAL_EXECUTION_VERSION,
  assertCausalObservations,
} from "../domain/historical-execution.js";
import {
  isAdjacentTradingDay,
  tradingAdjacency,
} from "../domain/historical-input.js";
import { openHistoryStore } from "../storage/history.js";
import {
  getStockFeaturesByCode,
  getExitEodRowsByCode,
} from "./daily-closes.js";
import {
  phaseShiftOf,
  sectorDropsOf,
  exitBreaksFromBrokenRows,
} from "./exit-context.js";

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}
function buildQuoteTemplates({ book, snapshot }) {
  const templates = {};
  for (const position of book.positions) {
    templates[position.code] = {
      date: null,
      name: position.name,
      previousCloseCents: position.markCents,
      openCents: null,
      limitUpCents: Math.round(position.markCents * 1.1),
      limitDownCents: Math.round(position.markCents * 0.9),
      volumeShares: 0,
    };
  }
  for (const stock of snapshot.stocks ?? []) {
    if (templates[stock.code] || stock.price === null) continue;
    const previousCloseCents = Math.round(stock.price * 100);
    templates[stock.code] = {
      date: null,
      name: stock.name,
      previousCloseCents,
      openCents: null,
      limitUpCents: Math.round(previousCloseCents * 1.1),
      limitDownCents: Math.round(previousCloseCents * 0.9),
      volumeShares: 0,
    };
  }
  return templates;
}
function inSessionTime(time) {
  return (
    (time >= "09:30" && time <= "11:30") || (time >= "13:00" && time < "14:57")
  );
}
function buildTimeline(minuteByCode) {
  const times = new Set();
  for (const series of Object.values(minuteByCode))
    for (const bar of series.bars ?? []) times.add(bar.time);
  return [...times].filter(inSessionTime).sort();
}
function observationsForDay({ date, minuteByCode, templates }) {
  const timeline = buildTimeline(minuteByCode);
  const observations = [];
  const cumulative = Object.fromEntries(
    Object.keys(templates).map((code) => [code, 0]),
  );
  for (const time of timeline) {
    const quotes = {};
    for (const [code, series] of Object.entries(minuteByCode)) {
      const template = templates[code];
      if (!template) continue;
      const bar = (series.bars ?? []).find((bar) => bar.time === time);
      if (!bar) continue;
      cumulative[code] += Math.max(0, Math.round(bar.volumeShares));
      quotes[code] = {
        ...template,
        date,
        closeCents: bar.priceCents,
        volumeShares: cumulative[code],
        timestamp: `${date}T${time}:00+08:00`,
      };
    }
    if (!Object.keys(quotes).length) continue;
    observations.push({
      observedAt: new Date(`${date}T${time}:00+08:00`).toISOString(),
      pollIntervalSeconds: 60,
      // 分钟采样重放必须声明采样质量：残余成本按 minuteQualityMultiplier
      // 计，不得冒充实时轮询精度（§3.1/§4.5）。
      observationQuality: "minute",
      quotes,
    });
  }
  return observations;
}
function endOfDayQuotes({ date, minuteByCode, templates }) {
  const quotes = {};
  const sampledCloseTimes = {};
  for (const [code, series] of Object.entries(minuteByCode)) {
    const template = templates[code];
    const bars = series.bars ?? [];
    const last = bars.at(-1);
    if (!template || !last) continue;
    sampledCloseTimes[code] = last.time;
    quotes[code] = {
      ...template,
      date,
      closeCents: last.priceCents,
      volumeShares: last.volumeShares,
      timestamp: `${date}T15:00:00+08:00`,
      sampledCloseTime: last.time,
      sampledCloseNote:
        last.time === "15:00"
          ? null
          : `收盘价以采样末端 ${last.time} 近似（采样未覆盖收盘时段）`,
    };
  }
  return { quotes, sampledCloseTimes };
}
export async function runBacktest(
  env,
  {
    datasetId,
    name,
    strategy,
    initialCapital,
    weights,
    fees,
    executionCostPolicy,
    selectionPolicyVersion,
  },
) {
  const store = openHistoryStore(env);
  if (!store)
    throw new Error(
      "历史研究存储仅本机可用：请配置 LOCAL_RESEARCH_DB_PATH 后在本机常驻实例运行回测",
    );
  const integrity = await store.datasetIntegrity(datasetId);
  if (integrity && !integrity.verified)
    throw new Error(
      `历史数据集 manifest 校验失败：${(integrity.issues ?? []).join("；")}；拒绝用于回测`,
    );
  const dataset = await store.getDataset(datasetId);
  if (!dataset) throw new Error("历史数据集不存在");
  if (dataset.executionModel !== "SIX_FACTOR_V1")
    throw new Error("回测需要六因子历史评分数据集（SIX_FACTOR_V1）");
  const strategyParams = strategy ?? BASE_STRATEGY;
  const feeConfig = fees ? normalizeFees(fees) : DEFAULT_FEES;
  // 冻结成本政策（§4.3/§5.4）：整个回测批次使用同一政策，与费用分开记录；
  // 缺省为 TIME_LIQUIDITY_V1 默认政策，不再默认全时段 10bps。
  const policyBundle = executionCostPolicy
    ? normalizeExecutionCostPolicy(executionCostPolicy)
    : defaultExecutionCostPolicy();
  if (!(await verifyPolicyBundle(policyBundle)))
    throw new Error("回测成本政策与摘要不一致，拒绝用于回测");
  const runId = newId("bt");
  let book = newBook(initialCapital ?? 1000000, feeConfig);
  const selectionPolicy =
    selectionPolicyVersion === undefined
      ? selectionPolicyForBook(book)
      : policyForVersion(selectionPolicyVersion);
  book.selectionPolicyVersion = selectionPolicy.version;
  const paramsDigest = await digestOf(strategyParams);
  const feeDigest = await digestOf(feeConfig);
  await store.createBacktestRun({
    id: runId,
    datasetId,
    name: name ?? "历史回测",
    strategyVersion: dataset.id,
    strategyParams,
    paramsDigest,
    feeConfig,
    feeDigest,
    executionModel: HISTORICAL_EXECUTION_MODEL,
    executionVersion: `${HISTORICAL_EXECUTION_VERSION}+${policyBundle.modelVersion.toLowerCase()}`,
    initialBook: {
      initialCashCents: book.initialCashCents,
      executionCostPolicy: policyBundle,
      ...selectionPolicyFields(selectionPolicy),
    },
  });
  try {
    return await runBacktestInner(env, store, runId, dataset, {
      strategyParams,
      feeConfig,
      book,
      policyBundle,
      selectionPolicy,
    });
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 300);
    await store.finishBacktestRun(runId, "FAILED", {
      executionModel: HISTORICAL_EXECUTION_MODEL,
      error: reason,
      note: "回测过程发生未预期错误（如持仓缺少收盘报价），任务记录为 FAILED；可修正数据后重试",
    });
    throw error;
  }
}
async function runBacktestInner(
  env,
  store,
  runId,
  dataset,
  { strategyParams, feeConfig, book, policyBundle, selectionPolicy },
) {
  const datasetId = dataset.id;
  const scores = await store.listScores(datasetId);
  const minuteDates = new Set(await store.listMinuteDates(datasetId));
  const adjacency = tradingAdjacency(dataset.coverage);
  const tradingDates = adjacency.tradingDates;
  const coverage = {
    ...selectionPolicyFields(selectionPolicy),
    executionModel: HISTORICAL_EXECUTION_MODEL,
    plannedPairs: 0,
    executedPairs: 0,
    skippedPairs: [],
    equity: [],
    totalReturn: null,
    maxDrawdown: null,
    fillCount: 0,
    feesCents: null,
    executionCostPolicy: policyBundle
      ? {
          modelVersion: policyBundle.modelVersion,
          payloadDigest: policyBundle.payloadDigest,
        }
      : null,
    notes: [
      "研究回测：MINUTE_SAMPLE_V1 采样价模型，涨跌停边界按上一收盘 ±10% 近似；不含可成交性保证，不代表可执行策略收益",
      `执行成本：${policyBundle.modelVersion} 政策 v${policyBundle.version}（摘要 ${policyBundle.payloadDigest.slice(0, 12)}）；分钟采样按声明倍数计残余成本，不代表实时滑点测量`,
    ],
  };
  if (!tradingDates.length)
    coverage.notes.push(
      "数据集未记录完整交易日历（旧版本），邻接检查退化为成功日期序列；建议重新导入以启用严格日历邻接",
    );
  // 原始分跨日回查：逐日累积已见评分，持仓掉出当日评分池时取最近一次入池评分。
  const scoreHistory = new Map();
  for (let index = 0; index + 1 < scores.length; index++) {
    const signal = scores[index];
    const signalDate = signal.tradeDate;
    const tradeDate = scores[index + 1].tradeDate;
    coverage.plannedPairs++;
    if (!isAdjacentTradingDay(adjacency, signalDate, tradeDate)) {
      coverage.skippedPairs.push({
        signalDate,
        tradeDate,
        reason: "评分日与执行日之间有缺失交易日，不跨缺失日配对执行",
      });
      continue;
    }
    if (!minuteDates.has(tradeDate)) {
      coverage.skippedPairs.push({
        signalDate,
        tradeDate,
        reason: "缺少次日分钟采样数据",
      });
      continue;
    }
    const snapshot = signal.payload;
    for (const stock of snapshot?.stocks ?? []) {
      if (stock?.score == null) continue;
      const score = Number(stock.score);
      if (Number.isFinite(score)) scoreHistory.set(stock.code, score);
    }
    let plan;
    try {
      // 方案 5 卖出上下文：回测与主账户/影子共用同一构建口径。历史重构
      // payload 无昨日涨停池原始行 → 用上一评分日规范化 stocks 转换为
      // 昨日池形状；无炸板池归档 → 出池持仓炸板信号保持未知（不猜）。
      // QUAN_DATA_DIR 未配置或未覆盖信号日时特征/EOD 为空，信号跳过。
      const previousPayload = index > 0 ? scores[index - 1].payload : null;
      const [featuresResult, eodResult] = await Promise.all([
        getStockFeaturesByCode(env, signalDate),
        getExitEodRowsByCode(env, signalDate),
      ]);
      const exitContext = {
        exitFeaturesByCode: featuresResult.featuresByCode,
        exitEodRowsByCode: eodResult.rowsByCode,
        exitBreaksByCode: exitBreaksFromBrokenRows(
          snapshot?.market?.brokenRows,
        ),
        sectorLimitDrops: sectorDropsOf(
          snapshot?.stocks,
          previousPayload?.stocks?.map((stock) => ({
            hybk: stock.sector,
            ylbc: stock.height,
          })) ?? [],
        ),
        phaseShift: phaseShiftOf(
          snapshot?.cycle ?? snapshot?.marketSummary?.cycle?.phase ?? null,
          previousPayload?.cycle ??
            previousPayload?.marketSummary?.cycle?.phase ??
            null,
        ),
      };
      plan = createPlan(
        snapshot,
        book,
        strategyParams,
        `backtest-${runId}`,
        `${signalDate}T07:10:00.000Z`,
        {
          executionCostPolicy: policyBundle,
          originalScoreLookup: (code) => scoreHistory.get(code) ?? null,
          selectionPolicy,
          snapshotDigest: await selectionSnapshotDigest(snapshot),
          ...exitContext,
        },
      );
    } catch (error) {
      coverage.skippedPairs.push({
        signalDate,
        tradeDate,
        reason: `计划生成失败：${String(error.message ?? error).slice(0, 120)}`,
      });
      continue;
    }
    await store.saveBacktestPlan(runId, signalDate, plan);
    const minuteByCode = await store.listMinuteInputs(datasetId, tradeDate);
    const templates = buildQuoteTemplates({ book, snapshot });
    const observations = observationsForDay({
      date: tradeDate,
      minuteByCode,
      templates,
    });
    if (!observations.length) {
      coverage.skippedPairs.push({
        signalDate,
        tradeDate,
        reason: "分钟采样未产生有效观测",
      });
      continue;
    }
    assertCausalObservations(observations);
    let session;
    try {
      session = openSession({ ...book, lastDate: signalDate }, plan, tradeDate);
    } catch (error) {
      coverage.skippedPairs.push({
        signalDate,
        tradeDate,
        reason: `会话开启失败：${String(error.message ?? error).slice(0, 120)}`,
      });
      continue;
    }
    const dayLedger = [];
    for (const observation of observations) {
      const result = advanceSession(book, session, observation);
      book = result.book;
      session = result.session;
      dayLedger.push(
        ...result.ledger.map((row, offset) => ({
          ...row,
          id: row.id ?? `${tradeDate}:${observation.observedAt}:${offset}`,
        })),
      );
    }
    const { quotes: eodQuotes, sampledCloseTimes } = endOfDayQuotes({
      date: tradeDate,
      minuteByCode,
      templates,
    });
    const closed = closeSession(book, session, {
      date: tradeDate,
      quotes: eodQuotes,
      source: "历史研究（采样收盘）",
    });
    book = closed.book;
    coverage.executedPairs++;
    if (dayLedger.length)
      await store.appendBacktestLedger(runId, tradeDate, dayLedger);
    const drawdown = book.peakEquityCents
      ? 1 - book.equityCents / book.peakEquityCents
      : 0;
    const sampledCloseIncomplete = Object.values(sampledCloseTimes).some(
      (time) => time !== "15:00",
    );
    if (sampledCloseIncomplete) {
      coverage.sampledCloseIncomplete = true;
      coverage.notes.push(
        `${tradeDate} 收盘价以分钟采样末端 ${Object.entries(sampledCloseTimes)
          .filter(([, time]) => time !== "15:00")
          .map(([code, time]) => `${code}@${time}`)
          .join("、")} 近似，未覆盖真实收盘时段`,
      );
    }
    const equityRow = {
      tradeDate,
      equityCents: book.equityCents,
      cashCents: book.cashCents,
      drawdown,
      positions: book.positions.length,
      sharesByCode: Object.fromEntries(
        book.positions.map((position) => [
          position.code,
          totalQuantity(position),
        ]),
      ),
      sampledCloseTimes,
    };
    coverage.equity.push(equityRow);
    await store.saveBacktestEquity(runId, tradeDate, equityRow);
  }
  coverage.totalReturn = book.equityCents / book.initialCashCents - 1;
  coverage.maxDrawdown = Math.max(
    0,
    ...coverage.equity.map((row) => row.drawdown),
  );
  const ledgerRows = await store.listBacktestLedger(runId);
  coverage.fillCount = ledgerRows.length;
  coverage.feesCents = book.feesCents;
  const stage =
    coverage.executedPairs > 0 &&
    coverage.skippedPairs.length === 0 &&
    !coverage.sampledCloseIncomplete
      ? "READY"
      : "PARTIAL";
  const run = await store.finishBacktestRun(runId, stage, coverage);
  return run;
}
export async function backtestDetail(env, runId) {
  const store = openHistoryStore(env);
  if (!store)
    throw new Error(
      "历史研究存储仅本机可用：请配置 LOCAL_RESEARCH_DB_PATH 后在本机常驻实例查看回测",
    );
  const run = await store.getBacktestRun(runId);
  if (!run) return null;
  const [plans, ledger, equity] = await Promise.all([
    store.listBacktestPlans(runId),
    store.listBacktestLedger(runId),
    store.listBacktestEquity(runId),
  ]);
  let selectionMatches = true;
  try {
    const policyDigest = selectionPolicyDigest(
      frozenSelectionPolicy(run.initialBook),
    );
    for (const row of plans) {
      const { digest: storedDigest, ...payload } = row;
      if (
        selectionPolicyDigest(frozenSelectionPolicy(payload)) !==
          policyDigest ||
        (await digestOf(payload)) !== storedDigest
      )
        selectionMatches = false;
    }
  } catch {
    selectionMatches = false;
  }
  const recomputedTotalReturn =
    equity.length && run.initialBook?.initialCashCents
      ? equity.at(-1).equityCents / run.initialBook.initialCashCents - 1
      : null;
  const ledgerCountMatches = ledger.length === (run.coverage?.fillCount ?? -1);
  const cashIssues = [];
  if (run.initialBook?.initialCashCents) {
    let replayCashCents = run.initialBook.initialCashCents;
    const ledgerByDate = new Map();
    for (const row of ledger) {
      const recomputedDelta =
        row.side === "BUY"
          ? -(row.quantity * row.priceCents) - row.feeCents
          : row.quantity * row.priceCents - row.feeCents;
      if (recomputedDelta !== row.cashDeltaCents)
        cashIssues.push(
          `${row.tradeDate} ${row.code} ${row.side} 现金变动 ${row.cashDeltaCents} 与数量×价格×费用重算值 ${recomputedDelta} 不一致`,
        );
      if (!ledgerByDate.has(row.tradeDate)) ledgerByDate.set(row.tradeDate, []);
      ledgerByDate.get(row.tradeDate).push(row);
      replayCashCents += recomputedDelta;
    }
    for (const equityRow of equity) {
      const dayRows = ledgerByDate.get(equityRow.tradeDate) ?? [];
      if (dayRows.length) {
        const lastAfter = dayRows.at(-1).cashAfterCents;
        if (lastAfter !== equityRow.cashCents)
          cashIssues.push(
            `${equityRow.tradeDate} 权益记录现金 ${equityRow.cashCents} 与账本末笔现金 ${lastAfter} 不一致`,
          );
      } else if (equityRow.cashCents !== replayCashCents) {
        cashIssues.push(
          `${equityRow.tradeDate} 无成交日现金 ${equityRow.cashCents} 与重放现金 ${replayCashCents} 不一致`,
        );
      }
    }
    if (equity.length && replayCashCents !== equity.at(-1).cashCents)
      cashIssues.push(
        `账本重放终值现金 ${replayCashCents} 与权益终值现金 ${equity.at(-1).cashCents} 不一致`,
      );
  }
  const positionIssues = [];
  if (run.initialBook?.initialCashCents) {
    const shares = {};
    const ledgerByDate = new Map();
    for (const row of ledger) {
      if (!ledgerByDate.has(row.tradeDate)) ledgerByDate.set(row.tradeDate, []);
      ledgerByDate.get(row.tradeDate).push(row);
    }
    for (const equityRow of equity) {
      for (const row of ledgerByDate.get(equityRow.tradeDate) ?? []) {
        const delta = row.side === "BUY" ? row.quantity : -Number(row.quantity);
        shares[row.code] = (shares[row.code] ?? 0) + delta;
        if (!shares[row.code]) delete shares[row.code];
      }
      const recorded = equityRow.sharesByCode ?? null;
      if (!recorded) continue;
      const codes = new Set([...Object.keys(shares), ...Object.keys(recorded)]);
      for (const code of codes) {
        if ((shares[code] ?? 0) !== (recorded[code] ?? 0)) {
          positionIssues.push(
            `${equityRow.tradeDate} ${code} 重放持仓 ${shares[code] ?? 0} 股与权益记录 ${recorded[code] ?? 0} 股不一致（成交被篡改或等价替换）`,
          );
        }
      }
    }
  }
  const cashChainMatches = cashIssues.length === 0;
  const positionsRebuilt = positionIssues.length === 0;
  return {
    run,
    plans,
    ledger: ledger.slice(-100),
    ledgerCount: ledger.length,
    equity,
    verification: {
      selectionPolicyMatches: selectionMatches,
      ledgerCountMatches,
      cashChainMatches,
      cashIssues: cashIssues.slice(0, 10),
      positionsRebuilt,
      positionIssues: positionIssues.slice(0, 10),
      totalReturnMatches:
        recomputedTotalReturn === null ||
        !ledgerCountMatches ||
        !ledger.length ||
        !cashChainMatches ||
        !positionsRebuilt ||
        !selectionMatches
          ? false
          : Math.abs(
              (recomputedTotalReturn ?? 0) - (run.coverage?.totalReturn ?? 0),
            ) < 1e-9,
      recomputedTotalReturn,
      note:
        ledger.length &&
        ledgerCountMatches &&
        cashChainMatches &&
        positionsRebuilt &&
        selectionMatches
          ? "收益核验基于账本独立重放（逐笔现金变动重算 + 逐日现金链 + 持仓数量重建）与权益终值"
          : "账本缺失、行数不符、现金重放、持仓重建或选股政策／计划摘要不一致，无法核验收益；不得将 totalReturn 视为已验证",
    },
  };
}
