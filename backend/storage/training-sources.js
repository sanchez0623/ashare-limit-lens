import { openHistoryStore } from "./history.js";
import {
  historicalTrainingSource,
  verifyHistoricalTrainingSource,
} from "../domain/research-samples.js";

export async function trainingSourceEvidence(env, experiment) {
  if (experiment.kind !== "BOOTSTRAP") return null;
  const load = async () => {
    const row = await env.DB.prepare(
      "SELECT payload,digest FROM research_training_sources WHERE experiment_id=?",
    )
      .bind(experiment.id)
      .first();
    return row
      ? { payload: JSON.parse(row.payload), digest: row.digest }
      : null;
  };
  let source = await load();
  if (!source) {
    // 旧实验仅能从实际原数据集补存精确匹配的 manifest；不修改预留或样本。
    const store = openHistoryStore(env);
    if (!store)
      throw new Error(
        "旧冷启动缺少原数据集评分来源，请配置 LOCAL_RESEARCH_DB_PATH 后重新导出",
      );
    try {
      const integrity = await store.datasetIntegrity(
        experiment.reservationPayload.datasetId,
      );
      if (!integrity?.verified)
        throw new Error("冷启动原数据集 manifest 校验失败，不能补存评分来源");
      source = await historicalTrainingSource(
        integrity.datasetId,
        integrity.manifest,
      );
      await verifyHistoricalTrainingSource(source, experiment);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO research_training_sources(experiment_id,payload,digest,created_at) VALUES(?,?,?,?)",
      )
        .bind(
          experiment.id,
          JSON.stringify(source.payload),
          source.digest,
          new Date().toISOString(),
        )
        .run();
      source = await load();
    } finally {
      store.close();
    }
  }
  await verifyHistoricalTrainingSource(source, experiment);
  return source;
}
