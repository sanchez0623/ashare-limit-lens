import {
  defaultDragonConfig,
  normalizeDragonConfig,
  dragonPreview,
  dragonEffectiveFields,
  DRAGON_RESEARCH_KEYS,
  DRAGON_POLICY_VERSION,
  DRAGON_REGIMES,
  DRAGON_FIELD_REGISTRY,
} from "../../shared/dragon-risk-config.js";
import {
  registerDragonConfig,
  loadDragonConfig,
  dragonBookFields,
  dragonConfigProvenance,
} from "../storage/dragon-risk.js";
import { PaperRepository } from "../storage/paper.js";
import { RealtimeRepository } from "../storage/realtime.js";
import {
  ShadowAccountRepository,
  SHADOW_ACCOUNT_KINDS,
} from "../storage/shadow.js";
import { executionEngineBuildDigest } from "../domain/execution-build.js";
import { digestOf, canonicalJson } from "../domain/research-lineage.js";
import { newBook, auditLedger } from "../domain/trading.js";
import { isDragon, DRAGON_RULES } from "../domain/dragon-risk.js";
import { INTRADAY_ENTRY_RULES } from "../domain/intraday-entry.js";
import { dragonSyntheticChecks } from "../domain/dragon-self-check.js";
import {
  OBSERVATION_SCHEDULE,
  observationMaintenanceOpen,
  observationVerificationOpen,
} from "../../shared/observation-schedule.js";
import {
  marketClock,
  openSession,
  advanceSession,
  closeSession,
} from "../domain/realtime.js";
import { buildIntradayContext } from "./intraday-inputs.js";
import { freezePortfolioPlan, settlePortfolioDay } from "./portfolio-runner.js";
import { collectTradingDay } from "./market.js";
import { QuoteFrameRepository } from "../storage/quotes.js";
import { observationCoverage } from "./entry-observation.js";
import { assertStoredProgramPlan } from "./strategy-program-evidence.js";
import {
  ensureDragonTemplateResearch,
  dragonResearchStatus,
} from "./dragon-research.js";
import { prepareResearchCancellation } from "./research-cancellation.js";

const observerId = (id) => `dragon-observer:${id}`;
const protectedLegacyFields = [
  "strategyParams",
  "riskLimits",
  "selectionPolicyVersion",
  "entryExecutionMode",
];
export function rejectLegacyDragonWrites(book, settings) {
  if (
    (isDragon(book) || book.dragonTransition?.state === "DRAINING") &&
    protectedLegacyFields.some((k) => Object.hasOwn(settings, k))
  )
    throw new Error("新交易政策已隔离旧配置，不能写入旧策略、风控或执行方式");
}
async function commitAccount(
  db,
  account,
  book,
  type,
  detail = {},
  lock = false,
  extra = [],
  condition = null,
) {
  const nonce = crypto.randomUUID(),
    stamp = new Date().toISOString();
  const update = db
    .prepare(
      `UPDATE paper_accounts SET state=?,revision=revision+1,last_run_id=?,updated_at=? WHERE id='primary' AND revision=?${lock ? " AND NOT EXISTS (SELECT 1 FROM research_window_owners WHERE namespace='main')" : ""}${condition ? ` AND (${condition.sql})` : ""}`,
    )
    .bind(
      JSON.stringify(book),
      nonce,
      stamp,
      account.revision,
      ...(condition?.args ?? []),
    );
  const event = {
    type,
    ...detail,
    createdAt: stamp,
    beforePolicy: account.book.tradingPolicyVersion ?? "legacy",
    afterPolicy: book.tradingPolicyVersion ?? "legacy",
    transition: book.dragonTransition,
    riskRuntime: {
      dragonHalted: book.dragonHalted,
      dragonRiskPeakCents: book.dragonRiskPeakCents,
    },
    dragonFields: isDragon(book)
      ? dragonBookFields({
          id: book.dragonConfigId,
          config: book.dragonConfig,
          digest: book.dragonConfigDigest,
          engineBuild: book.dragonEngineBuild,
          origin: book.dragonConfigProvenance?.origin,
          validationMode: book.dragonConfigProvenance?.validationMode,
          replacesId: book.dragonConfigProvenance?.replacesId,
          provenanceDigest: book.dragonConfigProvenance?.digest,
        })
      : null,
  };
  const guard =
    "EXISTS (SELECT 1 FROM paper_accounts WHERE id='primary' AND revision=? AND last_run_id=?)";
  const audit = db
    .prepare(
      `INSERT INTO paper_configuration_history(id,created_at,payload,digest) SELECT ?,?,?,? WHERE ${guard}`,
    )
    .bind(
      nonce,
      stamp,
      JSON.stringify(event),
      await digestOf(event),
      account.revision + 1,
      nonce,
    );
  const results = await db.batch([
    update,
    audit,
    ...extra.map((f) => f(guard, [account.revision + 1, nonce])),
  ]);
  if (!results[0]?.meta?.changes)
    throw new Error("账户状态或研究窗口已变化，请刷新后重试");
  return book;
}
export function previewDragonConfig(config, phase = "unknown") {
  return {
    ...dragonPreview(config, phase),
    fields: dragonEffectiveFields(config, phase),
    effectiveFrom: "预览情境；保存后用于下一份尚未冻结的计划",
  };
}
export async function dragonStatus(env, book = null, now = new Date()) {
  const papers = new PaperRepository(env);
  book ??= (await papers.account())?.book;
  const transition = book?.dragonTransition;
  let record = null,
    report = null;
  if (
    book?.pendingDragonConfigId ||
    transition?.configId ||
    book?.dragonConfigId
  ) {
    record = await loadDragonConfig(
      env.DB,
      book?.pendingDragonConfigId ??
        transition?.configId ??
        book.dragonConfigId,
    );
    const row = await env.DB.prepare(
      "SELECT payload,digest FROM dragon_observation_reports WHERE config_id=? ORDER BY trade_date DESC LIMIT 1",
    )
      .bind(record.id)
      .first();
    if (row) {
      report = JSON.parse(row.payload);
      if ((await digestOf(report)) !== row.digest)
        throw new Error("影子核验报告摘要不一致");
    }
  }
  const research = record?.baseId
    ? await dragonResearchStatus(env, record.id)
    : null;
  const base = record?.baseId
    ? await loadDragonConfig(env.DB, record.baseId)
    : null;
  const needsResearch =
    record?.validationMode !== "MANUAL_UNVERIFIED" &&
    !!base &&
    (transition?.candidate === true ||
      canonicalJson(base.config.advanced) !==
        canonicalJson(record.config.advanced));
  const engineBuild = await executionEngineBuildDigest(),
    synthetic = await dragonSyntheticChecks(),
    staleEngine = !!record && record.engineBuild !== engineBuild;
  const reportMatches =
    !!record &&
    report?.engineBuild === engineBuild &&
    report.configDigest === record.digest;
  const activationIssues = [];
  if (reportMatches) {
    if (report.replay === false)
      activationIssues.push("当前版本影子账本重放不一致，需排查后启用");
    if (report.accounting === false)
      activationIssues.push("当前版本影子账本核对失败，需排查后启用");
    if (report.stress?.some((result) => result.passed === false))
      activationIssues.push(
        "当前版本成本压力下资金或账本核对失败，需排查后启用",
      );
  }
  const observationVerified =
    report?.passed === true &&
    report.synthetic?.passed === true &&
    report.synthetic?.engineBuild === record.engineBuild &&
    report.engineBuild === engineBuild &&
    report.configDigest === record.digest;
  // 首次手动切换使用当前配置及基础行为检查；整日观察保留为运行诊断。
  // 已启用后的高级模板变更仍须完整研究与真实影子证据。
  const ready =
    !!record &&
    !staleEngine &&
    synthetic.passed === true &&
    synthetic.engineBuild === engineBuild &&
    !activationIssues.length &&
    (!needsResearch || (research?.status === "PASSED" && observationVerified));
  const state = isDragon(book)
    ? "ACTIVE"
    : transition?.state === "DRAINING"
      ? "DRAINING"
      : ready
        ? "READY"
        : transition
          ? "OBSERVING"
          : "DRAFT";
  const clock = marketClock(now),
    shadows = new ShadowAccountRepository(env),
    observer = record ? await shadows.account(observerId(record.id)) : null,
    observerPlan = observer
      ? await shadows.latestPlan(observer.accountId)
      : null,
    session = observer
      ? await shadows.session(observer.accountId, clock.date)
      : null;
  const researchLock = await env.DB.prepare(
    "SELECT owner_type AS ownerType,owner_id AS ownerId FROM research_window_owners WHERE namespace='main'",
  ).first();
  const observationStatus =
    !observer || !observerPlan
      ? "WAITING_PREPARATION"
      : session
        ? clock.time >= "15:00:00"
          ? "WAITING_VERIFICATION"
          : now.getTime() - Date.parse(session.lastObservedAt) <= 60000
            ? "RUNNING"
            : "STALLED"
        : clock.date > observerPlan.signalDate &&
            clock.time >= OBSERVATION_SCHEDULE.preparationEnd &&
            clock.time < "15:00:00"
          ? "WAITING_EXECUTION"
          : "PREPARED";
  return {
    policyVersion: DRAGON_POLICY_VERSION,
    state,
    ready,
    report,
    research,
    staleEngine,
    synthetic,
    requiresResearch: needsResearch,
    observationVerified,
    activationIssues,
    researchLock,
    provenance: record ? dragonConfigProvenance(record) : null,
    validationLabel:
      record?.validationMode === "MANUAL_UNVERIFIED"
        ? "人工指定 · 未验证"
        : research?.status === "PASSED" && observationVerified
          ? "研究验证通过"
          : "尚未完成研究验证",
    observation: {
      status: observationStatus,
      prepared: !!observerPlan,
      signalDate: observerPlan?.signalDate ?? null,
      lastObservedAt: session?.lastObservedAt ?? null,
      ...OBSERVATION_SCHEDULE,
    },
    configId: record?.id ?? book?.dragonConfigId ?? null,
    config: record?.config ?? book?.dragonConfig ?? defaultDragonConfig(),
    activeConfig: book?.dragonConfig ?? null,
    registry: DRAGON_FIELD_REGISTRY,
    rulesPreview: {
      market: DRAGON_REGIMES,
      trading: DRAGON_RULES,
      entry: INTRADAY_ENTRY_RULES,
    },
    pendingConfigId: book?.pendingDragonConfigId ?? null,
    observerId: transition?.observerId ?? null,
    candidateState:
      isDragon(book) && record?.id !== book.dragonConfigId
        ? ready
          ? "READY"
          : (research?.status ?? "OBSERVING")
        : null,
    effectiveFrom: "下一份尚未冻结的计划；持仓周期与已开始的 T 保持原基准",
    message:
      state === "ACTIVE"
        ? book.pendingDragonConfigId
          ? "新配置已排队，等待后续计划边界生效；当前冻结计划和持仓基准保留"
          : transition?.candidate
            ? "当前配置继续运行，研究候选独立验证；通过前保持未验证状态"
            : "新政策运行；旧策略与旧风控不参与决策"
        : state === "DRAINING"
          ? "旧仓结清中；停止新建仓、加仓和新 T"
          : ready
            ? needsResearch
              ? "高级模板研究及影子核验通过，可以批准新模板"
              : "配置及基础行为检查通过，可以申请整体切换；整日影子报告为可选运行诊断"
            : transition
              ? staleEngine
                ? "执行版本已变化，常驻服务将在基础检查通过后自动衔接新版本"
                : !synthetic.passed
                  ? "基础行为检查未通过，请修复后重试"
                  : activationIssues.length
                    ? activationIssues.join("；")
                    : observationStatus === "WAITING_PREPARATION"
                      ? "已登记，影子账户或计划尚未准备完成；09:30 前可准备，完整交易日 17:00 起核验"
                      : observationStatus === "PREPARED"
                        ? "影子计划已冻结，等待下一交易日开盘；完整交易日 17:00 起核验"
                        : observationStatus === "WAITING_EXECUTION"
                          ? "影子计划已冻结，尚未消费当日行情；完整交易日 17:00 起核验"
                          : observationStatus === "WAITING_VERIFICATION"
                            ? "当日影子观察已结束，17:00 起核验行情覆盖、账本重放及成本压力"
                            : observationStatus === "STALLED"
                              ? "影子行情消费超过一分钟未推进，请检查执行循环；17:00 起核验"
                              : "独立影子账户正在执行；完整交易日 17:00 起核验，通过前不启用"
              : "保存配置并通过基础检查后可申请整体切换；另行采集影子观察用于运行诊断",
  };
}
export async function saveDragonSettings(env, input, options = {}) {
  const config = normalizeDragonConfig(input),
    papers = new PaperRepository(env);
  const origin = options.origin ?? "MANUAL";
  if (!["MANUAL", "AI"].includes(origin)) throw new Error("配置保存来源无效");
  const account = await papers.initialize();
  const transition = account.book.dragonTransition;
  const previous = transition?.configId
    ? await loadDragonConfig(env.DB, transition.configId)
    : null;
  const stale =
    previous && previous.engineBuild !== (await executionEngineBuildDigest());
  const draining = transition?.state === "DRAINING";
  if (
    draining &&
    (!stale || canonicalJson(previous.config) !== canonicalJson(config))
  )
    throw new Error("旧仓结清期间配置已冻结；规则版本变化时只能重新验证原配置");
  const owner = await env.DB.prepare(
    "SELECT owner_type AS ownerType,owner_id AS ownerId FROM research_window_owners WHERE namespace='main'",
  ).first();
  const requested = options.cancelResearch;
  if (
    requested &&
    (origin !== "MANUAL" ||
      !owner ||
      requested.ownerType !== owner.ownerType ||
      requested.ownerId !== owner.ownerId ||
      Object.keys(requested).some(
        (key) => !["ownerType", "ownerId"].includes(key),
      ))
  )
    throw new Error("待终止研究已变化，请刷新后重新选择");
  if (owner && !requested)
    throw new Error("活动研究窗口内不能修改配置；可选择终止当前研究并保存");
  const cancellation = requested
    ? await prepareResearchCancellation(
        env,
        owner,
        "用户终止当前研究并手动保存配置",
      )
    : null;
  const base = account.book.dragonConfig;
  if (
    base &&
    !stale &&
    !cancellation &&
    !account.book.pendingDragonConfigId &&
    !transition?.candidate &&
    canonicalJson(base) === canonicalJson(config)
  )
    return {
      book: account.book,
      dragon: await dragonStatus(env, account.book),
    };
  const advancedChanged =
    base && canonicalJson(base.advanced) !== canonicalJson(config.advanced);
  if (
    origin === "AI" &&
    (!isDragon(account.book) ||
      !advancedChanged ||
      canonicalJson(base.risk) !== canonicalJson(config.risk) ||
      canonicalJson(base.operations) !== canonicalJson(config.operations) ||
      canonicalJson(base.buyPoints) !== canonicalJson(config.buyPoints) ||
      DRAGON_RESEARCH_KEYS.filter(
        (key) => base.advanced[key] !== config.advanced[key],
      ).length > 2)
  )
    throw new Error("AI候选只能调整最多两个高级参数，不得修改账户设置");
  const record = await registerDragonConfig(
    env.DB,
    config,
    account.book.dragonConfigId ?? null,
    {
      origin,
      validationMode:
        origin === "MANUAL" ? "MANUAL_UNVERIFIED" : "RESEARCH_REQUIRED",
      replacesId: previous?.id ?? null,
    },
  );
  const book = structuredClone(account.book);
  if (draining) {
    book.dragonTransition = {
      ...transition,
      configId: record.id,
      observerId: observerId(record.id),
      revalidating: true,
    };
  } else if (isDragon(book) && origin === "MANUAL") {
    book.pendingDragonConfigId = record.id;
    book.dragonTransition = {
      state: "ACTIVE",
      configId: book.dragonConfigId,
      candidate: false,
    };
  } else {
    book.dragonTransition = {
      state: "OBSERVING",
      configId: record.id,
      observerId: observerId(record.id),
      requestedAt: new Date().toISOString(),
      candidate: isDragon(book),
      baseId: record.baseId,
    };
  }
  const extra = [...(cancellation?.extra ?? [])];
  if (
    previous &&
    previous.id !== account.book.dragonConfigId &&
    !(owner?.ownerType === "DRAGON" && owner.ownerId === previous.id)
  ) {
    if (transition?.candidate && previous.baseId) {
      extra.push((guard, args) =>
        env.DB.prepare(
          `INSERT INTO dragon_research_runs(config_id,base_id,status,created_at,updated_at) SELECT ?,?,'INVALIDATED',?,? WHERE ${guard} ON CONFLICT(config_id) DO NOTHING`,
        ).bind(
          previous.id,
          previous.baseId,
          new Date().toISOString(),
          new Date().toISOString(),
          ...args,
        ),
      );
    }
    extra.push((guard, args) =>
      env.DB.prepare(
        `UPDATE dragon_research_runs SET status='INVALIDATED',updated_at=? WHERE config_id=? AND status NOT IN ('PASSED','FAILED','INVALIDATED') AND ${guard}`,
      ).bind(new Date().toISOString(), previous.id, ...args),
    );
    extra.push((guard, args) =>
      env.DB.prepare(
        `UPDATE shadow_accounts SET status='INVALIDATED',revision=revision+1,updated_at=? WHERE account_id IN (?,?,?) AND ${guard}`,
      ).bind(
        new Date().toISOString(),
        observerId(previous.id),
        `dragon-parent:${previous.id}`,
        `dragon-baseline:${previous.id}`,
        ...args,
      ),
    );
  }
  await commitAccount(
    env.DB,
    account,
    book,
    "DRAGON_CONFIG_REGISTERED",
    {
      configId: record.id,
      provenance: dragonConfigProvenance(record),
      cancelledResearch: cancellation?.detail ?? null,
    },
    !cancellation,
    extra,
    cancellation?.condition,
  );
  return { book, dragon: await dragonStatus(env, book) };
}
async function currentReadyRecord(env, book) {
  const status = await dragonStatus(env, book);
  if (!status.ready || !status.configId)
    throw new Error(
      status.staleEngine
        ? "执行版本已变化，请重新保存原配置后启用"
        : status.activationIssues.length
          ? status.activationIssues.join("；")
          : status.requiresResearch
            ? "高级模板需要完成研究验证及当前执行版本的完整真实交易日影子核验"
            : "需要保存当前执行版本的配置并通过基础行为检查后启用",
    );
  if (status.requiresResearch)
    await assertReadinessEvidence(env, status.report);
  return loadDragonConfig(env.DB, status.configId);
}
async function assertReadinessEvidence(env, report) {
  if (
    !report?.evidenceDigest ||
    !report.observerId ||
    !report.sessionDigest ||
    !report.closingDataset ||
    (await digestOf(report.closingDataset)) !== report.closingDigest
  )
    throw new Error("影子报告缺少独立冻结的行情及结算依据");
  const frames = await new QuoteFrameRepository(env).framesForDate(report.date);
  if (
    (await digestOf(
      frames.map((f) => ({ sequence: f.sequence, digest: f.digest })),
    )) !== report.evidenceDigest
  )
    throw new Error("影子报告与当前冻结行情摘要不一致");
  for (const f of frames)
    if ((await digestOf(f.payload)) !== f.digest)
      throw new Error("影子行情内容已改变");
  const stored = await new ShadowAccountRepository(env).session(
    report.observerId,
    report.date,
  );
  if (!stored || (await digestOf(stored)) !== report.sessionDigest)
    throw new Error("影子会话与核验报告不一致");
  await assertStoredProgramPlan(env, stored.plan, stored.initialBook, {
    tQualityScope: `shadow:${report.observerId}`,
  });
}
export async function refreshDragonEngine(env, now = new Date()) {
  const papers = new PaperRepository(env),
    account = await papers.account();
  if (!account) return { status: "NOT_CONFIGURED" };
  const transition = account.book.dragonTransition;
  const id =
    account.book.pendingDragonConfigId ??
    transition?.configId ??
    account.book.dragonConfigId;
  if (!id) return { status: "NOT_CONFIGURED" };
  const previous = await loadDragonConfig(env.DB, id);
  if (previous.engineBuild === (await executionEngineBuildDigest()))
    return { status: "CURRENT" };
  const checks = await dragonSyntheticChecks();
  if (!checks.passed)
    return { status: "BLOCKED", reason: "基础行为检查未通过" };
  const owner = await env.DB.prepare(
    "SELECT owner_type AS ownerType,owner_id AS ownerId FROM research_window_owners WHERE namespace='main'",
  ).first();
  if (owner && !(owner.ownerType === "DRAGON" && owner.ownerId === previous.id))
    return { status: "WAITING_RESEARCH", reason: "其他活动研究尚未结束" };
  const cancellation = owner
    ? await prepareResearchCancellation(env, owner, "执行版本升级，原研究失效")
    : null;
  const researchCandidate =
    isDragon(account.book) &&
    transition?.candidate &&
    !account.book.pendingDragonConfigId;
  const record = await registerDragonConfig(
    env.DB,
    previous.config,
    researchCandidate
      ? previous.baseId
      : isDragon(account.book)
        ? previous.id
        : previous.baseId,
    {
      origin: "ENGINE_UPGRADE",
      validationMode: previous.validationMode,
      replacesId: previous.id,
      id: `dragon-engine-${(await digestOf({ previousId: previous.id, engineBuild: checks.engineBuild })).slice(0, 32)}`,
    },
  );
  const book = structuredClone(account.book);
  if (isDragon(book) && !researchCandidate) {
    book.pendingDragonConfigId = record.id;
    book.dragonTransition = {
      state: "ACTIVE",
      configId: book.dragonConfigId,
      candidate: false,
    };
  } else {
    book.dragonTransition = {
      ...transition,
      state: transition?.state ?? "OBSERVING",
      configId: record.id,
      observerId: observerId(record.id),
      baseId: record.baseId,
    };
  }
  const extra = [...(cancellation?.extra ?? [])];
  if (!cancellation) {
    extra.push((guard, args) =>
      env.DB.prepare(
        `UPDATE dragon_research_runs SET status='INVALIDATED',updated_at=? WHERE config_id=? AND status NOT IN ('PASSED','FAILED','INVALIDATED') AND ${guard}`,
      ).bind(now.toISOString(), previous.id, ...args),
    );
    extra.push((guard, args) =>
      env.DB.prepare(
        `UPDATE shadow_accounts SET status='INVALIDATED',revision=revision+1,updated_at=? WHERE account_id IN (?,?,?) AND ${guard}`,
      ).bind(
        now.toISOString(),
        observerId(previous.id),
        `dragon-parent:${previous.id}`,
        `dragon-baseline:${previous.id}`,
        ...args,
      ),
    );
  }
  await commitAccount(
    env.DB,
    account,
    book,
    "DRAGON_ENGINE_REGISTERED",
    {
      configId: record.id,
      previousConfigId: previous.id,
      provenance: dragonConfigProvenance(record),
      cancelledResearch: cancellation?.detail ?? null,
    },
    !cancellation,
    extra,
    cancellation?.condition,
  );
  return { status: "REGISTERED", configId: record.id };
}
export async function requestDragonActivation(env) {
  await refreshDragonEngine(env);
  const account = await new PaperRepository(env).account();
  if (!account) throw new Error("主账户未初始化");
  if (account.book.dragonTransition?.state === "DRAINING")
    return dragonStatus(env, account.book);
  const record = await currentReadyRecord(env, account.book);
  if (isDragon(account.book)) {
    if (record.id === account.book.dragonConfigId)
      return dragonStatus(env, account.book);
    const book = { ...account.book, pendingDragonConfigId: record.id };
    await commitAccount(
      env.DB,
      account,
      book,
      "DRAGON_TEMPLATE_APPROVED",
      { configId: record.id },
      true,
    );
    return dragonStatus(env, book);
  }
  const book = {
    ...account.book,
    dragonTransition: { ...account.book.dragonTransition, state: "DRAINING" },
  };
  await commitAccount(env.DB, account, book, "DRAGON_DRAIN_STARTED", {}, true);
  return dragonStatus(env, book);
}
export async function requestDragonValidation(env) {
  await refreshDragonEngine(env);
  const papers = new PaperRepository(env),
    account = await papers.account();
  if (!isDragon(account?.book))
    throw new Error("请先启用龙头风险预算，再对运行中的人工配置发起研究验证");
  if (account.book.pendingDragonConfigId)
    throw new Error("请等待已保存配置在下一份计划生效，再发起研究验证");
  if (account.book.dragonTransition?.candidate)
    return dragonStatus(env, account.book);
  if (
    await env.DB.prepare(
      "SELECT 1 FROM research_window_owners WHERE namespace='main'",
    ).first()
  )
    throw new Error("当前有活动研究，请先终止或等待该研究结束");
  const current = await loadDragonConfig(env.DB, account.book.dragonConfigId);
  let base = current,
    visited = new Set();
  // 同参数的版本升级不作为收益对照，沿血缘找到修改前的配置。
  while (
    (base.baseId || base.replacesId) &&
    canonicalJson(base.config) === canonicalJson(current.config)
  ) {
    if (visited.has(base.id) || visited.size >= 50)
      throw new Error("配置血缘重复或过长，无法确定验证对照");
    visited.add(base.id);
    base = await loadDragonConfig(env.DB, base.baseId ?? base.replacesId);
  }
  const reference = await registerDragonConfig(
    env.DB,
    canonicalJson(base.config) === canonicalJson(current.config)
      ? defaultDragonConfig()
      : base.config,
    base.id,
    {
      origin: "RESEARCH",
      validationMode: "RESEARCH_REQUIRED",
      replacesId: base.id,
    },
  );
  const candidate = await registerDragonConfig(
    env.DB,
    current.config,
    reference.id,
    {
      origin: "RESEARCH",
      validationMode: "RESEARCH_REQUIRED",
      replacesId: current.id,
    },
  );
  const book = {
    ...account.book,
    dragonTransition: {
      state: "OBSERVING",
      configId: candidate.id,
      observerId: observerId(candidate.id),
      candidate: true,
      baseId: reference.id,
      requestedAt: new Date().toISOString(),
    },
  };
  await commitAccount(
    env.DB,
    account,
    book,
    "DRAGON_RESEARCH_REQUESTED",
    {
      configId: candidate.id,
      manualConfigId: current.id,
      referenceConfigId: reference.id,
    },
    true,
  );
  return dragonStatus(env, book);
}
export async function resumeDragonRiskCycle(env) {
  const papers = new RealtimeRepository(env),
    account = await papers.account();
  if (!isDragon(account?.book) || !account.book.dragonHalted)
    throw new Error("当前没有需要恢复的新政策回撤熔断");
  const book = structuredClone(account.book);
  if (
    book.positions.length ||
    (book.pendingRecovery ?? []).length ||
    (book.pendingOrders ?? []).length ||
    (book.pendingExits ?? []).length
  )
    throw new Error("恢复风险周期前须结清实际持仓和未完成订单");
  const sessions = await papers.sessions();
  if (sessions.some((s) => s.payload.status === "OPEN"))
    throw new Error("交易会话尚未关闭，请在结算后恢复");
  book.dragonHalted = false;
  book.dragonRiskPeakCents = book.equityCents;
  await commitAccount(
    env.DB,
    account,
    book,
    "DRAGON_RISK_RESUMED",
    { note: "只重建运行风险基准，历史绩效峰值保留" },
    true,
  );
  return dragonStatus(env, book);
}
export async function applyDragonLifecycle(env, date, now = new Date()) {
  await refreshDragonEngine(env, now);
  const papers = new RealtimeRepository(env),
    account = await papers.account();
  if (!account || account.book.lastDate !== date) return false;
  const clock = marketClock(now);
  let cyclePreparation = false;
  if (account.book.tradingCycleId && account.book.settlementCount === 0) {
    const row = await env.DB.prepare(
      "SELECT summary,digest FROM paper_trading_archives WHERE id=?",
    )
      .bind(account.book.tradingCycleId)
      .first();
    if (row) {
      const cycle = JSON.parse(row.summary);
      if ((await digestOf(cycle)) !== row.digest)
        throw new Error("新周期归档摘要不一致，不能切换交易政策");
      // A freshly archived, unexecuted cycle has an explicit next execution day.
      // Its real preparation window includes the intervening weekend.
      cyclePreparation =
        cycle.signalDate === date &&
        clock.date > date &&
        now.getTime() < Date.parse(`${cycle.tradeDate}T09:30:00+08:00`);
    }
  }
  if (
    !(
      (clock.date === date && clock.time >= "15:05:00") ||
      (clock.date > date && clock.time < OBSERVATION_SCHEDULE.preparationEnd) ||
      cyclePreparation
    )
  )
    return false;
  const book = structuredClone(account.book);
  if (isDragon(book) && book.pendingDragonConfigId) {
    const record = await loadDragonConfig(env.DB, book.pendingDragonConfigId);
    if (record.engineBuild !== (await executionEngineBuildDigest()))
      throw new Error("待生效配置执行指纹已变化，请重新验证");
    if (!(await dragonStatus(env, book)).ready) return false;
    const future = await env.DB.prepare(
      "SELECT * FROM paper_plans WHERE signal_date=?",
    )
      .bind(date)
      .first();
    const extra = [];
    if (future) {
      // 升级前未执行的旧版本计划另存修订，随后冻结新版本计划；已执行会话不改写。
      if (
        record.origin !== "ENGINE_UPGRADE" ||
        JSON.parse(future.payload).engineBuild === record.engineBuild
      )
        return false;
      if (
        await env.DB.prepare(
          "SELECT 1 FROM paper_live_sessions WHERE json_extract(payload,'$.plan.signalDate')=? LIMIT 1",
        )
          .bind(date)
          .first()
      )
        return false;
      extra.push((guard, args) =>
        env.DB.prepare(
          `INSERT INTO paper_plan_revisions(id,signal_date,created_at,payload,digest) SELECT ?,?,?,?,? WHERE ${guard}`,
        ).bind(
          crypto.randomUUID(),
          date,
          now.toISOString(),
          future.payload,
          future.digest,
          ...args,
        ),
      );
      extra.push((guard, args) =>
        env.DB.prepare(
          `DELETE FROM paper_plans WHERE signal_date=? AND ${guard}`,
        ).bind(date, ...args),
      );
      extra.push((guard, args) =>
        env.DB.prepare(
          `DELETE FROM dragon_plan_bindings WHERE scope='main' AND signal_date=? AND ${guard}`,
        ).bind(date, ...args),
      );
    }
    Object.assign(book, dragonBookFields(record));
    delete book.pendingDragonConfigId;
    book.dragonTransition = {
      state: "ACTIVE",
      configId: record.id,
      candidate: false,
    };
    await commitAccount(
      env.DB,
      account,
      book,
      "DRAGON_CONFIG_EFFECTIVE",
      { configId: record.id },
      true,
      extra,
    );
    return true;
  }
  if (book.dragonTransition?.state !== "DRAINING") return false;
  if (
    book.positions.length ||
    (book.pendingRecovery ?? []).length ||
    (book.pendingExits ?? []).length ||
    (book.pendingOrders ?? []).length
  )
    return false;
  const session = await papers.session(date);
  if (session?.status === "OPEN") return false;
  if (
    await env.DB.prepare(
      "SELECT 1 FROM paper_live_sessions WHERE trade_date>? LIMIT 1",
    )
      .bind(date)
      .first()
  )
    return false;
  if (!(await dragonStatus(env, book)).ready) return false;
  const record = await currentReadyRecord(env, book);
  Object.assign(book, dragonBookFields(record));
  book.dragonTransition = {
    ...book.dragonTransition,
    state: "ACTIVE",
    revalidating: false,
    effectiveSignalDate: date,
  };
  const previous = await env.DB.prepare(
    "SELECT * FROM paper_plans WHERE signal_date=?",
  )
    .bind(date)
    .first();
  const extra = previous
    ? [
        (guard, args) =>
          env.DB.prepare(
            `INSERT INTO paper_plan_revisions(id,signal_date,created_at,payload,digest) SELECT ?,?,?,?,? WHERE ${guard}`,
          ).bind(
            crypto.randomUUID(),
            date,
            now.toISOString(),
            previous.payload,
            previous.digest,
            ...args,
          ),
        (guard, args) =>
          env.DB.prepare(
            `DELETE FROM paper_plans WHERE signal_date=? AND ${guard}`,
          ).bind(date, ...args),
      ]
    : [];
  await commitAccount(
    env.DB,
    account,
    book,
    "DRAGON_ACTIVATED",
    { configId: record.id, effectiveSignalDate: date },
    true,
    extra,
  );
  return true;
}
export async function verifyDragonObservation(
  env,
  accountId,
  date,
  closing,
  now = new Date(),
) {
  if (!observationVerificationOpen(marketClock(now), date))
    return {
      status: "WAITING_VERIFICATION",
      date,
      verificationStart: OBSERVATION_SCHEDULE.verificationStart,
    };
  const shadows = new ShadowAccountRepository(env),
    stored = await shadows.session(accountId, date);
  if (!stored || !isDragon(stored.plan)) return null;
  const plan = structuredClone(stored.plan),
    id = plan.dragonPolicy.configId;
  const existing = await env.DB.prepare(
    "SELECT payload FROM dragon_observation_reports WHERE config_id=? AND trade_date=?",
  )
    .bind(id, date)
    .first();
  if (existing) {
    const report = JSON.parse(existing.payload);
    try {
      await assertReadinessEvidence(env, report);
    } catch (error) {
      return { ...report, passed: false, reason: error.message };
    }
    return report;
  }
  const frames = await new QuoteFrameRepository(env).framesForDate(date);
  const fills = (await shadows.ledger(accountId))
    .filter((l) => l.date === date)
    .sort((a, b) => a.sequence - b.sequence);
  const run = (inputPlan) => {
    let book = structuredClone(stored.initialBook),
      session = openSession(book, inputPlan, date),
      ledger = [];
    for (const f of frames) {
      const step = advanceSession(book, session, {
        ...f.payload,
        observedAt: f.observedAt,
      });
      book = step.book;
      session = step.session;
      ledger.push(...step.ledger);
    }
    return { ...closeSession(book, session, closing), ledger };
  };
  let replay = false,
    accounting = false;
  const stress = [];
  try {
    await assertStoredProgramPlan(env, plan, stored.initialBook, {
      tQualityScope: `shadow:${accountId}`,
    });
    for (const frame of frames)
      if ((await digestOf(frame.payload)) !== frame.digest)
        throw new Error("持久行情帧摘要不一致");
    const result = run(plan),
      account = await shadows.account(accountId);
    replay =
      canonicalJson(result.ledger) === canonicalJson(fills) &&
      canonicalJson(result.book) === canonicalJson(account.book);
    const first = await env.DB.prepare(
      "SELECT payload FROM shadow_sessions WHERE account_id=? ORDER BY trade_date LIMIT 1",
    )
      .bind(accountId)
      .first();
    const anchor = first
      ? JSON.parse(first.payload).initialBook
      : stored.initialBook;
    // An inherited matched portfolio has a real opening balance, not invented fills.
    const opening = {
      cashDeltaCents: anchor.cashCents - anchor.initialCashCents,
      realizedPnlCents: anchor.realizedPnlCents,
      feeCents: anchor.feesCents,
    };
    accounting = auditLedger(
      anchor.initialCashCents,
      [opening, ...(await shadows.ledger(accountId))],
      account.book,
      account.book.positions,
    ).passed;
    for (const multiplier of [1.5, 2]) {
      const stressed = structuredClone(plan);
      stressed.executionCostPolicy.payload.executionStressMultiplier =
        multiplier;
      stressed.executionCostPolicy.payloadDigest = await digestOf(
        stressed.executionCostPolicy.payload,
      );
      const out = run(stressed);
      stress.push({
        multiplier,
        passed:
          out.book.cashCents >= 0 &&
          out.book.equityCents - out.book.initialCashCents ===
            out.book.realizedPnlCents +
              out.book.positions.reduce(
                (s, p) =>
                  s +
                  p.lots.reduce(
                    (n, l) => n + l.quantity * p.markCents - l.costCents,
                    0,
                  ),
                0,
              ),
        fills: out.ledger.length,
      });
    }
  } catch (error) {
    stress.push({ passed: false, reason: error.message });
  }
  const coverage = observationCoverage(
    frames,
    date,
    Number(env.TRADING_POLL_SECONDS ?? 10),
  );
  const marketCoverage =
    frames.length > 0 &&
    frames.every((f) => {
      const m = f.payload?.entryInputs?.market,
        age = Date.parse(f.observedAt) - Date.parse(m?.observedAt);
      return (
        m?.date === date &&
        Object.hasOwn(DRAGON_REGIMES, m.cycle?.phase) &&
        age >= 0 &&
        age <= 120000
      );
    });
  const inputsPresent =
    frames.some(
      (f) => Object.keys(f.payload?.entryInputs?.auction ?? {}).length > 0,
    ) &&
    frames.every(
      (f) => f.payload?.pool?.sources?.researchPoolDate === plan.signalDate,
    ) &&
    Object.keys(plan.entryExecutionPolicy.history).length > 0;
  const report = {
    policyVersion: DRAGON_POLICY_VERSION,
    configId: id,
    configDigest: plan.dragonPolicy.configDigest,
    engineBuild: plan.engineBuild,
    synthetic: await dragonSyntheticChecks(),
    date,
    coverage,
    marketCoverage,
    replay,
    accounting,
    stress,
    fills: fills.length,
    inputsPresent,
    observerId: accountId,
    sessionDigest: await digestOf(stored),
    closingDataset: closing,
    closingDigest: await digestOf(closing),
    evidenceDigest: await digestOf(
      frames.map((f) => ({ sequence: f.sequence, digest: f.digest })),
    ),
    passed:
      (await dragonSyntheticChecks()).passed &&
      coverage &&
      marketCoverage &&
      inputsPresent &&
      replay &&
      accounting &&
      stress.length === 2 &&
      stress.every((s) => s.passed),
    note: "真实整日覆盖与技术核验，不声称收益优势；无成交不证明策略有效",
  };
  await env.DB.prepare(
    "INSERT OR IGNORE INTO dragon_observation_reports(config_id,trade_date,payload,digest) VALUES(?,?,?,?)",
  )
    .bind(id, date, JSON.stringify(report), await digestOf(report))
    .run();
  return report;
}
export async function maintainDragonObservation(env, date, now = new Date()) {
  const papers = new RealtimeRepository(env),
    primary = await papers.account();
  const transition = primary?.book.dragonTransition,
    clock = marketClock(now);
  if (
    !transition?.configId ||
    (transition.state === "DRAINING" && !transition.revalidating) ||
    (transition.state === "ACTIVE" && !transition.candidate)
  )
    return null;
  if (
    primary.book.lastDate !== date ||
    !observationMaintenanceOpen(clock, date)
  )
    return null;
  const record = await loadDragonConfig(env.DB, transition.configId);
  if (record.engineBuild !== (await executionEngineBuildDigest()))
    return {
      status: "STALE_ENGINE",
      reason: "源码已变化，请重新保存配置开启新观察",
    };
  const shadows = new ShadowAccountRepository(env),
    accountId = observerId(record.id);
  let observer = await shadows.account(accountId);
  if (observer && observer.book.lastDate !== date) {
    const current = await shadows.session(accountId, date);
    if (!current)
      return {
        status: "COVERAGE_MISSING",
        reason: "当日无持久行情会话，不能补造观察",
      };
    const closing = await collectTradingDay(
      date,
      observer.book.positions.map((p) => p.code),
      [],
      null,
    );
    if (current.status === "OPEN")
      await settlePortfolioDay(env, accountId, date, closing);
    await verifyDragonObservation(env, accountId, date, closing, now);
    observer = await shadows.account(accountId);
  }
  const original = await papers.snapshot(date);
  if (!original) return { status: "WAITING_SNAPSHOT" };
  const snapshot = original.intradayEntryContext
    ? original
    : {
        ...original,
        createdAt: now.toISOString(),
        intradayEntryContext: await buildIntradayContext(env, original),
      };
  if (!Object.keys(snapshot.intradayEntryContext?.history ?? {}).length)
    return { status: "WAITING_HISTORY" };
  const baseRecord = record.baseId
    ? await loadDragonConfig(env.DB, record.baseId)
    : null;
  if (
    transition.candidate &&
    record.validationMode !== "MANUAL_UNVERIFIED" &&
    baseRecord
  ) {
    await ensureDragonTemplateResearch(env, record, primary, snapshot, now);
    const research = await dragonResearchStatus(env, record.id);
    if (
      research?.status === "PASSED" &&
      primary.book.improvementMode === "auto"
    ) {
      const status = await dragonStatus(env);
      if (status.ready) await requestDragonActivation(env);
    }
    return {
      status: research?.status ?? "COLLECTING",
      accountId,
      signalDate: date,
    };
  }
  if (!observer)
    observer = await shadows.ensureAccount(accountId, {
      kind: SHADOW_ACCOUNT_KINDS.DRAGON_OBSERVATION,
      book: {
        ...newBook(primary.book.equityCents / 100, primary.book.feeConfig),
        lastDate: date,
        ...dragonBookFields(record),
        feeModel: primary.book.feeModel,
        feeConfigVersion: primary.book.feeConfigVersion,
      },
    });
  await freezePortfolioPlan(env, accountId, {
    snapshot,
    strategy: null,
    strategyVersion: record.id,
    now: now.toISOString(),
  });
  return { status: "OBSERVING", accountId, signalDate: date };
}
export async function preparePendingDragonObservation(env, now = new Date()) {
  const account = await new PaperRepository(env).account();
  if (account?.book.lastDate)
    return maintainDragonObservation(env, account.book.lastDate, now);
  return null;
}
