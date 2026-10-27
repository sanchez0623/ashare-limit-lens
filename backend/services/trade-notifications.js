import { digestOf } from "../domain/research-lineage.js";
import { marketClock } from "../domain/realtime.js";
import { beijingStamp, instanceAlias } from "../domain/alert-messages.js";
import { BUY_POINT_LABELS } from "../../shared/buy-point-type.js";
import { observationCoverage } from "./entry-observation.js";
import { alertsEnabled, sendNotification } from "./notifications.js";

const ACTIONS = {
  OPEN: "建仓",
  ADD: "加仓",
  ADD_PROFIT: "盈利加仓",
  ADD_LOSS: "亏损加仓",
  REDUCE: "减仓",
  EXIT: "清仓",
  CLOSE: "清仓",
  T_FORWARD: "正向T",
  T_REVERSE: "反向T",
  T_BUY: "做T买入",
  T_SELL: "做T卖出",
  RECOVER: "恢复底仓",
  T_RECOVERY: "做T第二腿",
};
const ORDER_STATES = {
  CANCELLED: "已撤单",
  EXPIRED: "已到期",
  EXPIRED_PARTIAL: "部分成交后到期",
  PENDING: "等待执行",
  PARTIAL: "部分成交",
};
const clean = (value) =>
  String(value ?? "")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 60);
const money = (value) =>
  Number.isSafeInteger(value) ? (value / 100).toFixed(2) : "未知";
const sum = (rows, key) => rows.reduce((n, row) => n + row[key], 0);
const scope = (session) => session?.initialBook?.tradingCycleId ?? "primary";
const quantity = (position) =>
  (position.lots ?? []).reduce((n, lot) => n + lot.quantity, 0);
const enabled = (env) =>
  env.TRADE_NOTIFICATIONS_ENABLED !== "false" && alertsEnabled(env);

function validateFill(fill, date) {
  if (
    fill.date !== date ||
    !fill.id ||
    !/^\d{6}$/.test(fill.code) ||
    !/^\d{2}:\d{2}:\d{2}$/.test(fill.time) ||
    !["BUY", "SELL"].includes(fill.side) ||
    !Number.isSafeInteger(fill.quantity) ||
    fill.quantity <= 0 ||
    !Number.isSafeInteger(fill.priceCents) ||
    fill.priceCents <= 0 ||
    !Number.isSafeInteger(fill.sequence) ||
    fill.sequence < 0 ||
    !Number.isSafeInteger(fill.realizedPnlCents) ||
    fill.notionalCents !== fill.quantity * fill.priceCents ||
    !Number.isSafeInteger(fill.feeCents) ||
    fill.feeCents < 0 ||
    fill.cashDeltaCents !==
      (fill.side === "BUY" ? -fill.notionalCents : fill.notionalCents) -
        fill.feeCents
  )
    throw new Error("TRADE_NOTIFICATION_INVALID_FILL");
}

function fillLine(fill) {
  const action =
    ACTIONS[fill.intent ?? fill.action] ?? clean(fill.intent ?? fill.action);
  return `${fill.time} ${clean(fill.name)}（${fill.code}）${fill.side === "BUY" ? "买入" : "卖出"}·${action} ${fill.quantity}股 × ${money(fill.priceCents)}元，成交${money(fill.notionalCents)}元，费用${money(fill.feeCents)}元`;
}

function progress(fill, fills, session) {
  const order = session?.orders?.find((row) => row.id === fill.orderId);
  if (!order) return null;
  const completed = fills
    .filter(
      (row) => row.orderId === fill.orderId && row.sequence <= fill.sequence,
    )
    .reduce((n, row) => n + row.quantity, 0);
  return { completed, target: order.quantity };
}

export function formatFillNotification(fill, fills, session, now, alias) {
  validateFill(fill, fill.date);
  const at = `${fill.date}T${fill.time}+08:00`;
  const delayed = Date.parse(now) - Date.parse(at) > 60000;
  const p = progress(fill, fills, session);
  return [
    `【模拟交易·${delayed ? "成交补发" : "成交提醒"}】${alias}`,
    `成交时间（北京时间）：${fill.date} ${fill.time}`,
    fillLine(fill),
    fill.buyPoint
      ? `买点：${BUY_POINT_LABELS[fill.buyPoint] ?? clean(fill.buyPoint)}`
      : null,
    p
      ? `订单截至本笔累计：${p.completed}/${p.target}股${p.completed < p.target ? "（部分成交）" : ""}`
      : null,
    `本笔现金${fill.cashDeltaCents < 0 ? "支出" : "收入"}：${money(Math.abs(fill.cashDeltaCents))}元（已含费用）`,
    fill.side === "SELL"
      ? `本笔已实现盈亏：${money(fill.realizedPnlCents)}元`
      : null,
    delayed ? `通知时间（北京时间）：${beijingStamp(now)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function splitLines(lines, maxBytes = 11000) {
  const encoder = new TextEncoder(),
    parts = [];
  let part = [];
  for (const line of lines) {
    if (
      part.length &&
      encoder.encode([...part, line].join("\n")).length > maxBytes
    ) {
      parts.push(part.join("\n"));
      part = [];
    }
    part.push(line);
  }
  if (part.length) parts.push(part.join("\n"));
  return parts;
}

async function dayFacts(env, date) {
  const [ledger, storedSession] = await Promise.all([
    env.DB.prepare(
      "SELECT payload FROM paper_ledger WHERE trade_date=? ORDER BY CAST(json_extract(payload,'$.sequence') AS INTEGER),id",
    )
      .bind(date)
      .all(),
    env.DB.prepare(
      "SELECT payload,digest FROM paper_live_sessions WHERE trade_date=?",
    )
      .bind(date)
      .first(),
  ]);
  const fills = ledger.results.map((row) => JSON.parse(row.payload));
  fills.forEach((fill) => validateFill(fill, date));
  const session = storedSession && JSON.parse(storedSession.payload);
  if (storedSession && (await digestOf(session)) !== storedSession.digest)
    throw new Error("TRADE_NOTIFICATION_SESSION_DIGEST");
  return { fills, session };
}

export async function buildDailyTradeNotifications(
  env,
  date,
  now = new Date(),
) {
  const stored = await env.DB.prepare(
    "SELECT payload FROM paper_equity WHERE trade_date=?",
  )
    .bind(date)
    .first();
  if (!stored) return null;
  const equity = JSON.parse(stored.payload),
    { fills, session } = await dayFacts(env, date);
  if (
    equity.date !== date ||
    equity.complete === false ||
    (session && session.status !== "CLOSED")
  )
    return null;
  if (session && session.fillCount !== fills.length)
    throw new Error("TRADE_NOTIFICATION_LEDGER_COUNT");
  const buy = fills.filter((row) => row.side === "BUY"),
    sell = fills.filter((row) => row.side === "SELL");
  const lines = [
    `成交${fills.length}笔（买入${buy.length}笔 / 卖出${sell.length}笔）`,
    `买入成交额${money(sum(buy, "notionalCents"))}元；卖出成交额${money(sum(sell, "notionalCents"))}元`,
    `当日费用${money(sum(fills, "feeCents"))}元；当日已实现盈亏${money(sum(fills, "realizedPnlCents"))}元`,
    `账户当日损益（含费）：${money(equity.dailyPnlCents)}元；收盘权益：${money(equity.equityCents)}元`,
    "",
    "逐笔成交（北京时间）：",
    ...(fills.length ? fills.map(fillLine) : ["今日无成交"]),
  ];
  const incomplete = session?.orders?.filter(
    (order) => order.quantity > order.filledQuantity,
  );
  if (incomplete?.length)
    lines.push(
      "",
      "未成交订单：",
      ...incomplete.map(
        (order) =>
          `${order.code} ${ACTIONS[order.intent ?? order.action] ?? clean(order.action)}：${order.filledQuantity}/${order.quantity}股，${ORDER_STATES[order.status] ?? clean(order.status)}${order.reason ? `（${clean(order.reason)}）` : ""}`,
      ),
    );
  const positions = session?.closingBook?.positions;
  if (positions)
    lines.push(
      "",
      "收盘持仓：",
      ...(positions.length
        ? positions.map(
            (position) =>
              `${clean(position.name)}（${position.code}）${quantity(position)}股，收盘价${money(position.markCents)}元`,
          )
        : ["空仓"]),
    );
  const ticks = (
    await env.DB.prepare(
      "SELECT json_extract(payload,'$.observedAt') AS observedAt FROM paper_live_ticks WHERE trade_date=? ORDER BY sequence",
    )
      .bind(date)
      .all()
  ).results;
  if (!observationCoverage(ticks, date))
    lines.push(
      "",
      `盘中观测不完整${session?.lastObservedAt ? `，最后观测 ${beijingStamp(session.lastObservedAt)}` : ""}；本报告仅列实际已记录成交。`,
    );
  lines.push(`生成时间（北京时间）：${beijingStamp(now.toISOString())}`);
  const sourceDigest = await digestOf({
    fills,
    sessionDigest: session ? await digestOf(session) : null,
    equity,
  });
  const parts = splitLines(lines),
    alias = instanceAlias(env);
  return {
    cycleId: scope(session),
    sourceDigest,
    texts: parts.map(
      (text, i) =>
        `【模拟交易·每日明细】${date} · ${alias}${parts.length > 1 ? `（${i + 1}/${parts.length}）` : ""}\n${text}`,
    ),
  };
}

async function enqueue(
  env,
  { kind, cycleId, ref, date, texts, sourceDigest },
  stamp,
) {
  const prepared = await Promise.all(
    texts.map(async (text, part) => {
      const id = `trade-${await digestOf({ kind, cycleId, ref, part })}`;
      const payload = { version: 1, kind, date, text, sourceDigest };
      return { id, part, payload, digest: await digestOf(payload) };
    }),
  );
  await env.DB.batch(
    prepared.map((row) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO paper_trade_notifications(id,kind,cycle_id,source_ref,trade_date,part,payload,digest,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        row.id,
        kind,
        cycleId,
        ref,
        date,
        row.part,
        JSON.stringify(row.payload),
        row.digest,
        stamp,
        stamp,
        stamp,
      ),
    ),
  );
}

export async function tradeNotificationStatus(env) {
  const counts = (
    await env.DB.prepare(
      "SELECT status,COUNT(*) AS count FROM paper_trade_notifications GROUP BY status",
    ).all()
  ).results;
  const latest = (
    await env.DB.prepare(
      "SELECT kind,trade_date,status,attempt,last_error,updated_at FROM paper_trade_notifications ORDER BY updated_at DESC LIMIT 5",
    ).all()
  ).results;
  return {
    enabled: enabled(env),
    counts: Object.fromEntries(counts.map((row) => [row.status, row.count])),
    latest,
  };
}

export async function processTradeNotifications(
  env,
  { now = new Date(), send = sendNotification, limit = 5 } = {},
) {
  if (!enabled(env))
    return { status: "CHANNEL_NOT_CONFIGURED", deliveries: [] };
  const stamp = now.toISOString(),
    clock = marketClock(now);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO settings(key,value) VALUES('trade-notification-start-date',?)",
  )
    .bind(JSON.stringify({ date: clock.date, createdAt: stamp }))
    .run();
  const start = JSON.parse(
    (
      await env.DB.prepare(
        "SELECT value FROM settings WHERE key='trade-notification-start-date'",
      ).first()
    ).value,
  ).date;
  // After settlement, the daily report carries every fill. Do not announce
  // old fills as fresh trades when the feature is first enabled after close.
  const settled = await env.DB.prepare(
    "SELECT 1 FROM paper_equity WHERE trade_date=?",
  )
    .bind(clock.date)
    .first();
  if (!settled && clock.date >= start) {
    const facts = await dayFacts(env, clock.date),
      cycleId = scope(facts.session);
    const queued = (
      await env.DB.prepare(
        "SELECT source_ref FROM paper_trade_notifications WHERE kind='FILL' AND cycle_id=? AND trade_date=?",
      )
        .bind(cycleId, clock.date)
        .all()
    ).results;
    const known = new Set(queued.map((row) => row.source_ref));
    for (const fill of facts.fills
      .filter((row) => !known.has(row.id))
      .slice(0, 100)) {
      await enqueue(
        env,
        {
          kind: "FILL",
          cycleId,
          ref: fill.id,
          date: clock.date,
          texts: [
            formatFillNotification(
              fill,
              facts.fills,
              facts.session,
              stamp,
              instanceAlias(env),
            ),
          ],
          sourceDigest: await digestOf(fill),
        },
        stamp,
      );
    }
  }
  const days = (
    await env.DB.prepare(
      `SELECT e.trade_date FROM paper_equity e LEFT JOIN paper_live_sessions s ON s.trade_date=e.trade_date
     WHERE e.trade_date>=? AND e.trade_date<=? AND NOT EXISTS (
       SELECT 1 FROM paper_trade_notifications n WHERE n.kind='DAILY' AND n.source_ref=e.trade_date
       AND n.cycle_id=COALESCE(json_extract(s.payload,'$.initialBook.tradingCycleId'),'primary'))
     ORDER BY e.trade_date LIMIT 5`,
    )
      .bind(start, clock.date)
      .all()
  ).results;
  for (const row of days) {
    if (row.trade_date === clock.date && clock.time < "15:05:00") continue;
    const report = await buildDailyTradeNotifications(env, row.trade_date, now);
    if (report)
      await enqueue(
        env,
        {
          kind: "DAILY",
          cycleId: report.cycleId,
          ref: row.trade_date,
          date: row.trade_date,
          texts: report.texts,
          sourceDigest: report.sourceDigest,
        },
        stamp,
      );
  }
  // A crashed sender may already have delivered. Preserve uncertainty rather
  // than replaying an in-flight message with an unknown acknowledgement.
  await env.DB.prepare(
    "UPDATE paper_trade_notifications SET status='UNCERTAIN',last_error='DELIVERY_ACK_MISSING',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='SENDING' AND lease_until<?",
  )
    .bind(stamp, stamp)
    .run();
  const pending = (
    await env.DB.prepare(
      "SELECT * FROM paper_trade_notifications WHERE status='PENDING' AND next_attempt_at<=? ORDER BY CASE kind WHEN 'FILL' THEN 0 ELSE 1 END,trade_date,part,created_at LIMIT ?",
    )
      .bind(stamp, limit)
      .all()
  ).results;
  const deliveries = [];
  for (const row of pending) {
    const payload = JSON.parse(row.payload);
    if ((await digestOf(payload)) !== row.digest) {
      await env.DB.prepare(
        "UPDATE paper_trade_notifications SET status='FAILED',last_error='DIGEST_FAILED',updated_at=? WHERE id=? AND status='PENDING'",
      )
        .bind(stamp, row.id)
        .run();
      deliveries.push({
        id: row.id,
        status: "FAILED",
        reason: "DIGEST_FAILED",
      });
      continue;
    }
    const owner = crypto.randomUUID(),
      until = new Date(now.getTime() + 60000).toISOString();
    const claimed = await env.DB.prepare(
      "UPDATE paper_trade_notifications SET status='SENDING',attempt=attempt+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND status='PENDING' AND next_attempt_at<=?",
    )
      .bind(owner, until, stamp, row.id, stamp)
      .run();
    if (!claimed.meta.changes) continue;
    let outcome;
    try {
      outcome = await send({
        env,
        channelRef: "feishu",
        safeMessage: { text: payload.text },
        eventId: row.id,
      });
    } catch {
      outcome = { ok: false, reason: "NETWORK_ERROR" };
    }
    const uncertain = ["NETWORK_ERROR", "INVALID_RESPONSE"].includes(
      outcome.reason,
    );
    const status = outcome.ok
      ? "SENT"
      : uncertain
        ? "UNCERTAIN"
        : outcome.retryable && row.attempt + 1 < 5
          ? "PENDING"
          : "FAILED";
    await env.DB.prepare(
      "UPDATE paper_trade_notifications SET status=?,provider_ref=?,last_error=?,next_attempt_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='SENDING' AND lease_owner=?",
    )
      .bind(
        status,
        outcome.providerRef ?? null,
        outcome.reason ?? null,
        new Date(now.getTime() + 60000 * 2 ** row.attempt).toISOString(),
        stamp,
        row.id,
        owner,
      )
      .run();
    deliveries.push({
      id: row.id,
      kind: row.kind,
      date: row.trade_date,
      status,
      reason: outcome.reason,
    });
  }
  return {
    status: "PROCESSED",
    deliveries,
    ...(await tradeNotificationStatus(env)),
  };
}
