import {
  entryObservationStatus,
  ENTRY_OBSERVER_ID,
} from "./entry-observation.js";
import { realtimeStatus } from "./realtime.js";
import { database } from "../storage/database.js";

// 进度读取不启动准备、采集或核验，也不改变冻结计划和执行源码指纹。
export async function entryObservationProgress(env, now = new Date()) {
  const [observation, realtime, session, ledger] = await Promise.all([
    entryObservationStatus(env),
    realtimeStatus(env, now),
    database(env)
      .prepare(
        `SELECT trade_date AS date,
          json_extract(payload, '$.signalDate') AS signalDate,
          json_extract(payload, '$.status') AS status,
          json_extract(payload, '$.sequence') AS sequence,
          json_extract(payload, '$.fillCount') AS fillCount,
          json_extract(payload, '$.lastObservedAt') AS lastObservedAt
         FROM shadow_sessions WHERE account_id = ?
           AND strftime('%w', trade_date) NOT IN ('0', '6')
         ORDER BY trade_date DESC LIMIT 1`,
      )
      .bind(ENTRY_OBSERVER_ID)
      .first(),
    database(env)
      .prepare(
        "SELECT COUNT(*) AS total, MAX(trade_date) AS latestTradeDate FROM shadow_ledger WHERE account_id = ?",
      )
      .bind(ENTRY_OBSERVER_ID)
      .first(),
  ]);
  return {
    ...observation,
    session: session ? { ...session } : null,
    ledger: { ...ledger },
    executor: {
      running: realtime.running,
      stale: realtime.stale,
      health: realtime.health,
    },
    checkedAt: now.toISOString(),
  };
}
