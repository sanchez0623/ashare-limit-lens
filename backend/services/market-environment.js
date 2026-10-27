import { PaperRepository } from "../storage/paper.js";
import {
  ShadowAccountRepository,
  SHADOW_ACCOUNT_KINDS,
} from "../storage/shadow.js";
import { QuoteFrameRepository } from "../storage/quotes.js";
import { frozenProgramSignal } from "../storage/strategy-signals.js";
import { createDragonPlan } from "../domain/dragon-risk.js";
import { digestOf, canonicalJson } from "../domain/research-lineage.js";
import { marketClock } from "../domain/realtime.js";
import { MARKET_ENVIRONMENT_POLICY as P } from "../../shared/market-environment.js";
import {
  ADAPTIVE_RISK_POLICY,
  ADAPTIVE_RISK_POLICY_V2,
  NEUTRAL_ADAPTIVE_RISK_POLICY,
} from "../../shared/adaptive-risk.js";
import {
  verifyEnvironmentRow,
  verifyEnvironmentOrigin,
  registerEnvironmentPolicy,
} from "../storage/market-environment.js";
import { environmentCalibration } from "../domain/environment-report.js";
import { freezePortfolioPlan, settlePortfolioDay } from "./portfolio-runner.js";
import { tradingCalendar } from "./market.js";
import { practiceCoverage } from "../domain/practice-coverage.js";
import {
  resampleIndexMatrix,
  pairedLowerBoundTest,
} from "../domain/research-statistics.js";
import { loadDragonConfig } from "../storage/dragon-risk.js";
import {
  environmentLedger,
  environmentDayReferences,
  verifyReportInputs,
} from "../storage/environment-report.js";

const parse = (r) => (r ? JSON.parse(r.payload) : null);
const nextWeekday = (date) => {
  const d = new Date(`${date}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
};
export async function prepareEnvironmentTrial(env, now = new Date()) {
  const papers = new PaperRepository(env),
    primary = await papers.account();
  if (!primary?.book?.lastDate) return { status: "WAITING_PLAN" };
  const plan = await papers.plan(primary.book.lastDate);
  if (
    plan?.dragonPolicy?.adaptiveRiskPolicy?.version !==
    ADAPTIVE_RISK_POLICY.version
  )
    return { status: "WAITING_VERSION" };
  const cycle = primary.book.tradingCycleId ?? "primary",
    shadows = new ShadowAccountRepository(env),
    db = env.DB;
  const row = await db
    .prepare(
      "SELECT * FROM market_environment_trials WHERE cycle_id=? AND status='ACTIVE'",
    )
    .bind(cycle)
    .first();
  if (row) {
    const m = JSON.parse(row.manifest);
    if ((await digestOf(m)) !== row.manifest_digest)
      throw new Error("环境对照清单摘要不一致");
    if (
      m.configDigest !== plan.dragonPolicy.configDigest ||
      m.engineBuild !== plan.engineBuild ||
      m.feeDigest !== (await digestOf(plan.feeConfig)) ||
      m.costDigest !== plan.executionCostPolicy.payloadDigest
    ) {
      await db
        .prepare(
          "UPDATE market_environment_trials SET status='INVALIDATED' WHERE id=? AND status='ACTIVE'",
        )
        .bind(row.id)
        .run();
      for (const id of Object.values(m.accounts))
        await shadows.setStatus(id, "INVALIDATED");
      return {
        status: "INVALIDATED",
        reason: "主账户配置、成本或执行版本改变，原窗口不再比较",
      };
    }
    // Only prepare unused next-day plans. Existing plans and sessions are immutable.
    for (const id of Object.values(m.accounts)) {
      const account = await shadows.account(id);
      if (
        account.book.lastDate === plan.signalDate &&
        !(await shadows.plan(id, plan.signalDate))
      )
        await freezeEnvironmentPlan(env, id, plan, now);
    }
    return { status: "ACTIVE", id: row.id };
  }
  const completed = await db
    .prepare(
      "SELECT * FROM market_environment_trials WHERE cycle_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(cycle)
    .first();
  if (completed) {
    const old = JSON.parse(completed.manifest);
    if ((await digestOf(old)) !== completed.manifest_digest)
      throw new Error("原环境对照清单摘要不一致");
    const consumed = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM shadow_sessions WHERE account_id IN (?,?,?)",
      )
      .bind(...Object.values(old.accounts))
      .first();
    const primaryUsed = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM paper_live_sessions WHERE trade_date>=?",
      )
      .bind(old.startDate)
      .first();
    // An invalidated preparation with no observations is not an experiment.
    // Completed or partially observed windows are never automatically repeated.
    if (completed.status !== "INVALIDATED" || consumed.n || primaryUsed.n)
      return {
        status: completed.status,
        id: completed.id,
        reason: "原定窗口已经结束或失效，不自动另开窗口反复比较",
      };
  }
  const tradeDate = nextWeekday(plan.signalDate);
  if (now.getTime() >= Date.parse(`${tradeDate}T09:30:00+08:00`))
    return { status: "WAITING_NEXT_PLAN" };
  if (
    await db
      .prepare("SELECT 1 FROM paper_live_sessions WHERE trade_date>=? LIMIT 1")
      .bind(tradeDate)
      .first()
  )
    return { status: "ALREADY_EXECUTING" };
  const source = await frozenProgramSignal(db, plan),
    id = `environment-${(await digestOf({ cycle, start: tradeDate, plan: await digestOf(plan) })).slice(0, 32)}`;
  const accounts = Object.fromEntries(
    ["LEGACY", "NEW", "NEUTRAL"].map((role) => [role, `${id}:${role}`]),
  );
  const manifest = {
    version: P.version,
    id,
    cycleId: cycle,
    startDate: tradeDate,
    windowDays: P.comparisonDays,
    calendar: "SHANGHAI_INDEX_TRADING_DAYS",
    createdAt: now.toISOString(),
    model: P,
    modelDigest: (await registerEnvironmentPolicy(db)).digest,
    engineBuild: plan.engineBuild,
    configDigest: plan.dragonPolicy.configDigest,
    feeDigest: await digestOf(plan.feeConfig),
    costDigest: plan.executionCostPolicy.payloadDigest,
    initialBook: primary.book,
    planDigest: await digestOf(plan),
    sourceDigest: plan.selectionAudit.snapshotDigest,
    accounts,
    validation: "MANUAL_UNVERIFIED",
    supersedesUnexecutedTrial: completed?.id ?? null,
  };
  await db.transaction(async () => {
    const latest = await papers.account();
    if (latest.revision !== primary.revision)
      throw new Error("账户变化，不能准备环境对照");
    await db
      .prepare(
        "INSERT INTO market_environment_trials(id,cycle_id,manifest,manifest_digest,status,created_at) VALUES(?,?,?,?,'ACTIVE',?)",
      )
      .bind(
        id,
        cycle,
        JSON.stringify(manifest),
        await digestOf(manifest),
        now.toISOString(),
      )
      .run();
    for (const [role, accountId] of Object.entries(accounts)) {
      const book = structuredClone(primary.book);
      if (role !== "NEW") book.environmentControl = role;
      await shadows.ensureAccount(accountId, {
        kind: SHADOW_ACCOUNT_KINDS.MARKET_ENVIRONMENT,
        cohortId: id,
        memberId: role,
        book,
      });
      const controlPlan = createDragonPlan(source, book, plan.createdAt, {
        adaptiveRiskPolicy:
          role === "LEGACY"
            ? ADAPTIVE_RISK_POLICY_V2
            : role === "NEUTRAL"
              ? NEUTRAL_ADAPTIVE_RISK_POLICY
              : ADAPTIVE_RISK_POLICY,
        executionCostPolicy: plan.executionCostPolicy,
        snapshotDigest: plan.selectionAudit.snapshotDigest,
        observationUniverse:
          plan.observationUniverse ?? plan.entryExecutionPolicy.candidates,
      });
      // NEW uses the exact same frozen plan, including its original audit shape.
      await shadows.savePlan(
        accountId,
        role === "NEW" ? plan : controlPlan,
        source,
      );
    }
  });
  return { status: "ACTIVE", id, accounts, tradeDate };
}
async function freezeEnvironmentPlan(env, id, main, now) {
  const shadows = new ShadowAccountRepository(env),
    account = await shadows.account(id),
    source = await frozenProgramSignal(env.DB, main);
  const plan = createDragonPlan(source, account.book, main.createdAt, {
    tCapitalPolicy: main.dragonPolicy.tCapitalPolicy ?? null,
    ...(account.memberId === "NEW"
      ? { manualExitRequests: main.manualExitRequests }
      : {}),
    executionCostPolicy: main.executionCostPolicy,
    snapshotDigest: main.selectionAudit.snapshotDigest,
    observationUniverse:
      main.observationUniverse ?? main.entryExecutionPolicy.candidates,
  });
  return shadows.savePlan(id, plan, source);
}
export async function marketEnvironment(
  env,
  { date, at, scope = "primary" } = {},
) {
  const db = env.DB;
  const current = await new PaperRepository(env).account();
  const cycle = current?.book.tradingCycleId ?? "primary";
  if (!date && at) date = marketClock(new Date(at)).date;
  date ??= (
    await db
      .prepare(
        "SELECT MAX(trade_date) AS date FROM market_environment_snapshots WHERE scope=? AND cycle_id=?",
      )
      .bind(scope, cycle)
      .first()
  )?.date;
  const cutoff =
    at ??
    (date
      ? new Date(
          Math.min(Date.now(), Date.parse(`${date}T23:59:59+08:00`)),
        ).toISOString()
      : new Date().toISOString());
  const row = await db
    .prepare(
      "SELECT * FROM market_environment_snapshots WHERE scope=? AND trade_date=? AND as_of<=? AND cycle_id=? ORDER BY sequence DESC LIMIT 1",
    )
    .bind(scope, date ?? "", cutoff, cycle)
    .first();
  const value = await verifyEnvironmentOrigin(db, row);
  return (
    value ?? {
      version: P.version,
      date,
      asOf: null,
      status: "COLLECTING",
      strength: null,
      direction: { band: "UNKNOWN" },
      fragility: { value: null, band: "UNKNOWN" },
      validation: "MANUAL_UNVERIFIED",
      note: "等待新版计划的真实盘中观测；旧历史不补造三维状态",
    }
  );
}
export async function researchEnvironment(
  env,
  { date, buyPoint, dimension } = {},
) {
  const current = await new PaperRepository(env).account(),
    cycle = current?.book.tradingCycleId ?? "primary";
  const trials = (
    await env.DB.prepare(
      "SELECT * FROM market_environment_trials WHERE cycle_id=? ORDER BY created_at DESC",
    )
      .bind(cycle)
      .all()
  ).results;
  const trial = trials[0];
  if (
    trial &&
    (await digestOf(JSON.parse(trial.manifest))) !== trial.manifest_digest
  )
    throw new Error("环境实验清单摘要不一致");
  const reportRow = trial
    ? await env.DB.prepare(
        `SELECT * FROM market_environment_reports WHERE trial_id=?${date ? " AND as_of<=?" : ""} ORDER BY as_of DESC LIMIT 1`,
      )
        .bind(trial.id, ...(date ? [date] : []))
        .first()
    : null;
  const report = await verifyEnvironmentRow(reportRow);
  if (report) await verifyReportInputs(env.DB, trial, report);
  const calibration = report?.calibration ?? {
    purpose: "DIAGNOSTIC",
    eligibleForPromotion: false,
    groups: [],
    openCycles: [],
    status: "COLLECTING",
  };
  return {
    version: P.version,
    validation: "MANUAL_UNVERIFIED",
    trial: trial
      ? {
          id: trial.id,
          status: trial.status,
          manifest: JSON.parse(trial.manifest),
        }
      : null,
    ...calibration,
    groups: calibration.groups.filter(
      (g) =>
        (!buyPoint || g.buyPoint === buyPoint) &&
        (!dimension || g.dimension === dimension),
    ),
    comparison: report?.comparison ?? null,
    note: "固定规则，尚未验证；统计不自动禁用买点、调参或授予采用资格。",
  };
}

function realClosingDataset(dataset, frames, date) {
  const quotes = { ...dataset.quotes };
  for (const frame of frames)
    for (const [code, q] of Object.entries(frame.payload.quotes ?? {}))
      if (
        q.date === date &&
        Date.parse(q.timestamp) >= Date.parse(`${date}T15:00:00+08:00`) &&
        Date.parse(q.timestamp) <= Date.parse(frame.observedAt) &&
        frame.observedAt.slice(0, 10) === date
      )
        quotes[code] = { ...q, closingSource: "OBSERVED_CLOSE" };
  return { ...dataset, quotes };
}
// Uses the exact production replay engine; no fitting or parameter search.
export async function replayEnvironmentPressure({
  manifest,
  record,
  days,
  loadFrames,
}) {
  const { replayPattern } = await import("./dragon-pattern-research.js");
  const dates = days.map((d) => d.date);
  const matrix =
    dates.length >= 2
      ? await resampleIndexMatrix({
          dates,
          blockLength: 5,
          resamples: 10000,
          seedInput: { id: manifest.id, dates, version: P.version },
        })
      : null;
  const costStress = [],
    tests = [];
  for (const multiplier of P.costMultipliers) {
    const arms = {};
    for (const role of ["LEGACY", "NEW", "NEUTRAL"]) {
      const start = structuredClone(manifest.initialBook);
      if (role !== "NEW") start.environmentControl = role;
      arms[role] = await replayPattern(record, start, days, multiplier, {
        loadFrames,
      });
    }
    costStress.push({ multiplier, arms });
    if (matrix)
      for (const reference of ["LEGACY", "NEUTRAL"])
        tests.push({
          multiplier,
          reference,
          ...pairedLowerBoundTest({
            memberReturns: arms.NEW.returns,
            comparisonReturns: arms[reference].returns,
            matrix,
            alphaPerComparison: 0.05 / 6,
          }),
        });
  }
  return {
    costStress,
    tests,
    matrixDigest: matrix?.digest ?? null,
    correction: { method: "BONFERRONI", familySize: 6, familyAlpha: 0.05 },
    eligibleForPromotion: false,
  };
}
function financialBook(book) {
  const { environmentControl: _control, ...value } = book ?? {};
  return value;
}
async function filteredOpportunityResults(env, manifest, events, asOf) {
  const ledger = {};
  const { completedPracticeCycles } = await import(
    "../domain/practice-review.js"
  );
  for (const [role, id] of Object.entries(manifest.accounts))
    ledger[role] = await environmentLedger(env.DB, asOf, id);
  const triggers = events.filter(
    (e) => e.scope === "primary" && e.kind === "TRIGGER",
  );
  return triggers
    .filter(
      (t) =>
        !ledger.NEW.some(
          (f) =>
            f.date === t.tradeDate &&
            f.code === t.code &&
            f.buyPoint === t.buyPoint &&
            f.intent === "OPEN",
        ),
    )
    .map((t) => ({
      date: t.tradeDate,
      code: t.code,
      buyPoint: t.buyPoint,
      references: Object.fromEntries(
        ["LEGACY", "NEUTRAL"].map((role) => {
          const fills = ledger[role],
            opening = fills.find(
              (f) =>
                f.date === t.tradeDate &&
                f.code === t.code &&
                f.buyPoint === t.buyPoint &&
                f.intent === "OPEN",
            );
          const cycle =
            opening &&
            completedPracticeCycles(fills).find(
              (c) => c.id === opening.cycleId,
            );
          return [
            role,
            {
              executed: !!opening,
              cycleId: opening?.cycleId ?? null,
              status: !opening ? "NOT_EXECUTED" : cycle ? "COMPLETED" : "OPEN",
              netPnlCents: cycle?.netPnlCents ?? null,
              feeCents: cycle?.feeCents ?? null,
            },
          ];
        }),
      ),
    }));
}
export async function maintainEnvironmentTrials(
  env,
  { now = new Date(), calendarProvider = tradingCalendar } = {},
) {
  const clock = marketClock(now);
  if (clock.time < "17:00:00") return { status: "WAITING_FINALIZATION" };
  const db = env.DB,
    shadows = new ShadowAccountRepository(env),
    papers = new PaperRepository(env);
  const trials = (
    await db
      .prepare(
        "SELECT * FROM market_environment_trials WHERE status='ACTIVE' ORDER BY created_at",
      )
      .all()
  ).results;
  const results = [];
  for (const trial of trials) {
    const owner = crypto.randomUUID();
    const claim = await db
      .prepare(
        "UPDATE market_environment_trials SET lease_owner=?,lease_until=? WHERE id=? AND status='ACTIVE' AND (lease_until IS NULL OR lease_until<=?)",
      )
      .bind(
        owner,
        new Date(Date.now() + 300000).toISOString(),
        trial.id,
        new Date().toISOString(),
      )
      .run();
    if (claim.meta.changes !== 1) continue;
    try {
      const m = JSON.parse(trial.manifest);
      if ((await digestOf(m)) !== trial.manifest_digest)
        throw new Error("环境对照清单摘要不一致");
      const current = await papers.account(),
        activePlan =
          (await papers.plan(current.book.lastDate)) ??
          parse(
            await db
              .prepare(
                "SELECT payload FROM paper_live_sessions WHERE trade_date=?",
              )
              .bind(current.book.lastDate)
              .first(),
          )?.plan;
      if (
        current.book.tradingCycleId !== m.cycleId ||
        activePlan?.engineBuild !== m.engineBuild ||
        activePlan?.dragonPolicy.configDigest !== m.configDigest
      ) {
        await db
          .prepare(
            "UPDATE market_environment_trials SET status='INVALIDATED' WHERE id=? AND lease_owner=?",
          )
          .bind(trial.id, owner)
          .run();
        for (const id of Object.values(m.accounts))
          await shadows.setStatus(id, "INVALIDATED");
        results.push({ id: trial.id, status: "INVALIDATED" });
        continue;
      }
      const calendar = await calendarProvider(
        m.initialBook.lastDate,
        clock.date,
      );
      const dates = calendar.dates
        .filter((d) => d >= m.startDate && d <= clock.date)
        .slice(0, m.windowDays);
      if (!dates.length) continue;
      const last = dates.at(-1);
      if (
        await db
          .prepare(
            "SELECT id FROM market_environment_reports WHERE trial_id=? AND as_of=?",
          )
          .bind(trial.id, last)
          .first()
      )
        continue;
      const missing = [],
        days = [],
        framesRepo = new QuoteFrameRepository(env),
        scopeSessions = {};
      for (const date of dates) {
        const day = parse(
          await db
            .prepare("SELECT payload FROM paper_market_days WHERE trade_date=?")
            .bind(date)
            .first(),
        );
        const frames = await framesRepo.framesForDate(date);
        for (const frame of frames)
          if ((await digestOf(frame.payload)) !== frame.digest)
            throw new Error("环境对照原始行情摘要不一致");
        if (!day) {
          missing.push({ date, reason: "主账户尚未结算" });
          continue;
        }
        const dataset = realClosingDataset(day, frames, date);
        for (const [role, id] of Object.entries(m.accounts)) {
          const session = await shadows.session(id, date);
          if (!session) {
            missing.push({ date, role, reason: "缺少实际影子会话" });
            continue;
          }
          if (session.status !== "CLOSED")
            try {
              await settlePortfolioDay(env, id, date, dataset);
            } catch (error) {
              missing.push({ date, role, reason: error.message });
              continue;
            }
          scopeSessions[id] ??= [];
          scopeSessions[id].push(await shadows.session(id, date));
          const controlCoverage = practiceCoverage({
            date,
            session: scopeSessions[id].at(-1),
            frames: frames.map((f) => f.payload),
            closingFrames: frames,
          });
          if (!controlCoverage.complete)
            missing.push({
              date,
              role,
              reason: "影子观测不完整",
              coverage: controlCoverage,
            });
        }
        const primaryRow = await db
          .prepare("SELECT payload FROM paper_live_sessions WHERE trade_date=?")
          .bind(date)
          .first();
        const primary = parse(primaryRow);
        if (!primary) {
          missing.push({ date, role: "primary", reason: "缺少主账户会话" });
          continue;
        }
        if (primary.plan.manualExitRequests?.length)
          missing.push({
            date,
            role: "primary",
            reason: "主账户存在人工退出干预，本窗口仅作诊断",
          });
        const tickRows = (
          await db
            .prepare(
              "SELECT payload,digest FROM paper_live_ticks WHERE trade_date=? ORDER BY sequence",
            )
            .bind(date)
            .all()
        ).results;
        const ticks = [];
        for (const row of tickRows) ticks.push(await verifyEnvironmentRow(row));
        const coverage = practiceCoverage({
          date,
          session: primary,
          frames: ticks,
          closingFrames: frames,
        });
        if (!coverage.complete)
          missing.push({ date, reason: "盘中观测不完整", coverage });
        const mirror = await shadows.session(m.accounts.NEW, date);
        if (
          mirror &&
          canonicalJson(financialBook(primary.closingBook)) !==
            canonicalJson(financialBook(mirror.closingBook))
        )
          missing.push({
            date,
            role: "NEW",
            reason: "主账户与新版影子结算状态不一致，需核对人工干预或执行差异",
          });
        const sameFrames = async (scope) => {
          const rows = (
            await db
              .prepare(
                "SELECT payload,digest FROM market_environment_snapshots WHERE cycle_id=? AND scope=? AND trade_date=? ORDER BY sequence",
              )
              .bind(m.cycleId, scope, date)
              .all()
          ).results;
          const values = [];
          for (const row of rows) {
            const {
              source,
              scope: _scope,
              cycleId: _cycle,
              ...value
            } = await verifyEnvironmentRow(row);
            values.push({ value, observationDigest: source.observationDigest });
          }
          return values;
        };
        if (
          canonicalJson(await sameFrames("primary")) !==
          canonicalJson(await sameFrames(m.accounts.NEW))
        )
          missing.push({
            date,
            role: "NEW",
            reason: "主账户与新版影子帧级环境或输入不一致",
          });
        const source = await frozenProgramSignal(db, primary.plan);
        days.push({
          date,
          source,
          createdAt: primary.plan.createdAt,
          fees: primary.plan.feeConfig,
          feeModel: primary.plan.feeModel,
          feeConfigVersion: primary.plan.feeConfigVersion,
          cost: primary.plan.executionCostPolicy,
          observationUniverse:
            primary.plan.observationUniverse ??
            primary.plan.entryExecutionPolicy.candidates,
          dataset,
          frameRefs: frames.map((f) => ({
            sequence: f.sequence,
            digest: f.digest,
          })),
        });
      }
      const references = [];
      for (const date of dates)
        references.push(await environmentDayReferences(db, m, date));
      const rawEvents = (
        await db
          .prepare(
            "SELECT * FROM market_environment_opportunities WHERE cycle_id=? AND trade_date<=? ORDER BY as_of,id",
          )
          .bind(m.cycleId, last)
          .all()
      ).results;
      const events = [];
      for (const row of rawEvents)
        events.push({
          ...(await verifyEnvironmentRow(row)),
          scope: row.scope,
          tradeDate: row.trade_date,
          asOf: row.as_of,
          code: row.code,
          buyPoint: row.buy_point,
        });
      const fills = await environmentLedger(db, last);
      const paths = [];
      for (const date of dates) {
        const ticks = (
          await db
            .prepare(
              "SELECT payload FROM paper_live_ticks WHERE trade_date=? ORDER BY sequence",
            )
            .bind(date)
            .all()
        ).results.map(parse);
        for (const tick of ticks)
          for (const [code, q] of Object.entries(tick.quotes ?? {}))
            if (
              q.date === date &&
              q.closeCents > 0 &&
              Date.parse(q.timestamp) <= Date.parse(tick.observedAt) &&
              Date.parse(tick.observedAt) - Date.parse(q.timestamp) <= 15000
            )
              paths.push({
                code,
                date,
                at: tick.observedAt,
                priceCents: q.closeCents,
                segment:
                  new Date(Date.parse(tick.observedAt) + 28800000)
                    .toISOString()
                    .slice(11, 19) < "12:00:00"
                    ? "AM"
                    : "PM",
              });
      }
      const calibration = await environmentCalibration({
        events,
        fills,
        asOf: last,
        paths,
        tradingDates: dates,
        completeDates: dates.filter((d) => !missing.some((m) => m.date === d)),
      });
      const arms = {};
      for (const [role, id] of Object.entries(m.accounts)) {
        const equities = (await shadows.equities(id)).filter((e) =>
          dates.includes(e.date ?? e.tradeDate),
        );
        const ledger = (await shadows.ledger(id)).filter((f) => f.date <= last);
        const { patternMetrics } = await import("../domain/dragon-patterns.js");
        arms[role] =
          equities.length === dates.length &&
          equities.every((e) => e.complete === true)
            ? patternMetrics(equities, ledger, m.initialBook.equityCents)
            : { status: "INCOMPLETE", days: equities.length };
        arms[role].meanGrossExposure = equities.length
          ? equities.reduce(
              (n, e) => n + (e.equityCents - e.cashCents) / e.equityCents,
              0,
            ) / equities.length
          : null;
      }
      if (
        canonicalJson(fills.filter((f) => f.date >= m.startDate)) !==
        canonicalJson(
          (await environmentLedger(db, last, m.accounts.NEW)).filter(
            (f) => f.date >= m.startDate,
          ),
        )
      )
        missing.push({
          date: last,
          role: "NEW",
          reason: "主账户与新版影子逐笔成交不一致",
        });
      const comparison = {
        status: missing.length
          ? "INCOMPLETE"
          : dates.length < m.windowDays
            ? "OBSERVING"
            : "COMPLETE",
        dates,
        missing,
        arms,
        costStress: [],
        tests: [],
        mirrorConsistent: dates.every((d) =>
          scopeSessions[m.accounts.NEW]?.some((s) => s.date === d),
        )
          ? !missing.some(
              (item) => item.role === "NEW" && item.reason.includes("不一致"),
            )
          : null,
        filteredOpportunities: await filteredOpportunityResults(
          env,
          m,
          events,
          last,
        ),
        eligibleForPromotion: false,
      };
      if (!missing.length && dates.length === m.windowDays) {
        const record = await loadDragonConfig(
          db,
          activePlan.dragonPolicy.configId,
        );
        Object.assign(
          comparison,
          await replayEnvironmentPressure({
            manifest: m,
            record,
            days,
            loadFrames: async (day) => {
              const lease = await db
                .prepare(
                  "UPDATE market_environment_trials SET lease_until=? WHERE id=? AND lease_owner=? AND status='ACTIVE'",
                )
                .bind(
                  new Date(Date.now() + 300000).toISOString(),
                  trial.id,
                  owner,
                )
                .run();
              if (lease.meta.changes !== 1)
                throw new Error("环境报告计算租约丢失");
              const frames = await framesRepo.framesForDate(day.date);
              if (
                canonicalJson(day.frameRefs) !==
                canonicalJson(
                  frames.map((f) => ({
                    sequence: f.sequence,
                    digest: f.digest,
                  })),
                )
              )
                throw new Error("对照行情来源变化");
              for (const frame of frames)
                if ((await digestOf(frame.payload)) !== frame.digest)
                  throw new Error("对照行情摘要不一致");
              return frames;
            },
          }),
        );
        const one = comparison.costStress.find((v) => v.multiplier === 1).arms;
        comparison.replayConsistent = Object.keys(arms).every((role) =>
          [
            "netReturn",
            "fills",
            "feesCents",
            "completedRounds",
            "returns",
          ].every(
            (key) =>
              canonicalJson(arms[role][key]) === canonicalJson(one[role][key]),
          ),
        );
        if (!comparison.replayConsistent) {
          missing.push({
            date: last,
            reason: "1倍成本回放与三组实际账本不一致",
          });
          comparison.status = "INCOMPLETE";
        }
      }
      const report = {
        version: P.version,
        asOf: last,
        calibration,
        comparison,
        inputManifest: {
          manifestDigest: trial.manifest_digest,
          events: rawEvents.map((r) => ({ id: r.id, digest: r.digest })),
          ledgerDigest: await digestOf(fills),
          days: references,
        },
        createdAt: now.toISOString(),
      };
      // Recheck the source prefix after the expensive, non-transactional work.
      const freshFills = await environmentLedger(db, last);
      if ((await digestOf(freshFills)) !== report.inputManifest.ledgerDigest)
        throw new Error("环境报告账本来源变化");
      await verifyReportInputs(db, trial, report);
      const published = await db
        .prepare(
          "INSERT OR IGNORE INTO market_environment_reports(id,trial_id,as_of,payload,digest,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM market_environment_trials WHERE id=? AND lease_owner=? AND status='ACTIVE')",
        )
        .bind(
          `${trial.id}:${last}`,
          trial.id,
          last,
          JSON.stringify(report),
          await digestOf(report),
          now.toISOString(),
          trial.id,
          owner,
        )
        .run();
      if (published.meta.changes !== 1)
        throw new Error("环境报告发布租约丢失或报告已存在");
      if (dates.length === m.windowDays) {
        const status = missing.length ? "INCONCLUSIVE" : "COMPLETE";
        await db
          .prepare(
            "UPDATE market_environment_trials SET status=? WHERE id=? AND status='ACTIVE'",
          )
          .bind(status, trial.id)
          .run();
        for (const id of Object.values(m.accounts))
          await shadows.setStatus(id, status);
      } else {
        const account = await papers.account(),
          main = await papers.plan(account.book.lastDate);
        for (const id of Object.values(m.accounts))
          if (
            (await shadows.account(id)).book.lastDate === main?.signalDate &&
            !(await shadows.plan(id, main.signalDate))
          )
            await freezeEnvironmentPlan(env, id, main, now);
      }
      results.push({ id: trial.id, asOf: last, status: comparison.status });
    } finally {
      await db
        .prepare(
          "UPDATE market_environment_trials SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?",
        )
        .bind(trial.id, owner)
        .run();
    }
  }
  return { results };
}
