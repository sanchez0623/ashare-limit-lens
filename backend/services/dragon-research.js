import {
  DRAGON_RESEARCH_KEYS,
  normalizeDragonConfig,
  DRAGON_TEMPLATE_VERSION,
} from "../../shared/dragon-risk-config.js";
import {
  isDragon,
  isAdaptiveDragon,
  createDragonPlan,
} from "../domain/dragon-risk.js";
import { hasAdaptiveMarketEvidence } from "../../shared/adaptive-risk.js";
import { digestOf, canonicalJson } from "../domain/research-lineage.js";
import {
  loadDragonConfig,
  dragonBookFields,
  registerDragonConfig,
} from "../storage/dragon-risk.js";
import { PaperRepository } from "../storage/paper.js";
import { RealtimeRepository } from "../storage/realtime.js";
import {
  ShadowAccountRepository,
  SHADOW_ACCOUNT_KINDS,
} from "../storage/shadow.js";
import {
  openSession,
  advanceSession,
  closeSession,
  marketClock,
  inSession,
} from "../domain/realtime.js";
import { frozenProgramSignal } from "../storage/strategy-signals.js";
import { verifyPolicyBundle } from "../storage/execution-cost.js";
import { freezePortfolioPlan, settlePortfolioDay } from "./portfolio-runner.js";
import { collectTradingDay } from "./market.js";
import { observationCoverage } from "./entry-observation.js";
import { QuoteFrameRepository } from "../storage/quotes.js";
import { assertStoredProgramPlan } from "./strategy-program-evidence.js";
import {
  patternMetrics,
  comparePatternWindow,
  fixedPatternConfig,
} from "../domain/dragon-patterns.js";
import { ResearchRepository } from "../storage/research.js";

const observer = (id) => `dragon-observer:${id}`;
const parent = (id) => `dragon-parent:${id}`;
const baseline = (id) => `dragon-baseline:${id}`;
const monthOf = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
const inputDigest = (days) =>
  digestOf(
    days.map((d) => ({
      date: d.date,
      source: d.source,
      frames: d.frames.map((f) => f.digest),
      dataset: d.dataset,
      cost: d.cost,
      fees: d.fees,
      feeModel: d.feeModel,
      feeConfigVersion: d.feeConfigVersion,
      createdAt: d.createdAt,
      observationUniverse: d.observationUniverse ?? null,
    })),
  );
export function validateDragonPatch(base, proposal, smallSteps = true) {
  if (
    !proposal ||
    typeof proposal.rationale !== "string" ||
    !proposal.rationale.trim() ||
    proposal.rationale.length > 2000 ||
    !proposal.patch ||
    typeof proposal.patch !== "object" ||
    Array.isArray(proposal.patch)
  )
    throw new Error("新政策提案结构无效");
  const keys = Object.keys(proposal.patch);
  if (
    !keys.length ||
    keys.length > 2 ||
    keys.some((k) => !DRAGON_RESEARCH_KEYS.includes(k))
  )
    throw new Error("新政策提案仅允许最多两个高级参数组");
  const config = structuredClone(base),
    steps = { stopLoss: 0.005, tFraction: 0.02, tSpread: 0.005 };
  for (const key of keys) {
    const value = proposal.patch[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value === base.advanced[key] ||
      (smallSteps && Math.abs(value - base.advanced[key]) > steps[key] + 1e-9)
    )
      throw new Error("新政策提案无变化或超过冻结步长");
    config.advanced[key] = value;
  }
  return normalizeDragonConfig(config);
}
async function writeRun(
  db,
  id,
  baseId,
  status,
  manifest = null,
  report = null,
) {
  const stamp = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO dragon_research_runs(config_id,base_id,status,manifest,report,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(config_id) DO UPDATE SET status=excluded.status,manifest=COALESCE(dragon_research_runs.manifest,excluded.manifest),report=excluded.report,updated_at=excluded.updated_at WHERE dragon_research_runs.status<>'INVALIDATED' OR excluded.status='INVALIDATED'",
    )
    .bind(
      id,
      baseId,
      status,
      manifest && JSON.stringify(manifest),
      report && JSON.stringify(report),
      stamp,
      stamp,
    )
    .run();
}
export async function dragonResearchStatus(env, id) {
  if (!id) return null;
  const row = await env.DB.prepare(
    "SELECT * FROM dragon_research_runs WHERE config_id=?",
  )
    .bind(id)
    .first();
  return row
    ? { status: row.status, report: row.report ? JSON.parse(row.report) : null }
    : null;
}
export async function sourceDays(env) {
  const rows = (
    await env.DB.prepare(
      "SELECT payload FROM paper_live_sessions ORDER BY trade_date DESC LIMIT 140",
    ).all()
  ).results;
  const sessions = rows
    .map((r) => JSON.parse(r.payload))
    .filter(
      (s) =>
        isDragon(s.plan) && isAdaptiveDragon(s.plan) && s.status === "CLOSED",
    )
    .reverse();
  return sessions;
}
export async function inputsFor(env, sessions, scope = "main") {
  const quotes = new QuoteFrameRepository(env),
    days = [];
  for (const s of sessions) {
    if (!isAdaptiveDragon(s.plan))
      throw new Error(
        "动态感知研究需要同版本的完整逐帧输入，不能沿用四档策略样本",
      );
    await assertStoredProgramPlan(env, s.plan, s.initialBook, {
      tQualityScope: scope,
    });
    const row = await env.DB.prepare(
      "SELECT payload FROM paper_market_days WHERE trade_date=?",
    )
      .bind(s.date)
      .first();
    const source = await frozenProgramSignal(env.DB, s.plan);
    const frames = await quotes.framesForDate(s.date);
    if (
      frames.some(
        (f) =>
          inSession(marketClock(new Date(f.observedAt)).time) &&
          !hasAdaptiveMarketEvidence(f.payload?.entryInputs?.market),
      )
    )
      throw new Error("动态感知的市场、板块原始指标不足，不能生成研究收益");
    if (
      !row ||
      !source ||
      !observationCoverage(
        frames,
        s.date,
        Number(env.TRADING_POLL_SECONDS ?? 10),
      ) ||
      !(await verifyPolicyBundle(s.plan.executionCostPolicy))
    )
      throw new Error("完整真实行情或冻结历史不足，不能进行新政策研究");
    for (const f of frames)
      if ((await digestOf(f.payload)) !== f.digest)
        throw new Error("研究行情摘要不一致");
    days.push({
      date: s.date,
      source,
      frames,
      dataset: JSON.parse(row.payload),
      cost: s.plan.executionCostPolicy,
      fees: s.plan.feeConfig,
      feeModel: s.plan.feeModel,
      feeConfigVersion: s.plan.feeConfigVersion,
      createdAt: s.plan.createdAt,
      dragonTemplateVersion: s.plan.dragonPolicy.templateVersion,
      entryOrderPolicy: s.plan.dragonPolicy.entryOrderPolicy ?? null,
      tCapitalPolicy: s.plan.dragonPolicy.tCapitalPolicy ?? null,
      adaptiveRiskPolicy: s.plan.dragonPolicy.adaptiveRiskPolicy,
      observationUniverse: s.plan.observationUniverse ?? null,
    });
  }
  for (let i = 0; i < days.length; i++)
    if (
      days[i].dataset.previousTradingDate !== days[i].source.date ||
      (i && days[i - 1].date !== days[i].source.date)
    )
      throw new Error("研究窗口不是相邻的完整交易日");
  return days;
}
function metrics(equities, fills, start) {
  return {
    ...patternMetrics(equities, fills, start),
    dates: equities.map((e) => e.date),
  };
}
export async function verifyDragonMatchedDays(
  env,
  accountId,
  days,
  expectedStart = null,
) {
  const shadows = new ShadowAccountRepository(env),
    storedFills = await shadows.ledger(accountId),
    equities = [],
    fills = [];
  let previous = expectedStart && structuredClone(expectedStart),
    start = previous?.equityCents;
  for (const day of days) {
    const stored = await shadows.session(accountId, day.date),
      equityRow = await env.DB.prepare(
        "SELECT payload FROM shadow_equity WHERE account_id=? AND trade_date=?",
      )
        .bind(accountId, day.date)
        .first();
    if (
      !stored ||
      stored.status !== "CLOSED" ||
      !equityRow ||
      (previous &&
        canonicalJson(previous) !== canonicalJson(stored.initialBook))
    )
      throw new Error("前瞻匹配账户的起点或结算不连续");
    await assertStoredProgramPlan(env, stored.plan, stored.initialBook, {
      tQualityScope: `shadow:${accountId}`,
    });
    start ??= stored.initialBook.equityCents;
    let book = structuredClone(stored.initialBook),
      session = openSession(book, stored.plan, day.date),
      ledger = [];
    for (const frame of day.frames) {
      if (
        new Date(Date.parse(frame.observedAt) + 8 * 3600000)
          .toISOString()
          .slice(11, 19) >= "15:00:00"
      )
        continue;
      const result = advanceSession(book, session, {
        ...frame.payload,
        observedAt: frame.observedAt,
      });
      book = result.book;
      session = result.session;
      ledger.push(...result.ledger);
    }
    const result = closeSession(book, session, day.dataset),
      actual = storedFills
        .filter((l) => l.date === day.date)
        .sort((a, b) => a.sequence - b.sequence);
    if (
      !result.equity.complete ||
      canonicalJson(result.session) !== canonicalJson(stored) ||
      canonicalJson([...ledger, ...result.ledger]) !== canonicalJson(actual) ||
      canonicalJson(result.equity) !==
        canonicalJson(JSON.parse(equityRow.payload))
    )
      throw new Error("前瞻匹配账户的实际行情、成交或净值与重放不一致");
    previous = result.book;
    equities.push(result.equity);
    fills.push(...ledger);
  }
  const account = await shadows.account(accountId);
  if (
    !account ||
    (account.book.lastDate === days.at(-1)?.date &&
      canonicalJson(account.book) !== canonicalJson(previous))
  )
    throw new Error("前瞻匹配账户总账与重放不一致");
  return metrics(equities, fills, start);
}
async function replay(env, record, start, days, multiplier = 1) {
  let book = { ...structuredClone(start), ...dragonBookFields(record) },
    equities = [],
    fills = [];
  for (const day of days) {
    book.lastDate = day.source.date;
    book.feeConfig = structuredClone(day.fees);
    book.feeModel = day.feeModel;
    book.feeConfigVersion = day.feeConfigVersion;
    const cost = structuredClone(day.cost);
    cost.payload.executionStressMultiplier = multiplier;
    cost.payloadDigest = await digestOf(cost.payload);
    const plan = createDragonPlan(day.source, book, day.createdAt, {
      dragonTemplateVersion:
        day.dragonTemplateVersion ?? DRAGON_TEMPLATE_VERSION,
      entryOrderPolicy: day.entryOrderPolicy ?? null,
      tCapitalPolicy: day.tCapitalPolicy ?? null,
      adaptiveRiskPolicy: day.adaptiveRiskPolicy,
      executionCostPolicy: cost,
      snapshotDigest: await digestOf(day.source),
      ...(day.observationUniverse
        ? { observationUniverse: day.observationUniverse }
        : {}),
    });
    let session = openSession(book, plan, day.date);
    for (const f of day.frames) {
      if (
        new Date(Date.parse(f.observedAt) + 8 * 3600000)
          .toISOString()
          .slice(11, 19) >= "15:00:00"
      )
        continue;
      const r = advanceSession(book, session, {
        ...f.payload,
        observedAt: f.observedAt,
      });
      book = r.book;
      session = r.session;
      fills.push(...r.ledger);
    }
    const result = closeSession(book, session, day.dataset);
    book = result.book;
    equities.push(result.equity);
    if (!result.equity.complete) throw new Error("研究结算覆盖不足");
  }
  return metrics(equities, fills, start.equityCents);
}
async function passes(candidate, reference, risk, k) {
  if (!Number.isInteger(k) || k < 1) return false;
  return (
    await comparePatternWindow({
      dates: candidate.dates,
      candidate,
      parent: reference,
      baseline: reference,
      risk,
      k,
      seed: {
        k,
        dates: candidate.dates,
        candidate: candidate.returns,
        reference: reference.returns,
      },
    })
  ).passed;
}
async function reserve(env, id, days, manifest) {
  const db = env.DB,
    stamp = new Date().toISOString(),
    month = monthOf();
  const used = await db
    .prepare(
      "SELECT trade_date FROM dragon_research_sample_uses ORDER BY trade_date",
    )
    .all();
  if (days.some((d) => used.results.some((u) => u.trade_date === d.date)))
    throw new Error("历史测试日期已经使用，等待新的封存窗口");
  const registry = await new ResearchRepository(env).ensureRegistry();
  manifest.comparisonK = registry.attemptSequence + 1;
  const nonce = `dragon-reserve:${id}`;
  const statements = [
    db
      .prepare(
        "UPDATE research_registry SET revision=revision+1,attempt_sequence=attempt_sequence+1,last_run_id=? WHERE namespace='main' AND revision=?",
      )
      .bind(nonce, registry.revision),
    db
      .prepare(
        "INSERT INTO dragon_research_runs(config_id,base_id,status,manifest,report,created_at,updated_at) SELECT ?,?,'HISTORICAL',?,NULL,?,? WHERE EXISTS (SELECT 1 FROM paper_accounts WHERE id='primary' AND json_extract(state,'$.dragonTransition.configId')=? AND json_extract(state,'$.dragonTransition.candidate')=1) AND EXISTS(SELECT 1 FROM research_registry WHERE namespace='main' AND last_run_id=?) ON CONFLICT(config_id) DO UPDATE SET status='HISTORICAL',manifest=excluded.manifest,report=NULL,updated_at=excluded.updated_at WHERE dragon_research_runs.status<>'INVALIDATED'",
      )
      .bind(
        id,
        manifest.baseId,
        JSON.stringify(manifest),
        stamp,
        stamp,
        id,
        nonce,
      ),
    db
      .prepare(
        "INSERT INTO research_window_owners(namespace,owner_type,owner_id,window_payload,created_at) SELECT 'main','DRAGON',?,?,? WHERE EXISTS (SELECT 1 FROM dragon_research_runs WHERE config_id=? AND status='HISTORICAL') AND EXISTS (SELECT 1 FROM paper_accounts WHERE id='primary' AND json_extract(state,'$.dragonTransition.configId')=? AND json_extract(state,'$.dragonTransition.candidate')=1)",
      )
      .bind(
        id,
        JSON.stringify({
          policy: "dragon-risk-v1",
          testDates: days.map((d) => d.date),
        }),
        stamp,
        id,
        id,
      ),
    db
      .prepare(
        "INSERT INTO research_generation_slots(namespace,month,slot,owner_type,owner_id,reserved_at) SELECT 'main',?,1,'DRAGON',?,? WHERE EXISTS (SELECT 1 FROM research_window_owners WHERE namespace='main' AND owner_type='DRAGON' AND owner_id=?)",
      )
      .bind(month, id, stamp, id),
    ...days.flatMap((d) => [
      db
        .prepare(
          "INSERT INTO dragon_research_sample_uses(trade_date,config_id,role) SELECT ?,?,'TEST' WHERE EXISTS (SELECT 1 FROM research_window_owners WHERE namespace='main' AND owner_type='DRAGON' AND owner_id=?)",
        )
        .bind(d.date, id, id),
      db
        .prepare(
          "INSERT INTO research_test_claims(namespace,outcome_date,experiment_id,role,reserved_at,owner_type,owner_id) SELECT 'main',?,?,'HISTORICAL_TEST',?,'DRAGON',? WHERE EXISTS(SELECT 1 FROM research_window_owners WHERE namespace='main' AND owner_type='DRAGON' AND owner_id=?)",
        )
        .bind(d.date, id, stamp, id, id),
    ]),
  ];
  try {
    await db.batch(statements);
    const owner = await db
      .prepare(
        "SELECT owner_id FROM research_window_owners WHERE namespace='main' AND owner_type='DRAGON'",
      )
      .first();
    if (owner?.owner_id !== id) throw new Error("候选已被终止或替换");
  } catch {
    throw new Error("活动研究窗口、月度预算或测试日期已被占用");
  }
}
async function release(env, id) {
  await env.DB.prepare(
    "DELETE FROM research_window_owners WHERE namespace='main' AND owner_type='DRAGON' AND owner_id=?",
  )
    .bind(id)
    .run();
}
export async function ensureDragonTemplateResearch(
  env,
  record,
  primary,
  snapshot,
  now,
) {
  if (record.validationMode === "MANUAL_UNVERIFIED") return;
  const base = await loadDragonConfig(env.DB, record.baseId),
    old = await env.DB.prepare(
      "SELECT * FROM dragon_research_runs WHERE config_id=?",
    )
      .bind(record.id)
      .first();
  if (
    old &&
    ["FAILED", "INVALIDATED", "PASSED", "INCONCLUSIVE"].includes(old.status)
  ) {
    await release(env, record.id);
    return;
  }
  let manifest = old?.manifest ? JSON.parse(old.manifest) : null;
  if (manifest) {
    const owner = await env.DB.prepare(
      "SELECT owner_id,owner_type FROM research_window_owners WHERE namespace='main'",
    ).first();
    if (owner?.owner_type !== "DRAGON" || owner.owner_id !== record.id) {
      await writeRun(env.DB, record.id, base.id, "INVALIDATED", manifest, {
        reason: "冻结研究窗口所有权不一致",
      });
      return;
    }
  }
  if (manifest && old.status === "HISTORICAL") {
    // Crash recovery must replay the frozen test window; never skip to forward.
    const sessions = (await sourceDays(env)).filter((s) =>
      manifest.testDates.includes(s.date),
    );
    let days;
    try {
      days = await inputsFor(env, sessions);
    } catch (error) {
      await writeRun(env.DB, record.id, base.id, "INVALIDATED", manifest, {
        reason: error.message,
      });
      await release(env, record.id);
      return;
    }
    const results = [],
      hash = await inputDigest(days);
    if (sessions.length !== 20 || hash !== manifest.testInputDigest) {
      await writeRun(env.DB, record.id, base.id, "INVALIDATED", manifest, {
        reason: "恢复时冻结的测试输入不一致",
      });
      await release(env, record.id);
      return;
    }
    for (const multiplier of manifest.stressMultipliers) {
      const c = await replay(
          env,
          record,
          manifest.historicalStart,
          days,
          multiplier,
        ),
        p = await replay(env, base, manifest.historicalStart, days, multiplier),
        b = await replay(
          env,
          manifest.fixed,
          manifest.historicalStart,
          days,
          multiplier,
        );
      results.push({
        multiplier,
        candidate: c,
        parent: p,
        baseline: b,
        passed:
          (await passes(c, p, record.config.risk, manifest.comparisonK)) &&
          (await passes(c, b, record.config.risk, manifest.comparisonK)),
      });
    }
    if (results.some((r) => !r.passed)) {
      await writeRun(env.DB, record.id, base.id, "FAILED", manifest, {
        historical: results,
      });
      await release(env, record.id);
      return;
    }
    await writeRun(env.DB, record.id, base.id, "FORWARD", manifest, {
      historical: results,
    });
  }
  if (!manifest) {
    const sessions = await sourceDays(env);
    if (sessions.length < 80) {
      await writeRun(env.DB, record.id, base.id, "COLLECTING", null, {
        reason: "需要60个训练日与20个完整封存测试日",
        availableDays: sessions.length,
      });
      return;
    }
    const selected = sessions.slice(-80),
      testSessions = selected.slice(60),
      days = await inputsFor(env, testSessions);
    const current = await new PaperRepository(env).account();
    if (
      current?.book.dragonTransition?.configId !== record.id ||
      !current.book.dragonTransition.candidate
    )
      return;
    const fixedConfig = fixedPatternConfig(record.config);
    const fixed = await registerDragonConfig(env.DB, fixedConfig, base.id, {
      id: `baseline:${record.id}`,
      origin: "RESEARCH",
      validationMode: "RESEARCH_REQUIRED",
    });
    manifest = {
      version: 1,
      configId: record.id,
      baseId: base.id,
      configDigest: record.digest,
      engineBuild: record.engineBuild,
      trainDates: selected.slice(0, 60).map((s) => s.date),
      testDates: days.map((d) => d.date),
      testInputDigest: await inputDigest(days),
      initialBook: structuredClone(primary.book),
      anchorConfigId: primary.book.dragonConfigId,
      anchorConfigDigest: await digestOf(primary.book.dragonConfig),
      historicalStart: testSessions[0].initialBook,
      forwardStartDate: snapshot.date,
      parent: base,
      fixed,
      forwardDays: 30,
      stressMultipliers: [1, 1.5, 2],
      frozenAt: now.toISOString(),
    };
    // The immutable manifest and all reservations commit together before testing.
    try {
      await reserve(env, record.id, days, manifest);
    } catch (error) {
      await writeRun(env.DB, record.id, base.id, "WAITING_WINDOW", null, {
        reason: error.message,
      });
      return;
    }
    const results = [];
    try {
      for (const multiplier of manifest.stressMultipliers) {
        const candidate = await replay(
          env,
          record,
          manifest.historicalStart,
          days,
          multiplier,
        );
        const p = await replay(
          env,
          base,
          manifest.historicalStart,
          days,
          multiplier,
        );
        const b = await replay(
          env,
          fixed,
          manifest.historicalStart,
          days,
          multiplier,
        );
        results.push({
          multiplier,
          candidate,
          parent: p,
          baseline: b,
          passed:
            (await passes(
              candidate,
              p,
              record.config.risk,
              manifest.comparisonK,
            )) &&
            (await passes(
              candidate,
              b,
              record.config.risk,
              manifest.comparisonK,
            )),
        });
      }
    } catch (error) {
      results.push({ passed: false, reason: error.message });
    }
    if (results.length !== 3 || results.some((r) => !r.passed)) {
      await writeRun(env.DB, record.id, base.id, "FAILED", manifest, {
        historical: results,
      });
      await release(env, record.id);
      return;
    }
    await writeRun(env.DB, record.id, base.id, "FORWARD", manifest, {
      historical: results,
    });
  }
  if (
    primary.book.dragonConfigId !== (manifest.anchorConfigId ?? base.id) ||
    (await digestOf(primary.book.dragonConfig)) !==
      (manifest.anchorConfigDigest ?? base.digest) ||
    primary.book.feeConfigVersion !== manifest.initialBook.feeConfigVersion
  ) {
    await writeRun(env.DB, record.id, base.id, "INVALIDATED", manifest, {
      reason: "主账户参数或费用改变，不能沿用旧窗口",
    });
    await release(env, record.id);
    return;
  }
  const shadows = new ShadowAccountRepository(env);
  for (const [id, r] of [
    [observer(record.id), record],
    [parent(record.id), base],
    [baseline(record.id), manifest.fixed],
  ]) {
    // Fixed baseline gets an independently frozen config record, without user-editable risk changes.
    if (id === baseline(record.id)) {
      const found = await env.DB.prepare(
        "SELECT id FROM dragon_config_versions WHERE id=?",
      )
        .bind(r.id)
        .first();
      if (!found)
        await env.DB.prepare(
          "INSERT INTO dragon_config_versions(id,payload,digest,engine_build,base_id,created_at) VALUES(?,?,?,?,?,?)",
        )
          .bind(
            r.id,
            JSON.stringify(r.config),
            r.digest,
            r.engineBuild,
            base.id,
            now.toISOString(),
          )
          .run();
    }
    let account = await shadows.account(id);
    if (!account)
      account = await shadows.ensureAccount(id, {
        kind: SHADOW_ACCOUNT_KINDS.DRAGON_OBSERVATION,
        book: {
          ...structuredClone(manifest.initialBook),
          ...dragonBookFields(r),
        },
      });
    if (account.book.lastDate !== snapshot.date) {
      const session = await shadows.session(id, snapshot.date);
      if (!session) {
        await writeRun(env.DB, record.id, base.id, "INCONCLUSIVE", manifest, {
          reason: "前瞻日期缺少会话，不补造历史",
        });
        await release(env, record.id);
        return;
      }
      if (session.status === "OPEN")
        await settlePortfolioDay(
          env,
          id,
          snapshot.date,
          await collectTradingDay(
            snapshot.date,
            account.book.positions.map((p) => p.code),
            [],
            null,
          ),
        );
    }
    await freezePortfolioPlan(env, id, {
      snapshot,
      strategy: null,
      strategyVersion: r.id,
      now: now.toISOString(),
    });
  }
  const equities = (
    await env.DB.prepare(
      "SELECT trade_date,payload FROM shadow_equity WHERE account_id=? ORDER BY trade_date",
    )
      .bind(observer(record.id))
      .all()
  ).results;
  if (equities.length < manifest.forwardDays) return;
  const dates = equities
      .slice(0, manifest.forwardDays)
      .map((r) => r.trade_date),
    allDays = [];
  for (const date of dates) {
    const session = await shadows.session(observer(record.id), date);
    if (!session) {
      await writeRun(env.DB, record.id, base.id, "INCONCLUSIVE", manifest, {
        reason: "前瞻窗口不完整",
      });
      await release(env, record.id);
      return;
    }
    allDays.push(session);
  }
  const days = await inputsFor(env, allDays, `shadow:${observer(record.id)}`),
    results = [];
  try {
    await env.DB.batch(
      dates.flatMap((date) => [
        env.DB.prepare(
          "INSERT OR IGNORE INTO dragon_research_sample_uses(trade_date,config_id,role) VALUES(?,?,'FORWARD')",
        ).bind(date, record.id),
        env.DB.prepare(
          "INSERT OR IGNORE INTO research_test_claims(namespace,outcome_date,experiment_id,role,reserved_at,owner_type,owner_id) VALUES('main',?,?,'FORWARD',?,'DRAGON',?)",
        ).bind(date, record.id, now.toISOString(), record.id),
      ]),
    );
    for (const date of dates) {
      const use = await env.DB.prepare(
        "SELECT config_id FROM dragon_research_sample_uses WHERE trade_date=?",
      )
        .bind(date)
        .first();
      if (use?.config_id !== record.id)
        throw new Error("前瞻日期被其他研究使用");
      const claim = await env.DB.prepare(
        "SELECT owner_id FROM research_test_claims WHERE namespace='main' AND outcome_date=?",
      )
        .bind(date)
        .first();
      if (claim?.owner_id !== record.id)
        throw new Error("前瞻日期被其他研究占用");
    }
    for (const multiplier of manifest.stressMultipliers) {
      const candidate = await replay(
          env,
          record,
          manifest.initialBook,
          days,
          multiplier,
        ),
        p = await replay(env, base, manifest.initialBook, days, multiplier),
        b = await replay(
          env,
          manifest.fixed,
          manifest.initialBook,
          days,
          multiplier,
        );
      results.push({
        multiplier,
        candidate,
        parent: p,
        baseline: b,
        passed:
          (await passes(
            candidate,
            p,
            record.config.risk,
            manifest.comparisonK,
          )) &&
          (await passes(
            candidate,
            b,
            record.config.risk,
            manifest.comparisonK,
          )),
      });
    }
    for (const id of [
      observer(record.id),
      parent(record.id),
      baseline(record.id),
    ]) {
      const account = await shadows.account(id);
      for (const date of dates) {
        const day = await shadows.session(id, date);
        if (
          !day ||
          day.plan.dragonPolicy.configId !==
            (id === observer(record.id)
              ? record.id
              : id === parent(record.id)
                ? base.id
                : manifest.fixed.id)
        )
          throw new Error("前瞻匹配账户混用政策");
        await assertStoredProgramPlan(env, day.plan, day.initialBook, {
          tQualityScope: `shadow:${id}`,
        });
      }
      if (!account) throw new Error("匹配账户不存在");
      const r =
        id === observer(record.id)
          ? record
          : id === parent(record.id)
            ? base
            : manifest.fixed;
      await verifyDragonMatchedDays(env, id, days, {
        ...structuredClone(manifest.initialBook),
        ...dragonBookFields(r),
      });
    }
  } catch (error) {
    results.push({ passed: false, reason: error.message });
  }
  const passed = results.length === 3 && results.every((r) => r.passed);
  await writeRun(
    env.DB,
    record.id,
    base.id,
    passed ? "PASSED" : "FAILED",
    manifest,
    {
      forward: results,
      dates,
      inputDigest: await inputDigest(days),
      actualAccountsVerified: passed,
    },
  );
  await release(env, record.id);
}
export async function proposeDragonImprovement(env) {
  const { proposePatternResearch } = await import(
    "./dragon-pattern-research.js"
  );
  return proposePatternResearch(env);
}
