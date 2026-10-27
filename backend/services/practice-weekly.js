import { digestOf } from "../domain/research-lineage.js";
import { isPracticeReview } from "../../shared/practice.js";
import { sendNotification, alertsEnabled } from "./notifications.js";
import { marketClock } from "../domain/realtime.js";
import { practiceFeatures } from "../domain/practice-review.js";
import { BUY_POINT_LABELS } from "../../shared/buy-point-type.js";

const yuan = (n) => (Number.isFinite(n) ? (n / 100).toFixed(2) : "未知");
export function practiceWeek(now) {
  const clock = marketClock(now);
  const day = new Date(`${clock.date}T00:00:00Z`).getUTCDay();
  // Retry the most recent Friday through the weekend and following week.
  const back = day >= 5 ? day - 5 : day + 2;
  let end = new Date(Date.parse(`${clock.date}T00:00:00Z`) - back * 86400000)
    .toISOString()
    .slice(0, 10);
  if (day === 5 && clock.time < "17:15:00")
    end = new Date(Date.parse(end) - 7 * 86400000).toISOString().slice(0, 10);
  return {
    end,
    start: new Date(Date.parse(end) - 4 * 86400000).toISOString().slice(0, 10),
  };
}

export async function practiceWeeklyStatus(env) {
  return (
    await env.DB.prepare(
      "SELECT week_end,status,attempt,updated_at FROM practice_weekly_reports ORDER BY week_end DESC LIMIT 8",
    ).all()
  ).results;
}
export async function processPracticeWeekly(
  env,
  { now = new Date(), send = sendNotification } = {},
) {
  if (!alertsEnabled(env)) return { status: "CHANNEL_NOT_CONFIGURED" };
  const clock = marketClock(now),
    week = practiceWeek(now),
    stamp = now.toISOString();
  let row = await env.DB.prepare(
    "SELECT * FROM practice_weekly_reports WHERE week_end=?",
  )
    .bind(week.end)
    .first();
  if (!row) {
    const storedDays = (
      await env.DB.prepare(
        "SELECT trade_date,payload,ai_payload FROM reviews WHERE trade_date>=? AND trade_date<=? ORDER BY trade_date",
      )
        .bind(week.start, week.end)
        .all()
    ).results
      .map((r) => ({
        date: r.trade_date,
        review: JSON.parse(r.payload),
        ai: r.ai_payload ? JSON.parse(r.ai_payload) : null,
      }))
      .filter((r) => isPracticeReview(r.review));
    const days = [],
      invalidDates = [];
    for (const day of storedDays) {
      if (
        (await digestOf(day.review.sources)) !== day.review.sourceDigest ||
        (await digestOf(practiceFeatures(day.review))) !==
          day.review.sources.featureDigest
      )
        invalidDates.push(day.date);
      else days.push(day);
    }
    const sessions = (
      await env.DB.prepare(
        "SELECT trade_date FROM paper_live_sessions WHERE trade_date>=? AND trade_date<=? AND json_extract(payload,'$.plan.dragonPolicy.version')='dragon-risk-v1'",
      )
        .bind(week.start, week.end)
        .all()
    ).results;
    if (!storedDays.length && !sessions.length)
      return { status: "NO_PRACTICE_DAYS" };
    const absent = [
      ...new Set([
        ...invalidDates,
        ...sessions
          .filter((s) => !days.some((d) => d.date === s.trade_date))
          .map((s) => s.trade_date),
      ]),
    ];
    const net =
      !absent.length &&
      days.every((d) => Number.isFinite(d.review.account.dailyPnlCents))
        ? days.reduce((n, d) => n + d.review.account.dailyPnlCents, 0)
        : null;
    const missing = [
      ...new Set([
        ...absent,
        ...days.filter((d) => !d.review.researchEligible).map((d) => d.date),
      ]),
    ];
    const batch = await env.DB.prepare(
      "SELECT stage,report FROM dragon_pattern_batches ORDER BY created_at DESC LIMIT 1",
    ).first();
    const cycles = days.flatMap((d) => d.review.cycles ?? []);
    const names = [...new Set(cycles.map((c) => c.buyPoint ?? "unknown"))];
    const grouping =
      names
        .map(
          (name) =>
            `${BUY_POINT_LABELS[name] ?? name} ${cycles.filter((c) => c.buyPoint === name).length}个完整周期`,
        )
        .join("；") || "完整周期样本仍在积累";
    const sum = (field) =>
      net !== null &&
      days.every((d) => Number.isFinite(d.review.summary[field]))
        ? days.reduce((n, d) => n + d.review.summary[field], 0)
        : null;
    const realized = sum("realizedPnlCents"),
      fees = sum("feeCents"),
      tNet = sum("completedTNetPnlCents");
    const contribution = new Map();
    for (const d of days)
      for (const p of d.review.rows)
        if (Number.isFinite(p.dailyPnlCents))
          contribution.set(
            p.code,
            (contribution.get(p.code) ?? 0) + p.dailyPnlCents,
          );
    const sources =
      [...contribution]
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 4)
        .map(([code, value]) => `${code} ${yuan(value)}元`)
        .join("；") || "无股票收益贡献";
    const text = `模拟练习周报 ${week.start}—${week.end}\n全账户含费损益：${yuan(net)}元；${days.length}个已归档交易日\n已实现 ${yuan(realized)}元；持仓浮盈变化 ${yuan(net !== null && realized !== null ? net - realized : null)}元；费用 ${yuan(fees)}元（已入账）\n已完成T价差 ${yuan(tNet)}元（属于账户收益，不重复相加）；主要贡献：${sources}\n${grouping}\n研究数据缺口：${missing.join("、") || "无"}\n组合研究：${batch?.stage ?? "COLLECTING"}\n${days.map((d) => `${d.date}：${d.ai?.summary?.slice(0, 180) ?? d.review.conclusion}`).join("\n")}\n单日复盘及探索分组不授予策略验证资格。`;
    const payload = {
      version: 1,
      week,
      generatedAt: stamp,
      text,
      missingDates: missing,
      sources: days.map((d) => ({
        date: d.date,
        sourceDigest: d.review.sourceDigest,
      })),
      batchStage: batch?.stage ?? "COLLECTING",
    };
    await env.DB.prepare(
      "INSERT OR IGNORE INTO practice_weekly_reports(week_end,payload,digest,status,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'PENDING',?,?,?)",
    )
      .bind(
        week.end,
        JSON.stringify(payload),
        await digestOf(payload),
        stamp,
        stamp,
        stamp,
      )
      .run();
    row = await env.DB.prepare(
      "SELECT * FROM practice_weekly_reports WHERE week_end=?",
    )
      .bind(week.end)
      .first();
  }
  if (row.status === "SENDING" && row.lease_until < stamp) {
    // A process may have died after the provider accepted a message. Avoid blind duplicates.
    await env.DB.prepare(
      "UPDATE practice_weekly_reports SET status='UNCERTAIN',updated_at=? WHERE week_end=? AND status='SENDING' AND lease_until<?",
    )
      .bind(stamp, week.end, stamp)
      .run();
    return { status: "UNCERTAIN", week: week.end };
  }
  if (row.status !== "PENDING" || row.next_attempt_at > stamp)
    return { status: row.status, week: week.end };
  const payload = JSON.parse(row.payload);
  if ((await digestOf(payload)) !== row.digest)
    return { status: "DIGEST_FAILED", week: week.end };
  const owner = crypto.randomUUID(),
    until = new Date(now.getTime() + 60000).toISOString();
  const claim = await env.DB.prepare(
    "UPDATE practice_weekly_reports SET status='SENDING',lease_owner=?,lease_until=?,attempt=attempt+1,updated_at=? WHERE week_end=? AND status='PENDING' AND next_attempt_at<=?",
  )
    .bind(owner, until, stamp, week.end, stamp)
    .run();
  if (!claim.meta.changes) return { status: "CONTENDED" };
  let result;
  try {
    result = await send({
      channelRef: "feishu",
      env,
      safeMessage: { text: payload.text },
      eventId: `practice-weekly:${week.end}`,
    });
  } catch {
    result = { ok: false, reason: "NETWORK_ERROR" };
  }
  const status = result.ok
    ? "SENT"
    : result.reason === "NETWORK_ERROR"
      ? "UNCERTAIN"
      : result.retryable && row.attempt < 4
        ? "PENDING"
        : "FAILED";
  await env.DB.prepare(
    "UPDATE practice_weekly_reports SET status=?,provider_ref=?,next_attempt_at=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE week_end=? AND status='SENDING' AND lease_owner=?",
  )
    .bind(
      status,
      result.providerRef ?? null,
      new Date(
        now.getTime() + Math.min(3600000, 60000 * 2 ** row.attempt),
      ).toISOString(),
      stamp,
      week.end,
      owner,
    )
    .run();
  return { status, week: week.end, checkedAt: `${clock.date} ${clock.time}` };
}
