import { clamp, PRESETS } from "../../shared/scoring.js";
import {
  CLASS_WEIGHT_PRESETS,
  STOCK_CLASSES,
} from "../../shared/stock-class.js";
import {
  DEFAULT_INITIAL_CAPITAL,
  DEFAULT_FEES,
  LEGACY_FEES,
  normalizeFees,
  feesForBook,
} from "../../shared/fees.js";
import {
  EXECUTION_COST_MODEL,
  defaultExecutionCostPolicy,
} from "../../shared/execution-cost.js";
import {
  DEFAULT_RISK_LIMITS,
  normalizeRiskLimits,
  riskLimitsForBook,
  planRiskLimits,
} from "../../shared/risk-limits.js";
import {
  STRATEGY_DEFAULTS,
  PYRAMID_MILESTONES,
} from "../../shared/strategy-params.js";
import {
  CLASS_MANAGEMENT,
  DOWNGRADE_CHAIN,
  DOWNGRADE_RULES_VERSION,
  downgradeEnabledForSnapshot,
  downgradeEnabledForPlan,
  detectDowngradeForPosition,
} from "../../shared/downgrade.js";
import { checkExitSignals } from "../../shared/exit-signals.js";
import { BUY_POINT_TYPES } from "../../shared/buy-point-type.js";
import {
  T_QUALITY_RULES_VERSION,
  summarizeTQuality,
  tQualityEnabledForSnapshot,
  tQualityEnabledForPlan,
} from "./t-quality.js";
import {
  classifySentimentCycle,
  resolveExposureCap,
  CYCLE_PHASES,
} from "../../shared/sentiment-cycle.js";
import {
  resolveStrategyProgram,
  familyEligibility,
  allocationState,
  allocateEntry,
  chargeEntry,
  assertProgramPlan,
  fillAllocations,
  recordAllocationFees,
  remainingEntryAllocations,
} from "./strategy-program.js";
import { buildExecutionContext, solveFillQuantity } from "./execution-cost.js";
import { canonicalJson } from "./research-lineage.js";
import {
  DEFAULT_SELECTION_VERSION,
  LEGACY_SELECTION_VERSION,
  SELECTION_VERSION_V5,
  buyPointGateForPolicy,
  selectionPolicy,
  selectionPolicyForBook,
  selectionPolicyFields,
  frozenSelectionPolicy,
  liquidityAmountCents,
  rankSignals,
  annotateObservationGrades,
  OBSERVATION_GRADE_RULES_VERSION,
} from "./signal-selection.js";

export const ACTIONS = Object.freeze({
  OPEN: "建仓",
  ADD: "加仓",
  REDUCE: "减仓",
  EXIT: "清仓",
  T_FORWARD: "正向 T",
  T_REVERSE: "反向 T",
  HOLD: "持有",
});
export const BASE_STRATEGY = Object.freeze({ ...STRATEGY_DEFAULTS });
// 兼容别名：旧执行器与既有引用仍使用默认风控；账户级自定义值
// 通过 book.riskLimits / plan.riskLimits 传递（shared/risk-limits.js）。
export const RISK_LIMITS = DEFAULT_RISK_LIMITS;
export const toCents = (value) => Math.round(Number(value) * 100);
export const roundLot = (quantity) =>
  Math.floor(Math.max(0, quantity) / 100) * 100;
export const totalQuantity = (position) =>
  position.lots.reduce((sum, lot) => sum + lot.quantity, 0);
export const availableQuantity = (position, date) =>
  position.lots
    .filter((lot) => lot.acquiredDate < date)
    .reduce((sum, lot) => sum + lot.quantity, 0);
export const costBasis = (position) =>
  position.lots.reduce((sum, lot) => sum + lot.costCents, 0);

export function newBook(
  initialCapital = DEFAULT_INITIAL_CAPITAL,
  feeConfig = DEFAULT_FEES,
) {
  if (
    !Number.isFinite(initialCapital) ||
    initialCapital < 10000 ||
    initialCapital > 100000000
  ) {
    throw new Error("初始资金必须在 1 万至 1 亿元之间");
  }
  const initialCashCents = toCents(initialCapital);
  return {
    initialCashCents,
    cashCents: initialCashCents,
    realizedPnlCents: 0,
    feesCents: 0,
    positions: [],
    lastDate: null,
    equityCents: initialCashCents,
    peakEquityCents: initialCashCents,
    activeStrategy: "baseline-v1",
    settlementCount: 0,
    feeModel: "itemized-v2",
    feeConfig: normalizeFees(feeConfig),
    feeConfigVersion: 1,
    riskLimits: normalizeRiskLimits(DEFAULT_RISK_LIMITS),
    riskLimitsVersion: 1,
    selectionPolicyVersion: DEFAULT_SELECTION_VERSION,
  };
}

export function transactionFees(
  notionalCents,
  side,
  config = DEFAULT_FEES,
  model = "itemized-v2",
) {
  const commission = Math.max(
    Math.round(config.commission_min * 100),
    Math.round(notionalCents * config.commission_rate),
  );
  const transfer = Math.round(notionalCents * config.transfer_fee);
  const stamp =
    side === "SELL" ? Math.round(notionalCents * config.stamp_tax) : 0;
  if (model === "legacy-v1")
    return {
      commission,
      transfer,
      stamp,
      total: commission + transfer + stamp,
    };
  const handling = Math.round(notionalCents * config.handling_fee);
  const regulatory = Math.round(notionalCents * config.regulatory_fee);
  return {
    commission,
    transfer,
    stamp,
    handling,
    regulatory,
    total: commission + transfer + stamp + handling + regulatory,
  };
}

export function scoreSignals(snapshot, strategy, policy = selectionPolicy()) {
  const legacy = policy.version === LEGACY_SELECTION_VERSION;
  // v3 股票分类路由（方案 3）：按类别改用对应权重预设。注意：平庸股
  // 必须保留在信号列表里（按策略权重评分）——持仓股依赖当日信号触发
  // 减仓/止损等风险动作，在这里剔除会让持仓回退旧评分做出错误动作。
  // 平庸股的"不进入候选池"由 createPlan 的新增买入阶段执行。
  const routing = policy.stockClassRouting === true;
  const weightsFor = (stock) => {
    if (!routing || !stock.stockClass) return strategy.weights;
    const preset = CLASS_WEIGHT_PRESETS[stock.stockClass];
    return preset ? PRESETS[preset] : strategy.weights;
  };
  const sectorScores = new Map(
    snapshot.sectors.map((sector) => [sector.name, sector.score]),
  );
  // v4：炸板池候选并入信号（方案 9）。候选行与涨停池行共用 analyze 内同一
  // 套 enrichRow + analyzeStock，评分/分类/买点口径一致，唯一差别是 isLimitUp
  // 判定来源与 candidateSource 溯源标记。口径隔离只发生在打分之前：炸板行
  // 不进入 sectorAnalysis / promotion / emotion 的输入，这里只是把它们作为
  // 候选补充进来。旧版本不并入，信号形状与排序逐字节不变；旧快照无
  // brokenStocks 字段时 ?? [] 兜底，同样不变。
  // v5：EOD 候选源（首阴低吸 / 假阴跌停低吸）并入信号，候选行从日线
  // parquet 构造，评分因子结构性缺失，门控按买点资格豁免覆盖/评分检查。
  const candidateRows = [
    ...snapshot.stocks,
    ...(policy.brokenCandidateSource === true
      ? (snapshot.brokenStocks ?? [])
      : []),
    ...(policy.extraCandidateSource === true
      ? (snapshot.extraStocks ?? [])
      : []),
  ];
  const signals = candidateRows.map((stock) => {
    const weights = weightsFor(stock);
    let weight = 0,
      weighted = 0;
    stock.factors.forEach((factor, index) => {
      if (legacy ? factor.value === null : !Number.isFinite(factor.value))
        return;
      const factorWeight =
        weights[
          policy.version === LEGACY_SELECTION_VERSION
            ? stock.factors.indexOf(factor)
            : index
        ];
      weight += factorWeight;
      weighted += factor.value * factorWeight;
    });
    const raw = weight ? clamp(weighted / weight - stock.deduction) : null;
    const scoreValue = Number.isFinite(raw) ? raw : null;
    return {
      ...stock,
      originalScore: stock.score,
      score: legacy
        ? weight
          ? Math.round(raw)
          : null
        : scoreValue === null
          ? null
          : Math.round(scoreValue),
      scoreValue,
      scoreRankKey:
        scoreValue === null ? null : Math.round(scoreValue * 1_000_000),
      liquidityAmountCents: liquidityAmountCents(stock.amount),
      sectorScore: sectorScores.get(stock.sector) ?? null,
    };
  });
  return annotateObservationGrades(rankSignals(signals, policy));
}

// 卖出上下文序列化：Map → 纯对象（JSON.stringify 安全）。无任何上下文
// 时返回 null；phaseShift 仅在有板块/个股上下文时才写 true（否则重算
// 会把无上下文的普通计划误判为退潮期）。特征/EOD 行/炸板记录只保留
// 决策实际读取的持仓代码（检测器仅按持仓查找），避免把全市场日线
// 特征塞进计划 payload。
function freezeExitContext({
  exitFeaturesByCode,
  exitEodRowsByCode,
  exitBreaksByCode,
  sectorLimitDrops,
  phaseShift,
  codes,
}) {
  const pick = (map) => {
    if (!map?.size) return null;
    const entries = [...map.entries()].filter(([code]) =>
      codes ? codes.has(code) : true,
    );
    return entries.length ? Object.fromEntries(entries) : null;
  };
  const features = pick(exitFeaturesByCode);
  const eodRows = pick(exitEodRowsByCode);
  const breaks = pick(exitBreaksByCode);
  const sectorDrops = sectorLimitDrops?.size
    ? [...sectorLimitDrops.keys()].sort()
    : null;
  if (!features && !eodRows && !breaks && !sectorDrops && !phaseShift)
    return null;
  return {
    ...(features ? { features } : {}),
    ...(eodRows ? { eodRows } : {}),
    ...(breaks ? { breaks } : {}),
    ...(sectorDrops ? { sectorDrops } : {}),
    ...(phaseShift ? { phaseShift: true } : {}),
  };
}

// 方案 4：金字塔减仓的下一档。position.pyramidStage 记录已执行的最高
// 档（成交时在 consumeLots 推进）；零比例档透明跳过（不产生减仓也不
// 阻断后续档位）；里程碑按序触达——价格跳空越过中间档时仍按最低未执
// 行档先减（skill 的依次减仓语义）。pyramidReduce 非数组（旧版本计划）
// 返回 null，调用方保持旧语义。
function nextPyramidRung(position, pnl, pyramidReduce) {
  if (!Array.isArray(pyramidReduce)) return null;
  const stage = position.pyramidStage ?? 0;
  for (let k = stage; k < PYRAMID_MILESTONES.length; k++) {
    const ratio = pyramidReduce[k];
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const milestone = PYRAMID_MILESTONES[k];
    // 1e-9 容差：盈亏比恰落在里程碑（如 +20%）时不受浮点表示误差拖延。
    if (!(pnl >= milestone - 1e-9)) return null; // 里程碑递增，后面更远
    return { rung: k + 1, milestone, ratio };
  }
  return null;
}

// 方案 4：保护单止盈触发时的金字塔减仓（日内执行与计划同一阶梯）。
// 价格相对成本触达下一未执行档里程碑才返回该档；否则返回 null，调用
// 方保持武装等待价格上行（旧计划无向量时由调用方走旧减半语义）。
export function protectivePyramidReduce(position, priceCents, pyramidReduce) {
  if (!position || !Number.isFinite(priceCents)) return null;
  const avgCost = costBasis(position) / totalQuantity(position);
  if (!(avgCost > 0)) return null;
  return nextPyramidRung(position, priceCents / avgCost - 1, pyramidReduce);
}

export function createPlan(
  snapshot,
  book,
  strategy,
  strategyVersion,
  createdAt,
  options = {},
) {
  // 政策冻结（§3.2）：订单计划保存完整规范化政策与内容摘要；
  // 新政策从下一个尚未冻结的计划生效，持仓本身不重置。
  const executionCostPolicy =
    options.executionCostPolicy ?? defaultExecutionCostPolicy();
  // 原始分跨日回查：持仓股掉出当日涨停池时，按最近一次快照归档评分回填，
  // 查不到才如实置空；不参与任何策略决策，仅还原展示口径。
  const originalScoreLookup = options.originalScoreLookup ?? null;
  // 卖出信号检测器（方案 5）：日线历史特征 + EOD 当日行（持仓股跌出涨停池
  // 时也用真实日线补齐，不能漏检）+ 板块退潮集合 + 情绪周期切换。
  // 全部为可选上下文；缺失时对应信号跳过，不猜。
  let exitFeaturesByCode = options.exitFeaturesByCode ?? null;
  let exitEodRowsByCode = options.exitEodRowsByCode ?? null;
  // 炸板池记录：出池持仓的炸板次数来自当日炸板池归档（涨停池行只覆盖
  // 封住涨停的股票）；不在炸板池的出池持仓保持未知（null，不猜 0）。
  let exitBreaksByCode = options.exitBreaksByCode ?? null;
  let sectorLimitDrops = options.sectorLimitDrops ?? new Map();
  let phaseShift = options.phaseShift === true;
  // 冻结态：序列化后的上下文，供重算 / 影子 / 回测 / 核验复现同一决策。
  // 已冻结计划重算时直接反序列化复用原始输入，而不是按当日行情重推
  // （行情字段当日即快照，重推结果一致；但手续费/资金路径只改 fee 不
  // 改行情，上下文缺失误判会把 EXIT 变 ADD）。
  const exitContextFrozen = options.exitContextFrozen ?? null;
  if (exitContextFrozen) {
    exitFeaturesByCode = exitContextFrozen.features
      ? new Map(Object.entries(exitContextFrozen.features))
      : null;
    exitEodRowsByCode = exitContextFrozen.eodRows
      ? new Map(Object.entries(exitContextFrozen.eodRows))
      : null;
    exitBreaksByCode = exitContextFrozen.breaks
      ? new Map(Object.entries(exitContextFrozen.breaks))
      : null;
    sectorLimitDrops = new Map(
      (exitContextFrozen.sectorDrops ?? []).map((sector) => [sector, true]),
    );
    phaseShift = exitContextFrozen.phaseShift === true;
  }
  // 做T质量冻结摘要（方案 7）：调用方从做T记录汇总（主账户查表、
  // 重放/回测/影子从各自成交流水派生），计划冻结时原样携带；重算时
  // 由 assertProgramSnapshot 用冻结证据独立重算，不信任计划内声明。
  // 缺失 = 旧语义（tFraction 原样，无闸门）；版本不匹配拒绝生成。
  const tQuality = options.tQuality ?? null;
  const tQualityEvidence = options.tQualityEvidence ?? null;
  if (tQuality && tQuality.rulesVersion !== T_QUALITY_RULES_VERSION)
    throw new Error(`不支持的做T质量规则版本 ${tQuality.rulesVersion}`);
  // 摘要与证据成对冻结：缺一的计划无法通过核验，冻结时就拒绝。
  if (tQuality && !tQualityEvidence)
    throw new Error("做T质量摘要缺少冻结证据，拒绝生成计划");
  if (tQualityEvidence && !tQuality)
    throw new Error("做T质量证据缺少摘要，拒绝生成计划");
  // 快照启用标记与计划摘要的一致性（对齐降级规则模式）：新快照（评分
  // 管线已写 tQualityRulesVersion）的计划必须携带质量摘要与证据——同时
  // 删除两者伪装成旧计划的路径被快照标记拦截；旧快照的计划不得携带。
  const sourceTQualityEnabled = tQualityEnabledForSnapshot(snapshot);
  if (sourceTQualityEnabled && !tQuality)
    throw new Error("信号快照已启用做T质量规则，计划缺少质量摘要");
  if (!sourceTQualityEnabled && (tQuality || tQualityEvidence))
    throw new Error("信号快照未启用做T质量规则，计划不得携带质量摘要");
  const policy = options.selectionPolicy ?? selectionPolicyForBook(book);
  const policyFields = selectionPolicyFields(policy);
  const modernSelection = policy.version !== LEGACY_SELECTION_VERSION;
  const previousLimitUpCodes = (snapshot.stocks ?? [])
    .filter(
      (stock) =>
        Number(
          strategy.program && Object.hasOwn(stock, "consecutiveBoards")
            ? stock.consecutiveBoards
            : stock.height,
        ) >= 1,
    )
    .map((stock) => stock.code);
  if (modernSelection) previousLimitUpCodes.sort();
  const signals = scoreSignals(snapshot, strategy, policy);
  if (new Set(signals.map((s) => s.code)).size !== signals.length)
    throw new Error("评分快照存在重复股票代码，拒绝生成计划");
  const byCode = new Map(signals.map((stock) => [stock.code, stock]));
  const equity = book.equityCents;
  const drawdown = book.peakEquityCents ? 1 - equity / book.peakEquityCents : 0;
  const riskLimits = riskLimitsForBook(book);
  // 真实快照在 review.js 中把 analyze() 的非 stocks/sectors 字段落到
  // marketSummary；旧测试 fixture 可能直接把 cycle 放在顶层。
  // 若快照中已有 marketSummary（说明走了 analyze() 链路）但 cycle 缺失
  // （如 backtest 历史重构旧 payload），则从 stocks 高度/数量兜底重算，
  // 确保情绪闸门始终生效。旧式合成 fixture（无 marketSummary 字段）跳过。
  let cycle = snapshot.cycle ?? snapshot.marketSummary?.cycle ?? null;
  if (
    !cycle &&
    snapshot.marketSummary &&
    Array.isArray(snapshot.stocks) &&
    snapshot.stocks.length
  ) {
    const height = Math.max(
      0,
      ...snapshot.stocks.map((s) => Number(s.height) || 0),
    );
    cycle = classifySentimentCycle({
      limitUp: snapshot.stocks.length,
      broken: snapshot.marketSummary.broken ?? null,
      height,
    });
  }
  // 实际敞口上限 = 周期闸门与账户硬限制的较小值（唯一口径），
  // 成交求解与家族核验同用 resolveExposureCap 读取，避免各处漂移。
  const effectiveCap = resolveExposureCap(riskLimits, cycle);
  const emotion = snapshot.emotion ?? snapshot.marketSummary?.emotion ?? 0;
  // 情绪档位（可配置，随计划冻结）：两档阈值同时驱动目标敞口与
  // 加仓 / 做 T / 开新仓 / 减仓闸门，旧版本缺字段时回退默认档位。
  const tiers = strategy.exposureTiers ?? BASE_STRATEGY.exposureTiers;
  // 方案 4：金字塔减仓比例向量。仅当计划冻结的策略版本声明了该字段才
  // 启用——旧版本计划保持原语义（含 pnl ≥ takeProfit 减半），重算与
  // 核验不因新规则漂移；新参数随新策略版本生效。
  const pyramidReduce = Array.isArray(strategy.pyramidReduce)
    ? strategy.pyramidReduce
    : null;
  // 方案 6：降级检测的快照版本门控——炸板池字段随本检测器同期归档，
  // 旧快照（无该字段）重建的计划保持旧语义（不检测、不声明、订单不
  // 携带类别字段），旧计划重算与核验不受新规则影响。
  const downgradeEnabled = downgradeEnabledForSnapshot(snapshot);
  const downgrades = [];
  let targetExposure =
    drawdown >= riskLimits.maxDrawdown
      ? 0
      : emotion >= tiers.highEmotion
        ? tiers.high
        : emotion >= tiers.midEmotion
          ? tiers.mid
          : tiers.low;
  // 情绪周期闸门：冰点 / 退潮期强制压缩目标敞口。
  if (cycle) targetExposure = Math.min(targetExposure, cycle.maxGrossExposure);
  const strategyProgram = resolveStrategyProgram(
    { ...strategy, exposureTiers: tiers },
    snapshot,
  );
  if (strategyProgram) targetExposure = Math.min(targetExposure, effectiveCap);
  if (strategyProgram?.regime === "unknown") targetExposure = 0;
  const componentStates = strategyProgram
    ? allocationState(strategyProgram, book, targetExposure)
    : null;
  if (strategyProgram)
    strategyProgram.resources = {
      initialEquityCents: book.equityCents,
      components: structuredClone(componentStates),
    };
  if (strategyProgram)
    strategyProgram.snapshotDigest = options.snapshotDigest ?? null;
  const orders = [];
  const holdings = new Set(book.positions.map((position) => position.code));
  const selectionAudit = {
    signalDate: snapshot.date,
    snapshotCreatedAt: snapshot.createdAt ?? null,
    snapshotDigest: options.snapshotDigest ?? null,
    gradeRulesVersion: OBSERVATION_GRADE_RULES_VERSION,
    candidates: signals.map((s, index) => ({
      rank: index + 1,
      code: s.code,
      name: s.name,
      sector: s.sector,
      score: s.score,
      scoreValue: s.scoreValue,
      scoreRankKey: s.scoreRankKey,
      liquidityAmountCents: s.liquidityAmountCents,
      factors: s.factors.map((f) =>
        Number.isFinite(f.value) ? f.value : null,
      ),
      deduction: s.deduction ?? null,
      coverage: s.coverage ?? null,
      sectorScore: s.sectorScore,
      height: s.height ?? null,
      // v3 股票分类结果随审计透出（平庸型在新增买入阶段被跳过）
      stockClass: s.stockClass ?? null,
      // 观察池分级（方案 8）：仅展示，不参与排序与交易决策
      grade: s.grade ?? null,
      gradeReason: s.gradeReason ?? null,
      ...(strategyProgram
        ? {
            consecutiveBoards: Object.hasOwn(s, "consecutiveBoards")
              ? s.consecutiveBoards
              : (s.height ?? null),
            turnover: s.turnover ?? null,
          }
        : {}),
      price: s.price ?? null,
      risks: s.risks.map((r) => r.text),
      ...(s.buyPoint
        ? {
            buyPoint: {
              primary: s.buyPoint.primary,
              secondary: s.buyPoint.secondary ?? null,
              confidence: s.buyPoint.confidence ?? null,
            },
          }
        : {}),
      ...(strategyProgram
        ? {
            familyChecks: strategyProgram.components.map((component) => ({
              componentId: component.id,
              ...familyEligibility(component.family.familyId, s, snapshot),
            })),
          }
        : {}),
      status: "SKIPPED",
      reason: "尚未评估",
    })),
  };
  let plannedBudget = 0;
  let plannedExposure = book.positions.reduce(
    (sum, position) => sum + totalQuantity(position) * position.markCents,
    0,
  );
  const addOrder = (order) =>
    orders.push({
      ...order,
      id: `${snapshot.date}:${order.code}:${order.action}`,
    });

  for (const position of book.positions) {
    const quantity = totalQuantity(position);
    const signal = byCode.get(position.code);
    const score = signal?.score ?? position.lastScore ?? 0;
    const referenceCents = position.markCents;
    const pnl = costBasis(position)
      ? (quantity * referenceCents) / costBasis(position) - 1
      : 0;
    // 方案 5：主动卖出信号检测（固定止损之外的止盈/退潮退出）。
    // 持仓股不在当日涨停评分池时，用日线 EOD 行补齐 row（开/收/高/涨幅/
    // 是否封板/炸板次数），避免漏检个股卖出信号。
    //   - 已在池：以评分 normalize 行（含真实 breaks / isLimitUp）为准；
    //   - 不在池且在炸板池：炸板池记录是"盘中触板且收盘未封"的权威事实，
    //     isLimitUp 明确为 false、breaks 取池内记录——不按涨幅推断
    //     （收涨 9.8% 会被误判为封板而漏检），日线缺失也可触发；
    //   - 不在池且不在炸板池：用 exitEodRowsByCode 推算 close/open/high/
    //     change，isLimitUp 由 change 距 limitUpPct 阈值推断（容差 0.3%），
    //     breaks 保持未知（null，不猜 0）。
    let exitRow = signal ?? null;
    if (!exitRow) {
      const eod = exitEodRowsByCode?.get(position.code);
      const breaks = exitBreaksByCode?.get(position.code) ?? null;
      if (eod || breaks !== null) {
        const limitPct = eod?.limitUpPct ?? 10;
        const change = Number.isFinite(eod?.change) ? eod.change : null;
        const isLimitUp =
          breaks !== null
            ? false
            : change !== null && change >= limitPct - 0.3
              ? true
              : change !== null
                ? false
                : null;
        exitRow = {
          code: position.code,
          close: eod?.close ?? null,
          price: eod?.close ?? null,
          open: eod?.open ?? null,
          high: eod?.high ?? null,
          change,
          breaks,
          isLimitUp,
        };
      }
    }
    const exitResult = checkExitSignals(position, {
      row: exitRow,
      features: exitFeaturesByCode?.get(position.code) ?? null,
      sectorLimitDrop: sectorLimitDrops.get(position.sector) === true,
      phaseShift,
    });
    // 方案 6：降级检测在计划冻结时派生（确定性：同一信号日快照 + 持仓
    // 状态 → 同一结论），结论以 downgrades 声明随计划携带，执行日开盘
    // 套用入账本——主账户、影子、研究重放与旧计划重算对同一输入收敛；
    // 检测不落在结算期（避免出现第二条与计划不一致的判定路径）。
    // 未携带类别的持仓按连板龙头型检测（策略默认买入动量龙头）。
    const demotion = downgradeEnabled
      ? detectDowngradeForPosition({
          position,
          stocks: snapshot.stocks ?? [],
          brokenRows: snapshot.market?.brokenRows ?? [],
          eodChange: exitEodRowsByCode?.get(position.code)?.change ?? null,
          sectorPerformance: snapshot.sectorPerformance ?? null,
          today: snapshot.date,
        })
      : null;
    if (demotion)
      downgrades.push({
        code: position.code,
        from: demotion.from,
        to: demotion.to,
        reason: demotion.reason,
      });
    // 管理类别取降级结论，其次持仓既有类别；订单类别再回退当日分类
    // （仅作成交回填的类别起点，不参与管理决策）。旧快照门控关闭时
    // 一律不启用类别管理，保持旧计划语义。
    const effectiveClass = demotion?.to ?? position.stockClass ?? null;
    const classManagement = downgradeEnabled
      ? (CLASS_MANAGEMENT[effectiveClass] ?? null)
      : null;
    const orderClass =
      demotion?.to ?? position.stockClass ?? signal?.stockClass ?? null;
    const maxHoldDays = classManagement?.maxHoldDays ?? strategy.maxHoldDays;
    const takeProfitCap = classManagement?.takeProfitCap ?? strategy.takeProfit;
    const base = {
      code: position.code,
      name: position.name,
      sector: position.sector,
      score,
      // 方案 6：管理类别随订单携带，成交回填保持账本一致。仅新快照
      // 启用——旧快照重建的计划保持旧字段形状，重算一致。
      ...(downgradeEnabled && orderClass ? { stockClass: orderClass } : {}),
      ...(modernSelection ? { scoreValue: signal?.scoreValue ?? null } : {}),
      originalScore:
        signal?.originalScore ?? originalScoreLookup?.(position.code) ?? null,
      referenceCents,
      stopCents: Math.round(
        (costBasis(position) / quantity) * (1 - strategy.stopLoss),
      ),
      takeProfitCents: Math.round(
        (costBasis(position) / quantity) *
          (1 + Math.min(strategy.takeProfit, takeProfitCap)),
      ),
    };
    if (
      drawdown >= riskLimits.maxDrawdown ||
      pnl <= -strategy.stopLoss ||
      position.heldDays >= maxHoldDays
    ) {
      addOrder({
        ...base,
        action: "EXIT",
        side: "SELL",
        quantity,
        reason:
          drawdown >= riskLimits.maxDrawdown
            ? "账户回撤触及风险上限"
            : pnl <= -strategy.stopLoss
              ? "收盘亏损达到止损阈值"
              : position.heldDays >= strategy.maxHoldDays
                ? "持仓达到最长观察期"
                : "降级后快进快出：持有达到降级类别持有上限",
      });
      plannedExposure -= quantity * referenceCents;
      continue;
    }
    // 方案 5：主动卖出信号命中 → 清仓（优先级高于减仓/做T）
    if (exitResult.exit) {
      addOrder({
        ...base,
        action: "EXIT",
        side: "SELL",
        quantity,
        reason: `主动卖出信号：${exitResult.reason}`,
      });
      plannedExposure -= quantity * referenceCents;
      continue;
    }
    // 目标仓位 = 每仓敞口 × 降级档位系数（仓位降 1 档 / 再降 1 档）；
    // 超额减仓与补仓目标共用同一口径，避免两条路径各算各的。
    const target = Math.round(
      equity *
        Math.min(0.175, targetExposure / strategy.maxPositions) *
        (classManagement?.targetScale ?? 1),
    );
    // 方案 6：降级后收益目标即清仓线——盈利触达降级类别收益上限时
    // 全额退出，优先于金字塔阶梯（收益目标收紧不是展示字段：计划与
    // 保护单两条路径都按上限执行，不再等待 20%/30% 档位）。
    if (
      classManagement?.takeProfitCap != null &&
      pnl >= classManagement.takeProfitCap
    ) {
      addOrder({
        ...base,
        action: "EXIT",
        side: "SELL",
        quantity,
        reason: `降级后收益目标兑现：盈利 ${(pnl * 100).toFixed(1)}% 触达降级类别上限 ${(
          classManagement.takeProfitCap * 100
        ).toFixed(0)}%`,
      });
      plannedExposure -= quantity * referenceCents;
      continue;
    }
    // 方案 6：仓位降一档的实际执行——目标仓位乘降级系数后，现有持仓
    // 超出目标的部分直接减掉（只收紧加仓额度无法处置超额持仓，超额
    // 仓位会继续按原市值做 T）。
    if (classManagement && classManagement.targetScale < 1) {
      const excessQuantity = roundLot(
        (quantity * referenceCents - target) / referenceCents,
      );
      if (excessQuantity > 0) {
        addOrder({
          ...base,
          action: "REDUCE",
          side: "SELL",
          quantity: excessQuantity,
          reason: `仓位降一档：持仓超出降级目标仓位，减仓 ${excessQuantity} 股`,
        });
        plannedExposure -= excessQuantity * referenceCents;
        continue;
      }
    }
    // 方案 4：金字塔减仓（比例参数化）。里程碑固定为成本价 +10%/+20%/+30%
    // （skill：第一个涨停减 3 成、第二个再减 2 成、第三个再减 1 成），
    // 各档只执行一次——position.pyramidStage 由成交推进（订单携带
    // pyramidRung），比例向量 strategy.pyramidReduce = [p1, p2, p3] 为
    // 赛马可优化参数。
    const pyramidRung = nextPyramidRung(position, pnl, pyramidReduce);
    if (pyramidRung && roundLot(quantity * pyramidRung.ratio) > 0) {
      const reduceQuantity = roundLot(quantity * pyramidRung.ratio);
      addOrder({
        ...base,
        action: "REDUCE",
        side: "SELL",
        quantity: reduceQuantity,
        pyramidRung: pyramidRung.rung,
        reason: `金字塔减仓第 ${pyramidRung.rung} 档：累计盈利达 ${(
          pyramidRung.milestone * 100
        ).toFixed(0)}% 减 ${Math.round(pyramidRung.ratio * 10)} 成`,
      });
      plannedExposure -= reduceQuantity * referenceCents;
      continue;
    }
    // 旧版本计划（未声明 pyramidReduce）保持原语义：pnl ≥ takeProfit
    // 与风险减半共用固定减半规则，reason 原样复现保证重算一致。
    const legacyProfitReduce =
      !Array.isArray(pyramidReduce) && pnl >= strategy.takeProfit;
    if (
      legacyProfitReduce ||
      (signal && score < 65) ||
      emotion < tiers.midEmotion
    ) {
      const reduceQuantity = roundLot(quantity / 2) || quantity;
      addOrder({
        ...base,
        action: "REDUCE",
        side: "SELL",
        quantity: reduceQuantity,
        reason: legacyProfitReduce
          ? "分批兑现达到止盈阈值的仓位"
          : emotion < tiers.midEmotion
            ? "市场情绪较弱，降低敞口"
            : "个股评分走弱，降低仓位",
      });
      plannedExposure -= reduceQuantity * referenceCents;
      continue;
    }
    const addBudget = target - quantity * referenceCents;
    let addQuantity = roundLot(addBudget / referenceCents);
    const addAllocation =
      strategyProgram && signal
        ? allocateEntry(
            signal,
            snapshot,
            componentStates,
            addQuantity,
            referenceCents,
          )
        : null;
    if (strategyProgram) addQuantity = addAllocation?.quantity ?? 0;
    if (
      signal &&
      score >= 88 &&
      addQuantity >= 100 &&
      emotion >= tiers.highEmotion &&
      plannedExposure + addQuantity * referenceCents <= equity * targetExposure
    ) {
      addOrder({
        ...base,
        action: "ADD",
        side: "BUY",
        quantity: addQuantity,
        ...(addAllocation
          ? { strategyAllocations: addAllocation.allocations }
          : {}),
        maxPriceCents: Math.round(referenceCents * (1 + strategy.maxBuyGap)),
        reason: "高分信号延续，补足目标仓位",
      });
      plannedBudget +=
        addQuantity * referenceCents +
        transactionFees(
          addQuantity * referenceCents,
          "BUY",
          feesForBook(book),
          book.feeModel || "legacy-v1",
        ).total;
      plannedExposure += addQuantity * referenceCents;
      if (addAllocation)
        chargeEntry(componentStates, addAllocation.allocations, referenceCents);
      continue;
    }
    // 做T质量闸门（方案 7）：停手期内禁止做T；胜率档位收紧做T仓位
    // （>60% 允许 2 成、40%~60% 限 1 成、<40% 禁止）。capTraction 为
    // null（无已了结历史）时不设上限，保持策略原 tFraction 语义。
    const tCap = tQuality ? tQuality.capTraction : null;
    const effectiveTFraction =
      tCap == null ? strategy.tFraction : Math.min(strategy.tFraction, tCap);
    const tQuantity = roundLot(quantity * effectiveTFraction);
    // 冰点期禁止正向 T（第一腿是买入），只允许反向 T（先卖后买）或 HOLD。
    const freezingBlockForwardT = cycle?.phase === CYCLE_PHASES.FREEZING;
    if (tQuality?.blocked === true) {
      addOrder({
        ...base,
        action: "HOLD",
        side: "NONE",
        quantity: 0,
        reason: tQuality.stopTriggerDate
          ? `连续 2 笔做T亏损，停手观察（自 ${tQuality.stopTriggerDate} 起 3 个交易日）`
          : "连续 2 笔做T亏损，停手观察",
      });
    } else if (
      tQuantity >= 100 &&
      score >= 65 &&
      emotion >= tiers.midEmotion &&
      (!strategyProgram ||
        (strategyProgram.regime !== "unknown" &&
          strategyProgram.components.some(
            (component) => component.family.familyId !== "cash-v1",
          )))
    ) {
      const tAction =
        score >= 82 && !freezingBlockForwardT ? "T_FORWARD" : "T_REVERSE";
      const tReason =
        tAction === "T_FORWARD"
          ? "保留底仓，低吸后在预设价差上兑现旧仓"
          : freezingBlockForwardT
            ? "冰点期禁止正T：先减旧仓，回落价再买回"
            : "先减旧仓，在预设回落价上买回";
      addOrder({
        ...base,
        action: tAction,
        side: "PAIR",
        quantity: tQuantity,
        buyTriggerCents: Math.round(referenceCents * (1 - strategy.tBuyDip)),
        sellTriggerCents: Math.round(referenceCents * (1 + strategy.tSellRise)),
        reason:
          tCap != null && tCap < strategy.tFraction
            ? `${tReason}；做T仓位按胜率档位限 ${Math.round(tCap * 10)} 成`
            : tReason,
      });
    } else {
      addOrder({
        ...base,
        action: "HOLD",
        side: "NONE",
        quantity: 0,
        reason:
          tQuality && tQuality.capTraction === 0
            ? `做T胜率 ${((tQuality.winRate ?? 0) * 100).toFixed(0)}% 低于 40%，暂停做T`
            : "保持底仓，条件不足时不强行交易",
      });
    }
  }

  const slots = Math.max(0, strategy.maxPositions - book.positions.length);
  let opened = 0;
  // v3：平庸型只在"新增买入候选"阶段排除；信号列表保留完整持仓风险信号
  const stockClassRouting = policy.stockClassRouting === true;
  // v4：买点硬闸门。只对新增建仓生效，不影响持仓的风险保护动作（减仓/止损
  // 继续走原有信号）。旧版本返回 null，闸门整体跳过，行为逐字节不变。
  const buyPointGate = buyPointGateForPolicy(policy);
  for (const [index, signal] of signals.entries()) {
    const audit = selectionAudit.candidates[index];
    if (stockClassRouting && signal.stockClass === STOCK_CLASSES.MEDIOCRE) {
      audit.reason = "平庸型不进入新增候选池";
      continue;
    }
    if (holdings.has(signal.code)) {
      audit.reason = "已有持仓，按持仓计划处理";
      continue;
    }
    // 只有 v5 的 EOD 候选且命中首阴/假阴买点时，才豁免结构性缺失的
    // 评分与覆盖检查。来源标记本身不授予建仓资格，也不改变旧版本门槛。
    const buyPointQualified = buyPointGate
      ? (signal.buyPoint?.labels ?? []).some((type) => buyPointGate.has(type))
      : null;
    const eodBuyPointQualified =
      policy.version === SELECTION_VERSION_V5 &&
      signal.candidateSource === "extra" &&
      (signal.buyPoint?.labels ?? []).some((type) =>
        [
          BUY_POINT_TYPES.FIRST_NEG_DIP,
          BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP,
        ].includes(type),
      );
    if (
      !/^\d{6}$/.test(signal.code) ||
      ((modernSelection || strategyProgram) &&
        !Number.isFinite(signal.sectorScore)) ||
      (!eodBuyPointQualified &&
        (((modernSelection || strategyProgram) &&
          (!Number.isFinite(signal.score) ||
            !Number.isFinite(signal.coverage))) ||
          signal.coverage < 80 ||
          signal.score < strategy.minScore)) ||
      signal.sectorScore < strategy.minSectorScore ||
      (strategyProgram && Object.hasOwn(signal, "consecutiveBoards")
        ? signal.consecutiveBoards
        : signal.height) >= 5 ||
      signal.risks.some((risk) => ["一字特征", "高换手"].includes(risk.text)) ||
      !(signal.price > 0)
    ) {
      audit.reason = "未满足评分、板块、覆盖、风险或价格条件";
      continue;
    }
    if (buyPointGate && !buyPointQualified && !eodBuyPointQualified) {
      // 闸门放在评分/板块/覆盖门槛之后：先确保候选数据可用且质量达标，
      // 再按买点资格过滤，避免把"数据不足"与"买点不合格"记成同一个原因。
      audit.reason = "买点未命中建仓闸门（仅放行打板 / 炸板低吸）";
      continue;
    }
    if (
      strategyProgram &&
      !audit.familyChecks.some((check) => check.eligible)
    ) {
      audit.reason = audit.familyChecks.map((check) => check.reason).join("；");
      continue;
    }
    if (
      emotion < tiers.midEmotion ||
      drawdown >= riskLimits.maxDrawdown ||
      strategyProgram?.regime === "unknown" ||
      cycle?.phase === CYCLE_PHASES.FREEZING
    ) {
      audit.reason =
        cycle?.phase === CYCLE_PHASES.FREEZING
          ? "情绪冰点期禁止开新仓"
          : "市场情绪或账户回撤限制新增交易";
      continue;
    }
    if (opened >= slots) {
      audit.reason = "建仓名额已用完";
      continue;
    }
    const referenceCents = toCents(signal.price);
    const budget = Math.max(
      0,
      Math.min(
        (equity * targetExposure) / strategy.maxPositions,
        equity * targetExposure - plannedExposure,
        book.cashCents - plannedBudget - 1000,
        ...(modernSelection || strategyProgram
          ? [
              equity * riskLimits.maxPositionWeight,
              equity * effectiveCap - plannedExposure,
            ]
          : []),
      ),
    );
    let quantity = roundLot(budget / referenceCents);
    const entryAllocation = strategyProgram
      ? allocateEntry(
          signal,
          snapshot,
          componentStates,
          quantity,
          referenceCents,
        )
      : null;
    if (entryAllocation) quantity = entryAllocation.quantity;
    if (quantity < 100) {
      audit.reason = "剩余资金或敞口不足一手";
      continue;
    }
    audit.status = "SELECTED";
    audit.reason = "通过资格与资金检查，按冻结排序入选";
    audit.quantity = quantity;
    audit.referenceNotionalCents = quantity * referenceCents;
    addOrder({
      code: signal.code,
      name: signal.name,
      sector: signal.sector,
      score: signal.score,
      // 方案 6：建仓订单携带分类类别，成交回填为持仓的管理类别起点。
      // 仅新快照启用——旧快照重建的计划保持旧字段形状，重算一致。
      ...(downgradeEnabled && signal.stockClass
        ? { stockClass: signal.stockClass }
        : {}),
      ...(signal.buyPoint ? { buyPoint: signal.buyPoint } : {}),
      ...(modernSelection
        ? {
            scoreValue: signal.scoreValue,
            scoreRankKey: signal.scoreRankKey,
            liquidityAmountCents: signal.liquidityAmountCents,
            selectionRank: audit.rank,
          }
        : {}),
      originalScore: signal.originalScore,
      referenceCents,
      action: "OPEN",
      side: "BUY",
      quantity,
      ...(entryAllocation
        ? { strategyAllocations: entryAllocation.allocations }
        : {}),
      maxPriceCents: Math.round(referenceCents * (1 + strategy.maxBuyGap)),
      stopCents: Math.round(referenceCents * (1 - strategy.stopLoss)),
      takeProfitCents: Math.round(referenceCents * (1 + strategy.takeProfit)),
      reason: "高分且板块协同较强，下一交易日开盘条件满足时建仓",
    });
    plannedBudget +=
      quantity * referenceCents +
      transactionFees(
        quantity * referenceCents,
        "BUY",
        feesForBook(book),
        book.feeModel || "legacy-v1",
      ).total;
    plannedExposure += quantity * referenceCents;
    if (entryAllocation)
      chargeEntry(componentStates, entryAllocation.allocations, referenceCents);
    opened++;
  }
  return {
    signalDate: snapshot.date,
    feeModel: book.feeModel || "legacy-v1",
    feeConfig: structuredClone(feesForBook(book)),
    feeConfigVersion: book.feeConfigVersion || 0,
    // 冻结账户原始 5 字段 riskLimits（严格风控 schema 兼容，extra 字段
    // 会被 normalizeRiskLimits 拒绝）；周期闸门单独冻结在 cycle.maxGrossExposure，
    // executeFillWithCostModel 与家族核验通过 resolveExposureCap 复原同一口径。
    riskLimits: structuredClone(riskLimits),
    riskLimitsVersion: book.riskLimitsVersion || 0,
    createdAt,
    strategyVersion,
    strategy,
    ...(strategyProgram ? { strategyProgram } : {}),
    ...policyFields,
    selectionAudit,
    executionCostModel: EXECUTION_COST_MODEL,
    executionCostPolicy: structuredClone(executionCostPolicy),
    previousLimitUpCodes,
    previousLimitUpKnown: true,
    emotion: strategyProgram ? strategyProgram.emotion : emotion,
    cycle: cycle
      ? {
          phase: cycle.phase,
          label: cycle.label,
          score: cycle.score,
          maxGrossExposure: cycle.maxGrossExposure,
        }
      : null,
    targetExposure,
    maxExposure: effectiveCap,
    // 卖出上下文冻结：与政策 digest 同级，重算/影子/回测/核验直接读
    // 这份快照复现同一决策，不再按当日行情重推（避免手续费变更引起
    // 上下文漂移、EXIT 变 ADD）。无上下文时置 null，不写空壳。
    exitContext: freezeExitContext({
      exitFeaturesByCode,
      exitEodRowsByCode,
      exitBreaksByCode,
      sectorLimitDrops,
      phaseShift,
      codes: holdings,
    }),
    // 方案 6：降级声明随计划冻结（门控开启时始终携带，空数组表示当日
    // 无降级），版本与源快照绑定；历史快照不补标记。
    ...(downgradeEnabled
      ? { downgradeRulesVersion: DOWNGRADE_RULES_VERSION, downgrades }
      : {}),
    // 方案 7：做T质量冻结摘要随计划携带（调用方传入时始终携带——含
    // 空历史摘要），支撑证据（做T记录 + 交易日）独立冻结在计划顶层，
    // 核验方用证据独立重算摘要——摘要不可直接声明。旧计划两者皆无，
    // 保持旧语义。
    ...(tQuality
      ? {
          // 规则启用标记独立于摘要：核验据此要求新快照的计划必须携带
          // 质量摘要与证据，删除两者伪装成旧计划会被快照标记拦截。
          tQualityRulesVersion: T_QUALITY_RULES_VERSION,
          tQuality: structuredClone(tQuality),
          ...(tQualityEvidence
            ? { tQualityEvidence: structuredClone(tQualityEvidence) }
            : {}),
        }
      : {}),
    orders: carriedPlanOrders(
      orders,
      book,
      snapshot.date,
      strategy,
      originalScoreLookup,
    ),
    constraints:
      "下一交易日执行；T+1；整手买入；涨跌停不保证成交；成交费用和滑点计入账本。",
  };
}

export function assertProgramSnapshot(plan, snapshot, initialBook) {
  if (!plan) return;
  const downgradeEnabled = downgradeEnabledForPlan(plan);
  const sourceDowngradeEnabled = downgradeEnabledForSnapshot(snapshot);
  const hasTQuality = plan.tQuality != null || plan.tQualityEvidence != null;
  const planTQualityEnabled = tQualityEnabledForPlan(plan);
  const sourceTQualityEnabled = tQualityEnabledForSnapshot(snapshot);
  if (
    !plan.strategy?.program &&
    !downgradeEnabled &&
    !sourceDowngradeEnabled &&
    !hasTQuality &&
    !planTQualityEnabled
  )
    return;
  if (downgradeEnabled !== sourceDowngradeEnabled)
    throw new Error("计划降级规则版本与原始信号快照不一致");
  // 方案 7：做T质量规则标记的一致性——快照已启用（评分管线写入标记）
  // 的计划必须携带质量摘要与证据，同时删除两者伪装成旧计划被拦截；
  // 旧快照的计划不得凭空携带。
  if (planTQualityEnabled !== sourceTQualityEnabled)
    throw new Error("计划做T质量规则版本与原始信号快照不一致");
  // 方案 7：做T质量摘要不可直接声明——用计划冻结的证据（做T记录 +
  // 交易日）独立重算并比对。改写摘要、改写证据、两者缺失其一都无法
  // 通过核验；证据的成交来源由导出核验用账本独立复核。
  let effectiveTQuality = plan.tQuality ?? null;
  if (hasTQuality) {
    if (!plan.tQuality || !plan.tQualityEvidence)
      throw new Error("做T质量摘要与冻结证据必须同时随计划冻结");
    const recomputed = summarizeTQuality(plan.tQualityEvidence.records, {
      signalDate: plan.signalDate,
      tradingDates: plan.tQualityEvidence.tradingDates,
    });
    if (canonicalJson(recomputed) !== canonicalJson(plan.tQuality))
      throw new Error("做T质量摘要与冻结证据重算不一致");
    effectiveTQuality = recomputed;
  }
  assertProgramPlan(plan, initialBook);
  if (
    !plan.sourceSnapshotMissing &&
    (!snapshot || snapshot.date !== plan.signalDate)
  )
    throw new Error("策略程序缺少信号日原始快照");
  if (
    !plan.sourceSnapshotMissing &&
    (!Number.isFinite(Date.parse(snapshot.createdAt)) ||
      !Number.isFinite(Date.parse(plan.createdAt)) ||
      Date.parse(snapshot.createdAt) > Date.parse(plan.createdAt))
  )
    throw new Error("策略程序信号快照在计划冻结后才可用，拒绝未来信息");
  const options = {
    executionCostPolicy: plan.executionCostPolicy,
    selectionPolicy: frozenSelectionPolicy(plan),
    snapshotDigest: plan.selectionAudit?.snapshotDigest,
    originalScoreLookup: (code) =>
      plan.orders.find((order) => order.code === code)?.originalScore ?? null,
    // 重算复用计划冻结的卖出上下文（方案 5）：EXIT 决策由冻结输入复现，
    // 不按当前环境重推（缺失时出池持仓回退做 T，会误报"重算不一致"）。
    ...(plan.exitContext ? { exitContextFrozen: plan.exitContext } : {}),
    // 重算复用计划冻结的做T质量摘要（方案 7）：T 闸门由冻结证据独立
    // 重算出的摘要驱动（已核验与声明一致），不按当前做T记录重推。
    // 摘要与证据成对传入（重算的 createPlan 同样执行成对校验）。
    ...(effectiveTQuality
      ? { tQuality: effectiveTQuality, tQualityEvidence: plan.tQualityEvidence }
      : {}),
  };
  const referenceBook = {
    ...initialBook,
    riskLimits: plan.riskLimits,
    riskLimitsVersion: plan.riskLimitsVersion,
    feeConfig: plan.feeConfig,
    feeConfigVersion: plan.feeConfigVersion,
    feeModel: plan.feeModel,
  };
  const expected = plan.sourceSnapshotMissing
    ? defensivePlan(
        plan.signalDate,
        referenceBook,
        plan.strategy,
        plan.strategyVersion,
        plan.createdAt,
        options,
      )
    : createPlan(
        snapshot,
        referenceBook,
        plan.strategy,
        plan.strategyVersion,
        plan.createdAt,
        options,
      );
  for (const key of [
    "strategyProgram",
    "orders",
    "targetExposure",
    "emotion",
    "downgradeRulesVersion",
    "downgrades",
  ])
    if (canonicalJson(plan[key]) !== canonicalJson(expected[key]))
      throw new Error("策略计划与信号日原始快照、情绪选择或资金分配重算不一致");
}

function consumeLots(
  position,
  quantity,
  date,
  allocations = null,
  pyramidRung = null,
) {
  let remaining = quantity;
  let basis = 0;
  for (const lot of position.lots) {
    if (remaining <= 0) break;
    if (lot.acquiredDate >= date) continue;
    const taken = Math.min(remaining, lot.quantity);
    const takenCost =
      taken === lot.quantity
        ? lot.costCents
        : Math.round((lot.costCents * taken) / lot.quantity);
    if (allocations || lot.strategyAllocations) {
      const owned = lot.strategyAllocations ?? [
        { componentId: "carry", familyId: "inherited", quantity: lot.quantity },
      ];
      let remainingOwned = taken;
      for (const row of owned) {
        const amount = Math.min(remainingOwned, row.quantity);
        if (amount && allocations)
          allocations.push({ ...row, quantity: amount });
        row.quantity -= amount;
        remainingOwned -= amount;
      }
      if (remainingOwned) throw new Error("持仓策略分配无法覆盖可卖数量");
      if (lot.strategyAllocations)
        lot.strategyAllocations = owned.filter((row) => row.quantity > 0);
    }
    lot.quantity -= taken;
    lot.costCents -= takenCost;
    basis += takenCost;
    remaining -= taken;
  }
  position.lots = position.lots.filter((lot) => lot.quantity > 0);
  if (remaining) throw new Error("成交数量超过 T+1 可卖数量");
  // 方案 4：金字塔减仓档位在成交时推进（任何一条卖出链路都经
  // consumeLots）；只前进不回退，按订单声明的档位取最大值。
  if (Number.isInteger(pyramidRung) && pyramidRung > 0)
    position.pyramidStage = Math.max(position.pyramidStage ?? 0, pyramidRung);
  return basis;
}
function carriedPlanOrders(orders, book, date, strategy, originalScoreLookup) {
  const carried = new Map();
  const create = (item, action, side, quantity, reason) => {
    const p = book.positions.find((p) => p.code === item.code);
    if (!p || !quantity) return;
    const basis = costBasis(p) / totalQuantity(p);
    carried.set(item.code, {
      id: `${date}:${item.code}:carry`,
      code: item.code,
      name: p.name,
      sector: p.sector,
      score: p.lastScore ?? null,
      originalScore: originalScoreLookup?.(item.code) ?? null,
      referenceCents: p.markCents,
      stopCents: Math.round(basis * (1 - strategy.stopLoss)),
      takeProfitCents: Math.round(basis * (1 + strategy.takeProfit)),
      action,
      side,
      quantity,
      // 方案 4：跨日续执行的减仓保留档位声明，成交推进 stage 不丢档。
      ...(Number.isInteger(item.pyramidRung)
        ? { pyramidRung: item.pyramidRung }
        : {}),
      allDay: true,
      carried: true,
      recovery: !!item.side,
      reason,
    });
  };
  for (const item of book.pendingOrders || [])
    create(
      item,
      "REDUCE",
      "SELL",
      item.quantity,
      "继续执行上日未完成的减仓，连续竞价时段重试",
    );
  for (const item of book.pendingRecovery || [])
    create(
      item,
      item.side === "BUY" ? "ADD" : "REDUCE",
      item.side,
      item.quantity,
      "继续恢复上日做 T 第二腿，按实时行情及费用执行",
    );
  for (const item of book.pendingExits || []) {
    const p = book.positions.find((p) => p.code === item.code);
    create(
      item,
      "EXIT",
      "SELL",
      p ? totalQuantity(p) : 0,
      "继续执行受 T+1 或跌停阻塞的清仓",
    );
  }
  // A newly planned risk exit takes precedence over restoring an unfinished T.
  for (const order of orders)
    if (order.action === "EXIT") carried.delete(order.code);
  return [...orders.filter((o) => !carried.has(o.code)), ...carried.values()];
}

export function defensivePlan(
  date,
  book,
  strategy,
  strategyVersion,
  createdAt,
  options = {},
) {
  // 缺少昨日冻结信息时如实声明：昨日涨停风险项不适用，不猜测。
  const executionCostPolicy =
    options.executionCostPolicy ?? defaultExecutionCostPolicy();
  // 当日评分整体缺失，策略加权分保持为空；原始分仍按最近归档回查展示。
  const originalScoreLookup = options.originalScoreLookup ?? null;
  const drawdown = 1 - book.equityCents / book.peakEquityCents;
  const riskLimits = riskLimitsForBook(book);
  const strategyProgram = resolveStrategyProgram(
    {
      ...strategy,
      exposureTiers: strategy.exposureTiers ?? BASE_STRATEGY.exposureTiers,
    },
    { date, emotion: null },
  );
  if (strategyProgram)
    strategyProgram.resources = {
      initialEquityCents: book.equityCents,
      components: allocationState(strategyProgram, book, 0),
    };
  if (strategyProgram) strategyProgram.snapshotDigest = null;
  return {
    signalDate: date,
    feeModel: book.feeModel || "legacy-v1",
    feeConfig: structuredClone(feesForBook(book)),
    feeConfigVersion: book.feeConfigVersion || 0,
    riskLimits: structuredClone(riskLimits),
    riskLimitsVersion: book.riskLimitsVersion || 0,
    createdAt,
    strategyVersion,
    strategy,
    ...(strategyProgram ? { strategyProgram } : {}),
    ...selectionPolicyFields(
      options.selectionPolicy ?? selectionPolicyForBook(book),
    ),
    selectionAudit: {
      signalDate: date,
      snapshotCreatedAt: null,
      candidates: [],
    },
    executionCostModel: EXECUTION_COST_MODEL,
    executionCostPolicy: structuredClone(executionCostPolicy),
    previousLimitUpCodes: [],
    previousLimitUpKnown: false,
    sourceSnapshotMissing: true,
    emotion: null,
    targetExposure: 0,
    maxExposure: riskLimits.maxGrossExposure,
    orders: carriedPlanOrders(
      book.positions.map((position) => {
        const quantity = totalQuantity(position),
          basis = costBasis(position);
        const exit =
          drawdown >= riskLimits.maxDrawdown ||
          (quantity * position.markCents) / basis - 1 <= -strategy.stopLoss ||
          position.heldDays >= strategy.maxHoldDays;
        return {
          id: `${date}:${position.code}:defensive`,
          code: position.code,
          name: position.name,
          sector: position.sector,
          score: null,
          originalScore: originalScoreLookup?.(position.code) ?? null,
          referenceCents: position.markCents,
          stopCents: Math.round((basis / quantity) * (1 - strategy.stopLoss)),
          takeProfitCents: Math.round(
            (basis / quantity) * (1 + strategy.takeProfit),
          ),
          action: exit ? "EXIT" : "HOLD",
          side: exit ? "SELL" : "NONE",
          quantity: exit ? quantity : 0,
          reason: exit
            ? "当日评分缺失，按已有持仓风险阈值清仓"
            : "当日评分缺失，停止新增交易并保留旧仓保护",
        };
      }),
      book,
      date,
      strategy,
      originalScoreLookup,
    ),
    constraints: "缺少评分时不构造信号；只允许基于已结算持仓执行风险保护。",
  };
}

// 方案 6：计划冻结的降级声明开盘套用（executePlan 与实时会话共用）。
// 声明以信号日为口径（downgradedAt = signalDate），幂等：已按同一信号
// 日降级的持仓跳过。只有显式版本计划启用；旧计划保持原语义。
export function applyPlanDowngrades(book, plan, notices = []) {
  if (!downgradeEnabledForPlan(plan)) return;
  const seen = new Set();
  for (const item of plan.downgrades) {
    if (
      !item?.code ||
      seen.has(item.code) ||
      DOWNGRADE_CHAIN[item.from] !== item.to ||
      typeof item.reason !== "string" ||
      !item.reason
    )
      throw new Error("计划降级声明无效");
    seen.add(item.code);
    const position = book.positions.find((p) => p.code === item.code);
    if (
      !position ||
      (position.downgradedAt === plan.signalDate
        ? position.stockClass !== item.to
        : (position.stockClass ?? STOCK_CLASSES.RELAY_LEADER) !== item.from)
    )
      throw new Error("计划降级声明与持仓类别不一致");
  }
  for (const item of plan.downgrades) {
    const position = book.positions.find((p) => p.code === item.code);
    if (!position || position.downgradedAt === plan.signalDate) continue;
    position.stockClass = item.to;
    position.downgradedAt = plan.signalDate;
    notices.push(
      `降级声明生效：${item.code} 管理类别降为 ${item.to}（${item.reason}）`,
    );
  }
}

export function executePlan(inputBook, plan, dataset) {
  if (plan) frozenSelectionPolicy(plan);
  if (plan) assertProgramPlan(plan, inputBook);
  const book = structuredClone(inputBook);
  const date = dataset.date;
  if (
    plan?.strategy?.program &&
    (!Number.isFinite(Date.parse(plan.createdAt)) ||
      Date.parse(plan.createdAt) >= Date.parse(`${date}T01:15:00.000Z`))
  )
    throw new Error("策略程序计划实际冻结时间晚于执行日前闸门");
  if (
    plan &&
    (plan.signalDate >= date || plan.createdAt >= `${date}T01:15:00.000Z`)
  ) {
    throw new Error("交易计划必须在执行日开盘前冻结，禁止使用当日收盘评分交易");
  }
  // 新版本计划缺政策/摘要时暂停执行（§3.2）；旧计划无标记则分派旧 10bps 执行器。
  const policyBundle = plan ? executionPolicyBundle(plan) : null;
  const execution = policyBundle
    ? { policyDigest: policyBundle.payloadDigest, byCode: {} }
    : null;
  const ledger = [];
  const outcomes = [];
  const notices = [];
  const orders = structuredClone(plan?.orders || []).filter(
    (order) => order.action !== "HOLD",
  );
  const runtime = new Map(
    orders.map((order) => [
      order.id,
      { order, stage: 0, firstTime: null, filled: 0 },
    ]),
  );
  const quotes = dataset.quotes;
  for (const position of book.positions) {
    const quote = quotes[position.code];
    if (!quote || quote.date !== date || !(quote.closeCents > 0))
      throw new Error(`${position.code} 缺少当天持仓行情，结算暂停`);
    if (
      Math.abs(quote.previousCloseCents - position.markCents) >
      Math.max(1, position.markCents * 0.001)
    ) {
      throw new Error(
        `${position.code} 昨收与账面价格不一致，需核对除权或缺失交易日，结算暂停`,
      );
    }
  }
  const prices = new Map(
    book.positions.map((position) => [position.code, position.markCents]),
  );
  // 方案 6：执行日开盘套用计划冻结的降级声明（主账户 / 影子 / 研究重放
  // / 核验重放同一入口）：管理类别与降级日落账本，当日保护单的降级
  // 收益上限随即生效。
  applyPlanDowngrades(book, plan, notices);
  const events = [];
  let missingMinuteOrders = 0;

  for (const order of orders) {
    const quote = quotes[order.code];
    if (
      !quote ||
      quote.date !== date ||
      !(quote.openCents > 0) ||
      !(quote.closeCents > 0) ||
      quote.volumeShares === 0
    ) {
      outcomes.push({
        ...order,
        status: "SKIPPED",
        reason: "缺少日期匹配的可交易行情",
      });
      runtime.delete(order.id);
      continue;
    }
    if (
      Math.abs(quote.previousCloseCents - order.referenceCents) >
      Math.max(1, order.referenceCents * 0.001)
    ) {
      outcomes.push({
        ...order,
        status: "SKIPPED",
        reason: "计划参考价与昨收不一致，可能除权，跳过交易",
      });
      runtime.delete(order.id);
      continue;
    }
    const bars = dataset.minutes[order.code] || [];
    const pair = order.side === "PAIR";
    if (pair && !completeMinutes(bars)) {
      missingMinuteOrders++;
      outcomes.push({
        ...order,
        status: "SKIPPED",
        reason: "盘中时序数据不足，不推断做 T 的先后顺序",
      });
      runtime.delete(order.id);
      continue;
    }
    if (bars.length) {
      for (const bar of bars)
        events.push({
          ...bar,
          orderId: order.id,
          code: order.code,
          quality: "minute",
          intervalKey: `${date}:${bar.time}`,
        });
    } else {
      events.push({
        orderId: order.id,
        code: order.code,
        time: "09:30",
        priceCents: quote.openCents,
        volumeShares: null,
        quality: "daily_open_assumption",
        intervalKey: `${date}:09:30`,
      });
    }
  }
  // Protective orders apply only to inventory owned before this trading day.
  for (const original of plan?.orders || []) {
    const position = book.positions.find((item) => item.code === original.code);
    if (!position || ["EXIT", "REDUCE"].includes(original.action)) continue;
    const quantity = availableQuantity(position, date);
    const bars = dataset.minutes[original.code] || [];
    if (!quantity || !bars.length) continue;
    const order = {
      ...structuredClone(original),
      id: `${original.id}:protect`,
      side: "SELL",
      quantity,
      protective: true,
    };
    runtime.set(order.id, { order, stage: 0, filled: 0 });
    for (const bar of bars)
      events.push({
        ...bar,
        orderId: order.id,
        code: order.code,
        quality: "minute",
        intervalKey: `${date}:${bar.time}`,
      });
  }
  events.sort(
    (a, b) =>
      a.time.localeCompare(b.time) ||
      (runtime.get(a.orderId)?.order.side === "SELL" ? 0 : 1) -
        (runtime.get(b.orderId)?.order.side === "SELL" ? 0 : 1) ||
      a.code.localeCompare(b.code),
  );

  const fill = (order, side, quantity, event) =>
    executeFill(
      book,
      plan,
      dataset,
      prices,
      ledger,
      order,
      side,
      quantity,
      event,
      execution,
    );

  for (const event of events) {
    const running = runtime.get(event.orderId);
    if (!running) continue;
    const { order } = running;
    prices.set(order.code, event.priceCents);
    if (order.protective) {
      if (running.stage || event.time > "14:55") continue;
      if (
        !running.triggered &&
        event.priceCents > order.stopCents &&
        event.priceCents < order.takeProfitCents
      )
        continue;
      if (!running.triggered) {
        const stopHit = event.priceCents <= order.stopCents;
        const heldPosition = book.positions.find(
          (item) => item.code === order.code,
        );
        // 方案 6：降级持仓的收益目标即清仓线——保护触达直接全退，
        // 不走金字塔档位（收益目标上限已收紧保护触发位）。仅对冻结了
        // 显式降级规则版本的新计划启用，旧计划
        // 保持原减半语义。
        const classCap = downgradeEnabledForPlan(plan)
          ? (CLASS_MANAGEMENT[heldPosition?.stockClass]?.takeProfitCap ?? null)
          : null;
        const capExit = !stopHit && classCap != null;
        // 方案 4：止盈触发按金字塔下一未执行档减仓（价格须触达该档
        // 里程碑），未触达时保护单保持武装、不取消原计划；旧计划无
        // pyramidReduce 向量 → 保持原减半语义。
        const rung =
          stopHit || capExit
            ? null
            : protectivePyramidReduce(
                heldPosition,
                event.priceCents,
                plan.strategy?.pyramidReduce,
              );
        const pyramidActive = Array.isArray(plan.strategy?.pyramidReduce);
        const reduceQuantity = rung
          ? roundLot(order.quantity * rung.ratio)
          : roundLot(order.quantity / 2) || order.quantity;
        if (
          !stopHit &&
          !capExit &&
          pyramidActive &&
          (!rung || reduceQuantity <= 0)
        )
          continue; // 未到档位里程碑，等待价格继续上行
        running.triggered = true;
        if (stopHit || capExit) {
          order.action = "EXIT";
          order.reason = stopHit
            ? "事前保护止损触发"
            : "降级后收益目标兑现（保护触发）";
        } else if (rung) {
          order.action = "REDUCE";
          order.reason = `事前金字塔止盈触发：第 ${rung.rung} 档减 ${Math.round(rung.ratio * 10)} 成`;
          order.quantity = reduceQuantity;
          order.pyramidRung = rung.rung;
        } else {
          order.action = "REDUCE";
          order.reason = "事前分批止盈触发";
          order.quantity = reduceQuantity;
        }
        for (const [id, other] of runtime) {
          if (
            id !== order.id &&
            other.order.code === order.code &&
            !other.stage
          ) {
            outcomes.push({
              ...other.order,
              status: "SKIPPED",
              reason: "保护订单触发，取消原交易计划",
            });
            runtime.delete(id);
          }
          if (
            id !== order.id &&
            other.order.code === order.code &&
            other.order.side === "PAIR" &&
            other.stage === 1
          ) {
            outcomes.push({
              ...other.order,
              status: "PARTIAL",
              reason: "保护订单触发，做 T 第二腿取消，保留实际仓位",
            });
            runtime.delete(id);
          }
        }
      }
      const result = fill(
        order,
        "SELL",
        order.quantity - running.filled,
        event,
      );
      if (result.ok) running.filled += result.quantity;
      else running.lastReason = result.reason;
      if (running.filled === order.quantity) {
        running.stage = 1;
        outcomes.push({
          ...order,
          status: "FILLED",
          filledQuantity: running.filled,
        });
      }
      continue;
    }
    if (order.side !== "PAIR") {
      if (running.stage) continue;
      if (event.time > "09:35") {
        running.stage = 1;
        outcomes.push({
          ...order,
          status: "SKIPPED",
          // 拒绝原因进入订单 outcome（§5.2）：保留窗口内最后一次真实拒绝原因，
          // 并记录最终未成交数量；不只记录成功交易。
          reason: running.lastReason || "开盘执行窗口内未取得可成交数据",
          unfilledQuantity: order.quantity - running.filled,
        });
        continue;
      }
      if (order.side === "BUY" && event.priceCents > order.maxPriceCents) {
        running.stage = 1;
        outcomes.push({
          ...order,
          status: "SKIPPED",
          reason: "开盘涨幅超过事前买入上限",
        });
        continue;
      }
      const result = fill(order, order.side, order.quantity, event);
      if (result.ok) {
        running.stage = 1;
        outcomes.push({
          ...order,
          status: result.quantity === order.quantity ? "FILLED" : "PARTIAL",
          filledQuantity: result.quantity,
          reason:
            result.quantity < order.quantity
              ? "受现金、仓位或参与率限制，部分成交"
              : order.reason,
        });
      } else running.lastReason = result.reason;
      continue;
    }
    if (event.time < "09:35" || event.time > "14:50" || running.stage >= 2)
      continue;
    const forward = order.action === "T_FORWARD";
    if (running.stage === 0) {
      const position = book.positions.find((item) => item.code === order.code);
      if (!position || availableQuantity(position, date) < order.quantity) {
        running.lastReason = "T+1 可卖底仓不足";
        continue;
      }
      const triggered = forward
        ? event.priceCents <= order.buyTriggerCents
        : event.priceCents >= order.sellTriggerCents;
      if (!triggered) continue;
      const result = fill(
        order,
        forward ? "BUY" : "SELL",
        order.quantity,
        event,
      );
      if (result.ok) {
        running.stage = 1;
        running.firstTime = event.time;
        running.filled = result.quantity;
      } else running.lastReason = result.reason;
    } else if (event.time > running.firstTime) {
      const triggered = forward
        ? event.priceCents >= order.sellTriggerCents
        : event.priceCents <= order.buyTriggerCents;
      if (!triggered) continue;
      const result = fill(
        order,
        forward ? "SELL" : "BUY",
        running.remaining ?? running.filled,
        event,
      );
      if (result.ok) {
        running.remaining =
          (running.remaining ?? running.filled) - result.quantity;
        if (running.remaining <= 0) {
          running.stage = 2;
          outcomes.push({
            ...order,
            status: "FILLED",
            filledQuantity: running.filled,
          });
        }
      } else running.lastReason = result.reason;
    }
  }
  for (const running of runtime.values()) {
    if (running.order.protective && !running.triggered) continue;
    if (!outcomes.some((outcome) => outcome.id === running.order.id)) {
      outcomes.push({
        ...running.order,
        status:
          running.stage === 1 || running.filled > 0 ? "PARTIAL" : "SKIPPED",
        reason:
          running.stage === 1
            ? "做 T 的第二腿未完成，实际新增或减少的仓位保留到账本"
            : running.lastReason || "预设条件未触发",
        unfilledQuantity: running.order.quantity - running.filled,
      });
    }
  }
  book.positions = book.positions.filter(
    (position) => totalQuantity(position) > 0,
  );
  for (const position of book.positions) {
    const quote = quotes[position.code];
    if (quote?.date === date && quote.closeCents > 0) {
      position.markCents = quote.closeCents;
      position.markDate = date;
    } else
      notices.push(
        `${position.code} 缺少当天收盘价，保留旧估值，收益标记不完整`,
      );
    position.heldDays++;
  }
  const marketValueCents = book.positions.reduce(
    (sum, position) => sum + totalQuantity(position) * position.markCents,
    0,
  );
  const unrealizedPnlCents = book.positions.reduce(
    (sum, position) =>
      sum + totalQuantity(position) * position.markCents - costBasis(position),
    0,
  );
  const equityCents = book.cashCents + marketValueCents;
  const dailyPnlCents = equityCents - book.equityCents;
  const dailyReturn = book.equityCents ? dailyPnlCents / book.equityCents : 0;
  book.equityCents = equityCents;
  book.peakEquityCents = Math.max(book.peakEquityCents, equityCents);
  book.lastDate = date;
  book.settlementCount++;
  const equity = {
    date,
    cashCents: book.cashCents,
    marketValueCents,
    equityCents,
    dailyPnlCents,
    dailyReturn,
    totalReturn: equityCents / book.initialCashCents - 1,
    realizedPnlCents: book.realizedPnlCents,
    unrealizedPnlCents,
    feesCents: book.feesCents,
    drawdown: 1 - equityCents / book.peakEquityCents,
    complete: notices.length === 0,
    positionCount: book.positions.length,
    missingMinuteOrders,
    source: dataset.source,
    executionCost: policyBundle
      ? {
          modelVersion: policyBundle.modelVersion,
          policyDigest: policyBundle.payloadDigest,
        }
      : null,
  };
  if (
    equityCents - book.initialCashCents !==
    book.realizedPnlCents + unrealizedPnlCents
  )
    throw new Error("资金账本与盈亏不一致");
  if (book.cashCents < 0) throw new Error("模拟账户不能透支");
  return { book, ledger, equity, outcomes, notices };
}

export function executeFill(
  book,
  plan,
  dataset,
  prices,
  ledger,
  order,
  side,
  desiredQuantity,
  event,
  execution = null,
) {
  // 版本分派（§3.2/§5.4）：旧计划无政策标记 → 明确分派旧 10bps 兼容执行器；
  // 新版本计划缺政策/摘要或版本未知 → 暂停执行，不静默回退。
  const bundle = executionPolicyBundle(plan);
  if (!bundle) return executeFillLegacy(...arguments);
  return executeFillWithCostModel(
    book,
    plan,
    dataset,
    prices,
    ledger,
    order,
    side,
    desiredQuantity,
    event,
    execution,
    bundle,
  );
}

// 校验并返回计划冻结的成本政策 bundle；旧计划返回 null。
export function executionPolicyBundle(plan) {
  const bundle = plan?.executionCostPolicy ?? null;
  if (!bundle && !plan?.executionCostModel) return null;
  if (!bundle?.payload || !bundle?.payloadDigest)
    throw new Error("计划版本要求成本政策，但缺少政策或摘要，暂停执行");
  if (bundle.modelVersion !== EXECUTION_COST_MODEL)
    throw new Error(`未知执行成本模型 ${bundle.modelVersion}，暂停执行`);
  return bundle;
}

function executeFillWithCostModel(
  book,
  plan,
  dataset,
  prices,
  ledger,
  order,
  side,
  desiredQuantity,
  event,
  execution,
  bundle,
) {
  const date = dataset.date;
  const quotes = dataset.quotes;
  const feeConfig = plan?.feeConfig || LEGACY_FEES;
  const feeModel = plan?.feeModel || "legacy-v1";
  // 计划冻结的风控约束（§3.2 同一模式）：旧计划回退默认值。
  const riskLimits = planRiskLimits(plan);
  const quote = quotes[order.code];
  const point = event.priceCents;
  if (
    (side === "BUY" && quote.limitUpCents && point >= quote.limitUpCents) ||
    (side === "SELL" && quote.limitDownCents && point <= quote.limitDownCents)
  )
    return {
      ok: false,
      reason: side === "BUY" ? "涨停排队不假设成交" : "跌停卖出不假设成交",
    };
  let position = book.positions.find((item) => item.code === order.code);
  let desired =
    side === "BUY"
      ? roundLot(desiredQuantity)
      : Math.min(
          desiredQuantity,
          position ? availableQuantity(position, date) : 0,
        );
  // 同股区间共享容量与冲击游标（§4.4）：保护单、普通卖单、买单和 T 两腿
  // 共享同股区间的绝对成交容量；只有成交成功才推进状态。
  const context = buildExecutionContext({
    plan,
    code: order.code,
    event,
    quote,
    intervalState: execution?.byCode?.[order.code] ?? null,
  });
  let capCents = null;
  if (side === "BUY") {
    const value = book.positions.reduce(
      (sum, item) =>
        sum + totalQuantity(item) * (prices.get(item.code) || item.markCents),
      0,
    );
    const equity = book.cashCents + value;
    const current = position
      ? totalQuantity(position) * (prices.get(order.code) || point)
      : 0;
    capCents = Math.min(
      book.cashCents,
      equity * riskLimits.maxPositionWeight - current,
      // 成交上限必须读周期口径：周期 20% 时不能按账户原始 60% 放行，
      // 否则会出现实际敞口突破周期上限的回归。
      equity * resolveExposureCap(riskLimits, plan?.cycle) - value,
    );
  }
  const allocationLimits =
    side === "BUY" && plan.strategyProgram
      ? remainingEntryAllocations(
          plan,
          book,
          order,
          order.maxPriceCents ?? point,
          (notional, fillSide) =>
            transactionFees(notional, fillSide, feeConfig, feeModel).total,
        )
      : null;
  if (allocationLimits)
    desired = Math.min(
      desired,
      allocationLimits.reduce((n, row) => n + row.quantity, 0),
    );
  const solved = solveFillQuantity({
    policy: bundle,
    context,
    side,
    desiredQuantity: desired,
    limits: {
      maxPriceCents: order.maxPriceCents,
      limitUpCents: quote.limitUpCents,
      limitDownCents: quote.limitDownCents,
      capCents,
      availableQuantity: desired,
    },
    estimateFees: (notional, fillSide) =>
      transactionFees(notional, fillSide, feeConfig, feeModel).total,
  });
  if (!solved.quantity)
    return {
      ok: false,
      reason: solved.reason,
      detail: solved.detail,
      executionCost: solved.executionCost?.costBreakdown ?? null,
    };
  if (execution) execution.byCode[order.code] = solved.nextIntervalState;
  const fillPriceCents = solved.executionCost.fillPriceCents;
  const quantity = solved.quantity;
  const notional = quantity * fillPriceCents;
  const fees = transactionFees(notional, side, feeConfig, feeModel);
  const strategyAllocations = plan.strategyProgram
    ? side === "BUY"
      ? fillAllocations(order, quantity, position, allocationLimits)
      : []
    : null;
  let basisCents = 0;
  let realizedPnlCents = 0;
  const cashDeltaCents =
    side === "BUY" ? -notional - fees.total : notional - fees.total;
  if (side === "BUY") {
    if (!position) {
      position = {
        code: order.code,
        name: order.name,
        sector: order.sector,
        lots: [],
        heldDays: 0,
        markCents: point,
        lastScore: order.score,
        markDate: date,
      };
      book.positions.push(position);
    }
    // 方案 6：管理类别随建仓/加仓订单回填（降级后类别保持不升级）。
    if (order.stockClass) position.stockClass = order.stockClass;
    position.lots.push({
      acquiredDate: date,
      quantity,
      costCents: notional + fees.total,
      priceCents: fillPriceCents,
      ...(strategyAllocations
        ? { strategyAllocations: structuredClone(strategyAllocations) }
        : {}),
    });
  } else {
    basisCents = consumeLots(
      position,
      quantity,
      date,
      strategyAllocations,
      order.pyramidRung ?? null,
    );
    realizedPnlCents = cashDeltaCents - basisCents;
    book.realizedPnlCents += realizedPnlCents;
  }
  book.cashCents += cashDeltaCents;
  book.feesCents += fees.total;
  const allocationFees = strategyAllocations
    ? recordAllocationFees(
        book,
        plan,
        strategyAllocations,
        fees.total,
        quantity,
      )
    : null;
  prices.set(order.code, point);
  ledger.push({
    id: `${date}:${order.id}:${ledger.length}`,
    date,
    signalDate: plan.signalDate,
    sequence: ledger.length,
    time: event.time,
    code: order.code,
    name: order.name,
    action: order.action,
    side,
    quantity,
    priceCents: fillPriceCents,
    notionalCents: notional,
    feeCents: fees.total,
    ...(side === "BUY" && order.buyPoint?.primary
      ? { buyPoint: order.buyPoint.primary.type }
      : {}),
    feeBreakdown: fees,
    ...(feeModel === "itemized-v2"
      ? {
          feeModel,
          feeConfig: structuredClone(feeConfig),
          feeConfigVersion: plan.feeConfigVersion || 1,
        }
      : {}),
    cashDeltaCents,
    basisCents,
    realizedPnlCents,
    cashAfterCents: book.cashCents,
    strategyVersion: plan.strategyVersion,
    dataQuality: event.quality,
    source: dataset.source,
    sourcePriceCents: point,
    executionCost: solved.executionCost.costBreakdown,
    ...(strategyAllocations
      ? {
          strategyAllocations: strategyAllocations.map((row, index) => ({
            ...row,
            feeCents: allocationFees[index],
            notionalCents: row.quantity * fillPriceCents,
          })),
          strategySpaceVersion: plan.strategyProgram.version,
        }
      : {}),
  });
  return { ok: true, quantity, priceCents: fillPriceCents };
}

// 旧 10bps 兼容执行器（LEGACY_FIXED_10BPS_V1）：历史计划与旧导出重放
// 仍按原 Math.round、10bps 及原容量规则执行（§5.4），不得重写历史成交。
function executeFillLegacy(
  book,
  plan,
  dataset,
  prices,
  ledger,
  order,
  side,
  desiredQuantity,
  event,
) {
  const date = dataset.date;
  const quotes = dataset.quotes;
  const feeConfig = plan?.feeConfig || LEGACY_FEES;
  const feeModel = plan?.feeModel || "legacy-v1";
  const quote = quotes[order.code];
  const point = event.priceCents;
  if (
    (side === "BUY" && quote.limitUpCents && point >= quote.limitUpCents) ||
    (side === "SELL" && quote.limitDownCents && point <= quote.limitDownCents)
  )
    return {
      ok: false,
      reason: side === "BUY" ? "涨停排队不假设成交" : "跌停卖出不假设成交",
    };
  let position = book.positions.find((item) => item.code === order.code);
  let quantity =
    side === "BUY"
      ? roundLot(desiredQuantity)
      : Math.min(
          desiredQuantity,
          position ? availableQuantity(position, date) : 0,
        );
  if (event.volumeShares !== null)
    quantity = Math.min(
      quantity,
      roundLot(event.volumeShares * RISK_LIMITS.maxParticipation),
    );
  const priceCents = Math.round(
    point * (1 + ((side === "BUY" ? 1 : -1) * RISK_LIMITS.slippageBps) / 10000),
  );
  if (side === "BUY" && order.maxPriceCents && priceCents > order.maxPriceCents)
    return { ok: false, reason: "含滑点价格超过事前买入上限" };
  if (
    (side === "BUY" &&
      quote.limitUpCents &&
      priceCents >= quote.limitUpCents) ||
    (side === "SELL" &&
      quote.limitDownCents &&
      priceCents <= quote.limitDownCents)
  )
    return { ok: false, reason: "加入滑点后触及涨跌停边界" };
  if (side === "BUY") {
    const value = book.positions.reduce(
      (sum, item) =>
        sum + totalQuantity(item) * (prices.get(item.code) || item.markCents),
      0,
    );
    const equity = book.cashCents + value;
    const current = position
      ? totalQuantity(position) * (prices.get(order.code) || point)
      : 0;
    const cap = Math.min(
      book.cashCents,
      equity * RISK_LIMITS.maxPositionWeight - current,
      equity * RISK_LIMITS.maxGrossExposure - value,
    );
    quantity = Math.min(
      quantity,
      roundLot(Math.max(0, cap - 1000) / priceCents),
    );
    while (
      quantity >= 100 &&
      quantity * priceCents +
        transactionFees(quantity * priceCents, side, feeConfig, feeModel)
          .total >
        cap
    )
      quantity -= 100;
  }
  if (quantity <= 0 || (side === "BUY" && quantity < 100))
    return {
      ok: false,
      reason:
        side === "SELL"
          ? "没有 T+1 可卖底仓或流动性不足"
          : "现金、仓位或流动性约束不足一手",
    };
  const notional = quantity * priceCents;
  const fees = transactionFees(notional, side, feeConfig, feeModel);
  let basisCents = 0;
  let realizedPnlCents = 0;
  const cashDeltaCents =
    side === "BUY" ? -notional - fees.total : notional - fees.total;
  if (side === "BUY") {
    if (!position) {
      position = {
        code: order.code,
        name: order.name,
        sector: order.sector,
        lots: [],
        heldDays: 0,
        markCents: point,
        lastScore: order.score,
        markDate: date,
      };
      book.positions.push(position);
    }
    // 方案 6：管理类别随建仓/加仓订单回填（降级后类别保持不升级）。
    if (order.stockClass) position.stockClass = order.stockClass;
    position.lots.push({
      acquiredDate: date,
      quantity,
      costCents: notional + fees.total,
      priceCents,
    });
  } else {
    basisCents = consumeLots(
      position,
      quantity,
      date,
      null,
      order.pyramidRung ?? null,
    );
    realizedPnlCents = cashDeltaCents - basisCents;
    book.realizedPnlCents += realizedPnlCents;
  }
  book.cashCents += cashDeltaCents;
  book.feesCents += fees.total;
  prices.set(order.code, point);
  ledger.push({
    id: `${date}:${order.id}:${ledger.length}`,
    date,
    signalDate: plan.signalDate,
    sequence: ledger.length,
    time: event.time,
    code: order.code,
    name: order.name,
    action: order.action,
    side,
    quantity,
    priceCents,
    notionalCents: notional,
    feeCents: fees.total,
    feeBreakdown: fees,
    ...(feeModel === "itemized-v2"
      ? {
          feeModel,
          feeConfig: structuredClone(feeConfig),
          feeConfigVersion: plan.feeConfigVersion || 1,
        }
      : {}),
    cashDeltaCents,
    basisCents,
    realizedPnlCents,
    cashAfterCents: book.cashCents,
    strategyVersion: plan.strategyVersion,
    dataQuality: event.quality,
    source: dataset.source,
    sourcePriceCents: point,
  });
  return { ok: true, quantity, priceCents };
}

export function completeMinutes(bars) {
  if (bars.length < 230 || bars[0].time > "09:35" || bars.at(-1).time < "14:55")
    return false;
  const minutes = (time) =>
    Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  return bars.every(
    (bar, index) =>
      /^\d{2}:\d{2}$/.test(bar.time) &&
      bar.priceCents > 0 &&
      Number.isFinite(bar.volumeShares) &&
      bar.volumeShares >= 0 &&
      (!index ||
        (bars[index - 1].time < bar.time &&
          (minutes(bar.time) - minutes(bars[index - 1].time) <= 5 ||
            (bars[index - 1].time >= "11:25" && bar.time <= "13:05")))),
  );
}

export function auditLedger(initialCashCents, ledger, latestEquity, positions) {
  const cashCents =
    initialCashCents +
    ledger.reduce((sum, fill) => sum + fill.cashDeltaCents, 0);
  const realizedPnlCents = ledger.reduce(
    (sum, fill) => sum + fill.realizedPnlCents,
    0,
  );
  const marketValueCents = positions.reduce(
    (sum, position) => sum + totalQuantity(position) * position.markCents,
    0,
  );
  const unrealizedPnlCents = positions.reduce(
    (sum, position) =>
      sum + totalQuantity(position) * position.markCents - costBasis(position),
    0,
  );
  const checks = {
    cash: cashCents === latestEquity.cashCents,
    equity: cashCents + marketValueCents === latestEquity.equityCents,
    pnl:
      latestEquity.equityCents - initialCashCents ===
      realizedPnlCents + unrealizedPnlCents,
    fees:
      ledger.reduce((sum, fill) => sum + fill.feeCents, 0) ===
      latestEquity.feesCents,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    cashCents,
    equityCents: cashCents + marketValueCents,
    realizedPnlCents,
    unrealizedPnlCents,
    formula:
      "权益 = 初始资金 + 全部成交现金流 + 当前持仓市值；累计盈亏 = 已实现盈亏 + 浮动盈亏",
  };
}
