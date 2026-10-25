import { PaperRepository, digest } from "../storage/paper.js";
import {
  ShadowAccountRepository,
  SHADOW_ACCOUNT_KINDS,
} from "../storage/shadow.js";
import { tradingArchive } from "../storage/trading-archives.js";
import {
  preserveProgramSignal,
  frozenProgramSignal,
} from "../storage/strategy-signals.js";
import { latestPolicyBundle } from "../storage/execution-cost.js";
import {
  newBook,
  createPlan,
  assertProgramSnapshot,
  auditLedger,
} from "../domain/trading.js";
import { selectionSnapshotDigest } from "../domain/signal-selection.js";
import {
  summarizeTQuality,
  buildTQualityEvidence,
  tQualityEnabledForSnapshot,
} from "../domain/t-quality.js";
import { marketClock, openSession } from "../domain/realtime.js";
import { assertStoredProgramPlan } from "./strategy-program-evidence.js";
import { validDate } from "../http.js";
import { eligible, INTRADAY_ENTRY_RULES } from "../domain/intraday-entry.js";
import { buildJointQuotePool } from "./quote-stream.js";
import { exportPaper, verifyExport } from "./paper.js";
import { isDragon } from "../domain/dragon-risk.js";
import { loadDragonConfig } from "../storage/dragon-risk.js";
import {
  saveDragonSettings,
  requestDragonActivation,
  applyDragonLifecycle,
  dragonStatus,
} from "./dragon-risk.js";

// Account state is moved, shared market inputs and research budgets remain historical.
const clearedTables = [
  "paper_plans",
  "paper_equity",
  "paper_ledger",
  "paper_market_days",
  "paper_runs",
  "paper_configuration_history",
  "paper_plan_revisions",
  "paper_live_sessions",
  "paper_live_ticks",
  "paper_executor_health",
  "paper_t_trades",
  "shadow_plans",
  "shadow_equity",
  "shadow_ledger",
  "shadow_sessions",
  "shadow_accounts",
  "frozen_t_quality",
  "dragon_plan_bindings",
  "reviews",
  "evidence_daily_metrics",
  "evidence_reports",
  "evidence_report_inputs",
];
const retainedTables = [
  "paper_accounts",
  "snapshots",
  "strategy_signal_snapshots",
  "strategy_versions",
  "dragon_config_versions",
  "dragon_observation_reports",
  "exit_context_inputs",
];
const observationKeys = [
  "intraday-entry-observation-request",
  "intraday-entry-observation-preparation",
  "intraday-entry-readiness",
];

function assertWindow(tradeDate, signalDate, now) {
  const weekday = new Date(`${tradeDate}T00:00:00Z`).getUTCDay();
  if (
    !validDate(tradeDate) ||
    [0, 6].includes(weekday) ||
    !validDate(signalDate) ||
    signalDate >= tradeDate
  )
    throw new Error("新周期必须指定有效的下一交易日和在先信号日");
  if (
    !Number.isFinite(now.getTime()) ||
    now.getTime() >= Date.parse(`${tradeDate}T09:30:00+08:00`)
  )
    throw new Error("已到执行日开盘，不能清空或补造当天计划");
  const clock = marketClock(now);
  if (
    clock.date < signalDate ||
    (clock.date === signalDate && clock.time < "15:05:00")
  )
    throw new Error("信号日尚未收盘，不能开始新交易周期");
  const next = new Date(`${signalDate}T00:00:00Z`);
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while ([0, 6].includes(next.getUTCDay()));
  if (next.toISOString().slice(0, 10) !== tradeDate)
    throw new Error("信号日与执行日不连续，请核对下一交易日");
}

export async function prepareTradingCutover(
  env,
  { tradeDate, now = new Date() },
) {
  const db = env.DB,
    papers = new PaperRepository(env);
  const existing = await db
    .prepare("SELECT id FROM paper_trading_archives WHERE trade_date=?")
    .bind(tradeDate)
    .first();
  if (existing)
    return {
      duplicate: true,
      summary: (await tradingArchive(env, existing.id)).summary,
    };
  const account = await papers.account();
  if (!account) throw new Error("主账户不存在");
  const signalDate = account.book.lastDate;
  assertWindow(tradeDate, signalDate, now);
  if (await db.prepare("SELECT 1 FROM research_window_owners LIMIT 1").first())
    throw new Error(
      "活动研究尚未结束，不能迁移交易账户；研究样本与预算必须保留",
    );
  if (
    (await db
      .prepare("SELECT 1 FROM paper_live_sessions WHERE trade_date>=? LIMIT 1")
      .bind(tradeDate)
      .first()) ||
    (await db
      .prepare("SELECT 1 FROM shadow_sessions WHERE trade_date>=? LIMIT 1")
      .bind(tradeDate)
      .first())
  )
    throw new Error("执行日已有会话，不能迁移已开始的交易周期");
  const oldPlanRow = await db
    .prepare("SELECT payload,digest FROM paper_plans WHERE signal_date=?")
    .bind(signalDate)
    .first();
  const oldPlan = oldPlanRow && JSON.parse(oldPlanRow.payload);
  if (
    oldPlan?.selectionPolicy?.version !== "signal-ranking-v5" ||
    oldPlan.entryExecutionMode !== "intraday-conditional" ||
    !oldPlan.entryExecutionPolicy?.candidates?.length
  )
    throw new Error("缺少已冻结的 V5 盘中观察名单");
  const oldPlanDigest = oldPlanRow.digest;
  if ((await digest(oldPlan)) !== oldPlanDigest)
    throw new Error("原 V5 计划摘要不一致");
  const sourceRow = await db
    .prepare("SELECT payload FROM strategy_signal_snapshots WHERE digest=?")
    .bind(oldPlan.selectionAudit.snapshotDigest)
    .first();
  const originalSource = sourceRow
    ? JSON.parse(sourceRow.payload)
    : await papers.snapshot(signalDate);
  if (
    !originalSource ||
    (await selectionSnapshotDigest(originalSource)) !==
      oldPlan.selectionAudit.snapshotDigest
  )
    throw new Error("原 V5 观察名单的冻结快照缺失或摘要不一致");
  const latest = await db
    .prepare("SELECT MAX(trade_date) AS date FROM snapshots")
    .first();
  if (latest.date !== signalDate)
    throw new Error("最新行情与账户信号日不一致，不能迁移过期观察名单");
  const archiveId = `v5-${tradeDate}-${crypto.randomUUID()}`;
  const book = {
    ...newBook(account.book.initialCashCents / 100, account.book.feeConfig),
    lastDate: signalDate,
    activeStrategy: account.book.activeStrategy,
    improvementMode: account.book.improvementMode ?? "auto",
    benchmarkCode: account.book.benchmarkCode,
    feeConfigVersion: account.book.feeConfigVersion,
    riskLimits: structuredClone(account.book.riskLimits),
    riskLimitsVersion: account.book.riskLimitsVersion,
    selectionPolicyVersion: "signal-ranking-v5",
    selectionPolicyMode: "manual",
    entryExecutionMode: "intraday-conditional",
    pendingOrders: [],
    pendingExits: [],
    pendingRecovery: [],
    tradingCycleId: archiveId,
  };
  const keep = new Set(oldPlan.entryExecutionPolicy.candidates);
  const snapshot = structuredClone(originalSource);
  snapshot.createdAt = now.toISOString();
  snapshot.intradayEntryContext.history = Object.fromEntries(
    Object.entries(snapshot.intradayEntryContext.history).filter(([code]) =>
      keep.has(code),
    ),
  );
  snapshot.tradingCutover = {
    archiveId,
    sourceSnapshotDigest: oldPlan.selectionAudit.snapshotDigest,
    sourcePlanDigest: oldPlanDigest,
  };
  const strategy = await papers.strategy(book);
  const plan = createPlan(
    snapshot,
    book,
    strategy,
    book.activeStrategy,
    now.toISOString(),
    {
      executionCostPolicy: await latestPolicyBundle(db),
      snapshotDigest: await selectionSnapshotDigest(snapshot),
      ...(tQualityEnabledForSnapshot(snapshot)
        ? {
            tQuality: summarizeTQuality([], { signalDate }),
            tQualityEvidence: buildTQualityEvidence([], []),
          }
        : {}),
    },
  );
  if (
    plan.orders.length ||
    JSON.stringify(plan.entryExecutionPolicy.candidates) !==
      JSON.stringify(oldPlan.entryExecutionPolicy.candidates)
  )
    throw new Error("空仓 V5 计划必须仅保留原观察名单，不得包含旧订单");
  assertProgramSnapshot(plan, snapshot, book);
  openSession(book, plan, tradeDate);
  const tables = {};
  for (const table of [...clearedTables, ...retainedTables].sort())
    tables[table] = (
      await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    ).results;
  tables.settings = (
    await db
      .prepare(
        `SELECT * FROM settings WHERE key IN (${observationKeys.map(() => "?").join(",")}) ORDER BY key`,
      )
      .bind(...observationKeys)
      .all()
  ).results;
  const chunks = [];
  for (const [table, rows] of Object.entries(tables).sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    for (let offset = 0; offset < rows.length; offset += 100) {
      const payload = rows.slice(offset, offset + 100);
      chunks.push({
        table,
        index: offset / 100,
        payload,
        digest: await digest(payload),
      });
    }
  const summary = {
    id: archiveId,
    version: "paper-trading-archive-v1",
    createdAt: now.toISOString(),
    tradeDate,
    signalDate,
    policy: "signal-ranking-v5",
    entryExecutionMode: "intraday-conditional",
    primary: {
      fills: tables.paper_ledger.length,
      positions: account.book.positions.length,
      initialCashCents: account.book.initialCashCents,
      equityCents: account.book.equityCents,
      realizedPnlCents: account.book.realizedPnlCents,
      feesCents: account.book.feesCents,
    },
    shadow: {
      accounts: tables.shadow_accounts.length,
      fills: tables.shadow_ledger.length,
    },
    candidates: plan.entryExecutionPolicy.candidates,
    initialBook: book,
    planDigest: await digest(plan),
    tables: Object.fromEntries(
      Object.entries(tables).map(([name, rows]) => [name, rows.length]),
    ),
    chunks: chunks.map(({ table, index, digest }) => ({
      table,
      index,
      digest,
    })),
  };
  return {
    duplicate: false,
    expectedRevision: account.revision,
    summary,
    chunks,
    book,
    plan,
    snapshot,
    observe: tables.settings.some((r) => r.key === observationKeys[0]),
  };
}

// The local adapter supplies BEGIN IMMEDIATE. Everything, including the archive,
// rolls back if a revision, source, checksum or new-plan verification fails.
export async function applyTradingCutover(
  env,
  prepared,
  { now = new Date() } = {},
) {
  if (prepared.duplicate) return prepared.summary;
  assertWindow(prepared.summary.tradeDate, prepared.summary.signalDate, now);
  const db = env.DB;
  if (typeof db.transaction !== "function")
    throw new Error("交易周期迁移需要本地事务数据库");
  return db.transaction(async () => {
    const current = await new PaperRepository(env).account();
    if (current?.revision !== prepared.expectedRevision)
      throw new Error("账户已变化，请重新准备交易迁移");
    const fresh = await prepareTradingCutover(env, {
      tradeDate: prepared.summary.tradeDate,
      now: new Date(prepared.summary.createdAt),
    });
    if (
      fresh.duplicate ||
      JSON.stringify(fresh.summary.chunks) !==
        JSON.stringify(prepared.summary.chunks)
    )
      throw new Error("归档输入已变化，请重新准备交易迁移");
    const { summary, book, plan, snapshot, chunks } = prepared;
    await db
      .prepare(
        "INSERT INTO paper_trading_archives(id,trade_date,created_at,summary,digest) VALUES(?,?,?,?,?)",
      )
      .bind(
        summary.id,
        summary.tradeDate,
        summary.createdAt,
        JSON.stringify(summary),
        await digest(summary),
      )
      .run();
    for (const chunk of chunks)
      await db
        .prepare(
          "INSERT INTO paper_trading_archive_chunks(archive_id,table_name,chunk_index,payload,digest) VALUES(?,?,?,?,?)",
        )
        .bind(
          summary.id,
          chunk.table,
          chunk.index,
          JSON.stringify(chunk.payload),
          chunk.digest,
        )
        .run();
    await tradingArchive(env, summary.id);
    for (const table of clearedTables)
      await db.prepare(`DELETE FROM ${table}`).run();
    await db
      .prepare(
        `DELETE FROM settings WHERE key IN (${observationKeys.map(() => "?").join(",")})`,
      )
      .bind(...observationKeys)
      .run();
    const update = await db
      .prepare(
        "UPDATE paper_accounts SET state=?,revision=revision+1,last_run_id=?,updated_at=? WHERE id='primary' AND revision=?",
      )
      .bind(
        JSON.stringify(book),
        summary.id,
        summary.createdAt,
        prepared.expectedRevision,
      )
      .run();
    if (update.meta.changes !== 1) throw new Error("账户迁移并发冲突");
    const event = {
      id: summary.id,
      createdAt: summary.createdAt,
      type: "TRADING_CYCLE_STARTED",
      tradeDate: summary.tradeDate,
      signalDate: summary.signalDate,
      initialBook: book,
      archiveDigest: await digest(summary),
      note: "旧交易完整归入历史；新周期从配置初始资金和空仓开始，不计作收益或实际卖出。",
    };
    await db
      .prepare(
        "INSERT INTO paper_configuration_history(id,created_at,payload,digest) VALUES(?,?,?,?)",
      )
      .bind(
        event.id,
        event.createdAt,
        JSON.stringify(event),
        await digest(event),
      )
      .run();
    await preserveProgramSignal(db, plan, snapshot);
    await new PaperRepository(env).savePlan(plan);
    await assertStoredProgramPlan(env, plan, book);
    if (prepared.observe) {
      const shadows = new ShadowAccountRepository(env);
      await shadows.ensureAccount("intraday-entry-observation-v1", {
        kind: SHADOW_ACCOUNT_KINDS.INTRADAY_OBSERVATION,
        book,
      });
      await shadows.savePlan("intraday-entry-observation-v1", plan, snapshot);
      await assertStoredProgramPlan(env, plan, book, {
        tQualityScope: "shadow:intraday-entry-observation-v1",
      });
      await db
        .prepare("INSERT INTO settings(key,value) VALUES(?,?)")
        .bind(
          observationKeys[0],
          JSON.stringify({
            requestedAt: summary.createdAt,
            version: "intraday-entry-v1",
            tradingCycleId: summary.id,
          }),
        )
        .run();
    }
    if (!auditLedger(book.initialCashCents, [], book, []).passed)
      throw new Error("新周期资金核对失败");
    if (!(await verifyExport(await exportPaper(env))).passed)
      throw new Error("新周期导出重放失败，交易迁移已回滚");
    return summary;
  });
}

// Policy correction for an unused archived cycle. It preserves the financial
// boundary and old plan revision, and never invents a trade or an earlier clock.
export async function switchTradingCycleToDragon(
  env,
  { sourceConfigId = null, now = new Date() } = {},
) {
  const db = env.DB;
  if (typeof db.transaction !== "function")
    throw new Error("新周期政策切换需要本地事务数据库");
  return db.transaction(async () => {
    const papers = new PaperRepository(env),
      account = await papers.account();
    if (!account?.book.tradingCycleId)
      throw new Error("缺少已归档新周期，不能替换已开始的交易政策");
    const previousPlan = await papers.plan(account.book.lastDate);
    if (isDragon(account.book)) {
      await assertStoredProgramPlan(env, previousPlan, account.book);
      return {
        changed: false,
        dragon: await dragonStatus(env),
        candidates: previousPlan.entryExecutionPolicy.candidates.length,
      };
    }
    const cycleRow = await db
      .prepare("SELECT summary,digest FROM paper_trading_archives WHERE id=?")
      .bind(account.book.tradingCycleId)
      .first();
    const cycle = cycleRow && JSON.parse(cycleRow.summary);
    if (!cycle || (await digest(cycle)) !== cycleRow.digest)
      throw new Error("新周期归档缺失或摘要不一致");
    assertWindow(cycle.tradeDate, account.book.lastDate, now);
    if (
      cycle.signalDate !== account.book.lastDate ||
      account.book.settlementCount !== 0 ||
      account.book.positions.length ||
      account.book.realizedPnlCents !== 0 ||
      account.book.feesCents !== 0 ||
      account.book.cashCents !== account.book.initialCashCents ||
      (account.book.pendingOrders ?? []).length ||
      (account.book.pendingExits ?? []).length ||
      (account.book.pendingRecovery ?? []).length
    )
      throw new Error("新周期已有持仓、盈亏或未完成操作，不能替换期初政策");
    for (const table of ["paper_ledger", "paper_equity", "paper_live_sessions"])
      if (await db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).first())
        throw new Error("新周期已经开始执行，不能替换冻结计划");
    if (previousPlan?.selectionPolicy?.version !== "signal-ranking-v5")
      throw new Error("待替换计划不是原 V5 周一观察计划");
    await assertStoredProgramPlan(env, previousPlan, account.book);
    const snapshot = await frozenProgramSignal(db, previousPlan);
    const previousDigest = await digest(previousPlan);
    if (!sourceConfigId)
      sourceConfigId = (
        await db
          .prepare(
            "SELECT id FROM dragon_config_versions ORDER BY created_at DESC,id DESC LIMIT 1",
          )
          .first()
      )?.id;
    if (!sourceConfigId) throw new Error("请先保存龙头风险预算参数");
    const sourceConfig = await loadDragonConfig(db, sourceConfigId);
    const oldObserverId = "intraday-entry-observation-v1";
    const shadows = new ShadowAccountRepository(env),
      oldObserver = await shadows.account(oldObserverId);
    if (
      oldObserver?.book.positions.length ||
      (await db
        .prepare("SELECT 1 FROM shadow_ledger WHERE account_id=? LIMIT 1")
        .bind(oldObserverId)
        .first()) ||
      (await db
        .prepare("SELECT 1 FROM shadow_sessions WHERE account_id=? LIMIT 1")
        .bind(oldObserverId)
        .first())
    )
      throw new Error("旧 V5 影子账户已开始执行，不能替换其观察计划");
    await saveDragonSettings(env, sourceConfig.config);
    await requestDragonActivation(env);
    if (!(await applyDragonLifecycle(env, account.book.lastDate, now)))
      throw new Error("尚未满足龙头风险预算整体切换条件");
    const { book } = await papers.account();
    const plan = createPlan(
      snapshot,
      book,
      null,
      book.dragonConfigId,
      now.toISOString(),
      {
        executionCostPolicy: await latestPolicyBundle(db),
        snapshotDigest: await selectionSnapshotDigest(snapshot),
      },
    );
    retainDragonObservationUniverse(plan, previousPlan.entryExecutionPolicy.candidates);
    await preserveProgramSignal(db, plan, snapshot);
    await papers.savePlan(plan);
    await assertStoredProgramPlan(env, plan, book);
    openSession(book, plan, cycle.tradeDate);
    await db
      .prepare(
        "DELETE FROM frozen_t_quality WHERE signal_date=? AND scope IN ('main',?)",
      )
      .bind(plan.signalDate, `shadow:${oldObserverId}`)
      .run();
    if (oldObserver) {
      await db
        .prepare("DELETE FROM shadow_plans WHERE account_id=?")
        .bind(oldObserverId)
        .run();
      await db
        .prepare("DELETE FROM shadow_accounts WHERE account_id=?")
        .bind(oldObserverId)
        .run();
      const observerId = book.dragonTransition.observerId;
      await shadows.ensureAccount(observerId, {
        kind: SHADOW_ACCOUNT_KINDS.DRAGON_OBSERVATION,
        book,
      });
      await shadows.savePlan(observerId, plan, snapshot);
      await assertStoredProgramPlan(env, plan, book, {
        tQualityScope: `shadow:${observerId}`,
      });
    }
    await db
      .prepare(
        `DELETE FROM settings WHERE key IN (${observationKeys.map(() => "?").join(",")})`,
      )
      .bind(...observationKeys)
      .run();
    const event = {
      type: "DRAGON_CYCLE_PREPARED",
      createdAt: now.toISOString(),
      sourceConfigId,
      configId: book.dragonConfigId,
      tradeDate: cycle.tradeDate,
      signalDate: plan.signalDate,
      previousPlanDigest: previousDigest,
      planDigest: await digest(plan),
      retiredObservation: oldObserver
        ? { account: oldObserver, planDigest: previousDigest }
        : null,
    };
    await db
      .prepare(
        "INSERT INTO paper_configuration_history(id,created_at,payload,digest) VALUES(?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        event.createdAt,
        JSON.stringify(event),
        await digest(event),
      )
      .run();
    const verification = await verifyExport(await exportPaper(env));
    if (!verification.passed)
      throw new Error("龙头风险预算切换后导出核验失败，已回滚");
    return {
      changed: true,
      tradeDate: cycle.tradeDate,
      configId: book.dragonConfigId,
      sourceConfigId,
      candidates: plan.entryExecutionPolicy.candidates.length,
      dragon: await dragonStatus(env),
      verification,
    };
  });
}

// The watchlist is frozen input, while liquidity remains a live entry gate.
// Keep the user's existing observations even when signal-day turnover is low.
export function retainDragonObservationUniverse(plan, codes) {
  if (!isDragon(plan) || !Array.isArray(codes)) throw new Error("只能恢复龙头政策的冻结观察名单");
  const unique = [...new Set(codes)], history = plan.entryExecutionPolicy.history;
  if (unique.length !== codes.length || unique.length > INTRADAY_ENTRY_RULES.maxPremarketCandidates)
    throw new Error("冻结观察名单重复或超过盘前上限");
  for (const code of unique) {
    const h = history[code];
    if (!/^\d{6}$/.test(code) || !h || h.recentLimitUp !== true || !h.name || /ST|退/i.test(h.name) ||
        !h.sector || h.sector === "未分类" || !(h.previousCloseCents > 0) ||
        !["relay-leader", "strong-reversal", "swing-range"].includes(h.stockClass))
      throw new Error(`观察标的 ${code} 的冻结历史或基本资格不完整`);
  }
  const sorted = unique.sort((a, b) => (history[b].amount ?? 0) - (history[a].amount ?? 0) || a.localeCompare(b));
  plan.entryExecutionPolicy.candidates = sorted;
  plan.selectionAudit.candidates = sorted.map((code, index) => ({
    code, name: history[code].name, rank: index + 1, amount: history[code].amount,
    status: eligible(history[code], null) ? "WATCHING" : "WAITING_TURNOVER",
    reason: eligible(history[code], null) ? "等待实际买点与共享风险预算" : "保留观察；盘中成交额达到准入门槛后仍可触发交易",
  }));
  return plan;
}

export async function restoreDragonObservationUniverse(env, { now = new Date() } = {}) {
  const db = env.DB;
  if (typeof db.transaction !== "function") throw new Error("观察名单修订需要本地事务数据库");
  return db.transaction(async () => {
    const papers = new PaperRepository(env), shadows = new ShadowAccountRepository(env);
    const account = await papers.account(), book = account?.book;
    if (!isDragon(book) || !book.tradingCycleId) throw new Error("当前不是已归档的新龙头交易周期");
    const cycleRow = await db.prepare("SELECT summary,digest FROM paper_trading_archives WHERE id=?").bind(book.tradingCycleId).first();
    const cycle = cycleRow && JSON.parse(cycleRow.summary);
    if (!cycle || await digest(cycle) !== cycleRow.digest) throw new Error("新周期归档缺失或摘要不一致");
    assertWindow(cycle.tradeDate, book.lastDate, now);
    if (book.settlementCount || book.positions.length || (book.pendingOrders ?? []).length ||
        (book.pendingRecovery ?? []).length || (book.pendingExits ?? []).length)
      throw new Error("周期已执行或存在未完成操作，不能修订观察名单");
    for (const table of ["paper_ledger", "paper_equity", "paper_live_sessions"])
      if (await db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).first()) throw new Error("主账户已有成交或会话，不能修订冻结观察名单");
    if (await db.prepare("SELECT 1 FROM research_window_owners LIMIT 1").first()) throw new Error("活动研究期间不能修订观察名单");
    const previousRow = await db.prepare("SELECT payload,digest FROM paper_plans WHERE signal_date=?").bind(book.lastDate).first();
    const previous = previousRow && JSON.parse(previousRow.payload);
    if (!previous || await digest(previous) !== previousRow.digest) throw new Error("当前冻结计划摘要不一致");
    await assertStoredProgramPlan(env, previous, book);
    const revisions = (await db.prepare("SELECT payload,digest FROM paper_plan_revisions WHERE signal_date=? ORDER BY created_at DESC,id DESC").bind(book.lastDate).all()).results;
    const originalRow = revisions.find(row => JSON.parse(row.payload).selectionPolicy?.version === "signal-ranking-v5");
    const original = originalRow && JSON.parse(originalRow.payload);
    if (!original || await digest(original) !== originalRow.digest || original.selectionAudit.snapshotDigest !== previous.selectionAudit.snapshotDigest)
      throw new Error("缺少与当前信号输入一致的原 V5 观察名单");
    const snapshot = await frozenProgramSignal(db, previous);
    const replacement = retainDragonObservationUniverse(structuredClone(previous), original.entryExecutionPolicy.candidates);
    const observers = (await shadows.accounts({ kinds: [SHADOW_ACCOUNT_KINDS.DRAGON_OBSERVATION] })).filter(row => row.status === "ACTIVE");
    const observerPlans = [];
    for (const observer of observers) {
      if (observer.book.dragonConfigId !== book.dragonConfigId || observer.book.lastDate !== book.lastDate || observer.book.positions.length ||
          await db.prepare("SELECT 1 FROM shadow_ledger WHERE account_id=? LIMIT 1").bind(observer.accountId).first() ||
          await db.prepare("SELECT 1 FROM shadow_sessions WHERE account_id=? LIMIT 1").bind(observer.accountId).first())
        throw new Error("独立观察账户已开始执行或配置不一致，不能替换其名单");
      const row = await db.prepare("SELECT * FROM shadow_plans WHERE account_id=? AND signal_date=?").bind(observer.accountId, book.lastDate).first();
      if (!row) throw new Error("独立观察账户缺少冻结计划");
      await assertStoredProgramPlan(env, JSON.parse(row.payload), observer.book, { tQualityScope: `shadow:${observer.accountId}` });
      observerPlans.push(row);
    }
    const candidates = replacement.entryExecutionPolicy.candidates;
    if (JSON.stringify(candidates) === JSON.stringify(previous.entryExecutionPolicy.candidates) &&
        observerPlans.every(row => JSON.stringify(JSON.parse(row.payload).entryExecutionPolicy.candidates) === JSON.stringify(candidates)))
      return { changed: false, candidates: candidates.length, pendingTurnover: candidates.filter(code => !eligible(replacement.entryExecutionPolicy.history[code], null)).length };
    replacement.createdAt = now.toISOString();
    const runId = crypto.randomUUID();
    const update = await db.prepare("UPDATE paper_accounts SET revision=revision+1,last_run_id=?,updated_at=? WHERE id='primary' AND revision=?").bind(runId, replacement.createdAt, account.revision).run();
    if (update.meta.changes !== 1) throw new Error("账户已变化，观察名单未修订");
    await db.prepare("INSERT INTO paper_plan_revisions(id,signal_date,created_at,payload,digest) VALUES(?,?,?,?,?)").bind(runId, book.lastDate, replacement.createdAt, previousRow.payload, previousRow.digest).run();
    await db.prepare("DELETE FROM paper_plans WHERE signal_date=?").bind(book.lastDate).run();
    await db.prepare("DELETE FROM dragon_plan_bindings WHERE scope='main' AND signal_date=?").bind(book.lastDate).run();
    await preserveProgramSignal(db, replacement, snapshot);
    await papers.savePlan(replacement);
    await assertStoredProgramPlan(env, replacement, book);
    openSession(book, replacement, cycle.tradeDate);
    for (const row of observerPlans) {
      const oldPlan = JSON.parse(row.payload);
      const plan = retainDragonObservationUniverse({ ...oldPlan, createdAt: replacement.createdAt }, original.entryExecutionPolicy.candidates);
      await db.prepare("DELETE FROM shadow_plans WHERE account_id=? AND signal_date=?").bind(row.account_id, book.lastDate).run();
      await db.prepare("DELETE FROM dragon_plan_bindings WHERE scope=? AND signal_date=?").bind(`shadow:${row.account_id}`, book.lastDate).run();
      await shadows.savePlan(row.account_id, plan, snapshot);
      await assertStoredProgramPlan(env, plan, book, { tQualityScope: `shadow:${row.account_id}` });
      await db.prepare("UPDATE shadow_accounts SET revision=revision+1,last_run_id=?,updated_at=? WHERE account_id=?").bind(runId, replacement.createdAt, row.account_id).run();
    }
    const pendingTurnover = candidates.filter(code => !eligible(replacement.entryExecutionPolicy.history[code], null)).length;
    const event = { type: "DRAGON_OBSERVATION_UNIVERSE_RESTORED", createdAt: replacement.createdAt,
      signalDate: book.lastDate, tradeDate: cycle.tradeDate, previousCount: previous.entryExecutionPolicy.candidates.length,
      count: candidates.length, pendingTurnover, sourcePlanDigest: originalRow.digest,
      previousPlanDigest: previousRow.digest, planDigest: await digest(replacement), supersededShadowPlans: observerPlans,
      note: "恢复用户原冻结观察名单；低于信号日流动性门槛的标的继续观察，实际入场仍核验盘中成交额、买点和风险预算。" };
    await db.prepare("INSERT INTO paper_configuration_history(id,created_at,payload,digest) VALUES(?,?,?,?)").bind(runId, event.createdAt, JSON.stringify(event), await digest(event)).run();
    const pool = await buildJointQuotePool(env, { now: new Date(`${cycle.tradeDate}T09:31:00+08:00`) });
    if (candidates.some(code => !pool.sources.primary.includes(code)) || observerPlans.some(row => candidates.some(code => !pool.sources.shadow[row.account_id]?.includes(code))))
      throw new Error("行情订阅未覆盖恢复后的完整观察名单");
    const verification = await verifyExport(await exportPaper(env));
    if (!verification.passed) throw new Error("恢复观察名单后导出核验失败，已回滚");
    return { changed: true, candidates: candidates.length, pendingTurnover, tradeDate: cycle.tradeDate, verification, poolCodes: pool.sources.primary };
  });
}
