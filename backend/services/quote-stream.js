import { tradingQuotes } from "./market.js";
import { QuoteFrameRepository } from "../storage/quotes.js";
import { RealtimeRepository } from "../storage/realtime.js";
import { ShadowAccountRepository } from "../storage/shadow.js";
import { marketClock, inSession } from "../domain/realtime.js";
import {
  collectIntradayInputs,
  verifyAuctionQuotes,
} from "./intraday-inputs.js";

// 联合行情采集（§7.1）：一次采集，多账本独立消费。
// 订阅股票为主账户、所有匹配组合及持续基线的持仓、未完成保护/补腿订单、冻结计划之并集，
// 另加上一交易日冻结涨停样本全集作为研究池；持仓不再涨停仍持续采集。
// 采集独立运行，不受主账户"未熔断、未结算、计划就绪"等执行条件影响。

export async function buildJointQuotePool(env, { now = new Date() } = {}) {
  const papers = new RealtimeRepository(env);
  const shadows = new ShadowAccountRepository(env);
  const clock = marketClock(now);
  const codes = new Set();
  const entryPlans = [];
  const sources = { primary: [], researchPool: [], shadow: {} };
  let primary = null;
  try {
    primary = await papers.account();
  } catch {
    primary = null;
  }
  if (primary?.book) {
    const primaryCodes = new Set();
    for (const position of primary.book.positions ?? [])
      primaryCodes.add(position.code);
    const plan = primary.book.lastDate
      ? await papers.plan(primary.book.lastDate)
      : null;
    for (const order of plan?.orders ?? []) primaryCodes.add(order.code);
    if (plan?.entryExecutionPolicy) {
      entryPlans.push(plan);
      for (const code of plan.entryExecutionPolicy.candidates)
        primaryCodes.add(code);
    }
    for (const code of primaryCodes) codes.add(code);
    sources.primary = [...primaryCodes].sort();
  }
  for (const account of await shadows.accounts()) {
    if (account.status !== "ACTIVE") continue;
    const accountCodes = new Set();
    for (const position of account.book.positions ?? [])
      accountCodes.add(position.code);
    const plan = await shadows.latestPlan(account.accountId);
    for (const order of plan?.orders ?? []) accountCodes.add(order.code);
    if (plan?.entryExecutionPolicy) {
      entryPlans.push(plan);
      for (const code of plan.entryExecutionPolicy.candidates)
        accountCodes.add(code);
    }
    for (const code of accountCodes) codes.add(code);
    if (accountCodes.size)
      sources.shadow[account.accountId] = [...accountCodes].sort();
  }
  const snapshotRows = await papers.history("snapshots", 1);
  if (snapshotRows[0]) {
    const snapshot = JSON.parse(snapshotRows[0].payload);
    for (const stock of snapshot.stocks ?? []) codes.add(stock.code);
    sources.researchPool = (snapshot.stocks ?? []).map((stock) => stock.code);
    sources.researchPoolDate = snapshot.date;
  }
  return { codes: [...codes].sort(), sources, clock, entryPlans };
}

export async function captureQuoteFrame(env, now, { providers = {} } = {}) {
  const clock = marketClock(now);
  if (!inSession(clock.time)) return null;
  const pool = await buildJointQuotePool(env, { now });
  const inputs = await collectIntradayInputs(
    pool.entryPlans[0],
    clock.date,
    pool.codes,
    { providers, now, env },
  );
  if (pool.entryPlans.length) {
    const additional = (inputs?.market?.discoveries ?? [])
      .filter((row) =>
        pool.entryPlans.some((p) => p.entryExecutionPolicy.history[row.code]),
      )
      .map((row) => row.code)
      .sort()
      .slice(0, 200);
    pool.codes = [...new Set([...pool.codes, ...additional])].sort();
  }
  if (!pool.codes.length) return null;
  const quotes = await (providers.quotes ?? tradingQuotes)(
    pool.codes,
    clock.date,
  );
  const observedAt = (providers.quotes ? now : new Date()).toISOString();
  const missingCodes = pool.codes.filter((code) => !quotes[code]);
  const frame = await new QuoteFrameRepository(env).appendFrame({
    tradeDate: clock.date,
    observedAt,
    quotes,
    entryInputs: verifyAuctionQuotes(inputs, quotes, clock.date),
    pollIntervalSeconds: Number(env.TRADING_POLL_SECONDS ?? 10),
    pool: {
      codes: pool.codes,
      sources: pool.sources,
      declaredAt: new Date().toISOString(),
    },
    capture: {
      missingCodes,
      batches: Math.ceil(pool.codes.length / 150),
      note: "HTTP 分批不是原子快照；每只股票按自身时间戳检查新鲜度，缺失代码如实登记",
    },
  });
  return {
    ...frame,
    quotes,
    poolCodes: pool.codes,
    missingCodes,
  };
}
