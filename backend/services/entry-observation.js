import {
  ShadowAccountRepository,
  SHADOW_ACCOUNT_KINDS,
} from "../storage/shadow.js";
import { RealtimeRepository } from "../storage/realtime.js";
import { QuoteFrameRepository } from "../storage/quotes.js";
import { freezePortfolioPlan, settlePortfolioDay } from "./portfolio-runner.js";
import { buildIntradayContext } from "./intraday-inputs.js";
import { collectTradingDay } from "./market.js";
import {
  openSession,
  advanceSession,
  closeSession,
  marketClock,
} from "../domain/realtime.js";
import { canonicalJson, digestOf } from "../domain/research-lineage.js";
import { INTRADAY_ENTRY_VERSION } from "../domain/intraday-entry.js";
import { executionEngineBuildDigest } from "../domain/execution-build.js";
import { assertStoredProgramPlan } from "./strategy-program-evidence.js";
import {
  OBSERVATION_SCHEDULE,
  observationMaintenanceOpen,
  observationVerificationOpen,
} from "../../shared/observation-schedule.js";

export const ENTRY_OBSERVER_ID = "intraday-entry-observation-v1";
const requestKey = "intraday-entry-observation-request";
const readinessKey = "intraday-entry-readiness";
const readSetting = async (db, key) => {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key=?")
    .bind(key)
    .first();
  return row ? JSON.parse(row.value) : null;
};
const writeSetting = (db, key, value) =>
  db
    .prepare(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .bind(key, JSON.stringify(value))
    .run();

export async function entryObservationStatus(env) {
  const shadows = new ShadowAccountRepository(env);
  const [requested, account, readiness, preparation] = await Promise.all([
    readSetting(env.DB, requestKey),
    shadows.account(ENTRY_OBSERVER_ID),
    readSetting(env.DB, readinessKey),
    readSetting(env.DB, "intraday-entry-observation-preparation"),
  ]);
  const ready =
    readiness?.passed === true &&
    readiness.version === INTRADAY_ENTRY_VERSION &&
    readiness.engineBuild === (await executionEngineBuildDigest());
  const plan = account ? await shadows.latestPlan(account.accountId) : null;
  return {
    requested: !!requested,
    status: ready
      ? "READY"
      : account
        ? "OBSERVING"
        : requested
          ? (preparation?.status ?? "WAITING_CLOSE")
          : "NOT_STARTED",
    ready,
    readiness,
    signalDate: plan?.signalDate ?? null,
    candidates: plan?.entryExecutionPolicy?.candidates.length ?? 0,
    message: ready
      ? "整日影子观察与重放核验已通过，可对后续新计划启用盘中执行"
      : account
        ? "影子账户独立采集与模拟，等待一个完整交易日的重放核验"
        : requested
          ? preparation?.status === "WAITING_HISTORY"
            ? "已登记；日线尚未覆盖信号日，常驻服务会在数据更新后、下次开盘前冻结影子计划"
            : "已登记，等待今日盘后结算后冻结下一交易日影子计划"
          : "V5 可直接选择盘中条件执行；可另外启动影子观察核验，不影响选择",
  };
}

export async function requestEntryObservation(env) {
  await writeSetting(env.DB, requestKey, {
    requestedAt: new Date().toISOString(),
    version: INTRADAY_ENTRY_VERSION,
  });
  const clock = marketClock();
  if (clock.time >= OBSERVATION_SCHEDULE.verificationStart)
    await maintainEntryObservation(env, clock.date);
  return entryObservationStatus(env);
}

export function observationCoverage(frames, date, pollSeconds = 10) {
  const ms = frames.map((f) => Date.parse(f.observedAt));
  const at = (time) => Date.parse(`${date}T${time}+08:00`);
  const tolerance = Math.max(20000, pollSeconds * 2000);
  const morning = ms.filter((t) => t >= at("09:30:00") && t <= at("11:30:00"));
  const afternoon = ms.filter(
    (t) => t >= at("13:00:00") && t <= at("14:55:00"),
  );
  const segment = (ticks, start, end) =>
    ticks.length > 1 &&
    ticks[0] - at(start) <= tolerance &&
    at(end) - ticks.at(-1) <= tolerance &&
    ticks.every(
      (t, i) => !i || (t - ticks[i - 1] > 0 && t - ticks[i - 1] <= tolerance),
    );
  return (
    segment(morning, "09:30:00", "11:30:00") &&
    segment(afternoon, "13:00:00", "14:55:00")
  );
}

export async function verifyEntryObservation(
  env,
  date,
  closingDataset,
  now = new Date(),
) {
  if (!observationVerificationOpen(marketClock(now), date))
    return {
      status: "WAITING_VERIFICATION",
      date,
      verificationStart: OBSERVATION_SCHEDULE.verificationStart,
    };
  const shadows = new ShadowAccountRepository(env);
  const stored = await shadows.session(ENTRY_OBSERVER_ID, date);
  if (!stored) return null;
  const frames = await new QuoteFrameRepository(env).framesForDate(date);
  const allFills = (await shadows.ledger(ENTRY_OBSERVER_ID))
    .filter((l) => l.date === date)
    .sort((a, b) => a.sequence - b.sequence);
  const usableFrames = frames.filter((frame) => {
    const now = Date.parse(frame.observedAt);
    const market = frame.payload.entryInputs?.market;
    const marketAge = now - Date.parse(market?.observedAt);
    return (
      market?.date === date &&
      marketAge >= 0 &&
      marketAge <= 120000 &&
      Object.entries(frame.payload.quotes ?? {}).some(([code, q]) => {
        const quoteAge = now - Date.parse(q.timestamp);
        const history = stored.plan.entryExecutionPolicy.history[code];
        return (
          history &&
          q.date === date &&
          quoteAge >= 0 &&
          quoteAge <= 15000 &&
          q.orderBookQuality === "OK" &&
          q.ask1Cents > 0 &&
          q.ask1Shares > 0 &&
          Math.abs(q.previousCloseCents - history.previousCloseCents) <=
            Math.max(1, history.previousCloseCents * 0.001)
        );
      })
    );
  });
  const coverage = observationCoverage(
    usableFrames,
    date,
    Number(env.TRADING_POLL_SECONDS ?? 10),
  );
  let book = structuredClone(stored.initialBook);
  let session = openSession(book, stored.plan, date);
  const fills = [];
  let replayPassed = false;
  try {
    await assertStoredProgramPlan(env, stored.plan, stored.initialBook, {
      tQualityScope: `shadow:${ENTRY_OBSERVER_ID}`,
    });
    for (const frame of frames) {
      if ((await digestOf(frame.payload)) !== frame.digest)
        throw new Error("行情帧摘要不一致");
      if (marketClock(new Date(frame.observedAt)).time >= "15:00:00") continue;
      const step = advanceSession(book, session, {
        ...frame.payload,
        observedAt: frame.observedAt,
      });
      book = step.book;
      session = step.session;
      fills.push(...step.ledger);
    }
    const result = closeSession(book, session, closingDataset);
    const account = await shadows.account(ENTRY_OBSERVER_ID);
    replayPassed =
      canonicalJson(fills) === canonicalJson(allFills) &&
      canonicalJson(result.session) === canonicalJson(stored) &&
      canonicalJson(result.book) === canonicalJson(account.book) &&
      !result.notices.length;
  } catch {
    replayPassed = false;
  }
  const inputsPresent =
    frames.some((f) => f.payload.entryInputs?.market?.date === date) &&
    frames.some(
      (f) => Object.keys(f.payload.entryInputs?.auction ?? {}).length > 0,
    );
  const contextPresent =
    Object.keys(stored.plan.entryExecutionPolicy?.history ?? {}).length > 0;
  const previousDateConfirmed =
    frames.length > 0 &&
    frames.every(
      (f) =>
        f.payload.pool?.sources?.researchPoolDate === stored.plan.signalDate,
    );
  const report = {
    version: INTRADAY_ENTRY_VERSION,
    date,
    engineBuild: await executionEngineBuildDigest(),
    passed:
      coverage &&
      replayPassed &&
      inputsPresent &&
      contextPresent &&
      previousDateConfirmed,
    coverage,
    replayPassed,
    inputsPresent,
    contextPresent,
    previousDateConfirmed,
    frameCount: frames.length,
    fills: allFills.length,
    verifiedAt: new Date().toISOString(),
    evidenceDigest: await digestOf(
      frames.map((f) => ({ sequence: f.sequence, digest: f.digest })),
    ),
  };
  // 已通过的证据不被后续无覆盖日抹掉；同一源码版本下保留最近一次有效验证。
  const previous = await readSetting(env.DB, readinessKey);
  if (
    report.passed ||
    previous?.date === date ||
    previous?.engineBuild !== report.engineBuild ||
    !previous?.passed
  )
    await writeSetting(env.DB, readinessKey, report);
  return report;
}

export async function maintainEntryObservation(env, date, now = new Date()) {
  if (!(await readSetting(env.DB, requestKey))) return null;
  const clock = marketClock(now);
  if (!observationMaintenanceOpen(clock, date)) return null;
  const papers = new RealtimeRepository(env);
  const primary = await papers.account();
  if (primary?.book.lastDate !== date) return { status: "WAITING_SETTLEMENT" };
  const shadows = new ShadowAccountRepository(env);
  let observer = await shadows.account(ENTRY_OBSERVER_ID);
  if (observer && observer.book.lastDate !== date) {
    const existingPlan = await shadows.plan(
      ENTRY_OBSERVER_ID,
      observer.book.lastDate,
    );
    if (!existingPlan)
      return { status: "BLOCKED", reason: "影子计划缺失，不能事后补录" };
    let session = await shadows.session(ENTRY_OBSERVER_ID, date);
    // 零帧日只盯市结算并报告覆盖不足，不能捏造任何日内成交。
    if (!session) {
      session = openSession(observer.book, existingPlan, date);
      const codes = observer.book.positions.map((p) => p.code);
      const closing = await collectTradingDay(date, codes, [], null);
      const result = closeSession(observer.book, session, closing);
      await shadows.commitSettlement({
        accountId: ENTRY_OBSERVER_ID,
        expectedRevision: observer.revision,
        runId: crypto.randomUUID(),
        tradeDate: date,
        book: result.book,
        equity: result.equity,
        session: result.session,
      });
      await verifyEntryObservation(env, date, closing, now);
    } else {
      const codes = observer.book.positions.map((p) => p.code);
      const closing = await collectTradingDay(date, codes, [], null);
      await settlePortfolioDay(env, ENTRY_OBSERVER_ID, date, closing, {
        shadows,
      });
      await verifyEntryObservation(env, date, closing, now);
    }
    observer = await shadows.account(ENTRY_OBSERVER_ID);
  }
  const source = await papers.snapshot(date);
  if (!source) return { status: "WAITING_SNAPSHOT" };
  let snapshot = source;
  if (!Object.keys(source.intradayEntryContext?.history ?? {}).length)
    snapshot = {
      ...source,
      createdAt: now.toISOString(),
      intradayEntryContext: await buildIntradayContext(env, source),
    };
  if (!Object.keys(snapshot.intradayEntryContext.history).length) {
    const preparation = { status: "WAITING_HISTORY", signalDate: date };
    await writeSetting(
      env.DB,
      "intraday-entry-observation-preparation",
      preparation,
    );
    return preparation;
  }
  if (!observer)
    observer = await shadows.ensureAccount(ENTRY_OBSERVER_ID, {
      kind: SHADOW_ACCOUNT_KINDS.INTRADAY_OBSERVATION,
      book: {
        ...structuredClone(primary.book),
        entryExecutionMode: "intraday-conditional",
        selectionPolicyVersion: "signal-ranking-v5",
      },
    });
  const strategy = await papers.strategy(observer.book);
  const plan = await freezePortfolioPlan(
    env,
    ENTRY_OBSERVER_ID,
    {
      snapshot,
      strategy,
      strategyVersion: observer.book.activeStrategy,
      now: now.toISOString(),
    },
    { shadows },
  );
  return { status: "OBSERVING", signalDate: plan.signalDate };
}

export async function preparePendingEntryObservation(env, now = new Date()) {
  const clock = marketClock(now);
  if (
    clock.time >= OBSERVATION_SCHEDULE.preparationEnd &&
    clock.time < OBSERVATION_SCHEDULE.verificationStart
  )
    return null;
  if (!(await readSetting(env.DB, requestKey))) return null;
  const account = await new RealtimeRepository(env).account();
  if (!account?.book.lastDate) return null;
  const shadow = new ShadowAccountRepository(env);
  if (await shadow.plan(ENTRY_OBSERVER_ID, account.book.lastDate)) return null;
  return maintainEntryObservation(env, account.book.lastDate, now);
}
