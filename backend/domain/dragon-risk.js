// Independent policy. Only the observed buy-point predicates, fees and cost solver
// are shared with the legacy engine; no legacy strategy/risk defaults are read.
import {
  DRAGON_POLICY_VERSION as VERSION,
  DRAGON_TEMPLATE_VERSION,
  DRAGON_ADAPTIVE_TEMPLATE_VERSION,
  DRAGON_T_CAPITAL_POLICY,
  DRAGON_REGIMES,
  DRAGON_HOLD_DAYS,
  normalizeDragonConfig,
  dragonPreview,
  dragonTCapitalLimits,
} from "../../shared/dragon-risk-config.js";
import {
  ADAPTIVE_RISK_POLICY,
  initialAdaptiveRisk,
  advanceAdaptiveRisk,
  adaptiveEffective,
  adaptiveEntryOrderDecision,
  validAdaptiveRiskPolicy,
  ADAPTIVE_RISK_POLICY_V2,
  NEUTRAL_ADAPTIVE_RISK_POLICY,
} from "../../shared/adaptive-risk.js";
import {
  MARKET_ENVIRONMENT_POLICY,
  isEnvironmentPolicy,
  freezeEnvironmentCohort,
  assertEnvironmentCohort,
} from "../../shared/market-environment.js";
import { ENTRY_ORDER_POLICY } from "../../shared/entry-order-policy.js";
import { assertManualExitRequests, manualExitFor } from "./manual-exits.js";
import {
  INTRADAY_ENTRY_RULES,
  INTRADAY_ENTRY_VERSION,
  eligible,
  typesAt,
  updateEntryPath,
  assertEntryHistoryProcessed,
} from "./intraday-entry.js";
import {
  selectionPolicy,
  selectionPolicyFields,
  SELECTION_VERSION_V5,
  SELECTION_VERSION_DRAGON,
} from "./signal-selection.js";
import { canonicalJson } from "./research-lineage.js";
import { buildExecutionContext, solveFillQuantity } from "./execution-cost.js";
import { EXECUTION_COST_MODEL } from "../../shared/execution-cost.js";
import {
  transactionFees,
  availableQuantity,
  totalQuantity,
  costBasis,
  roundLot,
} from "./trading.js";
import { feesForBook } from "../../shared/fees.js";
import { planFreezeDeadline } from "../../shared/observation-schedule.js";
import {
  recordPracticeDecision as trace,
  observePracticeRisk,
} from "./practice-trace.js";

export const DRAGON_RULES = Object.freeze({
  version: DRAGON_TEMPLATE_VERSION,
  sectorMinimum: 55,
  firstNegMinPrevHeight: 3,
  maxChase: 0.03,
  profitAddAt: 0.5,
  profitAddBefore: 1,
  profitAddFraction: 0.5,
  lossAddFrom: -0.75,
  lossAddTo: -0.5,
  lossAddFraction: 0.25,
  addRiskFraction: 0.5,
  tEntryDeviation: 0.02,
  tLossLimit: 2,
  tCooldownDays: 3,
  profitMilestones: [1, 2],
  profitFractions: [0.3, 0.3],
  trailingR: 1,
  holdDays: DRAGON_HOLD_DAYS,
});
export const isDragon = (value) => value?.tradingPolicyVersion === VERSION;
export const isAdaptiveDragon = (plan) =>
  plan?.dragonPolicy?.templateVersion === DRAGON_ADAPTIVE_TEMPLATE_VERSION;
const hasTCapital = (plan) =>
  plan?.dragonPolicy?.tCapitalPolicy?.version ===
  DRAGON_T_CAPITAL_POLICY.version;
const clone = (value) => structuredClone(value);
const qOf = (book, code) => book.positions.find((p) => p.code === code);
const qty = (p) => (p ? totalQuantity(p) : 0);
const clock = (stamp) =>
  new Date(Date.parse(stamp) + 8 * 3600000).toISOString().slice(11, 19);
const fresh = (stamp, now, age) =>
  Number.isFinite(Date.parse(stamp)) &&
  now >= Date.parse(stamp) &&
  now - Date.parse(stamp) <= age;
const terminal = new Set(["FILLED", "CANCELLED", "EXPIRED", "EXPIRED_PARTIAL"]);
function mark(book) {
  book.positions = book.positions.filter((p) => qty(p) > 0);
  book.equityCents =
    book.cashCents +
    book.positions.reduce((n, p) => n + qty(p) * p.markCents, 0);
  book.peakEquityCents = Math.max(book.peakEquityCents, book.equityCents);
  if (book.dragonRiskPeakCents != null)
    book.dragonRiskPeakCents = Math.max(
      book.dragonRiskPeakCents,
      book.equityCents,
    );
}
export function assertDragonPlan(plan, book = null) {
  if (!isDragon(plan))
    throw new Error("新政策计划缺少 dragon-risk-v1 标记，禁止回退旧规则");
  const policy = plan.dragonPolicy;
  assertManualExitRequests(plan.manualExitRequests, plan);
  const expectedSelection = selectionPolicyFields(
    selectionPolicy(SELECTION_VERSION_DRAGON),
  );
  if (
    canonicalJson(plan.selectionPolicy) !==
      canonicalJson(expectedSelection.selectionPolicy) ||
    plan.selectionPolicyDigest !== expectedSelection.selectionPolicyDigest
  )
    throw new Error("新政策排序声明不一致，不能继承旧评分排序");
  if (
    !policy ||
    policy.version !== VERSION ||
    ![DRAGON_TEMPLATE_VERSION, DRAGON_ADAPTIVE_TEMPLATE_VERSION].includes(
      policy.templateVersion,
    ) ||
    (isAdaptiveDragon(plan)
      ? !validAdaptiveRiskPolicy(policy.adaptiveRiskPolicy)
      : Object.hasOwn(policy, "adaptiveRiskPolicy")) ||
    (Object.hasOwn(policy, "entryOrderPolicy") &&
      (!isAdaptiveDragon(plan) ||
        policy.entryOrderPolicy !== ENTRY_ORDER_POLICY)) ||
    (Object.hasOwn(policy, "tCapitalPolicy") &&
      (!isAdaptiveDragon(plan) ||
        canonicalJson(policy.tCapitalPolicy) !==
          canonicalJson(DRAGON_T_CAPITAL_POLICY))) ||
    canonicalJson(policy.rules) !== canonicalJson(DRAGON_RULES) ||
    canonicalJson(plan.entryExecutionPolicy?.rules) !==
      canonicalJson(INTRADAY_ENTRY_RULES)
  )
    throw new Error("新政策规则或模板与冻结版本不一致");
  normalizeDragonConfig(policy.config);
  if (isEnvironmentPolicy(policy.adaptiveRiskPolicy)) {
    if (
      canonicalJson(policy.marketEnvironmentPolicy) !==
      canonicalJson(MARKET_ENVIRONMENT_POLICY)
    )
      throw new Error("市场环境政策摘要不一致");
    assertEnvironmentCohort(policy.environmentCohort, plan);
  }
  if (
    !policy.configId ||
    !policy.configDigest ||
    !plan.executionCostPolicy?.payloadDigest ||
    !plan.engineBuild
  )
    throw new Error("新政策缺少配置版本、成本政策或执行指纹");
  if (book?.tradingPolicyVersion && !isDragon(book))
    throw new Error("账户交易政策与计划不一致");
  if (
    plan.strategy ||
    plan.riskLimits ||
    plan.strategyProgram ||
    plan.exposureTiers
  )
    throw new Error("新政策计划不得携带旧策略或风控参数");
  return policy.config;
}
export function createDragonPlan(snapshot, book, createdAt, options = {}) {
  assertEntryHistoryProcessed(snapshot);
  const manualExitRequests = options.manualExitRequests ?? [];
  assertManualExitRequests(
    manualExitRequests,
    { signalDate: snapshot.date, createdAt },
    book,
  );
  const config = normalizeDragonConfig(book.dragonConfig);
  const riskPolicy =
    options.adaptiveRiskPolicy ??
    (book.environmentControl === "LEGACY"
      ? ADAPTIVE_RISK_POLICY_V2
      : book.environmentControl === "NEUTRAL"
        ? NEUTRAL_ADAPTIVE_RISK_POLICY
        : ADAPTIVE_RISK_POLICY);
  const context = snapshot.intradayEntryContext;
  if (
    !options.defensive &&
    (context?.asOf !== snapshot.date ||
      context?.version !== INTRADAY_ENTRY_VERSION)
  )
    throw new Error("新政策缺少信号日冻结的买点历史");
  const history = clone(context?.history ?? {});
  const retained = options.observationUniverse;
  if (
    retained !== undefined &&
    (!Array.isArray(retained) ||
      retained.length > INTRADAY_ENTRY_RULES.maxCandidates ||
      new Set(retained).size !== retained.length ||
      retained.some(
        (code) =>
          !/^\d{6}$/.test(code) ||
          (!history[code] && !book.positions.some((p) => p.code === code)),
      ))
  )
    throw new Error("版本衔接的冻结观察名单无效");
  const candidates =
    retained ??
    Object.keys(history)
      .filter((code) => eligible(history[code], null))
      .sort(
        (a, b) =>
          (history[b].amount ?? 0) - (history[a].amount ?? 0) ||
          a.localeCompare(b),
      )
      .slice(0, INTRADAY_ENTRY_RULES.maxPremarketCandidates);
  const allCandidates = [
    ...new Set([...book.positions.map((p) => p.code), ...candidates]),
  ];
  const phase =
    snapshot.cycle?.phase ?? snapshot.marketSummary?.cycle?.phase ?? "unknown";
  const plan = {
    tradingPolicyVersion: VERSION,
    signalDate: snapshot.date,
    createdAt,
    strategyVersion: book.dragonConfigId,
    entryExecutionMode: "intraday-conditional",
    sourceSnapshotMissing: !!options.defensive,
    ...(retained ? { observationUniverse: clone(retained) } : {}),
    engineBuild: options.engineBuild ?? book.dragonEngineBuild,
    ...(manualExitRequests.length
      ? { manualExitRequests: clone(manualExitRequests) }
      : {}),
    dragonPolicy: {
      version: VERSION,
      templateVersion:
        options.dragonTemplateVersion ?? DRAGON_ADAPTIVE_TEMPLATE_VERSION,
      ...(options.dragonTemplateVersion === DRAGON_TEMPLATE_VERSION
        ? {}
        : {
            adaptiveRiskPolicy: clone(riskPolicy),
            ...(options.tCapitalPolicy === null
              ? {}
              : {
                  tCapitalPolicy: clone(
                    options.tCapitalPolicy ?? DRAGON_T_CAPITAL_POLICY,
                  ),
                }),
            ...(options.entryOrderPolicy === null
              ? {}
              : {
                  entryOrderPolicy:
                    options.entryOrderPolicy ?? ENTRY_ORDER_POLICY,
                }),
          }),
      configId: book.dragonConfigId,
      ...(options.dragonTemplateVersion !== DRAGON_TEMPLATE_VERSION &&
      isEnvironmentPolicy(riskPolicy)
        ? {
            marketEnvironmentPolicy: clone(MARKET_ENVIRONMENT_POLICY),
            environmentCohort: freezeEnvironmentCohort({
              ...snapshot,
              createdAt: snapshot.createdAt ?? createdAt,
            }),
          }
        : {}),
      configDigest: book.dragonConfigDigest,
      config,
      ...(book.dragonConfigProvenance
        ? { provenance: clone(book.dragonConfigProvenance) }
        : {}),
      rules: clone(DRAGON_RULES),
    },
    ...selectionPolicyFields(selectionPolicy(SELECTION_VERSION_DRAGON)),
    sourceUniverseVersion: SELECTION_VERSION_V5,
    entryExecutionPolicy: {
      version: INTRADAY_ENTRY_VERSION,
      sourceDate: snapshot.date,
      ...(context?.industrySnapshotId
        ? { industrySnapshotId: context.industrySnapshotId }
        : {}),
      rules: clone(INTRADAY_ENTRY_RULES),
      history,
      candidates: allCandidates,
      firstNegMinPrevHeight: DRAGON_RULES.firstNegMinPrevHeight,
    },
    feeModel: book.feeModel,
    feeConfig: clone(feesForBook(book)),
    feeConfigVersion: book.feeConfigVersion,
    executionCostModel: EXECUTION_COST_MODEL,
    executionCostPolicy: clone(options.executionCostPolicy),
    previousLimitUpCodes: (snapshot.stocks ?? [])
      .filter((s) => s.height >= 1)
      .map((s) => s.code)
      .sort(),
    previousLimitUpKnown: !options.defensive,
    marketPolicy:
      options.dragonTemplateVersion === DRAGON_TEMPLATE_VERSION
        ? dragonPreview(config, phase)
        : {
            ...dragonPreview(config, "unknown"),
            templateVersion: DRAGON_ADAPTIVE_TEMPLATE_VERSION,
            adaptiveRiskPolicyVersion: riskPolicy.version,
          },
    selectionAudit: {
      signalDate: snapshot.date,
      snapshotDigest: options.snapshotDigest ?? null,
      candidates: candidates.map((code, index) => ({
        code,
        name: history[code]?.name ?? qOf(book, code)?.name,
        rank: index + 1,
        amount: history[code]?.amount ?? null,
        status: "WATCHING",
        reason: "等待实际买点与共享风险预算",
      })),
    },
    orders: book.positions.map((p) => {
      const order = {
        tradingPolicyVersion: VERSION,
        referenceCents: p.markCents,
        takeProfitCents: p.dragon?.p0Cents + p.dragon?.r0Cents,
        id: `${snapshot.date}:${p.code}:HOLD`,
        code: p.code,
        name: p.name,
        action: "HOLD",
        side: "NONE",
        quantity: 0,
        stopCents: p.dragon?.stopCents,
        reason: "由独立风险预算政策管理",
      };
      const request = manualExitFor({ manualExitRequests }, p);
      if (request)
        Object.assign(order, {
          action: "EXIT",
          side: "SELL",
          quantity: qty(p),
          manualExitRequestId: request.id,
          protective: true,
          reason: request.reason,
        });
      return order;
    }),
    constraints:
      "独立配置；按实际观测买点触发；所有买入共享预算；T+1；旧参数不参与。",
  };
  assertDragonPlan(plan, book);
  return plan;
}
export function openDragonSession(book, plan, date) {
  assertDragonPlan(plan, book);
  assertManualExitRequests(plan.manualExitRequests, plan, book);
  if (plan.manualExitRequests?.some((row) => row.tradeDate > date))
    throw new Error("尚未到用户指定的清仓交易日");
  if (
    !isDragon(book) ||
    book.lastDate !== plan.signalDate ||
    plan.signalDate >= date ||
    !Number.isFinite(Date.parse(plan.createdAt)) ||
    Date.parse(plan.createdAt) >= planFreezeDeadline(plan, date)
  )
    throw new Error("新政策需要执行日前冻结的计划，禁止盘中切换");
  for (const p of book.positions)
    if (!p.dragon) throw new Error("新政策不能接管未结清的旧持仓");
  return {
    tradingPolicyVersion: VERSION,
    date,
    signalDate: plan.signalDate,
    status: "OPEN",
    plan: clone(plan),
    initialBook: clone(book),
    sequence: 0,
    fillCount: 0,
    quotes: {},
    orders: [],
    lastObservedAt: null,
    executionState: {
      policyDigest: plan.executionCostPolicy.payloadDigest,
      byCode: {},
    },
    entryState: {
      admissions: Object.fromEntries(
        plan.entryExecutionPolicy.candidates.map((code) => [
          code,
          { code, source: "PREMARKET", admittedAt: plan.createdAt },
        ]),
      ),
      paths: {},
      coverage: { acceptedQuotes: 0 },
    },
    regime: {
      phase: "unknown",
      pending: null,
      confirmations: 0,
      marketStamp: null,
    },
    ...(isAdaptiveDragon(plan)
      ? {
          adaptiveRisk: initialAdaptiveRisk(
            date,
            plan.dragonPolicy.adaptiveRiskPolicy,
          ),
        }
      : {}),
    dailyPaused: false,
    cooldownAtStart: book.dragonCooldownDays ?? 0,
    practice: { version: 1, startedSequence: 0, decisions: {} },
  };
}
function marketState(session, observation) {
  const market = observation.entryInputs?.market,
    now = Date.parse(observation.observedAt);
  const next =
    market?.date === session.date &&
    fresh(market.observedAt, now, INTRADAY_ENTRY_RULES.marketMaxAgeMs) &&
    Object.hasOwn(DRAGON_REGIMES, market.cycle?.phase)
      ? market.cycle.phase
      : "unknown";
  const order = { unknown: -1, freezing: 0, ebbing: 1, climax: 2, rising: 3 };
  const state = session.regime;
  if (next === "unknown" || order[next] <= order[state.phase]) {
    state.phase = next;
    state.pending = null;
    state.confirmations = 0;
  } else if (market.observedAt !== state.marketStamp) {
    state.confirmations = state.pending === next ? state.confirmations + 1 : 1;
    state.pending = next;
    if (state.confirmations >= 2) {
      state.phase = next;
      state.pending = null;
      state.confirmations = 0;
    }
  }
  if (market) state.marketStamp = market.observedAt;
  return DRAGON_REGIMES[state.phase];
}
function reservations(
  book,
  session,
  excludingCode = null,
  excludingOrder = null,
) {
  const result = book.positions
    .filter(
      (p) => p.code !== excludingCode && p.dragon?.t?.direction === "REVERSE",
    )
    .reduce(
      (s, p) => {
        const t = p.dragon.t,
          remaining = t.firstQuantity - t.secondQuantity;
        const cents = remaining * t.reservePriceCents;
        const buyFee = transactionFees(
          cents,
          "BUY",
          session.plan.feeConfig,
          session.plan.feeModel,
        ).total;
        const sellFee = transactionFees(
          cents,
          "SELL",
          session.plan.feeConfig,
          session.plan.feeModel,
        ).total;
        s.cash += cents + buyFee;
        s.exposure += cents;
        s.risk +=
          remaining * Math.max(1, t.reservePriceCents - p.dragon.stopCents) +
          buyFee +
          sellFee;
        if (p.sector) s.sectors[p.sector] = (s.sectors[p.sector] ?? 0) + cents;
        s.stocks[p.code] = (s.stocks[p.code] ?? 0) + cents;
        return s;
      },
      {
        cash: 0,
        exposure: 0,
        risk: 0,
        sectors: {},
        stocks: {},
        entryExposure: 0,
        entrySectors: {},
        entryStocks: {},
      },
    );
  for (const o of session.orders) {
    if (
      o.id === excludingOrder ||
      terminal.has(o.status) ||
      !["OPEN", "ADD_PROFIT", "ADD_LOSS"].includes(o.intent)
    )
      continue;
    const remaining = Math.max(0, o.quantity - o.filledQuantity),
      cents = remaining * o.maxPriceCents;
    const fee = remaining
      ? transactionFees(
          cents,
          "BUY",
          session.plan.feeConfig,
          session.plan.feeModel,
        ).total +
        transactionFees(
          cents,
          "SELL",
          session.plan.feeConfig,
          session.plan.feeModel,
        ).total
      : 0;
    result.cash += cents + fee;
    result.exposure += cents;
    result.entryExposure += cents;
    result.stocks[o.code] = (result.stocks[o.code] ?? 0) + cents;
    result.entryStocks[o.code] = (result.entryStocks[o.code] ?? 0) + cents;
    result.risk += remaining * Math.max(1, o.maxPriceCents - o.stopCents) + fee;
    const sector = session.plan.entryExecutionPolicy.history[o.code]?.sector;
    result.sectors[sector] = (result.sectors[sector] ?? 0) + cents;
    result.entrySectors[sector] = (result.entrySectors[sector] ?? 0) + cents;
  }
  return result;
}

function tRemaining(position) {
  const t = position?.dragon?.t;
  return t ? Math.max(0, t.firstQuantity - t.secondQuantity) : 0;
}
function strategicQuantity(position) {
  const direction = position?.dragon?.t?.direction;
  return Math.max(
    0,
    qty(position) +
      (direction === "REVERSE"
        ? tRemaining(position)
        : direction === "FORWARD"
          ? -tRemaining(position)
          : 0),
  );
}
function strategicExposure(book) {
  const result = { gross: 0, sectors: {} };
  for (const position of book.positions) {
    const cents = strategicQuantity(position) * position.markCents;
    result.gross += cents;
    result.sectors[position.sector] =
      (result.sectors[position.sector] ?? 0) + cents;
  }
  return result;
}
export function dragonBudget(
  book,
  session,
  code,
  priceCents,
  stopCents,
  intent,
  maxQuantity = Infinity,
  excludingOrder = null,
) {
  const config = session.plan.dragonPolicy.config,
    risk = config.risk,
    regime = DRAGON_REGIMES[session.regime.phase];
  if (1 - book.equityCents / session.initialBook.equityCents >= risk.dailyLoss)
    session.dailyPaused = true;
  if (
    1 - book.equityCents / (book.dragonRiskPeakCents ?? book.peakEquityCents) >=
    risk.drawdown
  )
    book.dragonHalted = true;
  const p = qOf(book, code),
    history = session.plan.entryExecutionPolicy.history[code];
  const sector = p?.sector ?? history?.sector;
  const reserve = reservations(
    book,
    session,
    intent === "T_RECOVERY" ? code : null,
    excludingOrder,
  );
  const exposure = book.positions.reduce((s, x) => s + qty(x) * x.markCents, 0);
  const sectorExposure = book.positions
    .filter((x) => x.sector === sector)
    .reduce((s, x) => s + qty(x) * x.markCents, 0);
  const heldRisk = book.positions.reduce(
    (s, x) =>
      s +
      qty(x) *
        Math.max(
          x.dragon?.exit ? x.dragon.r0Cents : 0,
          x.markCents - (x.dragon?.stopCents ?? 0),
          0,
        ) +
      Math.ceil(qty(x) * x.markCents * 0.003),
    0,
  );
  const dynamic = isAdaptiveDragon(session.plan);
  const policy = dynamic
    ? adaptiveEffective(config, session.adaptiveRisk, {
        code,
        sector,
        observedAt: session.lastObservedAt,
        intent,
      })
    : dragonPreview(config, session.regime.phase).effective;
  const gross =
    !dynamic && intent === "T_RECOVERY" && session.regime.phase === "ebbing"
      ? Math.min(0.2, risk.grossWeight)
      : policy.grossWeight;
  const factor = dynamic
    ? policy.factor
    : intent === "T_RECOVERY" && session.regime.phase === "ebbing"
      ? 1
      : regime.factor;
  if (
    session.dailyPaused ||
    session.missingHoldingQuotes ||
    book.dragonHalted ||
    !factor ||
    gross == null ||
    session.plan.sourceSnapshotMissing
  )
    return {
      quantity: 0,
      reason: "市场、数据或账户暂停新增风险",
      reasonCode: session.dailyPaused
        ? "DAILY_PAUSED"
        : session.missingHoldingQuotes
          ? "HOLDING_DATA_MISSING"
          : book.dragonHalted
            ? "DRAWDOWN_HALTED"
            : "MARKET_RESTRICTED",
    };
  const pendingCodes = new Set(
    session.orders
      .filter(
        (o) =>
          o.intent === "OPEN" &&
          !terminal.has(o.status) &&
          o.quantity > o.filledQuantity &&
          !qOf(book, o.code),
      )
      .map((o) => o.code),
  );
  if (
    !p &&
    !pendingCodes.has(code) &&
    book.positions.length + pendingCodes.size >= risk.maxPositions
  )
    return {
      quantity: 0,
      reason: "持仓及待成交名额已满",
      reasonCode: "MAX_POSITIONS",
    };
  const equity = book.equityCents;
  const tCapital = hasTCapital(session.plan);
  const tIntent = ["T_FIRST", "T_RECOVERY"].includes(intent);
  const peak = tCapital ? dragonTCapitalLimits(config, policy) : null;
  const strategic = tCapital ? strategicExposure(book) : null;
  const coreCap =
    tCapital && !tIntent
      ? Math.min(
          equity * gross - strategic.gross - reserve.entryExposure,
          equity * policy.stockWeight -
            strategicQuantity(p) * (p?.markCents ?? 0) -
            (reserve.entryStocks[code] ?? 0),
          equity * policy.sectorWeight -
            (strategic.sectors[sector] ?? 0) -
            (reserve.entrySectors[sector] ?? 0),
        )
      : Infinity;
  const cap = Math.max(
    0,
    Math.min(
      book.cashCents - reserve.cash,
      coreCap,
      equity * (peak?.grossWeight ?? gross) - exposure - reserve.exposure,
      equity *
        (peak?.stockWeight ??
          (dynamic ? policy.stockWeight : risk.stockWeight)) -
        qty(p) * (p?.markCents ?? 0) -
        (tCapital ? (reserve.stocks[code] ?? 0) : 0),
      equity *
        (peak?.sectorWeight ??
          (dynamic ? policy.sectorWeight : risk.sectorWeight)) -
        sectorExposure -
        (reserve.sectors[sector] ?? 0),
    ),
  );
  const perShareRisk =
    Math.max(1, priceCents - stopCents) + Math.ceil(priceCents * 0.003);
  const tradeRisk =
    equity * risk.entryRisk * factor * (intent.startsWith("ADD_") ? 0.5 : 1);
  const remainingRisk = Math.max(
    0,
    equity * risk.portfolioRisk * (dynamic ? policy.marketFactor : factor) -
      heldRisk -
      reserve.risk,
  );
  return {
    quantity: roundLot(
      Math.min(
        maxQuantity,
        tCapital && intent === "T_FIRST"
          ? p
            ? availableQuantity(p, session.date) * config.advanced.tFraction
            : 0
          : Infinity,
        cap / (priceCents * 1.003),
        tradeRisk / perShareRisk,
        remainingRisk / perShareRisk,
      ),
    ),
    capCents: Math.floor(cap),
    riskBudgetCents: Math.floor(Math.min(tradeRisk, remainingRisk)),
    stopCents,
    ...(tCapital
      ? {
          capital: {
            version: session.plan.dragonPolicy.tCapitalPolicy.version,
            coreGrossWeight: gross,
            peakGrossWeight: peak.grossWeight,
            peakStockWeight: peak.stockWeight,
            peakSectorWeight: peak.sectorWeight,
            strategicExposureCents: strategic.gross,
            totalExposureCents: exposure,
          },
        }
      : {}),
    ...(dynamic
      ? {
          adaptiveRisk: {
            version: session.adaptiveRisk.version,
            marketTimestamp: session.adaptiveRisk.market.observedAt,
            factor,
            marketFactor: policy.marketFactor,
            sectorFactor: policy.sectorFactor,
            stockFactor: policy.stockFactor,
          },
        }
      : {}),
    reason:
      cap <= 0 ? "现金、仓位或预留不足" : "计划风险、集中度与共享预算约束",
    reasonCode: cap <= 0 ? "CASH_OR_EXPOSURE" : "RISK_BUDGET",
  };
}
function addOrder(session, code, action, reason, extras = {}) {
  const baseId = `${session.date}:${code}:${action}`;
  let order = session.orders.findLast(
    (o) => o.code === code && o.intent === action,
  );
  const retry = order?.adaptiveCancelled && !order.filledQuantity;
  const id = retry ? `${baseId}:retry:${session.sequence}` : baseId;
  if (retry) order = null;
  if (!order) {
    const h = session.plan.entryExecutionPolicy.history[code];
    order = {
      id,
      code,
      name: h?.name ?? code,
      action,
      intent: action,
      side: ["EXIT", "REDUCE"].includes(action) ? "SELL" : "BUY",
      quantity: 0,
      filledQuantity: 0,
      firstFilled: 0,
      secondFilled: 0,
      status: "WATCHING",
      reason,
      ...extras,
    };
    session.orders.push(order);
  }
  return order;
}
function recordT(book, position, status, date) {
  const t = position.dragon.t;
  if (!t) return;
  const complete =
    status === "COMPLETED" && t.firstQuantity === t.secondQuantity;
  const record = {
    id: t.id,
    code: position.code,
    direction: t.direction,
    startedDate: t.date,
    completedDate: date,
    status,
    buyQuantity: t.direction === "FORWARD" ? t.firstQuantity : t.secondQuantity,
    sellQuantity:
      t.direction === "FORWARD" ? t.secondQuantity : t.firstQuantity,
    netPnlCents: complete ? t.cashDeltaCents : null,
    netCashCents: t.cashDeltaCents,
  };
  book.dragonTRecords = [...(book.dragonTRecords ?? []), record].slice(-100);
  if (complete) {
    book.dragonTNetPnlCents = (book.dragonTNetPnlCents ?? 0) + t.cashDeltaCents;
    book.dragonTLossStreak =
      t.cashDeltaCents < 0 ? (book.dragonTLossStreak ?? 0) + 1 : 0;
    if (book.dragonTLossStreak >= 2) {
      book.dragonCooldownDays = 3;
      book.dragonCooldownDate = date;
      book.dragonTLossStreak = 0;
    }
  }
  position.dragon.t = null;
}
// The cost solver is shared, while risk caps, intent validation and accounting
// state are policy-local. A failed/partial fill never spends unfilled inventory.
function fill(
  book,
  session,
  item,
  order,
  side,
  desired,
  ledger,
  budget = null,
) {
  const { quote, volume } = item,
    code = quote.code,
    plan = session.plan;
  const p = qOf(book, code);
  if (
    (side === "BUY" && quote.closeCents >= quote.limitUpCents) ||
    (side === "SELL" && quote.closeCents <= quote.limitDownCents)
  ) {
    order.reason = "涨跌停排队不假设成交";
    trace(session, code, "LIMIT_LOCKED", {
      intent: order.intent,
      orderId: order.id,
    });
    return null;
  }
  const now = Date.parse(session.lastObservedAt);
  if (
    (side === "BUY" || isAdaptiveDragon(plan)) &&
    (quote.orderBookQuality !== "OK" ||
      !((side === "BUY" ? quote.ask1Cents : quote.bid1Cents) > 0) ||
      !((side === "BUY" ? quote.ask1Shares : quote.bid1Shares) > 0) ||
      !fresh(quote.orderBookTimestamp, now, INTRADAY_ENTRY_RULES.quoteMaxAgeMs))
  ) {
    order.reason = side === "BUY" ? "缺少当帧可验证卖盘" : "缺少当帧可验证买盘";
    trace(session, code, "ORDERBOOK_MISSING", {
      intent: order.intent,
      orderId: order.id,
    });
    return null;
  }
  const fees = (n) =>
    transactionFees(n, side, plan.feeConfig, plan.feeModel).total;
  const event = {
    priceCents: quote.closeCents,
    volumeShares: volume,
    time: clock(session.lastObservedAt),
    intervalKey: quote.timestamp,
    quality: "realtime_poll",
  };
  const context = buildExecutionContext({
    plan,
    code,
    event,
    quote,
    intervalState: session.executionState.byCode[code],
  });
  const available =
    side === "SELL"
      ? Math.min(
          availableQuantity(p, session.date),
          isAdaptiveDragon(plan) ? quote.bid1Shares : Infinity,
        )
      : Math.min(desired, quote.ask1Shares);
  const solve = (desiredQuantity) =>
    solveFillQuantity({
      policy: plan.executionCostPolicy,
      context,
      side,
      desiredQuantity,
      limits: {
        maxPriceCents: side === "BUY" ? order.maxPriceCents : null,
        limitUpCents: quote.limitUpCents,
        limitDownCents: quote.limitDownCents,
        capCents:
          side === "BUY"
            ? Math.min(book.cashCents, budget?.capCents ?? 0)
            : null,
        availableQuantity: available,
      },
      estimateFees: (n) => fees(n),
    });
  let solved = solve(Math.min(desired, available));
  while (side === "BUY" && solved.quantity > 0) {
    const n = solved.quantity * solved.executionCost.fillPriceCents;
    const planned =
      solved.quantity *
        Math.max(0, solved.executionCost.fillPriceCents - budget.stopCents) +
      fees(n) +
      transactionFees(n, "SELL", plan.feeConfig, plan.feeModel).total;
    if (planned <= budget.riskBudgetCents) break;
    solved = solve(solved.quantity - 100);
  }
  if (!solved.quantity) {
    order.reason = solved.detail ?? solved.reason;
    order.status = "BLOCKED";
    trace(
      session,
      code,
      side === "SELL" && !available ? "T1_BLOCKED" : "CAPACITY_BLOCKED",
      { intent: order.intent, orderId: order.id, desired, available },
    );
    return null;
  }
  const quantity = solved.quantity,
    price = solved.executionCost.fillPriceCents,
    notional = quantity * price;
  const feeBreakdown = transactionFees(
      notional,
      side,
      plan.feeConfig,
      plan.feeModel,
    ),
    fee = feeBreakdown.total;
  if (order.side === "PAIR") {
    const roundTripFees =
      transactionFees(notional, "BUY", plan.feeConfig, plan.feeModel).total +
      transactionFees(notional, "SELL", plan.feeConfig, plan.feeModel).total;
    const nextCost =
      (notional * (solved.executionCost.costBreakdown.totalBps ?? 0)) / 10000;
    if (
      notional * plan.dragonPolicy.config.advanced.tSpread <=
      roundTripFees + nextCost
    ) {
      order.reason = "实际可成交数量不足以覆盖做 T 双边费用和预计成本";
      order.status = "BLOCKED";
      trace(session, code, "T_COST_BLOCKED", {
        intent: order.intent,
        orderId: order.id,
      });
      return null;
    }
  }
  const cashDelta = side === "BUY" ? -notional - fee : notional - fee;
  let position = p,
    basisCents = 0;
  if (side === "BUY") {
    if (!position) {
      const h = plan.entryExecutionPolicy.history[code];
      position = {
        code,
        name: h.name,
        sector: h.sector,
        lots: [],
        heldDays: 0,
        markCents: quote.closeCents,
        markDate: session.date,
      };
      book.positions.push(position);
    }
    position.lots.push({
      acquiredDate: session.date,
      quantity,
      costCents: notional + fee,
      priceCents: price,
      dragonIntent: order.intent,
      cycleId: position.dragon?.id ?? `${session.date}:${code}`,
    });
  } else {
    let left = quantity;
    for (const lot of position.lots) {
      if (lot.acquiredDate >= session.date || !left) continue;
      const used = Math.min(left, lot.quantity),
        basis = Math.round((lot.costCents * used) / lot.quantity);
      lot.quantity -= used;
      lot.costCents -= basis;
      basisCents += basis;
      left -= used;
    }
    position.lots = position.lots.filter((l) => l.quantity > 0);
    book.realizedPnlCents += cashDelta - basisCents;
  }
  book.cashCents += cashDelta;
  book.feesCents += fee;
  session.executionState.byCode[code] = solved.nextIntervalState;
  const row = {
    id: `${session.date}:live:${session.fillCount}`,
    date: session.date,
    signalDate: plan.signalDate,
    sequence: session.fillCount++,
    time: event.time,
    code,
    name: position.name,
    action: order.action,
    intent: order.intent,
    side,
    quantity,
    priceCents: price,
    notionalCents: notional,
    feeCents: fee,
    feeBreakdown,
    feeModel: plan.feeModel,
    feeConfig: plan.feeConfig,
    feeConfigVersion: plan.feeConfigVersion,
    cashDeltaCents: cashDelta,
    basisCents,
    realizedPnlCents: side === "SELL" ? cashDelta - basisCents : 0,
    cashAfterCents: book.cashCents,
    strategyVersion: plan.strategyVersion,
    tradingPolicyVersion: VERSION,
    orderId: order.id,
    ...(order.manualExitRequestId
      ? { manualExitRequestId: order.manualExitRequestId }
      : {}),
    buyPoint: order.buyPoint ?? null,
    quoteTimestamp: quote.timestamp,
    observationSequence: session.sequence,
    dataQuality: "realtime_poll",
    source: "持久行情帧",
    sourcePriceCents: quote.closeCents,
    executionCost: solved.executionCost.costBreakdown,
    entryEvidence: {
      ...(session.adaptiveRisk?.environment
        ? {
            environment: clone(session.adaptiveRisk.environment),
            initialRiskPerShareCents: Math.max(
              1,
              price -
                (budget?.stopCents ??
                  Math.floor(
                    price * (1 - plan.dragonPolicy.config.advanced.stopLoss),
                  )),
            ),
          }
        : {}),
      intent: order.intent,
      observedAt: session.lastObservedAt,
      quoteTimestamp: quote.timestamp,
      marketTimestamp: session.regime.marketStamp,
      phase: session.regime.phase,
      buyPoint: order.buyPoint ?? null,
      observedPriceCents: quote.closeCents,
      previousCloseCents: quote.previousCloseCents,
      triggerPriceCents: order.triggerPriceCents ?? null,
      stableQuotes: session.entryState.paths[code]?.stableQuotes ?? 0,
      downQuotes: session.entryState.paths[code]?.downQuotes ?? 0,
      stopCents: budget?.stopCents ?? position.dragon?.stopCents ?? null,
      riskBudgetCents: budget?.riskBudgetCents ?? null,
      capCents: budget?.capCents ?? null,
      configId: plan.dragonPolicy.configId,
      ...(session.adaptiveRisk
        ? {
            adaptiveRisk: adaptiveDecision(session, code, position.sector),
          }
        : {}),
    },
    cycleId: position.dragon?.id ?? `${session.date}:${code}`,
  };
  ledger.push(row);
  order.filledQuantity += quantity;
  order.status = order.filledQuantity >= order.quantity ? "FILLED" : "PARTIAL";
  order.reason = "按实际观测、共享容量、费用和风险预算成交";
  trace(session, code, "FILLED", {
    intent: order.intent,
    orderId: order.id,
    buyPoint: order.buyPoint ?? null,
    quantity,
    priceCents: price,
  });
  mark(book);
  return { quantity, price, cashDelta, position, notional, fee };
}
function adaptiveDecision(session, code, sector) {
  const state = session.adaptiveRisk;
  if (!state) return null;
  const e = adaptiveEffective(session.plan.dragonPolicy.config, state, {
    code,
    sector,
  });
  return {
    version: state.version,
    observedAt: state.observedAt,
    marketTimestamp: state.market.observedAt,
    stockTimestamp: state.stocks[code]?.observedAt ?? null,
    effective: e,
    reasons: [
      state.market.reasons,
      state.sectors[sector]?.reasons ?? [],
      state.stocks[code]?.reasons ?? [],
    ],
  };
}
function localRegime(session, code, sector, legacy) {
  if (!isAdaptiveDragon(session.plan)) return legacy;
  const e = adaptiveEffective(
    session.plan.dragonPolicy.config,
    session.adaptiveRisk,
    { code, sector },
  );
  return {
    ...e,
    t: e.tForward || e.tReverse,
    target: null,
    phase: session.regime.phase,
  };
}
function cancelAdaptiveOrders(book, session, observation) {
  if (!isAdaptiveDragon(session.plan)) return;
  const waitForConfirmation =
    session.plan.dragonPolicy.entryOrderPolicy === ENTRY_ORDER_POLICY ||
    observation.entryOrderPolicy === ENTRY_ORDER_POLICY;
  for (const order of session.orders) {
    if (
      terminal.has(order.status) ||
      !["OPEN", "ADD_PROFIT", "ADD_LOSS"].includes(order.intent)
    )
      continue;
    const sector =
      qOf(book, order.code)?.sector ??
      session.plan.entryExecutionPolicy.history[order.code]?.sector;
    if (waitForConfirmation) {
      if (order.expiresAt && clock(session.lastObservedAt) > order.expiresAt) {
        order.status = order.filledQuantity ? "EXPIRED_PARTIAL" : "EXPIRED";
        order.reason = "买点有效窗口结束，取消剩余买入";
        delete order.entryPaused;
        trace(session, order.code, "ORDER_EXPIRED", {
          intent: order.intent,
          buyPoint: order.buyPoint,
        });
        continue;
      }
      const decision = adaptiveEntryOrderDecision(
        session.plan.dragonPolicy.config,
        session.adaptiveRisk,
        {
          code: order.code,
          sector,
          intent: order.intent,
          paused: session.dailyPaused || book.dragonHalted,
          missingHoldingQuotes: session.missingHoldingQuotes,
        },
      );
      if (decision === "WAIT") {
        order.entryPaused = true;
        order.reason = "等待有效行情和风控预热确认，保留剩余买入";
        trace(session, order.code, "ADAPTIVE_WAIT", { intent: order.intent });
        continue;
      }
      delete order.entryPaused;
      if (decision === "CANCEL") {
        order.status = "CANCELLED";
        order.adaptiveCancelled = true;
        order.reason = "已确认风险或操作权限收紧，取消剩余买入";
        trace(session, order.code, "ADAPTIVE_CANCEL", { intent: order.intent });
        continue;
      }
    }
    const e = adaptiveEffective(
      session.plan.dragonPolicy.config,
      session.adaptiveRisk,
      {
        code: order.code,
        sector,
        paused:
          session.dailyPaused ||
          session.missingHoldingQuotes ||
          book.dragonHalted,
      },
    );
    const allowed =
      order.intent === "OPEN"
        ? e.open
        : order.intent === "ADD_PROFIT"
          ? e.profitAdd
          : e.lossAdd;
    if (!allowed) {
      order.status = "CANCELLED";
      order.adaptiveCancelled = true;
      order.reason = "动态预算或操作权限收紧，取消剩余新增风险";
      trace(session, order.code, "ADAPTIVE_CANCEL", {
        intent: order.intent,
        adaptiveRisk: adaptiveDecision(session, order.code, sector),
      });
      continue;
    }
    if (order.maxPriceCents > 0 && order.stopCents > 0) {
      const remaining = Math.max(0, order.quantity - order.filledQuantity);
      const budget = dragonBudget(
        book,
        session,
        order.code,
        order.maxPriceCents,
        order.stopCents,
        order.intent,
        remaining,
        order.id,
      );
      order.quantity =
        order.filledQuantity + Math.min(remaining, budget.quantity);
      if (order.quantity === order.filledQuantity) {
        order.status = "CANCELLED";
        order.adaptiveCancelled = true;
        order.reason = "动态预算不足，取消剩余新增风险";
        trace(session, order.code, "ADAPTIVE_CANCEL", {
          intent: order.intent,
          adaptiveRisk: adaptiveDecision(session, order.code, sector),
        });
      }
    }
  }
}
function dynamicReductionTarget(book, session, p) {
  if (!isAdaptiveDragon(session.plan) || session.missingHoldingQuotes)
    return null;
  const e = adaptiveEffective(
    session.plan.dragonPolicy.config,
    session.adaptiveRisk,
    { code: p.code, sector: p.sector },
  );
  const equity = book.equityCents;
  const gross = book.positions.reduce((n, x) => n + qty(x) * x.markCents, 0);
  const sector = book.positions
    .filter((x) => x.sector === p.sector)
    .reduce((n, x) => n + qty(x) * x.markCents, 0);
  if (hasTCapital(session.plan)) {
    const strategic = strategicExposure(book);
    const coreQuantity = strategicQuantity(p);
    const overlay = qty(p) - coreQuantity;
    const peak = dragonTCapitalLimits(
      session.plan.dragonPolicy.config,
      e.protection,
    );
    let target = qty(p);
    for (const [cap, exposure] of [
      [e.protection.grossWeight, strategic.gross],
      [e.protection.sectorWeight, strategic.sectors[p.sector] ?? 0],
    ])
      if (cap != null && exposure > equity * cap)
        target = Math.min(
          target,
          Math.max(
            0,
            roundLot((coreQuantity * equity * cap) / exposure) + overlay,
          ),
        );
    if (
      e.protection.stockWeight != null &&
      coreQuantity * p.markCents > equity * e.protection.stockWeight
    )
      target = Math.min(
        target,
        Math.max(
          0,
          roundLot((equity * e.protection.stockWeight) / p.markCents) + overlay,
        ),
      );
    for (const [cap, exposure] of [
      [peak.grossWeight, gross],
      [peak.sectorWeight, sector],
      [peak.stockWeight, qty(p) * p.markCents],
    ])
      if (cap != null && exposure > equity * cap)
        target = Math.min(target, roundLot((qty(p) * equity * cap) / exposure));
    return target < qty(p) ? target : null;
  }
  let target = qty(p);
  for (const [cap, exposure] of [
    [e.protection.grossWeight, gross],
    [e.protection.sectorWeight, sector],
  ])
    if (cap != null && exposure > equity * cap)
      target = Math.min(target, roundLot((qty(p) * equity * cap) / exposure));
  if (
    e.protection.stockWeight != null &&
    qty(p) * p.markCents > equity * e.protection.stockWeight
  )
    target = Math.min(
      target,
      roundLot((equity * e.protection.stockWeight) / p.markCents),
    );
  return target < qty(p) ? target : null;
}
function processProtection(book, session, item, ledger, regime) {
  const p = qOf(book, item.quote.code);
  if (!p?.dragon) return false;
  const c = p.dragon,
    price = p.markCents,
    config = session.plan.dragonPolicy.config;
  const manualExit = manualExitFor(session.plan, p);
  if (manualExit) c.exit = true;
  c.highCents = Math.max(c.highCents, price);
  let reason = null,
    target = null,
    dynamicReduction = false;
  const dynamicTarget = dynamicReductionTarget(book, session, p);
  const gross = book.equityCents
    ? (book.equityCents - book.cashCents) / book.equityCents
    : 0;
  if (
    book.dragonHalted ||
    (!isAdaptiveDragon(session.plan) && regime.phase === "freezing") ||
    c.exit ||
    price <= c.stopCents ||
    p.heldDays >= c.holdDays
  ) {
    c.exit = true;
    target = 0;
    reason = manualExit ? manualExit.reason : "熔断、保护位或持有期限要求退出";
  } else if (
    regime.target != null &&
    gross > Math.min(regime.target, config.risk.grossWeight)
  ) {
    target = roundLot(
      (qty(p) * Math.min(regime.target, config.risk.grossWeight)) / gross,
    );
    reason = "市场退潮压缩敞口";
  } else {
    let stage = c.stage;
    if (price >= c.p0Cents + c.r0Cents) stage = Math.max(stage, 1);
    if (price >= c.p0Cents + 2 * c.r0Cents) stage = 2;
    const newStage = stage > c.stage;
    if (newStage) {
      c.baseQuantity ??= c.strategicQuantity;
      c.stage = stage;
      c.targetQuantity = Math.max(
        0,
        c.baseQuantity - roundLot(c.baseQuantity * 0.3) * stage,
      );
      c.stopCents = Math.max(
        c.stopCents,
        Math.ceil(c.strategicCostCents / c.strategicQuantity),
      );
    }
    if (c.stage) c.stopCents = Math.max(c.stopCents, c.highCents - c.r0Cents);
    if (price <= c.stopCents) {
      c.exit = true;
      target = 0;
      reason = "跟踪保护退出";
    } else if (
      c.targetQuantity != null &&
      qty(p) >
        c.targetQuantity +
          (!newStage && c.t?.direction === "FORWARD"
            ? c.t.firstQuantity - c.t.secondQuantity
            : 0)
    ) {
      target = c.targetQuantity;
      reason = "按累计盈利档位减仓";
    }
  }
  // Dynamic limits may tighten an exit, but never bypass the existing profit
  // milestones or the trailing-stop update while a reduction is capacity-bound.
  if (dynamicTarget != null && (target == null || dynamicTarget < target)) {
    target = dynamicTarget;
    dynamicReduction = true;
    reason = "市场、板块或个股动态敞口收紧";
  }
  if (target == null) return false;
  if (c.t) recordT(book, p, "ABORTED_BY_RISK", session.date);
  if (!dynamicReduction)
    c.targetQuantity = Math.min(c.targetQuantity ?? Infinity, target);
  for (const o of session.orders.filter(
    (o) => o.code === p.code && o.side === "BUY" && !terminal.has(o.status),
  ))
    o.status = "CANCELLED";
  const desired = Math.max(
      0,
      qty(p) - (dynamicReduction ? target : c.targetQuantity),
    ),
    action = target === 0 ? "EXIT" : "REDUCE";
  if (desired > 0) {
    trace(session, p.code, "PROTECTIVE_EXIT", {
      intent: action,
      desired,
      stopCents: c.stopCents,
      stage: c.stage,
      ...(dynamicReduction
        ? { adaptiveRisk: adaptiveDecision(session, p.code, p.sector) }
        : {}),
    });
    const order = addOrder(session, p.code, action, reason);
    if (manualExit) order.manualExitRequestId = manualExit.id;
    order.quantity = order.filledQuantity + desired;
    fill(book, session, item, order, "SELL", desired, ledger);
  }
  return true;
}
function processT(book, session, item, ledger, regime, recoveringOnly = false) {
  const p = qOf(book, item.quote.code);
  if (!p?.dragon || p.dragon.exit) return;
  const c = p.dragon,
    conf = session.plan.dragonPolicy.config,
    time = clock(session.lastObservedAt),
    price = item.quote.closeCents;
  let t = c.t;
  if (
    !t &&
    !recoveringOnly &&
    regime.t &&
    !session.dailyPaused &&
    !book.dragonHalted &&
    !(book.dragonCooldownDays > 0) &&
    c.dayAction !== session.date &&
    c.startDate < session.date &&
    time >= "09:35:00" &&
    time < "14:45:00"
  ) {
    const path = session.entryState.paths[p.code],
      reference = item.quote.previousCloseCents;
    const direction =
      conf.operations.tForward &&
      regime.tForward !== false &&
      price <= reference * 0.98 &&
      path?.stableQuotes >= 1
        ? "FORWARD"
        : conf.operations.tReverse &&
            regime.tReverse !== false &&
            price >= reference * 1.02 &&
            (path?.downQuotes ?? 0) >= 1
          ? "REVERSE"
          : null;
    const quantity = roundLot(
      availableQuantity(p, session.date) * conf.advanced.tFraction,
    );
    if (!direction || quantity < 100) return;
    const expected = quantity * price * conf.advanced.tSpread;
    if (
      expected <=
      transactionFees(
        quantity * price,
        "BUY",
        session.plan.feeConfig,
        session.plan.feeModel,
      ).total +
        transactionFees(
          quantity * price,
          "SELL",
          session.plan.feeConfig,
          session.plan.feeModel,
        ).total +
        quantity * price * 0.006
    )
      return;
    let budget;
    if (direction === "REVERSE") {
      const reduced = clone(book),
        simulated = qOf(reduced, p.code);
      let remaining = quantity;
      for (const l of simulated.lots) {
        if (l.acquiredDate >= session.date) continue;
        const n = Math.min(remaining, l.quantity);
        l.quantity -= n;
        remaining -= n;
      }
      reduced.cashCents += quantity * price;
      budget = dragonBudget(
        reduced,
        session,
        p.code,
        Math.ceil(price * 1.03),
        c.stopCents,
        "T_RECOVERY",
        quantity,
      );
    } else
      budget = dragonBudget(
        book,
        session,
        p.code,
        Math.ceil(price * 1.03),
        c.stopCents,
        "T_FIRST",
        quantity,
      );
    if (budget.quantity < 100) return;
    const desired = Math.min(quantity, budget.quantity);
    const order = addOrder(session, p.code, `T_${direction}`, "做 T 第一腿", {
      side: "PAIR",
      quantity: desired,
    });
    order.maxPriceCents = Math.ceil(price * 1.03);
    const result = fill(
      book,
      session,
      item,
      order,
      direction === "FORWARD" ? "BUY" : "SELL",
      desired,
      ledger,
      budget,
    );
    if (!result) return;
    c.dayAction = session.date;
    t = c.t = {
      id: order.id,
      direction,
      date: session.date,
      firstQuantity: result.quantity,
      secondQuantity: 0,
      firstNotional: result.notional,
      firstPriceCents: result.price,
      cashDeltaCents: result.cashDelta,
      reservePriceCents: Math.ceil(result.price * 1.03),
      lastQuote: item.quote.timestamp,
      spread: conf.advanced.tSpread,
    };
    order.status = "FIRST_LEG";
    order.quantity = result.quantity;
    order.firstFilled = result.quantity;
    return;
  }
  if (!t || Date.parse(item.quote.timestamp) <= Date.parse(t.lastQuote)) return;
  const secondBuy = t.direction === "REVERSE";
  const trigger = secondBuy
    ? price <= t.firstPriceCents * (1 - t.spread)
    : price >= t.firstPriceCents * (1 + t.spread);
  if (!trigger && time < "14:50:00") return;
  const remaining = t.firstQuantity - t.secondQuantity;
  const order = addOrder(session, p.code, "T_RECOVERY", "完成做 T 第二腿", {
    side: secondBuy ? "BUY" : "SELL",
    quantity: remaining,
  });
  order.quantity = order.filledQuantity + remaining;
  order.maxPriceCents = t.reservePriceCents;
  const budget = secondBuy
    ? dragonBudget(
        book,
        session,
        p.code,
        t.reservePriceCents,
        c.stopCents,
        "T_RECOVERY",
        remaining,
      )
    : null;
  const result = fill(
    book,
    session,
    item,
    order,
    secondBuy ? "BUY" : "SELL",
    secondBuy ? budget.quantity : remaining,
    ledger,
    budget,
  );
  if (!result) return;
  c.dayAction = session.date;
  t.secondQuantity += result.quantity;
  t.cashDeltaCents += result.cashDelta;
  t.lastQuote = item.quote.timestamp;
  const firstOrder = session.orders.find((o) => o.id === t.id);
  if (firstOrder) {
    firstOrder.secondFilled = t.secondQuantity;
    firstOrder.status = "SECOND_LEG";
  }
  if (t.secondQuantity === t.firstQuantity) {
    recordT(book, p, "COMPLETED", session.date);
    const first = session.orders.find((o) => o.id === t.id);
    if (first) first.status = "FILLED";
  }
}
function processEntry(book, session, item, observation, ledger, regime) {
  const code = item.quote.code,
    h = session.plan.entryExecutionPolicy.history[code],
    conf = session.plan.dragonPolicy.config;
  const p = qOf(book, code),
    c = p?.dragon,
    path = session.entryState.paths[code];
  if (session.plan.manualExitRequests?.some((row) => row.code === code)) {
    trace(session, code, "MANUAL_EXIT", { intent: "EXIT" });
    return;
  }
  if (
    !eligible(
      h,
      observation.entryInputs?.market?.discoveries?.find(
        (s) => s.code === code,
      ),
    ) ||
    !path
  ) {
    trace(session, code, "INELIGIBLE");
    return;
  }
  const sector = observation.entryInputs?.market?.sectors?.find(
    (s) => s.name === h.sector,
  );
  const entryBlock = !Number.isFinite(sector?.score)
    ? "SECTOR_MISSING"
    : sector.score < DRAGON_RULES.sectorMinimum
      ? "SECTOR_WEAK"
      : !regime.open
        ? session.regime.phase === "unknown"
          ? "MARKET_UNKNOWN"
          : "MARKET_RESTRICTED"
        : session.dailyPaused
          ? "DAILY_PAUSED"
          : book.dragonHalted
            ? "DRAWDOWN_HALTED"
            : path.stableQuotes < 1 || !(item.volume > 0)
              ? "WAITING_CONFIRMATION"
              : h.previousVolumeShares > 0 &&
                  item.quote.volumeShares > h.previousVolumeShares * 3
                ? "VOLUME_ABNORMAL"
                : null;
  if (entryBlock) {
    trace(session, code, entryBlock, { sectorScore: sector?.score ?? null });
    return;
  }
  const time = clock(observation.observedAt);
  const types = typesAt(
    session.plan.entryExecutionPolicy,
    h,
    item.quote,
    path,
    time,
    observation.entryInputs?.auction?.[code],
    session.date,
  ).filter((type) => conf.buyPoints[type]);
  const pending = session.orders.find(
    (o) =>
      o.code === code &&
      ["OPEN", "ADD_PROFIT", "ADD_LOSS"].includes(o.intent) &&
      o.filledQuantity > 0 &&
      o.filledQuantity < o.quantity &&
      !terminal.has(o.status),
  );
  if (
    !types.length ||
    c?.exit ||
    c?.t ||
    c?.stage ||
    (c?.startDate === session.date && !pending)
  ) {
    trace(session, code, !types.length ? "NO_BUY_POINT" : "POSITION_PROTECTED");
    return;
  }
  let intent = "OPEN",
    maxQuantity = Infinity;
  if (pending) {
    intent = pending.intent;
    maxQuantity = pending.quantity - pending.filledQuantity;
  } else if (c) {
    const r = (item.quote.closeCents - c.p0Cents) / c.r0Cents;
    if (
      regime.profitAdd &&
      conf.operations.profitAdd &&
      r >= 0.5 &&
      r < 1 &&
      !c.profitAdded
    ) {
      intent = "ADD_PROFIT";
      maxQuantity = roundLot(c.initialQuantity * 0.5);
    } else if (
      regime.lossAdd &&
      conf.operations.lossAdd &&
      r >= -0.75 &&
      r <= -0.5 &&
      !c.lossAdded &&
      types[0] !== "limit-up-momentum"
    ) {
      intent = "ADD_LOSS";
      maxQuantity = roundLot(c.initialQuantity * 0.25);
    } else {
      trace(session, code, "NO_ADD_SIGNAL");
      return;
    }
  }
  let order = session.orders.findLast(
    (o) => o.code === code && o.intent === intent,
  );
  if (order?.entryPaused) return;
  if (order?.adaptiveCancelled && !order.filledQuantity) order = null;
  if (c?.dayAction === session.date && (!order || terminal.has(order.status))) {
    trace(session, code, "DAILY_ACTION_LIMIT", { intent });
    return;
  }
  if (order && terminal.has(order.status)) return;
  const triggerPrice = order?.triggerPriceCents ?? item.quote.closeCents;
  const maxPrice = Math.floor(triggerPrice * (1 + DRAGON_RULES.maxChase));
  const stop =
    c?.stopCents ?? Math.floor(triggerPrice * (1 - conf.advanced.stopLoss));
  const budget = dragonBudget(
    book,
    session,
    code,
    maxPrice,
    stop,
    intent,
    maxQuantity,
    order?.id,
  );
  trace(session, code, "BUY_POINT_TRIGGERED", {
    intent,
    buyPoint: types[0],
    triggerPriceCents: triggerPrice,
  });
  if (budget.quantity < 100)
    trace(session, code, budget.reasonCode ?? "RISK_BUDGET", {
      intent,
      buyPoint: types[0],
      riskBudgetCents: budget.riskBudgetCents ?? 0,
      capCents: budget.capCents ?? 0,
    });
  if (!order) {
    order = addOrder(session, code, intent, budget.reason, {
      quantity: budget.quantity,
      triggerPriceCents: triggerPrice,
      maxPriceCents: maxPrice,
      stopCents: stop,
      buyPoint: types[0],
      expiresAt: INTRADAY_ENTRY_RULES.windows[types[0]].find(
        ([a, b]) => time >= a && time <= b,
      )?.[1],
    });
  }
  if (time > order.expiresAt) {
    order.status = order.filledQuantity ? "EXPIRED_PARTIAL" : "EXPIRED";
    trace(session, code, "ORDER_EXPIRED", { intent, buyPoint: order.buyPoint });
    return;
  }
  if (order.quantity < 100 && !order.filledQuantity)
    order.quantity = budget.quantity;
  const result = fill(
    book,
    session,
    item,
    order,
    "BUY",
    Math.min(budget.quantity, order.quantity - order.filledQuantity),
    ledger,
    budget,
  );
  if (!result) return;
  const position = result.position;
  if (!position.dragon)
    position.dragon = {
      id: `${session.date}:${code}`,
      startDate: session.date,
      p0Cents: result.price + Math.ceil(result.fee / result.quantity),
      r0Cents: Math.max(
        1,
        Math.ceil(
          (result.price + result.fee / result.quantity) *
            conf.advanced.stopLoss,
        ),
      ),
      stopCents: Math.floor(
        (result.price + result.fee / result.quantity) *
          (1 - conf.advanced.stopLoss),
      ),
      initialQuantity: 0,
      strategicQuantity: 0,
      strategicCostCents: 0,
      stage: 0,
      highCents: result.price,
      holdDays: DRAGON_HOLD_DAYS[order.buyPoint],
      buyPoint: order.buyPoint,
      dayAction: session.date,
    };
  const state = position.dragon;
  if (intent === "OPEN") {
    state.initialQuantity += result.quantity;
    state.p0Cents = Math.ceil(
      (state.strategicCostCents + result.notional + result.fee) /
        (state.strategicQuantity + result.quantity),
    );
    state.r0Cents = Math.ceil(state.p0Cents * conf.advanced.stopLoss);
    state.stopCents = Math.max(
      state.stopCents,
      Math.floor(state.p0Cents * (1 - conf.advanced.stopLoss)),
    );
  } else state[intent === "ADD_PROFIT" ? "profitAdded" : "lossAdded"] = true;
  state.strategicQuantity += result.quantity;
  state.strategicCostCents += result.notional + result.fee;
  state.dayAction = session.date;
}
export function advanceDragonSession(inputBook, inputSession, observation) {
  if (
    observation.entryOrderPolicy &&
    observation.entryOrderPolicy !== ENTRY_ORDER_POLICY
  )
    throw new Error("不支持的盘中订单恢复政策");
  assertDragonPlan(inputSession.plan, inputBook);
  if (!isDragon(inputBook) || !isDragon(inputSession))
    throw new Error("新旧会话政策不能混用");
  const { practice, ...sessionCore } = inputSession;
  const book = clone(inputBook),
    session = {
      ...clone(sessionCore),
      ...(practice
        ? { practice: { ...practice, decisions: { ...practice.decisions } } }
        : {}),
    },
    ledger = [];
  if (session.status !== "OPEN") return { book, session, ledger };
  const now = Date.parse(observation.observedAt),
    time = clock(observation.observedAt);
  if (
    !Number.isFinite(now) ||
    new Date(now + 8 * 3600000).toISOString().slice(0, 10) !== session.date ||
    !(
      (time >= "09:30:00" && time <= "11:30:00") ||
      (time >= "13:00:00" && time < "14:57:00")
    )
  )
    throw new Error("不在本交易日连续竞价时段");
  if (session.lastObservedAt && now <= Date.parse(session.lastObservedAt))
    return { book, session, ledger };
  session.sequence++;
  session.lastObservedAt = observation.observedAt;
  if (!session.practice)
    session.practice = {
      version: 1,
      startedSequence: session.sequence - 1,
      decisions: {},
    };
  for (const o of session.orders)
    if (o.expiresAt && time > o.expiresAt && !terminal.has(o.status))
      o.status = o.filledQuantity ? "EXPIRED_PARTIAL" : "EXPIRED";
  const rule = isAdaptiveDragon(session.plan)
    ? null
    : marketState(session, observation);
  let regime = rule ? { ...rule, phase: session.regime.phase } : null;
  const history = session.plan.entryExecutionPolicy.history;
  for (const row of observation.entryInputs?.market?.discoveries ?? []) {
    if (
      Object.keys(session.entryState.admissions).length >=
      INTRADAY_ENTRY_RULES.maxCandidates
    )
      break;
    if (
      eligible(history[row.code], row) &&
      !session.entryState.admissions[row.code]
    ) {
      session.entryState.admissions[row.code] = {
        code: row.code,
        source: "INTRADAY_POOL",
        admittedAt: observation.observedAt,
      };
      trace(session, row.code, "ADMITTED");
    }
  }
  for (const code of new Set([
    ...Object.keys(session.entryState.admissions),
    ...book.positions.map((p) => p.code),
  ]))
    if (!observation.quotes?.[code]) trace(session, code, "QUOTE_MISSING");
  const accepted = [];
  for (const [code, raw] of Object.entries(observation.quotes ?? {})) {
    if (
      !/^\d{6}$/.test(code) ||
      (!session.entryState.admissions[code] && !qOf(book, code))
    ) {
      continue;
    }
    const quote = { ...raw, code },
      last = session.quotes[code];
    if (
      quote.date !== session.date ||
      !fresh(quote.timestamp, now, 15000) ||
      !(quote.closeCents > 0) ||
      !Number.isFinite(quote.volumeShares) ||
      quote.volumeShares < 0 ||
      (last && Date.parse(quote.timestamp) <= Date.parse(last.timestamp))
    ) {
      trace(
        session,
        code,
        last && Date.parse(quote.timestamp) <= Date.parse(last.timestamp)
          ? "QUOTE_REPEATED"
          : "QUOTE_INVALID",
        { quoteTimestamp: quote.timestamp ?? null },
      );
      continue;
    }
    const expected =
      session.initialBook.positions.find((p) => p.code === code)?.markCents ??
      history[code]?.previousCloseCents;
    if (
      !expected ||
      Math.abs(quote.previousCloseCents - expected) >
        Math.max(1, expected * 0.001)
    ) {
      trace(session, code, "PREVIOUS_CLOSE_MISMATCH");
      continue;
    }
    const contiguous =
      last && Date.parse(quote.timestamp) - Date.parse(last.timestamp) <= 20000;
    const volume =
      contiguous && quote.volumeShares >= last.volumeShares
        ? quote.volumeShares - last.volumeShares
        : 0;
    session.entryState.admissions[code] ??= { code };
    updateEntryPath(session, code, quote, last, volume, observation.observedAt);
    const path = session.entryState.paths[code];
    path.downQuotes =
      contiguous && volume > 0 && quote.closeCents <= last.closeCents
        ? (path.downQuotes ?? 0) + 1
        : 0;
    session.quotes[code] = quote;
    const position = qOf(book, code);
    if (position) {
      position.markCents = quote.closeCents;
      position.markDate = session.date;
    }
    accepted.push({ quote, volume });
  }
  mark(book);
  observePracticeRisk(session, book);
  session.missingHoldingQuotes = book.positions.some(
    (p) => !fresh(session.quotes[p.code]?.timestamp, now, 15000),
  );
  if (isAdaptiveDragon(session.plan)) {
    const runtimePolicy =
      observation.adaptiveRiskPolicy ??
      session.plan.dragonPolicy.adaptiveRiskPolicy;
    if (!validAdaptiveRiskPolicy(runtimePolicy))
      throw new Error("盘中动态风控政策与版本不一致");
    if (
      session.adaptiveRisk?.version !== runtimePolicy.version &&
      observation.adaptiveRiskPolicy &&
      session.adaptiveRisk?.version ===
        session.plan.dragonPolicy.adaptiveRiskPolicy.version
    )
      session.adaptiveRisk.version = runtimePolicy.version;
    if (session.adaptiveRisk?.version !== runtimePolicy.version)
      throw new Error("动态感知会话缺少冻结版本，禁止回退四档规则");
    advanceAdaptiveRisk(session.adaptiveRisk, {
      observedAt: observation.observedAt,
      market: observation.entryInputs?.market,
      environmentCohort: session.plan.dragonPolicy.environmentCohort,
      environmentQuotes: observation.quotes,
      quotes: Object.fromEntries(
        accepted.map((item) => [item.quote.code, item.quote]),
      ),
      sectors: Object.fromEntries(
        [
          ...Object.keys(session.entryState.admissions),
          ...book.positions.map((p) => p.code),
        ].map((code) => [
          code,
          qOf(book, code)?.sector ?? history[code]?.sector,
        ]),
      ),
      stopLoss: session.plan.dragonPolicy.config.advanced.stopLoss,
    });
    session.regime.phase = session.adaptiveRisk.market.valid
      ? (session.adaptiveRisk.market.phase ?? "unknown")
      : "unknown";
    session.regime.marketStamp = session.adaptiveRisk.market.observedAt;
    regime = localRegime(session);
  }
  if (isEnvironmentPolicy(session.plan.dragonPolicy.adaptiveRiskPolicy)) {
    session.environmentOpportunities = { ...session.environmentOpportunities };
    for (const { quote } of accepted) {
      const code = quote.code,
        h = history[code],
        path = session.entryState.paths[code];
      if (!h || !path || qOf(book, code)) continue;
      for (const type of typesAt(
        session.plan.entryExecutionPolicy,
        h,
        quote,
        path,
        time,
        observation.entryInputs?.auction?.[code],
        session.date,
      )) {
        const key = `${code}:${type}`;
        session.environmentOpportunities[key] ??= {
          code,
          buyPoint: type,
          sequence: session.sequence,
          observedAt: session.lastObservedAt,
          environment: clone(session.adaptiveRisk.environment),
          enabled: session.plan.dragonPolicy.config.buyPoints[type] === true,
        };
      }
    }
  }
  const risk = session.plan.dragonPolicy.config.risk;
  if (1 - book.equityCents / session.initialBook.equityCents >= risk.dailyLoss)
    session.dailyPaused = true;
  if (
    1 - book.equityCents / (book.dragonRiskPeakCents ?? book.peakEquityCents) >=
    risk.drawdown
  )
    book.dragonHalted = true;
  cancelAdaptiveOrders(book, session, observation);
  const blocked = new Set();
  for (const item of accepted)
    if (processProtection(book, session, item, ledger, regime))
      blocked.add(item.quote.code);
  for (const item of accepted)
    if (!blocked.has(item.quote.code))
      processT(
        book,
        session,
        item,
        ledger,
        localRegime(
          session,
          item.quote.code,
          qOf(book, item.quote.code)?.sector,
          regime,
        ),
        true,
      );
  const rank = (item) => {
    const code = item.quote.code,
      h = history[code],
      path = session.entryState.paths[code];
    return h && path
      ? INTRADAY_ENTRY_RULES.priority.indexOf(
          typesAt(
            session.plan.entryExecutionPolicy,
            h,
            item.quote,
            path,
            time,
            observation.entryInputs?.auction?.[code],
            session.date,
          )[0],
        )
      : 99;
  };
  accepted.sort(
    (a, b) =>
      (rank(a) < 0 ? 99 : rank(a)) - (rank(b) < 0 ? 99 : rank(b)) ||
      (history[b.quote.code]?.amount ?? 0) -
        (history[a.quote.code]?.amount ?? 0) ||
      a.quote.code.localeCompare(b.quote.code),
  );
  for (const item of accepted)
    if (!blocked.has(item.quote.code))
      processEntry(
        book,
        session,
        item,
        observation,
        ledger,
        localRegime(
          session,
          item.quote.code,
          history[item.quote.code]?.sector,
          regime,
        ),
      );
  for (const item of accepted)
    if (!blocked.has(item.quote.code))
      processT(
        book,
        session,
        item,
        ledger,
        localRegime(
          session,
          item.quote.code,
          qOf(book, item.quote.code)?.sector,
          regime,
        ),
      );
  mark(book);
  observePracticeRisk(session, book);
  return { book, session, ledger };
}
export function closeDragonSession(inputBook, inputSession, dataset) {
  assertDragonPlan(inputSession.plan, inputBook);
  const book = clone(inputBook),
    session = clone(inputSession),
    notices = [];
  if (session.status !== "OPEN" || dataset.date !== session.date)
    throw new Error("新政策交易日状态无效");
  for (const p of book.positions) {
    const quote = dataset.quotes[p.code],
      old = session.initialBook.positions.find((x) => x.code === p.code);
    if (
      !quote ||
      quote.date !== session.date ||
      !(quote.closeCents > 0) ||
      !Number.isFinite(Date.parse(quote.timestamp)) ||
      clock(quote.timestamp) < "15:00:00"
    )
      throw new Error(`${p.code} 缺少最终收盘价`);
    if (
      old &&
      Math.abs(quote.previousCloseCents - old.markCents) >
        Math.max(1, old.markCents * 0.001)
    )
      throw new Error("昨收与账面价格不一致");
    p.markCents = quote.closeCents;
    p.markDate = session.date;
    p.heldDays++;
    if (quote.closingSource === "FRAME_LAST_OBSERVED")
      notices.push(`${p.code} 缺少最终收盘报价`);
  }
  mark(book);
  book.pendingRecovery = book.positions
    .filter((p) => p.dragon?.t)
    .map((p) => ({
      code: p.code,
      quantity: p.dragon.t.firstQuantity - p.dragon.t.secondQuantity,
      side: p.dragon.t.direction === "FORWARD" ? "SELL" : "BUY",
      tradingPolicyVersion: VERSION,
    }));
  book.pendingExits = book.positions
    .filter((p) => p.dragon?.exit)
    .map((p) => ({ code: p.code }));
  book.pendingOrders = [];
  if (session.cooldownAtStart > 0 && book.dragonCooldownDate !== session.date)
    book.dragonCooldownDays = Math.max(0, session.cooldownAtStart - 1);
  book.lastDate = session.date;
  book.settlementCount++;
  session.status = "CLOSED";
  session.closingBook = clone(book);
  for (const o of session.orders)
    if (
      ["OPEN", "ADD_PROFIT", "ADD_LOSS"].includes(o.intent) &&
      !terminal.has(o.status)
    )
      o.status = o.filledQuantity ? "EXPIRED_PARTIAL" : "EXPIRED";
  const marketValueCents = book.equityCents - book.cashCents;
  const unrealizedPnlCents = book.positions.reduce(
    (s, p) => s + qty(p) * p.markCents - costBasis(p),
    0,
  );
  if (
    book.equityCents - book.initialCashCents !==
      book.realizedPnlCents + unrealizedPnlCents ||
    book.cashCents < 0
  )
    throw new Error("新政策账本不守恒");
  return {
    book,
    session,
    ledger: [],
    outcomes: session.orders,
    notices,
    equity: {
      date: session.date,
      cashCents: book.cashCents,
      marketValueCents,
      equityCents: book.equityCents,
      dailyPnlCents: book.equityCents - session.initialBook.equityCents,
      dailyReturn: book.equityCents / session.initialBook.equityCents - 1,
      totalReturn: book.equityCents / book.initialCashCents - 1,
      realizedPnlCents: book.realizedPnlCents,
      unrealizedPnlCents,
      feesCents: book.feesCents,
      drawdown: 1 - book.equityCents / book.peakEquityCents,
      maxObservedDrawdown: Math.max(
        session.practice?.maxDrawdown ?? 0,
        1 - book.equityCents / book.peakEquityCents,
      ),
      maxObservedDailyLoss: session.practice?.maxDailyLoss ?? null,
      complete: !notices.length,
      positionCount: book.positions.length,
      source: dataset.source,
    },
  };
}
