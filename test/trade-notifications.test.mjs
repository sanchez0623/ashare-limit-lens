import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { digestOf } from "../backend/domain/research-lineage.js";
import {
  processTradeNotifications,
  buildDailyTradeNotifications,
  tradeNotificationStatus,
} from "../backend/services/trade-notifications.js";
import { sendNotification } from "../backend/services/notifications.js";

const date = "2026-10-26",
  morning = new Date(`${date}T10:44:30+08:00`),
  close = new Date(`${date}T15:06:00+08:00`);
const fill = (sequence = 0, quantity = 300) => ({
  id: `fill-${sequence}`,
  date,
  sequence,
  signalDate: "2026-10-23",
  time: `10:${String(44 + Math.floor(sequence / 60)).padStart(2, "0")}:${String(sequence % 60).padStart(2, "0")}`,
  code: "603278",
  name: "合成样本",
  action: "OPEN",
  intent: "OPEN",
  side: "BUY",
  quantity,
  priceCents: 1712,
  notionalCents: quantity * 1712,
  feeCents: 533,
  cashDeltaCents: -quantity * 1712 - 533,
  realizedPnlCents: 0,
  orderId: "order-1",
  buyPoint: "broken-board-dip",
});

async function fixture(t, { fills = [fill()], settled = false } = {}) {
  const DB = localDatabase();
  t.after(() => DB.close());
  const env = {
    DB,
    FEISHU_WEBHOOK_URL: "https://feishu.test/synthetic",
    ALERT_INSTANCE_ALIAS: "合成测试",
  };
  for (const row of fills)
    await DB.prepare(
      "INSERT INTO paper_ledger(id,trade_date,payload) VALUES(?,?,?)",
    )
      .bind(row.id, date, JSON.stringify(row))
      .run();
  const total = fills.reduce((n, row) => n + row.quantity, 0);
  const session = {
    date,
    status: settled ? "CLOSED" : "OPEN",
    initialBook: { tradingCycleId: "cycle-1" },
    fillCount: fills.length,
    lastObservedAt: `${date}T05:32:05.000Z`,
    orders: [
      {
        id: "order-1",
        code: "603278",
        action: "OPEN",
        quantity: Math.max(4500, total),
        filledQuantity: total,
        status: settled ? "CANCELLED" : "PARTIAL",
        reason: "合成原因",
      },
    ],
    closingBook: {
      positions: fills.length
        ? [
            {
              code: "603278",
              name: "合成样本",
              lots: [{ quantity: total }],
              markCents: 1725,
            },
          ]
        : [],
    },
  };
  await DB.prepare(
    "INSERT INTO paper_live_sessions(trade_date,payload,digest) VALUES(?,?,?)",
  )
    .bind(date, JSON.stringify(session), await digestOf(session))
    .run();
  if (settled)
    await DB.prepare("INSERT INTO paper_equity(trade_date,payload) VALUES(?,?)")
      .bind(
        date,
        JSON.stringify({
          date,
          complete: true,
          dailyPnlCents: fills.length ? 3367 : 0,
          equityCents: 100003367,
        }),
      )
      .run();
  return { DB, env, session, fills };
}
const success = async () => ({ ok: true, providerRef: "synthetic-ack" });

test("部分成交推送真实份额、价格、费用和当时累计进度，重复轮询不重发", async (t) => {
  const f = await fixture(t, { fills: [fill(0), fill(1, 200)] }),
    messages = [];
  const before = (
    await f.DB.prepare("SELECT payload FROM paper_ledger ORDER BY id").all()
  ).results;
  const send = async (message) => {
    messages.push(message);
    return success();
  };
  await processTradeNotifications(f.env, { now: morning, send });
  await processTradeNotifications(f.env, { now: morning, send });
  assert.equal(messages.length, 2);
  assert.match(
    messages[0].safeMessage.text,
    /300股 × 17\.12元，成交5136\.00元，费用5\.33元/,
  );
  assert.match(messages[0].safeMessage.text, /累计：300\/4500股（部分成交）/);
  assert.match(messages[1].safeMessage.text, /累计：500\/4500股/);
  assert.equal(messages[0].channelRef, "feishu");
  assert.deepEqual(
    (await f.DB.prepare("SELECT payload FROM paper_ledger ORDER BY id").all())
      .results,
    before,
  );
  assert.equal((await tradeNotificationStatus(f.env)).counts.SENT, 2);
});

test("盘后首次启用只发送完整日报，含北京时间明细、收盘持仓、余单和数据缺口", async (t) => {
  const f = await fixture(t, { settled: true }),
    sent = [];
  const result = await processTradeNotifications(f.env, {
    now: close,
    send: async (message) => {
      sent.push(message);
      return success();
    },
  });
  assert.equal(result.deliveries.length, 1);
  assert.match(sent[0].safeMessage.text, /每日明细/);
  assert.match(sent[0].safeMessage.text, /成交1笔（买入1笔 \/ 卖出0笔）/);
  assert.match(sent[0].safeMessage.text, /账户当日损益（含费）：33\.67元/);
  assert.match(sent[0].safeMessage.text, /300\/4500股，已撤单/);
  assert.match(sent[0].safeMessage.text, /收盘持仓：[\s\S]*300股/);
  assert.match(
    sent[0].safeMessage.text,
    /盘中观测不完整，最后观测 2026-10-26 13:32:05/,
  );
  await processTradeNotifications(f.env, {
    now: close,
    send: async () => {
      throw new Error("不应再次发送");
    },
  });
  assert.equal((await tradeNotificationStatus(f.env)).counts.SENT, 1);
});

test("每日报告等待15:05且仅在结算后发送；零成交明确通知", async (t) => {
  const f = await fixture(t, { settled: true, fills: [] }),
    sent = [];
  const send = async (message) => {
    sent.push(message);
    return success();
  };
  await processTradeNotifications(f.env, {
    now: new Date(`${date}T15:04:00+08:00`),
    send,
  });
  assert.equal(sent.length, 0);
  await processTradeNotifications(f.env, { now: close, send });
  assert.equal(sent.length, 1);
  assert.match(sent[0].safeMessage.text, /今日无成交/);
});

test("并发通知进程由数据库认领同一消息，成交只发一次", async (t) => {
  const f = await fixture(t),
    sent = [];
  const send = async (message) => {
    sent.push(message);
    return success();
  };
  await Promise.all([
    processTradeNotifications(f.env, { now: morning, send }),
    processTradeNotifications(f.env, { now: morning, send }),
  ]);
  assert.equal(sent.length, 1);
});

test("飞书明确限流时有界退避重试；超时或发送中崩溃记为不确定，不盲目重复", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const send = async () =>
    ++calls === 1
      ? { ok: false, retryable: true, reason: "RATE_LIMITED" }
      : success();
  await processTradeNotifications(f.env, { now: morning, send });
  await processTradeNotifications(f.env, { now: morning, send });
  assert.equal(calls, 1);
  await processTradeNotifications(f.env, {
    now: new Date(morning.getTime() + 61000),
    send,
  });
  assert.equal(calls, 2);
  assert.equal((await tradeNotificationStatus(f.env)).counts.SENT, 1);
  const unknown = await fixture(t);
  await processTradeNotifications(unknown.env, {
    now: morning,
    send: async () => ({ ok: false, reason: "NETWORK_ERROR" }),
  });
  await processTradeNotifications(unknown.env, {
    now: new Date(morning.getTime() + 120000),
    send: async () => {
      throw new Error("禁止盲目重发");
    },
  });
  assert.equal(
    (await tradeNotificationStatus(unknown.env)).counts.UNCERTAIN,
    1,
  );
  await unknown.DB.prepare(
    "UPDATE paper_trade_notifications SET status='SENDING',lease_until=?,lease_owner='dead' WHERE status='UNCERTAIN'",
  )
    .bind(morning.toISOString())
    .run();
  await processTradeNotifications(unknown.env, {
    now: new Date(morning.getTime() + 120000),
    send: async () => {
      throw new Error("禁止重放未知发送");
    },
  });
  assert.equal(
    (await tradeNotificationStatus(unknown.env)).latest[0].last_error,
    "DELIVERY_ACK_MISSING",
  );
});

test("大量逐笔明细按字节分页完整发送，保留第101笔及后续成交", async (t) => {
  const fills = Array.from({ length: 130 }, (_, i) => fill(i, 100));
  const f = await fixture(t, { settled: true, fills });
  const report = await buildDailyTradeNotifications(f.env, date, close);
  assert.ok(report.texts.length > 1);
  for (const text of report.texts)
    assert.ok(new TextEncoder().encode(text).length < 12000);
  assert.equal(
    (
      report.texts.join("\n").match(/\d\d:\d\d:\d\d 合成样本（603278）买入/g) ??
      []
    ).length,
    130,
  );
  const sent = [],
    send = async (message) => {
      sent.push(message);
      return success();
    };
  await processTradeNotifications(f.env, { now: close, send, limit: 1 });
  await processTradeNotifications(f.env, { now: close, send, limit: 20 });
  assert.equal(sent.length, report.texts.length);
});

test("没有配置或明确关闭交易通知时不发送、不登记；未验证数据不当作成交推送", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await processTradeNotifications(
        { DB: f.DB },
        { now: morning, send: success },
      )
    ).deliveries.length,
    0,
  );
  assert.equal(
    (
      await processTradeNotifications(
        { ...f.env, TRADE_NOTIFICATIONS_ENABLED: "false" },
        { now: morning, send: success },
      )
    ).deliveries.length,
    0,
  );
  assert.equal(
    (
      await f.DB.prepare(
        "SELECT COUNT(*) AS n FROM paper_trade_notifications",
      ).first()
    ).n,
    0,
  );
  await f.DB.prepare("UPDATE paper_ledger SET payload=?")
    .bind(JSON.stringify({ ...fill(), notionalCents: 1 }))
    .run();
  await assert.rejects(
    processTradeNotifications(f.env, { now: morning, send: success }),
    /INVALID_FILL/,
  );
});

test("飞书签名在JSON请求体内并校验HMAC，业务拒绝不冒充发送成功", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const secret = "synthetic-only",
    calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ code: calls.length === 1 ? 0 : 19021 });
  };
  const input = {
    channelRef: "feishu",
    env: {
      FEISHU_WEBHOOK_URL: "https://feishu.test/hook",
      FEISHU_SECRET: secret,
    },
    safeMessage: { text: "合成交易通知" },
    eventId: "synthetic-id",
  };
  assert.equal((await sendNotification(input)).ok, true);
  const { timestamp, sign } = calls[0].body;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${timestamp}\n${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  assert.equal(
    sign,
    btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.sign("HMAC", key, new Uint8Array()),
        ),
      ),
    ),
  );
  assert.equal(calls[0].url, "https://feishu.test/hook");
  assert.match(calls[0].body.content.text, /synthetic-id/);
  assert.equal((await sendNotification(input)).reason, "CONFIG_ERROR");
});
