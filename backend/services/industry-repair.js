import { PaperRepository } from "../storage/paper.js";
import { StockMetadataRepository } from "../storage/stock-metadata.js";
import {
  frozenProgramSignal,
  preserveProgramSignal,
} from "../storage/strategy-signals.js";
import { createPlan } from "../domain/trading.js";
import {
  openSession,
  advanceSession,
  marketClock,
} from "../domain/realtime.js";
import { isDragon } from "../domain/dragon-risk.js";
import { digestOf, canonicalJson } from "../domain/research-lineage.js";
import { executionEngineBuildDigest } from "../domain/execution-build.js";
import { selectionSnapshotDigest } from "../domain/signal-selection.js";
import {
  dragonBookFields,
  registerDragonConfig,
} from "../storage/dragon-risk.js";
import { assertStoredProgramPlan } from "./strategy-program-evidence.js";
import { exportPaper, verifyExport } from "./paper.js";
import { tradingArchive } from "../storage/trading-archives.js";
import { ENTRY_ORDER_POLICY } from "../../shared/entry-order-policy.js";
import { ADAPTIVE_RISK_POLICY } from "../../shared/adaptive-risk.js";
import {
  industryContinuation,
  industryContinuationId,
  INDUSTRY_CONTINUATION,
  planPayload,
  continuationBookPayload,
} from "../storage/industry-continuation.js";

// A metadata-only amendment may use a published classification that was already
// available before the original signal freeze. It may never change price inputs,
// candidate membership, fees, risk settings, or the original signal-freeze time.
export async function inspectIndustryRepair(env, now = new Date()) {
  const papers = new PaperRepository(env),
    account = await papers.account();
  if (!isDragon(account?.book) || !account.book.lastDate) return null;
  const plan = await papers.plan(account.book.lastDate);
  if (!plan?.entryExecutionPolicy) return null;
  if (plan.entryExecutionPolicy.industrySnapshotId) return null;
  if (await industryContinuation(env.DB, plan)) return null;
  const source = await frozenProgramSignal(env.DB, plan);
  const revision = source?.industryRevision;
  const metadata = await new StockMetadataRepository(env).snapshot("stock_em", {
    ...(revision?.metadataSnapshotId
      ? { id: revision.metadataSnapshotId }
      : { before: plan.createdAt }),
  });
  if (!metadata || Date.parse(metadata.fetchedAt) > Date.parse(plan.createdAt))
    return null;
  if (
    !Number.isFinite(Date.parse(metadata.fetchedAt)) ||
    !metadata.source.startsWith("eastmoney-")
  )
    throw new Error("行业修复必须使用有明确采集时间的东财来源");
  if ((await digestOf(metadata.records)) !== metadata.digest)
    throw new Error("东财行业快照摘要不一致，拒绝修正交易输入");
  const corrections = [];
  for (const [code, history] of Object.entries(
    plan.entryExecutionPolicy.history,
  )) {
    const industry = metadata.byCode.get(code)?.emIndustry;
    if (industry && industry !== history.sector)
      corrections.push({
        code,
        name: history.name,
        from: history.sector,
        to: industry,
      });
  }
  if (
    plan.entryExecutionPolicy.candidates.some(
      (code) => !metadata.byCode.get(code)?.emIndustry,
    )
  )
    throw new Error("东财行业快照未覆盖完整观察名单，拒绝部分修复");
  const date = marketClock(now).date;
  if (date <= account.book.lastDate) return null;
  const sessionRow = await env.DB.prepare(
    "SELECT payload,digest FROM paper_live_sessions WHERE trade_date=?",
  )
    .bind(date)
    .first();
  const session = sessionRow && JSON.parse(sessionRow.payload);
  const continuing =
    !corrections.length &&
    revision?.version === "eastmoney-code-industry-amendment-v1" &&
    session?.status === "OPEN" &&
    (session.orders?.length > 0 ||
      session.fillCount > 0 ||
      account.book.positions.length > 0);
  return {
    account,
    plan,
    metadata,
    corrections,
    date,
    source,
    sessionRow,
    mode: continuing ? "CONTINUE" : "REPAIR",
  };
}

async function continueIndustryInputs(env, prepared, now) {
  const { account, plan, metadata, source, date, sessionRow } = prepared;
  const previous = planPayload(plan);
  const session = JSON.parse(sessionRow.payload);
  const revision = source.industryRevision;
  if (
    revision.metadataSnapshotId !== metadata.id ||
    revision.metadataDigest !== metadata.digest ||
    revision.metadataFetchedAt !== metadata.fetchedAt ||
    revision.originalSignalFrozenAt !== plan.createdAt ||
    (await digestOf(session)) !== sessionRow.digest ||
    (await digestOf(session.plan)) !== (await digestOf(previous)) ||
    account.book.tradingCycleId !== session.initialBook.tradingCycleId ||
    account.book.dragonConfigId !== session.initialBook.dragonConfigId
  )
    throw new Error("行业续跑缺少一致的原始修订、会话或账户依据");
  const bundle = await exportPaper(env);
  const verification = await verifyExport(bundle);
  if (!verification.passed)
    throw new Error("行业续跑前账本核验未通过，原成交保持不变");
  const ticks = (
    await env.DB.prepare(
      "SELECT sequence,payload,digest FROM paper_live_ticks WHERE trade_date=? ORDER BY sequence",
    )
      .bind(date)
      .all()
  ).results.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  let replayBook = structuredClone(session.initialBook);
  let replaySession = openSession(replayBook, previous, date);
  const replayLedger = [];
  for (const [index, tick] of ticks.entries()) {
    if (
      tick.sequence !== index + 1 ||
      Date.parse(tick.payload.observedAt) > now.getTime() ||
      Date.parse(tick.payload.observedAt) < Date.parse(revision.correctedAt) ||
      (tick.payload.entryInputs?.market &&
        tick.payload.entryInputs.market.industryContext?.stockEmSnapshotId !==
          metadata.id)
    )
      throw new Error("行业续跑观测的顺序、时刻或行业来源不一致");
    const step = advanceSession(replayBook, replaySession, tick.payload);
    replayBook = step.book;
    replaySession = step.session;
    replayLedger.push(...step.ledger);
  }
  const dayLedger = bundle.ledger.filter((row) => row.date === date);
  if (
    !ticks.length ||
    canonicalJson(replaySession) !== canonicalJson(session) ||
    canonicalJson(continuationBookPayload(replayBook)) !==
      canonicalJson(continuationBookPayload(account.book)) ||
    canonicalJson(replayLedger) !== canonicalJson(dayLedger)
  )
    throw new Error("新执行构建无法逐帧复现原会话、持仓和成交，拒绝续跑");
  const runtimeBuild = await executionEngineBuildDigest();
  const id = await industryContinuationId(previous, runtimeBuild);
  const event = {
    id,
    type: INDUSTRY_CONTINUATION,
    scope: "main",
    createdAt: now.toISOString(),
    tradeDate: date,
    signalDate: plan.signalDate,
    planDigest: await digestOf(previous),
    sourceDigest: plan.selectionAudit.snapshotDigest,
    planEngineBuild: plan.engineBuild,
    runtimeBuild,
    entryOrderPolicy: ENTRY_ORDER_POLICY,
    adaptiveRiskPolicy: structuredClone(ADAPTIVE_RISK_POLICY),
    industrySnapshotId: metadata.id,
    metadataDigest: metadata.digest,
    verifiedPrefix: {
      sequence: session.sequence,
      fillCount: session.fillCount,
      initialBookDigest: await digestOf(session.initialBook),
      bookDigestMode: "EXECUTION_STATE_V1",
      sessionDigest: await digestOf(session),
      bookDigest: await digestOf(continuationBookPayload(account.book)),
      ledgerDigest: await digestOf(dayLedger),
      ticksDigest: await digestOf(
        ticks.map(({ sequence, digest }) => ({ sequence, digest })),
      ),
    },
    note: "仅为原冻结计划登记经完整重放验证的执行续跑；原计划、行业归属、成交、持仓及全部观测保持原样，从登记后的新行情继续。",
  };
  await env.DB.prepare(
    "INSERT INTO paper_configuration_history(id,created_at,payload,digest) VALUES(?,?,?,?)",
  )
    .bind(id, event.createdAt, JSON.stringify(event), await digestOf(event))
    .run();
  await assertStoredProgramPlan(env, previous, session.initialBook);
  if (!(await verifyExport(await exportPaper(env))).passed)
    throw new Error("行业续跑登记后账本核验未通过，登记已回滚");
  return {
    changed: true,
    mode: "CONTINUE",
    continuationId: id,
    correctedAt: event.createdAt,
    candidates: previous.entryExecutionPolicy.candidates.length,
    corrections: [],
    retiredObservations: 0,
    preservedObservations: session.sequence,
    preservedFills: session.fillCount,
    verification,
  };
}

export async function repairIndustryInputs(env, { now = new Date() } = {}) {
  const db = env.DB;
  if (typeof db.transaction !== "function")
    throw new Error("行业输入修复需要本地事务数据库");
  return db.transaction(async () => {
    const prepared = await inspectIndustryRepair(env, now);
    if (!prepared) return { changed: false };
    if (prepared.mode === "CONTINUE")
      return continueIndustryInputs(env, prepared, now);
    const { account, plan: previous, metadata, corrections, date } = prepared;
    const book = structuredClone(account.book);
    if (!book.tradingCycleId)
      throw new Error("行业自动修复仅用于有完整期初归档的新练习周期");
    // This startup repair is deliberately restricted to a fresh, empty practice
    // cycle. Once any execution exists, keep its original classification intact.
    if (
      book.positions.length ||
      book.settlementCount ||
      (book.pendingOrders ?? []).length ||
      (book.pendingRecovery ?? []).length ||
      (book.pendingExits ?? []).length
    )
      throw new Error(
        "已有持仓、结算或未完成操作，不能自动修订行业；原账本保持不变",
      );
    for (const table of [
      "paper_ledger",
      "paper_equity",
      "research_window_owners",
    ])
      if (await db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).first())
        throw new Error("已有成交、权益结算或活动研究，不能自动修订行业");
    if (
      await db
        .prepare("SELECT 1 FROM shadow_accounts WHERE status='ACTIVE' LIMIT 1")
        .first()
    )
      throw new Error("有活动影子账户，不能只修订主账户行业");
    if (
      await db
        .prepare(
          "SELECT 1 FROM paper_live_sessions WHERE trade_date<>? LIMIT 1",
        )
        .bind(date)
        .first()
    )
      throw new Error("存在其他交易日会话，不能自动修订行业");
    const sessionRow = await db
      .prepare("SELECT * FROM paper_live_sessions WHERE trade_date=?")
      .bind(date)
      .first();
    if (sessionRow) {
      const session = JSON.parse(sessionRow.payload);
      if (
        session.status !== "OPEN" ||
        session.fillCount ||
        session.orders?.length ||
        session.initialBook?.positions?.length
      )
        throw new Error("盘中会话已下单或有持仓，行业修复未执行");
    }
    const before = await exportPaper(env);
    if (!(await verifyExport(before)).passed)
      throw new Error("修复前账本核验未通过，拒绝变更行业");
    const source = await frozenProgramSignal(db, previous);
    const revised = structuredClone(source);
    const stamp = now.toISOString();
    for (const change of corrections)
      revised.intradayEntryContext.history[change.code].sector = change.to;
    revised.intradayEntryContext.industrySnapshotId = metadata.id;
    revised.industryRevision = {
      version: "eastmoney-code-industry-amendment-v1",
      correctedAt: stamp,
      originalSignalDigest: previous.selectionAudit.snapshotDigest,
      originalPlanDigest: await digestOf(previous),
      originalSignalFrozenAt: previous.createdAt,
      metadataSnapshotId: metadata.id,
      metadataDigest: metadata.digest,
      metadataFetchedAt: metadata.fetchedAt,
      corrections,
      note: "仅修正原冻结历史的行业归属；原始价格信号、观察名单和参数保持不变，修订时间单独留存。",
    };
    const build = await executionEngineBuildDigest();
    if (book.dragonEngineBuild !== build) {
      const record = await registerDragonConfig(
        db,
        book.dragonConfig,
        book.dragonConfigId,
        {
          origin: "ENGINE_UPGRADE",
          validationMode: "MANUAL_UNVERIFIED",
          replacesId: book.dragonConfigId,
          id: `dragon-industry-${(await digestOf({ previousId: book.dragonConfigId, build })).slice(0, 32)}`,
        },
      );
      Object.assign(book, dragonBookFields(record));
      delete book.pendingDragonConfigId;
      book.dragonTransition = {
        state: "ACTIVE",
        configId: record.id,
        candidate: false,
      };
    }
    const replacement = createPlan(
      revised,
      {
        ...book,
        feeConfig: previous.feeConfig,
        feeModel: previous.feeModel,
        feeConfigVersion: previous.feeConfigVersion,
      },
      null,
      book.dragonConfigId,
      previous.createdAt,
      {
        executionCostPolicy: previous.executionCostPolicy,
        snapshotDigest: await selectionSnapshotDigest(revised),
        observationUniverse: previous.entryExecutionPolicy.candidates,
        engineBuild: build,
        dragonTemplateVersion: previous.dragonPolicy.templateVersion,
        entryOrderPolicy: previous.dragonPolicy.entryOrderPolicy ?? null,
        tCapitalPolicy: previous.dragonPolicy.tCapitalPolicy ?? null,
        adaptiveRiskPolicy: previous.dragonPolicy.adaptiveRiskPolicy,
      },
    );
    const comparable = (plan) => {
      const p = structuredClone(plan);
      delete p.engineBuild;
      delete p.strategyVersion;
      delete p.dragonPolicy.configId;
      delete p.dragonPolicy.provenance;
      delete p.selectionAudit.snapshotDigest;
      delete p.entryExecutionPolicy.industrySnapshotId;
      for (const h of Object.values(p.entryExecutionPolicy.history))
        delete h.sector;
      return p;
    };
    if (
      canonicalJson(comparable(previous)) !==
      canonicalJson(comparable(replacement))
    )
      throw new Error("行业修订试图改变价格信号、观察名单或交易参数，已拒绝");
    const id = `industry-repair-${date}-${crypto.randomUUID()}`;
    const tables = { repair_export: [before] };
    const dayTables = [
      "paper_live_sessions",
      "paper_live_ticks",
      "quote_frames",
      "observation_score_cursors",
      "observation_score_latest",
      "observation_score_snapshots",
      "observation_score_invalidations",
    ];
    for (const table of dayTables)
      tables[table] = (
        await db
          .prepare(`SELECT * FROM ${table} WHERE trade_date=? ORDER BY rowid`)
          .bind(date)
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
          digest: await digestOf(payload),
        });
      }
    const summary = {
      id,
      version: "paper-trading-archive-v1",
      kind: "INDUSTRY_INPUT_REPAIR",
      createdAt: stamp,
      tradeDate: date,
      signalDate: previous.signalDate,
      policy: previous.tradingPolicyVersion,
      entryExecutionMode: previous.entryExecutionMode,
      candidates: previous.entryExecutionPolicy.candidates,
      primary: {
        fills: 0,
        positions: 0,
        initialCashCents: book.initialCashCents,
        equityCents: book.equityCents,
        realizedPnlCents: book.realizedPnlCents,
        feesCents: book.feesCents,
      },
      shadow: { accounts: 0, fills: 0 },
      initialBook: book,
      planDigest: await digestOf(replacement),
      tables: Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [name, rows.length]),
      ),
      chunks: chunks.map(({ table, index, digest }) => ({
        table,
        index,
        digest,
      })),
      amendment: revised.industryRevision,
      note: "行业输入修复前的原始观测单独归档；重启后从新报价建立确认，不重放修复前行情生成成交。",
    };
    await db
      .prepare(
        "INSERT INTO industry_repair_archives(id,trade_date,created_at,summary,digest) VALUES(?,?,?,?,?)",
      )
      .bind(id, date, stamp, JSON.stringify(summary), await digestOf(summary))
      .run();
    for (const chunk of chunks)
      await db
        .prepare(
          "INSERT INTO industry_repair_archive_chunks(archive_id,table_name,chunk_index,payload,digest) VALUES(?,?,?,?,?)",
        )
        .bind(
          id,
          chunk.table,
          chunk.index,
          JSON.stringify(chunk.payload),
          chunk.digest,
        )
        .run();
    await tradingArchive(env, id);
    // Retiring the old frame prefix prevents the backlog consumer from trading
    // historical observations using the amended industry classification.
    for (const table of dayTables)
      await db
        .prepare(`DELETE FROM ${table} WHERE trade_date=?`)
        .bind(date)
        .run();
    await db
      .prepare("DELETE FROM observation_score_invalidations WHERE trade_date=?")
      .bind(date)
      .run();
    await db
      .prepare(
        "INSERT INTO paper_plan_revisions(id,signal_date,created_at,payload,digest) VALUES(?,?,?,?,?)",
      )
      .bind(
        id,
        previous.signalDate,
        stamp,
        JSON.stringify(previous),
        await digestOf(previous),
      )
      .run();
    await db
      .prepare("DELETE FROM paper_plans WHERE signal_date=?")
      .bind(previous.signalDate)
      .run();
    await db
      .prepare(
        "DELETE FROM dragon_plan_bindings WHERE scope='main' AND signal_date=?",
      )
      .bind(previous.signalDate)
      .run();
    await preserveProgramSignal(db, replacement, revised);
    const papers = new PaperRepository(env);
    await papers.savePlan(replacement);
    await assertStoredProgramPlan(env, replacement, book);
    if (sessionRow) {
      const session = openSession(book, replacement, date);
      await db
        .prepare(
          "INSERT INTO paper_live_sessions(trade_date,payload,digest) VALUES(?,?,?)",
        )
        .bind(date, JSON.stringify(session), await digestOf(session))
        .run();
    }
    const update = await db
      .prepare(
        "UPDATE paper_accounts SET state=?,revision=revision+1,last_run_id=?,updated_at=? WHERE id='primary' AND revision=?",
      )
      .bind(JSON.stringify(book), id, stamp, account.revision)
      .run();
    if (update.meta.changes !== 1)
      throw new Error("账户已变化，行业修复已回滚");
    const event = {
      type: "DRAGON_INDUSTRY_DATA_REPAIRED",
      createdAt: stamp,
      archiveId: id,
      signalDate: previous.signalDate,
      effectiveSignalDate: previous.signalDate,
      tradeDate: date,
      candidates: replacement.entryExecutionPolicy.candidates.length,
      corrections: corrections.length,
      metadataSnapshotId: metadata.id,
      metadataFetchedAt: metadata.fetchedAt,
      originalPlanDigest: revised.industryRevision.originalPlanDigest,
      planDigest: await digestOf(replacement),
      originalSignalFrozenAt: previous.createdAt,
      correctedAt: stamp,
      dragonFields: dragonBookFields({
        id: book.dragonConfigId,
        config: book.dragonConfig,
        digest: book.dragonConfigDigest,
        engineBuild: book.dragonEngineBuild,
        origin: book.dragonConfigProvenance?.origin,
        validationMode: book.dragonConfigProvenance?.validationMode,
        replacesId: book.dragonConfigProvenance?.replacesId,
        provenanceDigest: book.dragonConfigProvenance?.digest,
      }),
      transition: book.dragonTransition,
      note: summary.note,
    };
    await db
      .prepare(
        "INSERT INTO paper_configuration_history(id,created_at,payload,digest) VALUES(?,?,?,?)",
      )
      .bind(id, stamp, JSON.stringify(event), await digestOf(event))
      .run();
    const verification = await verifyExport(await exportPaper(env));
    if (!verification.passed)
      throw new Error(
        `行业修复后账本重放未通过，全部修改已回滚：${JSON.stringify(verification.checks)}`,
      );
    return {
      changed: true,
      archiveId: id,
      correctedAt: stamp,
      candidates: replacement.entryExecutionPolicy.candidates.length,
      corrections,
      retiredObservations: tables.paper_live_ticks.length,
      verification,
    };
  });
}
