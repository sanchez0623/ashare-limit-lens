import { digestOf } from "./research-lineage.js";
import { tradingAdjacency, isAdjacentTradingDay } from "./historical-input.js";

export const FULL_SAMPLE_DIGEST = "FULL_PAYLOAD_V1";
export async function historicalTrainingSample({
  signalDate,
  nextDate,
  datasetId,
  datasetManifestDigest,
  scoreDigest,
}) {
  const payload = {
    role: "HISTORICAL_TRAIN",
    digestVersion: FULL_SAMPLE_DIGEST,
    signalDate,
    tradeDate: nextDate,
    datasetId,
    datasetManifestDigest,
    scoreDigest,
  };
  return { date: nextDate, payload, digest: await digestOf(payload) };
}

export async function historicalTrainingSource(datasetId, manifest) {
  const payload = { datasetId, manifest };
  return { payload, digest: await digestOf(payload) };
}

// 发布时的 manifest 摘要已由旧样本哈希覆盖；其中的 scoreRefs 绑定原评分日期。
// 只给新证据重算自身摘要不能改变这个锚点，也不允许仅按样本的可变日期构造证据。
export async function verifyHistoricalTrainingSource(source, experiment) {
  const reservation = experiment.reservationPayload;
  const manifest = source?.payload?.manifest;
  if (
    experiment.kind !== "BOOTSTRAP" ||
    source?.payload?.datasetId !== reservation.datasetId ||
    !manifest ||
    manifest.executionModel !== "SIX_FACTOR_V1" ||
    !Array.isArray(manifest.scoreRefs) ||
    (await digestOf(source.payload)) !== source.digest ||
    (await digestOf(manifest)) !== reservation.datasetManifestDigest
  )
    throw new Error("冷启动原数据集评分来源缺失或与冻结 manifest 不一致");
  return {
    scores: new Set(
      manifest.scoreRefs.map((ref) => `${ref.tradeDate}:${ref.digest}`),
    ),
    adjacency: tradingAdjacency(manifest.coverage),
  };
}

// 旧冷启动只哈希 scoreDigest/nextDate/datasetManifestDigest，原行不可重写。
// 兼容入口限于原来的五字段结构，并核对原数据集评分日期与摘要的关联。
export async function verifyResearchSample(
  sample,
  experiment,
  historicalSource,
) {
  const p = sample.payload;
  if (
    !p ||
    (p.role && p.role !== sample.role) ||
    (p.tradeDate && p.tradeDate !== sample.outcomeDate)
  )
    throw new Error("样本日期或用途与存储身份不一致");
  if (sample.role === "HISTORICAL_TRAIN") {
    const reservation = experiment.reservationPayload;
    if (
      experiment.kind !== "BOOTSTRAP" ||
      p.role !== "HISTORICAL_TRAIN" ||
      p.datasetId !== reservation.datasetId ||
      p.datasetManifestDigest !== reservation.datasetManifestDigest ||
      !reservation.trainingDates.includes(sample.outcomeDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(p.signalDate ?? "") ||
      p.signalDate >= sample.outcomeDate
    )
      throw new Error("冷启动样本与冻结数据集、日期或用途不一致");
    if (
      !historicalSource?.scores.has(`${p.signalDate}:${p.scoreDigest}`) ||
      !isAdjacentTradingDay(
        historicalSource.adjacency,
        p.signalDate,
        sample.outcomeDate,
      )
    )
      throw new Error("冷启动样本信号日期与原数据集评分摘要或次日关系不一致");
  }
  if (p.digestVersion !== undefined && p.digestVersion !== FULL_SAMPLE_DIGEST)
    throw new Error("样本摘要版本不支持");
  if ((await digestOf(p)) === sample.digest) return;
  if (
    sample.role === "HISTORICAL_TRAIN" &&
    p.digestVersion === undefined &&
    Object.keys(p).length === 5 &&
    Object.keys(p).every((key) =>
      [
        "role",
        "signalDate",
        "datasetId",
        "datasetManifestDigest",
        "scoreDigest",
      ].includes(key),
    ) &&
    (await digestOf({
      scoreDigest: p.scoreDigest,
      nextDate: sample.outcomeDate,
      datasetManifestDigest: p.datasetManifestDigest,
    })) === sample.digest
  )
    return;
  throw new Error("样本摘要不一致");
}
