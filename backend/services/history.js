import { createTencentHistoricalProvider } from "./historical-providers.js";
import {
  assessFieldCoverage,
  buildSampleProvenance,
  classifyExecutionModel,
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
  { provider = "tencent-free", kind, start, end, name },
) {
  if (!["LIMIT_FEATURES", "DAILY"].includes(kind))
    throw new Error("历史导入类型无效（LIMIT_FEATURES 或 DAILY）");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    throw new Error("历史导入日期范围无效");
  if (start > end) throw new Error("历史导入起始日期晚于结束日期");
  const providers = historyProviders();
  if (!providers[provider]) throw new Error("未知历史数据供应商");
  const jobs = new HistoryJobRepository(env);
  return jobs.createJob({
    id: newId("hjob"),
    provider,
    kind,
    start,
    end,
    name,
  });
}
function emRowToCanonical(raw) {
  return {
    code: String(raw.c ?? ""),
    name: String(raw.n ?? ""),
    sector: String(raw.hybk ?? "未分类"),
    price: raw.p === undefined ? null : Number(raw.p) / 1000,
    change: raw.zdp === undefined ? null : Number(raw.zdp),
    amount: raw.amount === undefined ? null : Number(raw.amount),
    floatCap: raw.ltsz === undefined ? null : Number(raw.ltsz),
    seal: raw.fund === undefined ? null : Number(raw.fund),
    turnover: raw.hs === undefined ? null : Number(raw.hs),
    first: raw.fbt === undefined ? null : Number(raw.fbt),
    last: raw.lbt === undefined ? null : Number(raw.lbt),
    breaks: raw.zbc === undefined ? null : Number(raw.zbc),
    height: raw.lbc === undefined ? null : Number(raw.lbc),
  };
}
export async function runHistoryImport(env, jobId, options = {}) {
  const jobs = new HistoryJobRepository(env);
  const job = await jobs.getJob(jobId);
  if (!job) throw new Error("历史导入任务不存在");
  if (["READY", "PARTIAL"].includes(job.stage)) return job;
  const provider = historyProviders()[job.provider];
  if (!provider) throw new Error("未知历史数据供应商");
  const store = openHistoryStore(env);
  const requestedStart = job.requestedRange.start,
    requestedEnd = job.requestedRange.end;
  await jobs.updateJob(jobId, { stage: "PROBING" });
  const capabilities = await provider.capabilities({
    start: requestedStart,
    end: requestedEnd,
  });
  if (
    job.kind === "LIMIT_FEATURES" &&
    capabilities.limitFeatures.availableFrom === null
  ) {
    return jobs.updateJob(jobId, {
      stage: "BLOCKED",
      statusPayload: {
        capabilities,
        reason: "能力探测显示请求范围内涨停特征不可用，未开始下载",
      },
    });
  }
  const datasetId = job.datasetId ?? newId("hds");
  const coverage = {
    observedStart: null,
    observedEnd: null,
    succeededDates: [],
    failedDates: [],
    notes: [],
  };
  if (!job.datasetId)
    await store.createDatasetVersion({
      id: datasetId,
      provider: job.provider,
      kind: job.kind,
      executionModel: "PENDING",
      requestedStart,
      requestedEnd,
      coverage,
    });
  await jobs.updateJob(jobId, { stage: "DOWNLOADING", datasetId });
  const calendar = await provider.tradingCalendar({
    start: requestedStart,
    end: requestedEnd,
  });
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
            requestRange: date,
            actualRange: date,
            rows: normalized.length,
            stage: "DONE",
          });
        } catch (error) {
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
    await jobs.updateJob(jobId, { stage: "NORMALIZING" });
    const weights = options.weights ?? PRESETS.balanced;
    const paramsDigest = await digestOf(weights);
    await jobs.updateJob(jobId, { stage: "SCORING" });
    let nextByCodeByDate = null;
    if (options.withObservationReturns !== false && succeeded.length) {
      const daily = await provider.dailyPrices({
        codes: [...universeCodes],
        start: succeeded[0].date,
        end: requestedEnd,
      });
      nextByCodeByDate = new Map();
      for (const code of Object.keys(daily.rows))
        for (const row of daily.rows[code]) {
          if (!nextByCodeByDate.has(row.tradeDate))
            nextByCodeByDate.set(row.tradeDate, new Map());
          nextByCodeByDate.get(row.tradeDate).set(code, row);
        }
    }
    for (let index = 0; index < succeeded.length; index++) {
      const entry = succeeded[index];
      const previousEntry = succeeded[index - 1] ?? null;
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
          createdAt: new Date().toISOString(),
          weights,
          source: `历史重构（${job.provider}）`,
          modelVersion: SCORING_VERSION,
          judgment:
            "历史重构评分：由供应商档案重建当日涨停特征后按同一规则模型计算；非事前采集，不构成事前判断。",
          stocks: a.stocks,
          sectors: a.sectors,
          emotion: a.emotion,
          origin: "HISTORICAL_RECONSTRUCTED",
        },
      );
      const nextEntry = succeeded[index + 1] ?? null;
      if (!nextEntry) continue;
      const nextQuotes = nextByCodeByDate?.get(nextEntry.date) ?? null;
      const universe = entry.normalized.map((row) => {
        const next = nextQuotes ? (nextQuotes.get(row.code) ?? null) : null;
        const quoteCents =
          row.price !== null ? Math.round(row.price * 100) : null;
        const openReturnPct =
          next && quoteCents
            ? ((next.openCents - quoteCents) / quoteCents) * 100
            : null;
        const closeReturnPct =
          next && quoteCents
            ? ((next.closeCents - quoteCents) / quoteCents) * 100
            : null;
        return {
          code: row.code,
          name: row.name,
          score: entry.scoresByCode?.get(row.code) ?? null,
          continued:
            Boolean(
              next && next.height !== null && next.height > (row.height ?? 0),
            ) || false,
          openReturnPct,
          closeReturnPct,
        };
      });
      const withReturns = universe.filter((row) => row.openReturnPct !== null);
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
        nextEntry.date,
        SCORING_VERSION,
        {
          signalDate: entry.date,
          labelEndDate: nextEntry.date,
          universeCount: universe.length,
          continuedCount: universe.filter((row) => row.continued).length,
          continuationRate: universe.length
            ? universe.filter((row) => row.continued).length / universe.length
            : null,
          observationCoverage: withReturns.length,
          topOpenReturnPct: mean(topQuantile.map((row) => row.openReturnPct)),
          topCloseReturnPct: mean(topQuantile.map((row) => row.closeReturnPct)),
          allOpenReturnPct: mean(withReturns.map((row) => row.openReturnPct)),
          allCloseReturnPct: mean(withReturns.map((row) => row.closeReturnPct)),
          note: "历史观察反馈：基于次日日线收盘数据的观察收益；不含可成交性保证，不代表可执行策略收益",
          universe: universe.slice(0, 200),
        },
      );
    }
  } else if (job.kind === "DAILY") {
    await jobs.updateJob(jobId, { stage: "DOWNLOADING" });
    const codes = options.codes ?? [];
    if (!codes.length) {
      return jobs.updateJob(jobId, {
        stage: "BLOCKED",
        statusPayload: {
          capabilities,
          reason: "DAILY 导入需要显式声明研究股票池（options.codes）",
        },
      });
    }
    const daily = await provider.dailyPrices({
      codes,
      start: requestedStart,
      end: requestedEnd,
    });
    const dates = new Set();
    for (const code of Object.keys(daily.rows))
      for (const row of daily.rows[code]) dates.add(row.tradeDate);
    for (const date of [...dates].sort()) {
      const perCode = {};
      for (const code of codes) {
        const row = daily.rows[code]?.find((item) => item.tradeDate === date);
        if (row) perCode[code] = row;
      }
      await store.saveDailyInputs(datasetId, date, {
        normalized: perCode,
        provenance: {
          origin: "HISTORICAL_RECONSTRUCTED",
          provider: job.provider,
          note: "日线观察输入；无涨停特征，不能重建六因子评分",
        },
      });
      succeeded.push({ date });
      for (const code of codes) universeCodes.add(code);
    }
  }
  coverage.observedStart = succeeded.length ? succeeded[0].date : null;
  coverage.observedEnd = succeeded.length ? succeeded.at(-1).date : null;
  coverage.succeededDates = succeeded.map((entry) => entry.date);
  coverage.failedDates = failed;
  coverage.notes.push(
    `联合采集股票池 ${universeCodes.size} 只；失败日期 ${failed.length} 个`,
  );
  const allNormalizedRows = [];
  for (const entry of succeeded)
    if (entry.normalized) allNormalizedRows.push(...entry.normalized);
  const coverageCheck = assessFieldCoverage(allNormalizedRows);
  coverage.coverage = coverageCheck;
  const executionModel = classifyExecutionModel(
    coverageCheck.ratio,
    job.kind === "LIMIT_FEATURES" && allNormalizedRows.length > 0,
  );
  coverage.executionModel = executionModel;
  await store.updateDatasetCoverage(datasetId, coverage);
  const finalStage = failed.length ? "PARTIAL" : "READY";
  return jobs.updateJob(jobId, {
    stage: finalStage,
    statusPayload: {
      capabilities,
      datasetId,
      executionModel,
      coverage,
      note:
        executionModel === "DAILY_OBSERVATION_V1"
          ? "日线观察数据集：无封板特征，不能重建六因子评分，仅用于观察研究"
          : "六因子历史评分数据集就绪",
    },
  });
}
export async function historyImportDetail(env, jobId) {
  const jobs = new HistoryJobRepository(env);
  const job = await jobs.getJob(jobId);
  if (!job) return null;
  const store = openHistoryStore(env);
  const dataset = job.datasetId ? await store.getDataset(job.datasetId) : null;
  const dates = job.datasetId
    ? await store.listDatasetDates(job.datasetId)
    : [];
  const scores = job.datasetId ? await store.listScores(job.datasetId) : [];
  const reviews = job.datasetId ? await store.listReviews(job.datasetId) : [];
  return {
    job,
    dataset,
    dates,
    scoreCount: scores.length,
    reviewCount: reviews.length,
    scores: scores.slice(-10),
    reviews: reviews.slice(-10),
  };
}
