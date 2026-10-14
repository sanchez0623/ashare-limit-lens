import { digestOf } from "./research-lineage.js";

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

// 旧冷启动只哈希 scoreDigest/nextDate/datasetManifestDigest，原行不可重写。
// 兼容入口限于原来的五字段结构，并把未哈希的身份字段绑定回冻结预留清单。
export async function verifyResearchSample(sample, experiment) {
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
