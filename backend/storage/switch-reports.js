import {
  recoverSwitchReport,
  verifySwitchReport,
} from "../domain/research-switches.js";

// 兼容已发布 0018 记录：仅补充能按事件原摘要准确恢复的快照，原事件保持不变。
export async function switchReportRows(db, switches, evaluation) {
  const reports = [];
  for (const { payload: event } of switches) {
    if (event.eventType !== "PROMOTE") continue;
    let stored = await db
      .prepare(
        "SELECT payload,digest FROM strategy_switch_reports WHERE digest=?",
      )
      .bind(event.reportDigest)
      .first();
    if (!stored) {
      const recovered = await recoverSwitchReport(
        evaluation,
        event.reportDigest,
        event.cohortId,
      );
      await db
        .prepare(
          "INSERT INTO strategy_switch_reports(digest,cohort_id,payload,created_at) VALUES(?,?,?,?) ON CONFLICT(digest) DO NOTHING",
        )
        .bind(
          recovered.digest,
          event.cohortId,
          JSON.stringify(recovered.payload),
          event.createdAt,
        )
        .run();
      stored = await db
        .prepare(
          "SELECT payload,digest FROM strategy_switch_reports WHERE digest=?",
        )
        .bind(event.reportDigest)
        .first();
    }
    const row = { digest: stored.digest, payload: JSON.parse(stored.payload) };
    await verifySwitchReport(row, event.cohortId);
    reports.push(row);
  }
  return reports;
}
