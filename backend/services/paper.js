import { PaperRepository, digest } from "../storage/paper.js";
import {
  newBook,
  createPlan,
  defensivePlan,
  executePlan,
  auditLedger,
  RISK_LIMITS,
} from "../domain/trading.js";
import { collectTradingDay, tradingCalendar } from "./market.js";
import { readWeights, aiConfig } from "./review.js";
import { improveStrategy } from "./improvement.js";
import { safeError } from "../http.js";
import { feesForBook } from "../../shared/fees.js";
import { RealtimeRepository } from "../storage/realtime.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../domain/realtime.js";
import { realtimeStatus } from "./realtime.js";
export async function runPaperDay(env, date) {
  try {
    return await settlePaperDay(env, date);
  } catch (error) {
    const reason = safeError(error);
    const repository = new PaperRepository(env);
    try {
      await repository.logRun(date, "ERROR", { date, status: "ERROR", reason });
    } catch {}
    return { date, status: "ERROR", reason };
  }
}

async function settlePaperDay(env, date) {
  const repository = new RealtimeRepository(env);
  let account = await repository.initialize(await readWeights(env));
  const existing = account.book.lastDate === date;
  let settlement = null;
  if (!existing) {
    const from = new Date(
      new Date(`${account.book.lastDate || date}T00:00:00Z`).getTime() -
        20 * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const calendar = await tradingCalendar(from, date);
    if (!calendar.dates.includes(date))
      return {
        status: "NON_TRADING_DAY",
        reason: "指数行情未确认当天为交易日",
      };
    const previousDate =
      calendar.dates.filter((day) => day < date).at(-1) || null;
    if (account.book.lastDate && account.book.lastDate !== previousDate) {
      const reason =
        "存在尚未结算的交易日，请补齐已冻结计划和对应行情后重放；账户暂不跨日结算";
      await repository.logRun(date, "BLOCKED", { reason });
      return { status: "BLOCKED", reason };
    }
    // A new account never retroactively executes an older plan.
    const plan = account.book.lastDate
      ? await repository.plan(previousDate)
      : null;
    if (account.book.lastDate && !plan) {
      const reason = "缺少上一交易日事前计划，结算暂停，避免事后构造交易";
      await repository.logRun(date, "BLOCKED", { reason });
      return { status: "BLOCKED", reason };
    }
    const historical = await repository.history("snapshots", 30);
    const codes = new Set(
      account.book.positions.map((position) => position.code),
    );
    for (const order of plan?.orders || []) codes.add(order.code);
    for (const row of historical)
      for (const stock of JSON.parse(row.payload).stocks.slice(0, 20)) {
        if (codes.size < 600) codes.add(stock.code);
      }
    const minuteCodes = [
      ...new Set([
        ...(plan?.orders || []).map((order) => order.code),
        ...account.book.positions.map((position) => position.code),
      ]),
    ];
    const benchmark = calendar.benchmark.find((row) => row.date === date);
    const dataset = await collectTradingDay(
      date,
      [...codes],
      minuteCodes,
      benchmark,
    );
    dataset.previousTradingDate = previousDate;
    try {
      if (plan) {
        const session =
          (await repository.session(date)) ||
          openSession(account.book, plan, date);
        dataset.executionMode = "realtime";
        settlement = closeSession(account.book, session, dataset);
        if (!session.sequence)
          settlement.notices.push(
            "当日没有实时轮询记录，不补造开盘或盘中成交；仅结算实际持仓",
          );
      } else settlement = executePlan(account.book, plan, dataset);
    } catch (error) {
      await repository.logRun(date, "BLOCKED", { reason: error.message });
      return { status: "BLOCKED", reason: error.message };
    }
    settlement.book.benchmarkBaseCents =
      account.book.benchmarkBaseCents || benchmark?.closeCents || null;
    settlement.equity.benchmarkReturn =
      benchmark?.closeCents && settlement.book.benchmarkBaseCents
        ? benchmark.closeCents / settlement.book.benchmarkBaseCents - 1
        : null;
    const saved = await repository.settle(
      account.revision,
      settlement,
      dataset,
    );
    if (!saved) settlement = null;
    account = await repository.account();
    if (account.book.lastDate !== date)
      return { status: "RETRY", reason: "账户设置同时更新，请重试盘后结算" };
  }
  let improvement;
  try {
    improvement = await improveStrategy(repository, env);
  } catch {
    improvement = {
      status: "ERROR",
      reason: "改进服务暂不可用，原策略继续生成计划",
    };
  }
  account = await repository.account();
  const snapshot = await repository.snapshot(date);
  let nextPlan = await repository.plan(date);
  if (!nextPlan) {
    const strategy = await repository.strategy(account.book);
    nextPlan = await repository.savePlan(
      snapshot
        ? createPlan(
            snapshot,
            account.book,
            strategy,
            account.book.activeStrategy,
            new Date().toISOString(),
          )
        : defensivePlan(
            date,
            account.book,
            strategy,
            account.book.activeStrategy,
            new Date().toISOString(),
          ),
    );
  }
  const response = {
    status: nextPlan ? "SETTLED" : "WAITING_SNAPSHOT",
    date,
    duplicate: existing || !settlement,
    fills: settlement?.ledger.length || 0,
    equity: settlement?.equity || null,
    outcomes: settlement?.outcomes || [],
    notices: settlement?.notices || [],
    nextPlan: nextPlan
      ? {
          signalDate: nextPlan.signalDate,
          orders: nextPlan.orders.length,
          strategyVersion: nextPlan.strategyVersion,
        }
      : null,
    improvement,
    reason: nextPlan
      ? "当日账本已结算，下一交易日计划已冻结"
      : "已结算，等待当日评分后生成下一交易日计划",
  };
  const storedRun = await repository.db
    .prepare("SELECT payload FROM paper_runs WHERE trade_date=? AND status=?")
    .bind(date, "SETTLED")
    .first();
  // A repeated run cannot erase execution feedback from the original settlement.
  if (!storedRun || settlement)
    await repository.logRun(date, response.status, response);
  return response;
}

export async function exportPaper(env, attempt = 0) {
  const repository = new RealtimeRepository(env);
  const { book, revision } = await repository.initialize(
    await readWeights(env),
  );
  const rows = await Promise.all(
    [
      "paper_equity",
      "paper_ledger",
      "paper_plans",
      "paper_market_days",
      "snapshots",
      "paper_configuration_history",
      "paper_plan_revisions",
    ].map((table) => repository.history(table, 100000)),
  );
  const liveSessions = await repository.sessions();
  const liveObservations = await Promise.all(
    liveSessions.map(async (row) => ({
      date: row.payload.date,
      observations: await repository.observations(row.payload.date),
    })),
  );
  const versions = await repository.versions();
  if ((await repository.account()).revision !== revision) {
    if (attempt < 3) return exportPaper(env, attempt + 1);
    throw new Error("账户正在提交成交，请稍后重新导出");
  }
  return {
    format: "limit-lens-paper-v1",
    exportedAt: new Date().toISOString(),
    initialCashCents: book.initialCashCents,
    book,
    riskLimits: RISK_LIMITS,
    feeConfig: feesForBook(book),
    equities: rows[0].map((row) => JSON.parse(row.payload)).reverse(),
    ledger: rows[1]
      .map((row) => JSON.parse(row.payload))
      .sort((a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence),
    plans: rows[2]
      .map((row) => ({ payload: JSON.parse(row.payload), digest: row.digest }))
      .reverse(),
    datasets: rows[3]
      .map((row) => ({ payload: JSON.parse(row.payload), digest: row.digest }))
      .reverse(),
    snapshots: rows[4].map((row) => JSON.parse(row.payload)).reverse(),
    versions,
    configurationHistory: rows[5]
      .map((row) => ({ payload: JSON.parse(row.payload), digest: row.digest }))
      .reverse(),
    supersededPlans: rows[6]
      .map((row) => ({ payload: JSON.parse(row.payload), digest: row.digest }))
      .reverse(),
    realtimeSessions: liveSessions,
    realtimeObservations: liveObservations,
  };
}

export async function verifyExport(bundle) {
  const latest = bundle.book;
  const accounting = auditLedger(
    bundle.initialCashCents,
    bundle.ledger,
    latest,
    bundle.book.positions,
  );
  const plans = new Map(
    bundle.plans.map((row) => [row.payload.signalDate, row.payload]),
  );
  const liveSessions = new Map(
    (bundle.realtimeSessions || []).map((row) => [
      row.payload.date,
      row.payload,
    ]),
  );
  const liveTicks = new Map(
    (bundle.realtimeObservations || []).map((row) => [
      row.date,
      row.observations,
    ]),
  );
  let hashes = true,
    replay = true;
  let book = newBook(bundle.initialCashCents / 100);
  let fillIndex = 0;
  try {
    for (const row of [
      ...bundle.plans,
      ...bundle.datasets,
      ...(bundle.configurationHistory || []),
      ...(bundle.supersededPlans || []),
      ...(bundle.realtimeSessions || []),
      ...(bundle.realtimeObservations || []).flatMap((row) => row.observations),
    ])
      if ((await digest(row.payload)) !== row.digest) hashes = false;
    for (let index = 0; index < bundle.datasets.length; index++) {
      const dataset = bundle.datasets[index].payload;
      const plan = index ? plans.get(dataset.previousTradingDate) : null;
      if (index && (!plan || book.lastDate !== dataset.previousTradingDate)) {
        replay = false;
        break;
      }
      let result;
      if (dataset.executionMode === "realtime") {
        let session = openSession(book, plan, dataset.date),
          fills = [];
        for (const tick of liveTicks.get(dataset.date) || []) {
          const step = advanceSession(book, session, tick.payload);
          book = step.book;
          session = step.session;
          fills.push(...step.ledger);
        }
        result = closeSession(book, session, dataset);
        result.ledger = fills;
        if (!liveSessions.has(dataset.date)) replay = false;
      } else result = executePlan(book, plan, dataset);
      if (
        JSON.stringify(result.ledger) !==
        JSON.stringify(
          bundle.ledger.slice(fillIndex, fillIndex + result.ledger.length),
        )
      )
        replay = false;
      const saved = bundle.equities[index];
      if (
        !saved ||
        [
          "cashCents",
          "equityCents",
          "dailyPnlCents",
          "feesCents",
          "totalReturn",
        ].some((key) => result.equity[key] !== saved[key])
      )
        replay = false;
      fillIndex += result.ledger.length;
      book = result.book;
    }
    for (const [date, savedSession] of [...liveSessions].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      if (date <= (book.lastDate || "")) continue;
      let session = openSession(book, plans.get(book.lastDate), date),
        fills = [];
      for (const tick of liveTicks.get(date) || []) {
        const step = advanceSession(book, session, tick.payload);
        book = step.book;
        session = step.session;
        fills.push(...step.ledger);
      }
      if (
        JSON.stringify(fills) !==
          JSON.stringify(
            bundle.ledger.slice(fillIndex, fillIndex + fills.length),
          ) ||
        session.sequence !== savedSession.sequence ||
        savedSession.status !== "OPEN"
      )
        replay = false;
      fillIndex += fills.length;
    }
    if (
      fillIndex !== bundle.ledger.length ||
      book.equityCents !== bundle.book.equityCents ||
      JSON.stringify(book.positions) !== JSON.stringify(bundle.book.positions)
    )
      replay = false;
  } catch {
    replay = false;
  }
  return {
    passed: accounting.passed && hashes && replay,
    checks: { ...accounting.checks, hashes, replay },
    days: bundle.datasets.length,
    fills: bundle.ledger.length,
    formula: accounting.formula,
    note: "哈希检验用于发现导出文件内部变更，不是第三方签名；公开行情模拟成交不等同于券商实际成交。",
  };
}

export async function paperOverview(env, attempt = 0) {
  const repository = new RealtimeRepository(env);
  const { book, revision } = await repository.initialize(
    await readWeights(env),
  );
  const rows = await Promise.all(
    ["paper_equity", "paper_ledger", "paper_plans", "paper_runs"].map((table) =>
      repository.history(table, table === "paper_ledger" ? 100 : 120),
    ),
  );
  const equities = rows[0].map((row) => JSON.parse(row.payload)).reverse();
  const allLedger = (await repository.history("paper_ledger", 100000)).map(
    (row) => JSON.parse(row.payload),
  );
  const audit = auditLedger(
    book.initialCashCents,
    allLedger,
    book,
    book.positions,
  );
  const canEditCapital = await repository.canEditCapital(book),
    versions = await repository.versions(),
    realtime = await realtimeStatus(env);
  if ((await repository.account()).revision !== revision) {
    if (attempt < 3) return paperOverview(env, attempt + 1);
    throw new Error("账户正在更新，请稍后重试");
  }
  return {
    book,
    equity: equities.at(-1) || null,
    equities,
    ledger: rows[1].map((row) => JSON.parse(row.payload)),
    plan: rows[2][0] ? JSON.parse(rows[2][0].payload) : null,
    run: rows[3][0] ? JSON.parse(rows[3][0].payload) : null,
    audit,
    riskLimits: RISK_LIMITS,
    feeConfig: feesForBook(book),
    canEditCapital,
    versions,
    ai: aiConfig(env),
    realtime,
  };
}
