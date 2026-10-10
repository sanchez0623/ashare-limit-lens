import { createTencentHistoricalProvider } from "./historical-providers.js";
import {
  assessFieldCoverage,
  buildSampleProvenance,
  classifyExecutionModel,
  normalizeDailyBarRow,
  normalizeLimitFeatureRow,
} from "../domain/historical-input.js";
import { analyze, PRESETS } from "../../shared/scoring.js";
import { digestOf } from "../domain/research-lineage.js";
import {
  HistoryDatasetStore,
  HistoryJobRepository,
  openHistoryStore,
} from "../storage/history.js";

const SCORING_VERSION = "rules-v1-historical";
const EXECUTOR_ID = `history-${crypto.randomUUID()}`;
const TAKEOVER_NOTICE =
  "任务已由其他执行器接管，本次执行中止（不覆盖接管方状态）";
class ExecutorLostError extends Error {
  constructor() {
    super(TAKEOVER_NOTICE);
    this.name = "ExecutorLostError";
  }
}
function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}
export function historyProviders() {
  return { "tencent-free": createTencentHistoricalProvider() };
}
export async function probeHistoryCapabilities(env, { start, end }) {
  const provider = createTencentHistoricalProvider();
  return provider.capabilities({ start, end });
}
export async function createHistoryImport(
  env,
  { provider = "tencent-free", kind, start, end, name, codes, datasetId },
) {
  if (!["LIMIT_FEATURES", "DAILY", "MINUTES"].includes(kind))
    throw new Error("历史导入类型无效（LIMIT_FEATURES、DAILY 或 MINUTES）");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    throw new Error("历史导入日期范围无效");
  if (start > end) throw new Error("历史导入起始日期晚于结束日期");
  const declaredCodes = Array.isArray(codes)
    ? [...new Set(codes.map((code) => String(code).trim()))]
    : [];
  if (
    declaredCodes.some((code) => !/^\d{6}$/.test(code)) ||
    (!declaredCodes.length && codes !== undefined)
  )
    throw new Error("股票池 codes 必须为六位数字代码数组");
  if (["DAILY", "MINUTES"].includes(kind) && !declaredCodes.length)
    throw new Error(
      `${kind} 导入需要显式声明研究股票池（codes，六位数字代码数组）`,
    );
  const providers = historyProviders();
  if (!providers[provider]) throw new Error("未知历史数据供应商");
  const jobs = new HistoryJobRepository(env);
  const job = await jobs.createJob({
    id: newId("hjob"),
    provider,
    kind,
    start,
    end,
    name,
  });
  const statusPayload = {};
  if (declaredCodes.length) statusPayload.codes = declaredCodes;
  if (datasetId) {
    if (kind !== "MINUTES")
      throw new Error("仅 MINUTES 导入支持附加到已有数据集（datasetId）");
    statusPayload.datasetId = datasetId;
  }
  if (Object.keys(statusPayload).length)
    return jobs.updateJob(job.id, { statusPayload });
  return job;
}
function orNull(value) {
  return value === null || value === undefined || value === "" ? null : value;
}
function emRowToCanonical(raw) {
  return {
    code: String(raw.c ?? ""),
    name: orNull(raw.n),
    sector: String(raw.hybk ?? "未分类"),
    price: orNull(raw.p) === null ? null : Number(raw.p) / 1000,
    change: orNull(raw.zdp) === null ? null : Number(raw.zdp),
    amount: orNull(raw.amount) === null ? null : Number(raw.amount),
    floatCap: orNull(raw.ltsz) === null ? null : Number(raw.ltsz),
    seal: orNull(raw.fund) === null ? null : Number(raw.fund),
    turnover: orNull(raw.hs) === null ? null : Number(raw.hs),
    first: orNull(raw.fbt) === null ? null : Number(raw.fbt),
    last: orNull(raw.lbt) === null ? null : Number(raw.lbt),
    breaks: orNull(raw.zbc) === null ? null : Number(raw.zbc),
    height: orNull(raw.lbc) === null ? null : Number(raw.lbc),
  };
}
export async function runHistoryImport(env, jobId, options = {}) {
  const jobs = new HistoryJobRepository(env);
  const job = await jobs.getJob(jobId);
  if (!job) throw new Error("历史导入任务不存在");
  if (job.stage === "READY" && options.withObservationReturns !== true)
    return job;
  const store = openHistoryStore(env);
  if (!store) {
    return jobs.updateJob(jobId, {
      stage: "BLOCKED",
      statusPayload: {
        reason:
          "历史研究存储仅本机可用：请配置 LOCAL_RESEARCH_DB_PATH 后在本机常驻实例运行导入",
      },
    });
  }
  if (!(await jobs.claimExecution(jobId, EXECUTOR_ID)))
    return {
      ...job,
      note: "另一个执行器正在运行此导入任务，本次未接管（避免并发覆盖）",
    };
  try {
    return await runHistoryImportInner(env, job, { jobs, store, options });
  } catch (error) {
    if (error instanceof ExecutorLostError)
      return { ...(await jobs.getJob(jobId)), note: TAKEOVER_NOTICE };
    const reason = String(error?.message ?? error).slice(0, 300);
    const failedJob = await jobs.finishJob(jobId, EXECUTOR_ID, {
      stage: "FAILED",
      statusPayload: {
        error: reason,
        note: "导入过程中发生未预期错误；已完成的下载块保留，可重试续传",
      },
    });
    if (failedJob) return failedJob;
    return {
      ...(await jobs.getJob(jobId)),
      note: "任务已由其他执行器接管或进入终态，本次错误未写入",
    };
  }
}
async function runHistoryImportInner(env, job, { jobs, store, options }) {
  const jobId = job.id;
  const takeoverNotice = TAKEOVER_NOTICE;
  const guardOwnership = async () => {
    if (!(await jobs.stillOwner(jobId, EXECUTOR_ID)))
      throw new ExecutorLostError();
  };
  const provider = historyProviders()[job.provider];
  if (!provider) throw new Error("未知历史数据供应商");
  const requestedStart = job.requestedRange.start,
    requestedEnd = job.requestedRange.end;
  if (!(await jobs.progressJob(jobId, EXECUTOR_ID, { stage: "PROBING" })))
    return { ...(await jobs.getJob(jobId)), note: takeoverNotice };
  const capabilities = await provider.capabilities({
    start: requestedStart,
    end: requestedEnd,
  });
  await guardOwnership();
  if (
    job.kind === "LIMIT_FEATURES" &&
    capabilities.limitFeatures.availableFrom === null
  ) {
    return jobs.finishJob(jobId, EXECUTOR_ID, {
      stage: "BLOCKED",
      statusPayload: {
        capabilities,
        reason: "能力探测显示请求范围内涨停特征不可用，未开始下载",
      },
    });
  }
  const coverage = {
    observedStart: null,
    observedEnd: null,
    succeededDates: [],
    failedDates: [],
    notes: [],
  };
  let preservedExecutionModel = null;
  let clonedSourceDates = null;
  let clonedSourceTradingDates = null;
  let datasetId = job.datasetId;
  if (!datasetId) {
    await guardOwnership();
    datasetId = newId("hds");
    const claimed = await jobs.claimDataset(jobId, datasetId);
    if (!claimed) {
      const current = await jobs.getJob(jobId);
      datasetId = current.datasetId;
    } else {
      await store.createDatasetVersion({
        id: datasetId,
        provider: job.provider,
        kind: job.kind,
        executionModel: "PENDING",
        requestedStart,
        requestedEnd,
        coverage,
      });
    }
  }
  if (
    !(await jobs.progressJob(jobId, EXECUTOR_ID, {
      stage: "DOWNLOADING",
      datasetId,
    }))
  )
    return { ...(await jobs.getJob(jobId)), note: takeoverNotice };
  const calendar = await provider.tradingCalendar({
    start: requestedStart,
    end: requestedEnd,
  });
  await guardOwnership();
  if (calendar.issues.length)
    coverage.notes.push(
      ...calendar.issues.map((issue) => `交易日历：${issue}`),
    );
  const doneChunks = await store.completedChunkKeys(jobId);
  const succeeded = [];
  const failed = [];
  const universeCodes = new Set();
  if (job.kind === "LIMIT_FEATURES") {
    for (const date of calendar.dates) {
      const chunkKey = `limit:${date}`;
      let normalized = null;
      let broken = null;
      if (doneChunks.has(chunkKey) && job.datasetId) {
        const stored = await store.getDailyInput(datasetId, date);
        if (stored) {
          normalized = stored.normalized;
          broken = stored.provenance?.broken ?? null;
        }
      }
      if (!normalized) {
        try {
          const features = await provider.limitFeatures({ date });
          await guardOwnership();
          normalized = [];
          for (const raw of features.rows) {
            const { row } = normalizeLimitFeatureRow(emRowToCanonical(raw), {
              origin: "LIVE_ARCHIVED",
              provider: job.provider,
              fetchedAt: features.fetchedAt,
            });
            normalized.push(row);
          }
          broken = features.broken;
          const provenance = await buildSampleProvenance({
            origin: "LIVE_ARCHIVED",
            provider: job.provider,
            tradeDate: date,
            fetchedAt: features.fetchedAt,
            pointInTimeConfidence: "SOURCE_REPORTED",
            fieldCoverage: assessFieldCoverage(normalized),
            rawPayload: features,
            normalizedPayload: normalized,
          });
          await store.saveDailyInputs(datasetId, date, {
            normalized,
            provenance: { ...provenance, broken },
          });
          await store.saveChunk(jobId, {
            chunkKey,
            datasetId,
            requestRange: date,
            actualRange: date,
            rows: normalized.length,
            stage: "DONE",
            rawDigest: await digestOf(features),
            raw: features,
          });
        } catch (error) {
          if (error instanceof ExecutorLostError) throw error;
          await store.saveChunk(jobId, {
            chunkKey,
            requestRange: date,
            actualRange: null,
            rows: 0,
            stage: "FAILED",
            artifactRef: String(error.message ?? error).slice(0, 160),
          });
          failed.push({
            date,
            reason: String(error.message ?? error).slice(0, 160),
          });
          continue;
        }
      }
      if (normalized) {
        succeeded.push({ date, normalized, broken });
        for (const row of normalized) universeCodes.add(row.code);
      }
    }
    if (!(await jobs.progressJob(jobId, EXECUTOR_ID, { stage: "NORMALIZING" })))
      return { ...(await jobs.getJob(jobId)), note: takeoverNotice };
    const weights = options.weights ?? PRESETS.balanced;
    const paramsDigest = await digestOf(weights);
    if (!(await jobs.progressJob(jobId, EXECUTOR_ID, { stage: "SCORING" })))
      return { ...(await jobs.getJob(jobId)), note: takeoverNotice };
    let dailyNormalized = null;
    if (options.withObservationReturns !== false && succeeded.length) {
      try {
        const daily = await provider.dailyPrices({
          codes: [...universeCodes],
          start: succeeded[0].date,
          end: requestedEnd,
        });
        dailyNormalized = new Map();
        for (const code of Object.keys(daily.rows))
          for (const row of daily.rows[code]) {
            let normalized;
            try {
              normalized = normalizeDailyBarRow(row);
            } catch {
              continue;
            }
            if (!dailyNormalized.has(normalized.tradeDate))
              dailyNormalized.set(normalized.tradeDate, new Map());
            dailyNormalized.get(normalized.tradeDate).set(code, normalized);
          }
      } catch (error) {
        dailyNormalized = null;
        coverage.notes.push(
          `观察反馈日线下载失败，本次不生成次日观察收益：${String(error.message ?? error).slice(0, 120)}`,
        );
      }
      if (dailyNormalized) {
        await guardOwnership();
        for (const [obsDate, byCode] of dailyNormalized)
          await store.saveObservationDaily(datasetId, obsDate, byCode);
      }
    }
    const dateIndex = new Map(
      calendar.dates.map((date, index) => [date, index]),
    );
    for (const entry of succeeded) {
      await guardOwnership();
      const previousEntry =
        succeeded.slice(0, succeeded.indexOf(entry)).at(-1) ?? null;
      const a = analyze(
        entry.normalized,
        entry.broken ?? null,
        previousEntry ? previousEntry.normalized : null,
        weights,
      );
      entry.scoresByCode = new Map(
        a.stocks.map((stock) => [stock.code, stock.score]),
      );
      entry.nextUniverse = a.stocks.length;
      await store.saveScore(
        datasetId,
        entry.date,
        SCORING_VERSION,
        paramsDigest,
        {
          date: entry.date,
          createdAt: `${entry.date}T07:05:00.000Z`,
          weights,
          source: `历史重构（${job.provider}）`,
          modelVersion: SCORING_VERSION,
          judgment:
            "历史重构评分：由供应商档案重建当日涨停特征后按同一规则模型计算；非事前采集，不构成事前判断；createdAt 采用评分日盘前虚拟时间以保证可重放性",
          stocks: a.stocks,
          sectors: a.sectors,
          emotion: a.emotion,
          origin: "HISTORICAL_RECONSTRUCTED",
        },
      );
      const nextTradingDate =
        calendar.dates[dateIndex.get(entry.date) + 1] ?? null;
      const nextEntry =
        nextTradingDate === null
          ? null
          : (succeeded.find((row) => row.date === nextTradingDate) ?? null);
      if (!nextEntry) {
        coverage.notes.push(
          `${entry.date} 的相邻交易日 ${nextTradingDate ?? "（范围内无）"} 数据缺失，未生成次日观察反馈（不跨越缺失日）`,
        );
        continue;
      }
      const dailyByCode = dailyNormalized?.get(entry.date) ?? null;
      const nextQuotes = dailyNormalized?.get(nextTradingDate) ?? null;
      const nextFeatures = new Map(
        (nextEntry.normalized ?? []).map((row) => [row.code, row]),
      );
      const universe = entry.normalized.map((row) => {
        const nextDaily = nextQuotes
          ? (nextQuotes.get(row.code) ?? null)
          : null;
        const dailyPrev = dailyByCode
          ? (dailyByCode.get(row.code) ?? null)
          : null;
        const quoteCents = dailyPrev ? dailyPrev.closeCents : null;
        const returnPct = (cents) =>
          nextDaily && quoteCents !== null
            ? ((cents - quoteCents) / quoteCents) * 100
            : null;
        const openReturnPct = nextDaily ? returnPct(nextDaily.openCents) : null;
        const closeReturnPct = nextDaily
          ? returnPct(nextDaily.closeCents)
          : null;
        let continued = null;
        if (row.height !== null && nextEntry.normalized !== null) {
          const nextFeature = nextFeatures.get(row.code);
          if (!nextFeature) continued = false;
          else if (nextFeature.height !== null)
            continued = nextFeature.height > row.height;
        }
        return {
          code: row.code,
          name: row.name,
          score: entry.scoresByCode?.get(row.code) ?? null,
          continued,
          openReturnPct:
            openReturnPct !== null && Number.isFinite(openReturnPct)
              ? openReturnPct
              : null,
          closeReturnPct:
            closeReturnPct !== null && Number.isFinite(closeReturnPct)
              ? closeReturnPct
              : null,
        };
      });
      const withReturns = universe.filter((row) => row.openReturnPct !== null);
      const decidable = universe.filter((row) => row.continued !== null);
      const continuedCount = decidable.filter((row) => row.continued).length;
      const topQuantile =
        withReturns.length && withReturns.some((row) => row.score !== null)
          ? withReturns
              .filter((row) => row.score !== null)
              .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
              .slice(0, Math.max(1, Math.ceil(withReturns.length / 5)))
          : [];
      const mean = (values) =>
        values.length
          ? values.reduce((a, b) => a + b, 0) / values.length
          : null;
      await store.saveReview(
        datasetId,
        entry.date,
        nextTradingDate,
        SCORING_VERSION,
        {
          signalDate: entry.date,
          labelEndDate: nextTradingDate,
          universeCount: universe.length,
          continuedDecidableCount: decidable.length,
          continuedUnknownCount: universe.length - decidable.length,
          continuedCount,
          continuationRate: decidable.length
            ? continuedCount / decidable.length
            : null,
          observationCoverage: withReturns.length,
          topOpenReturnPct: mean(topQuantile.map((row) => row.openReturnPct)),
          topCloseReturnPct: mean(topQuantile.map((row) => row.closeReturnPct)),
          allOpenReturnPct: mean(withReturns.map((row) => row.openReturnPct)),
          allCloseReturnPct: mean(withReturns.map((row) => row.closeReturnPct)),
          priceBasis:
            "信号日基准价取同源前复权日线收盘（QFQ）；信号日日线缺失时不计算收益，不与涨停池未复权价格混用",
          note: "历史观察反馈：基于相邻交易日日线收盘数据的观察收益；不含可成交性保证，不代表可执行策略收益",
          universe: universe.slice(0, 200),
        },
      );
    }
  } else if (job.kind === "MINUTES") {
    const codes = options.codes ?? job.statusPayload?.codes ?? [];
    if (!codes.length) {
      return jobs.finishJob(jobId, EXECUTOR_ID, {
        stage: "BLOCKED",
        statusPayload: {
          capabilities,
          reason: "MINUTES 导入需要显式声明研究股票池（codes）",
        },
      });
    }
    const targetDatasetId = options.datasetId ?? job.statusPayload?.datasetId;
    if (targetDatasetId) {
      await guardOwnership();
      const cloneSource = job.datasetId ?? targetDatasetId;
      const cloned = await store.cloneDatasetForMinutes(cloneSource);
      datasetId = cloned.id;
      preservedExecutionModel = cloned.sourceCoverage.executionModel ?? null;
      clonedSourceDates = Array.isArray(cloned.sourceCoverage.succeededDates)
        ? cloned.sourceCoverage.succeededDates
        : [];
      clonedSourceTradingDates = Array.isArray(
        cloned.sourceCoverage.tradingDates,
      )
        ? cloned.sourceCoverage.tradingDates
        : [];
      if (!(await jobs.progressJob(jobId, EXECUTOR_ID, { datasetId })))
        return { ...(await jobs.getJob(jobId)), note: takeoverNotice };
      coverage.notes.push(
        `分钟数据附加为新数据集版本 ${datasetId}（克隆自 ${cloneSource}，继承已完成分钟数据）；源数据集保持发布时状态不被改写`,
      );
    }
    for (const date of calendar.dates) {
      let dayRows = 0;
      let dayFailures = 0;
      for (const code of codes) {
        const chunkKey = `minute:${date}:${code}`;
        if (doneChunks.has(chunkKey) && job.datasetId) {
          dayRows++;
          continue;
        }
        try {
          const series = await provider.minuteSeries({ code, date });
          await guardOwnership();
          await store.saveMinuteInputs(datasetId, date, code, {
            bars: series.inSession,
            anomalies: series.anomalies.slice(0, 5),
            sampled: true,
            note: "分钟采样价序列（MINUTE_SAMPLE_V1），非完整 OHLC",
          });
          await store.saveChunk(jobId, {
            chunkKey,
            datasetId,
            requestRange: date,
            actualRange: date,
            rows: series.inSession.length,
            stage: "DONE",
            rawDigest: await digestOf(series),
            raw: series,
          });
          dayRows++;
        } catch (error) {
          if (error instanceof ExecutorLostError) throw error;
          await store.saveChunk(jobId, {
            chunkKey,
            requestRange: date,
            actualRange: null,
            rows: 0,
            stage: "FAILED",
            artifactRef: String(error.message ?? error).slice(0, 160),
          });
          dayFailures++;
        }
      }
      if (dayFailures === 0 && dayRows > 0) {
        succeeded.push({ date });
        for (const code of codes) universeCodes.add(code);
      } else if (dayRows > 0) {
        succeeded.push({ date });
        failed.push({
          date,
          reason: `分钟采样部分缺失：${dayFailures}/${codes.length} 只失败`,
        });
      } else {
        failed.push({ date, reason: "分钟采样全部失败" });
      }
    }
  } else if (job.kind === "DAILY") {
    if (!(await jobs.progressJob(jobId, EXECUTOR_ID, { stage: "DOWNLOADING" })))
      return { ...(await jobs.getJob(jobId)), note: takeoverNotice };
    const codes = options.codes ?? job.statusPayload?.codes ?? [];
    if (!codes.length) {
      return jobs.finishJob(jobId, EXECUTOR_ID, {
        stage: "BLOCKED",
        statusPayload: {
          capabilities,
          reason: "DAILY 导入需要显式声明研究股票池（codes）",
        },
      });
    }
    const daily = await provider.dailyPrices({
      codes,
      start: requestedStart,
      end: requestedEnd,
    });
    await guardOwnership();
    const dates = new Set();
    for (const code of Object.keys(daily.rows))
      for (const row of daily.rows[code]) dates.add(row.tradeDate);
    for (const calendarDate of calendar.dates)
      if (!dates.has(calendarDate))
        failed.push({
          date: calendarDate,
          reason: "交易日历中的日期缺少任何股票的日线数据",
        });
    for (const date of [...dates].sort()) {
      await guardOwnership();
      const perCode = {};
      for (const code of codes) {
        const row = daily.rows[code]?.find((item) => item.tradeDate === date);
        if (!row) {
          failed.push({
            date,
            reason: `缺少日线数据：${code}`,
          });
          continue;
        }
        try {
          perCode[code] = normalizeDailyBarRow(row);
        } catch (error) {
          failed.push({
            date,
            reason: `日线行规范化失败（${code}）：${String(error.message ?? error).slice(0, 120)}`,
          });
        }
      }
      if (Object.keys(perCode).length) {
        await store.saveDailyInputs(datasetId, date, {
          normalized: perCode,
          provenance: {
            origin: "HISTORICAL_RECONSTRUCTED",
            provider: job.provider,
            adjustedPrice: "QFQ",
            note: "日线观察输入（前复权）；无涨停特征，不能重建六因子评分",
          },
        });
        await store.saveChunk(jobId, {
          chunkKey: `daily:${date}`,
          datasetId,
          requestRange: date,
          actualRange: date,
          rows: Object.keys(perCode).length,
          stage: "DONE",
          rawDigest: await digestOf(perCode),
          raw: perCode,
        });
        succeeded.push({ date });
      }
      for (const code of codes) universeCodes.add(code);
    }
  }
  coverage.observedStart = succeeded.length ? succeeded[0].date : null;
  coverage.observedEnd = succeeded.length ? succeeded.at(-1).date : null;
  coverage.succeededDates = succeeded.map((entry) => entry.date);
  if (clonedSourceDates)
    coverage.succeededDates = [
      ...new Set([...clonedSourceDates, ...coverage.succeededDates]),
    ].sort();
  coverage.tradingDates = [
    ...new Set([...(clonedSourceTradingDates ?? []), ...calendar.dates]),
  ].sort();
  coverage.failedDates = failed;
  coverage.notes.push(
    `联合采集股票池 ${universeCodes.size} 只；失败日期 ${failed.length} 个`,
  );
  const allNormalizedRows = [];
  for (const entry of succeeded)
    if (entry.normalized) allNormalizedRows.push(...entry.normalized);
  const coverageCheck = assessFieldCoverage(allNormalizedRows);
  coverage.coverage = coverageCheck;
  const executionModel =
    preservedExecutionModel ??
    classifyExecutionModel(
      coverageCheck.ratio,
      job.kind === "LIMIT_FEATURES" && allNormalizedRows.length > 0,
    );
  coverage.executionModel = executionModel;
  await guardOwnership();
  const finalCoverage = await store.updateDatasetCoverage(datasetId, coverage);
  if (!succeeded.length)
    return jobs.finishJob(jobId, EXECUTOR_ID, {
      stage: "FAILED",
      statusPayload: {
        capabilities,
        datasetId,
        executionModel,
        coverage,
        manifestDigest: finalCoverage.manifestDigest,
        error: "请求范围内没有任何成功日期，不能发布为就绪数据集",
      },
    });
  const finalStage = failed.length ? "PARTIAL" : "READY";
  const finished = await jobs.finishJob(jobId, EXECUTOR_ID, {
    stage: finalStage,
    datasetId,
    statusPayload: {
      capabilities,
      datasetId,
      executionModel,
      coverage,
      manifestDigest: finalCoverage.manifestDigest,
      note:
        executionModel === "DAILY_OBSERVATION_V1"
          ? "日线观察数据集：无封板特征，不能重建六因子评分，仅用于观察研究"
          : "六因子历史评分数据集就绪",
    },
  });
  if (finished) return finished;
  return {
    ...(await jobs.getJob(jobId)),
    note: "任务终态已由其他执行器写入，本次结果未覆盖",
  };
}
export async function historyImportDetail(env, jobId) {
  const jobs = new HistoryJobRepository(env);
  const job = await jobs.getJob(jobId);
  if (!job) return null;
  const store = openHistoryStore(env);
  const dataset =
    store && job.datasetId ? await store.getDataset(job.datasetId) : null;
  const integrity =
    store && job.datasetId ? await store.datasetIntegrity(job.datasetId) : null;
  const dates =
    store && job.datasetId ? await store.listDatasetDates(job.datasetId) : [];
  const scores =
    store && job.datasetId ? await store.listScores(job.datasetId) : [];
  const reviews =
    store && job.datasetId ? await store.listReviews(job.datasetId) : [];
  return {
    job,
    dataset,
    integrity: integrity
      ? {
          verified: integrity.verified,
          manifestDigest: integrity.manifestDigest,
          chunkCount: integrity.manifest.chunkRefs.length,
          note: integrity.verified
            ? "数据集 manifest 与当前输入一致"
            : "警告：数据集输入与发布时的 manifest 摘要不一致（可能被修改），回测与训练将拒绝使用",
        }
      : null,
    dates,
    scoreCount: scores.length,
    reviewCount: reviews.length,
    scores: scores.slice(-10),
    reviews: reviews.slice(-10),
  };
}
