import {
  OBSERVATION_SCORE_POLICY as POLICY,
  scoreObservation,
} from "../../shared/observation-scoring.js";
import { digestOf, canonicalJson } from "../domain/research-lineage.js";
import { executionEngineBuildDigest } from "../domain/execution-build.js";
import { observationScoreBuildDigest } from "../domain/observation-score-build.js";
import { openSession, advanceSession } from "../domain/realtime.js";
import { completedPracticeCycles } from "../domain/practice-review.js";
import { buildScoreCalibration } from "../domain/score-calibration.js";
import {
  INDUSTRY_CONTINUATION,
  industryContinuation,
} from "../storage/industry-continuation.js";

const parse = (row) => (row ? JSON.parse(row.payload) : null);
async function verified(row, label) {
  const value = parse(row);
  if (value && (await digestOf(value)) !== row.digest)
    throw new Error(`${label}摘要不一致`);
  return value;
}
export async function scoringPolicy(env) {
  const policy = {
    ...POLICY,
    implementationDigest: await observationScoreBuildDigest(),
  };
  const row = await env.DB.prepare(
    "SELECT * FROM observation_score_policies WHERE version=?",
  )
    .bind(POLICY.version)
    .first();
  if (row) await verified(row, "评分政策");
  if (row && (await digestOf(policy)) !== row.digest)
    throw new Error("同版本评分政策已改变，必须登记新版本");
  return {
    policy,
    digest: await digestOf(policy),
    publishedAt: row?.published_at ?? null,
  };
}
async function register(env, now) {
  const { policy, digest } = await scoringPolicy(env);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO observation_score_policies(version,payload,digest,published_at) VALUES(?,?,?,?)",
  )
    .bind(POLICY.version, JSON.stringify(policy), digest, now.toISOString())
    .run();
  return scoringPolicy(env);
}

export async function scoringScores(
  env,
  { date, code, buyPoint, now = new Date() } = {},
) {
  date ??= (
    await env.DB.prepare(
      "SELECT MAX(trade_date) AS date FROM observation_score_latest",
    ).first()
  )?.date;
  if (!date)
    return {
      version: POLICY.version,
      date: null,
      rows: [],
      status: "COLLECTING",
      note: "等待独立评分进程处理真实观测",
    };
  if (
    await env.DB.prepare(
      "SELECT trade_date FROM observation_score_invalidations WHERE trade_date=?",
    )
      .bind(date)
      .first()
  )
    return {
      version: POLICY.version,
      date,
      rows: [],
      status: "SOURCE_CHANGED",
      note: "原始观测已修改、删除或归档，原评分保留但不作为当前证据",
    };
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM observation_score_latest WHERE trade_date=? AND version=?${code ? " AND code=?" : ""} ORDER BY code`,
    )
      .bind(date, POLICY.version, ...(code ? [code] : []))
      .all()
  ).results;
  const profiles = [];
  for (const row of rows) {
    const value = await verified(row, "评分");
    const local = new Date(now.getTime() + 28800000).toISOString();
    const time = local.slice(11, 19);
    const live =
      date === local.slice(0, 10) &&
      ((time >= "09:30:00" && time <= "11:30:00") ||
        (time >= "13:00:00" && time < "14:57:00"));
    const quoteAt = value.risk?.layers?.stock?.observedAt ?? value.asOf;
    value.freshness =
      live && now.getTime() - Date.parse(quoteAt) > 15000
        ? "STALE"
        : live
          ? "CURRENT"
          : "AS_OBSERVED";
    if (value.freshness === "STALE") {
      value.risk = {
        ...value.risk,
        value: null,
        level: "过期",
        reason: "当前观测已过期，历史快照保留",
        effective: null,
      };
      value.cards = value.cards.map((c) => ({
        ...c,
        value: null,
        components: { L: c.components.L, E: null, F: null, C: null },
        coverage: c.components.L === null ? 0 : 0.25,
        missing:
          c.components.L === null ? ["L", "E", "F", "C"] : ["E", "F", "C"],
        status: c.enabled ? "WAITING_DATA" : "DISABLED",
        reason: "报价或评分观测已过期，等待独立处理更新",
      }));
    }
    if (buyPoint) value.cards = value.cards.filter((c) => c.type === buyPoint);
    profiles.push(value);
  }
  const cursor = await env.DB.prepare(
    "SELECT sequence FROM observation_score_cursors WHERE trade_date=? AND version=?",
  )
    .bind(date, POLICY.version)
    .first();
  const latest = await env.DB.prepare(
    "SELECT MAX(sequence) AS n FROM paper_live_ticks WHERE trade_date=?",
  )
    .bind(date)
    .first();
  return {
    version: POLICY.version,
    date,
    rows: profiles,
    cursor: cursor?.sequence ?? 0,
    sourceSequence: latest?.n ?? 0,
    status:
      (cursor?.sequence ?? 0) < (latest?.n ?? 0)
        ? "LAGGING"
        : profiles.length
          ? "CURRENT"
          : "COLLECTING",
    note: POLICY.note,
  };
}
export async function scoringCalibration(
  env,
  { date, buyPoint, phase, version = POLICY.version } = {},
) {
  const row = await env.DB.prepare(
    `SELECT * FROM observation_score_calibrations WHERE version=?${date ? " AND as_of<=?" : ""} ORDER BY as_of DESC,created_at DESC LIMIT 1`,
  )
    .bind(version, ...(date ? [date] : []))
    .first();
  if (!row)
    return {
      version,
      purpose: "DIAGNOSTIC",
      eligibleForPromotion: false,
      groups: [],
      samples: [],
      sampleCount: 0,
      status: "COLLECTING",
      note: "等待带事前评分的完整建仓至清仓周期",
    };
  const report = await verified(row, "评分校准报告");
  if (report.sourceManifest) {
    const ledger = (
      await env.DB.prepare(
        "SELECT payload FROM paper_ledger WHERE trade_date<=? ORDER BY trade_date,json_extract(payload,'$.sequence')",
      )
        .bind(report.asOf)
        .all()
    ).results.map(parse);
    if ((await digestOf(ledger)) !== report.sourceManifest.ledgerDigest)
      throw new Error("校准账本来源已改变");
    for (const source of report.sourceManifest.entries)
      await verifyEntrySource(env, source);
    for (const source of report.sourceManifest.days ?? [])
      await verifyLedgerDay(env, source);
  }
  report.id = row.id;
  report.groups = report.groups.filter(
    (g) =>
      (!buyPoint || g.buyPoint === buyPoint) && (!phase || g.phase === phase),
  );
  report.samples = report.samples.filter(
    (s) =>
      (!buyPoint || s.buyPoint === buyPoint) && (!phase || s.phase === phase),
  );
  report.sampleCount = report.samples.length;
  return report;
}

async function calibrate(env, asOf) {
  const ledgerRows = (
    await env.DB.prepare(
      "SELECT payload FROM paper_ledger WHERE trade_date<=? ORDER BY trade_date,json_extract(payload,'$.sequence')",
    )
      .bind(asOf)
      .all()
  ).results;
  const fills = ledgerRows.map(parse);
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM observation_score_snapshots WHERE kind='ENTRY' AND version=? AND trade_date<=?",
    )
      .bind(POLICY.version, asOf)
      .all()
  ).results;
  const entries = [];
  const manifest = [];
  const cycles = completedPracticeCycles(fills);
  const completeIds = new Set(cycles.map((c) => c.id));
  for (const row of rows) {
    const entry = await verified(row, "建仓评分快照");
    if (!completeIds.has(entry.cycleId)) continue;
    const source = {
      id: row.id,
      digest: row.digest,
      date: row.trade_date,
      sequence: row.sequence,
      observationDigest: entry.observationDigest,
      planDigest: entry.planDigest,
    };
    await verifyEntrySource(env, source);
    manifest.push(source);
    entries.push(entry);
  }
  const scoredCycles = new Set(entries.map((e) => e.cycleId));
  const days = [];
  for (const date of [
    ...new Set(
      fills.filter((f) => scoredCycles.has(f.cycleId)).map((f) => f.date),
    ),
  ]) {
    const cursorRow = await env.DB.prepare(
      "SELECT * FROM observation_score_cursors WHERE trade_date=? AND version=?",
    )
      .bind(date, POLICY.version)
      .first();
    const cursor = await verified(cursorRow, "校准执行核验游标");
    const maximum = Math.max(
      ...fills
        .filter((f) => f.date === date && scoredCycles.has(f.cycleId))
        .map((f) => f.observationSequence ?? Infinity),
    );
    if (!cursor?.verifiedLedger || cursorRow.sequence < maximum)
      return { status: "WAITING_VERIFICATION" };
    const source = {
      date,
      sequence: cursorRow.sequence,
      ledgerDigest: await digestOf(cursor.verifiedLedger),
    };
    await verifyLedgerDay(env, source);
    days.push(source);
  }
  const report = buildScoreCalibration({
    cycles,
    entries,
    fills,
    asOf,
  });
  report.sourceManifest = {
    ledgerDigest: await digestOf(fills),
    entries: manifest.sort((a, b) => a.id.localeCompare(b.id)),
    days,
  };
  const digest = await digestOf(report),
    id = `${asOf}:${POLICY.version}:${digest}`;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO observation_score_calibrations(id,as_of,version,payload,digest,created_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      id,
      asOf,
      POLICY.version,
      JSON.stringify(report),
      digest,
      new Date().toISOString(),
    )
    .run();
  return report;
}

async function verifyLedgerDay(env, source) {
  const rows = (
    await env.DB.prepare(
      "SELECT payload FROM paper_ledger WHERE trade_date=? AND json_extract(payload,'$.observationSequence')<=? ORDER BY json_extract(payload,'$.sequence')",
    )
      .bind(source.date, source.sequence)
      .all()
  ).results.map(parse);
  if ((await digestOf(rows)) !== source.ledgerDigest)
    throw new Error("校准成交与独立执行核验不一致");
}

async function verifyEntrySource(env, source) {
  if (
    await env.DB.prepare(
      "SELECT trade_date FROM observation_score_invalidations WHERE trade_date=?",
    )
      .bind(source.date)
      .first()
  )
    throw new Error("校准原始观测摘要不一致：来源日已修改或归档");
  const row = await env.DB.prepare(
    "SELECT * FROM observation_score_snapshots WHERE id=?",
  )
    .bind(source.id)
    .first();
  if (!row || row.digest !== source.digest)
    throw new Error("校准建仓评分快照缺失或已改变");
  await verified(row, "建仓评分快照");
  const tick = await env.DB.prepare(
    "SELECT payload,digest FROM paper_live_ticks WHERE trade_date=? AND sequence=?",
  )
    .bind(source.date, source.sequence)
    .first();
  if (!tick || tick.digest !== source.observationDigest)
    throw new Error("校准原始观测缺失或已改变");
  await verified(tick, "校准原始观测");
  const session = parse(
    await env.DB.prepare(
      "SELECT payload FROM paper_live_sessions WHERE trade_date=?",
    )
      .bind(source.date)
      .first(),
  );
  if (!session || (await digestOf(session.plan)) !== source.planDigest)
    throw new Error("校准冻结计划已改变");
}

// Replays the already committed account observations in a separate process.
// No writes to account/session/ledger/quote tables; reads never run this worker.
export async function runScoringTick(
  env,
  { now = new Date(), maxFrames = 5 } = {},
) {
  const policy = await register(env, now),
    build = await executionEngineBuildDigest();
  const sessions = (
    await env.DB.prepare(
      "SELECT s.trade_date,s.payload FROM paper_live_sessions s WHERE (json_extract(s.payload,'$.plan.engineBuild')=? OR EXISTS(SELECT 1 FROM paper_configuration_history h WHERE json_extract(h.payload,'$.type')=? AND json_extract(h.payload,'$.tradeDate')=s.trade_date AND json_extract(h.payload,'$.runtimeBuild')=?)) AND EXISTS(SELECT 1 FROM paper_live_ticks t WHERE t.trade_date=s.trade_date AND t.sequence>COALESCE((SELECT c.sequence FROM observation_score_cursors c WHERE c.trade_date=s.trade_date AND c.version=?),0)) ORDER BY s.trade_date",
    )
      .bind(build, INDUSTRY_CONTINUATION, build, POLICY.version)
      .all()
  ).results;
  let processed = 0;
  const issues = [];
  for (const row of sessions) {
    const authoritative = parse(row),
      plan = authoritative.plan;
    if (plan?.tradingPolicyVersion !== "dragon-risk-v1") continue;
    const hasTicks = await env.DB.prepare(
      "SELECT MAX(sequence) AS n FROM paper_live_ticks WHERE trade_date=?",
    )
      .bind(row.trade_date)
      .first();
    if (!hasTicks?.n) continue;
    const stored = await env.DB.prepare(
      "SELECT * FROM observation_score_cursors WHERE trade_date=? AND version=?",
    )
      .bind(row.trade_date, POLICY.version)
      .first();
    if ((stored?.sequence ?? 0) >= hasTicks.n) continue;
    const continuation =
      plan.engineBuild === build
        ? null
        : await industryContinuation(env.DB, plan);
    if (plan.engineBuild !== build && !continuation) {
      issues.push({
        date: row.trade_date,
        reason: "执行源码与冻结计划不一致，评分等待相应版本",
      });
      continue;
    }
    const checkpoint = await verified(stored, "评分游标");
    const planDigest = await digestOf(plan);
    if (checkpoint && checkpoint.planDigest !== planDigest) {
      issues.push({
        date: row.trade_date,
        reason: "冻结计划发生变化，保留原评分快照",
      });
      continue;
    }
    let book = checkpoint?.book ?? structuredClone(authoritative.initialBook);
    let session =
      checkpoint?.session ?? openSession(book, plan, row.trade_date);
    let verifiedLedger = checkpoint?.verifiedLedger ?? [];
    const ticks = (
      await env.DB.prepare(
        "SELECT * FROM paper_live_ticks WHERE trade_date=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
        .bind(row.trade_date, stored?.sequence ?? 0, maxFrames - processed)
        .all()
    ).results;
    for (const tick of ticks) {
      if (tick.sequence !== session.sequence + 1)
        throw new Error("评分观测序号不连续");
      const observation = await verified(tick, "原始账户观测");
      const result = advanceSession(book, session, observation);
      const actual = (
        await env.DB.prepare(
          "SELECT payload FROM paper_ledger WHERE trade_date=? AND json_extract(payload,'$.observationSequence')=? ORDER BY json_extract(payload,'$.sequence')",
        )
          .bind(row.trade_date, tick.sequence)
          .all()
      ).results.map(parse);
      if (canonicalJson(actual) !== canonicalJson(result.ledger))
        throw new Error("评分重放成交与实际账本不一致");
      const source = {
        planDigest,
        observationDigest: tick.digest,
        sequence: tick.sequence,
        engineBuild: plan.engineBuild,
        runtimeBuild: build,
        ...(continuation ? { continuationId: continuation.id } : {}),
        scorePolicyDigest: policy.digest,
        configDigest: plan.dragonPolicy.configDigest,
        feeDigest: await digestOf(plan.feeConfig ?? null),
      };
      const statements = [];
      const guard =
        "EXISTS(SELECT 1 FROM observation_score_cursors WHERE trade_date=? AND version=? AND sequence=? AND digest=?)";
      verifiedLedger = [...verifiedLedger, ...result.ledger];
      const next = {
        planDigest,
        book: result.book,
        session: result.session,
        verifiedLedger,
      };
      const nextDigest = await digestOf(next);
      statements.push(
        env.DB.prepare(
          "INSERT INTO observation_score_cursors(trade_date,version,sequence,payload,digest) VALUES(?,?,?,?,?) ON CONFLICT(trade_date,version) DO UPDATE SET sequence=excluded.sequence,payload=excluded.payload,digest=excluded.digest WHERE observation_score_cursors.sequence=?",
        ).bind(
          row.trade_date,
          POLICY.version,
          tick.sequence,
          JSON.stringify(next),
          nextDigest,
          tick.sequence - 1,
        ),
      );
      const args = [row.trade_date, POLICY.version, tick.sequence, nextDigest];
      for (const code of plan.entryExecutionPolicy.candidates
        .concat(Object.keys(result.session.entryState?.admissions ?? {}))
        .filter((c, i, all) => all.indexOf(c) === i)) {
        const profile = {
          ...scoreObservation({
            code,
            plan,
            session: result.session,
            observation,
            ledger: result.ledger,
            book: result.book,
          }),
          source,
        };
        statements.push(
          env.DB.prepare(
            `INSERT INTO observation_score_latest(trade_date,code,version,sequence,payload,digest) SELECT ?,?,?,?,?,? WHERE ${guard} ON CONFLICT(trade_date,code,version) DO UPDATE SET sequence=excluded.sequence,payload=excluded.payload,digest=excluded.digest WHERE observation_score_latest.sequence<excluded.sequence`,
          ).bind(
            row.trade_date,
            code,
            POLICY.version,
            tick.sequence,
            JSON.stringify(profile),
            await digestOf(profile),
            ...args,
          ),
        );
        for (const card of profile.cards) {
          const first = result.ledger.find(
            (f) =>
              f.code === code &&
              (f.intent ?? f.action) === "OPEN" &&
              f.buyPoint === card.type,
          );
          const initial = first && !book.positions.some((p) => p.code === code);
          const events = ["TRIGGERED", "FILLED"].includes(card.status)
            ? ["TRIGGER", ...(initial ? ["ENTRY"] : [])]
            : [];
          for (const kind of events) {
            const cycleId = kind === "ENTRY" ? first.cycleId : null;
            const id = [
              POLICY.version,
              row.trade_date,
              code,
              card.type,
              kind,
              cycleId ?? "first",
            ].join(":");
            const snapshot = {
              ...source,
              profile,
              cycleId,
              buyPoint: card.type,
              phase: result.session.regime?.phase ?? "unknown",
              initialR0Cents: initial
                ? (result.book.positions.find((p) => p.code === code)?.dragon
                    ?.r0Cents ?? null)
                : null,
              prospective:
                Date.parse(observation.observedAt) >=
                Date.parse(policy.publishedAt),
            };
            statements.push(
              env.DB.prepare(
                `INSERT OR IGNORE INTO observation_score_snapshots(id,trade_date,code,buy_point,kind,cycle_id,version,sequence,observed_at,payload,digest) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`,
              ).bind(
                id,
                row.trade_date,
                code,
                card.type,
                kind,
                cycleId,
                POLICY.version,
                tick.sequence,
                observation.observedAt,
                JSON.stringify(snapshot),
                await digestOf(snapshot),
                ...args,
              ),
            );
          }
        }
      }
      await env.DB.batch(statements);
      book = result.book;
      session = result.session;
      processed++;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (processed >= maxFrames) break;
  }
  const settled = await env.DB.prepare(
    "SELECT MAX(trade_date) AS date FROM reviews WHERE json_extract(payload,'$.reviewKind')='DRAGON_PRACTICE'",
  ).first();
  if (settled?.date) await calibrate(env, settled.date);
  return { processed, issues };
}
