import {
  normalizeStrategyProgram,
  FAMILY_DEFINITIONS,
  STRATEGY_SPACE_VERSION,
} from "../../shared/strategy-program.js";
import { EXPOSURE_TIERS_DEFAULTS } from "../../shared/strategy-params.js";
import { planRiskLimits } from "../../shared/risk-limits.js";
import { resolveExposureCap } from "../../shared/sentiment-cycle.js";
import { EXECUTION_COST_MODEL } from "../../shared/execution-cost.js";

export function familyEligibility(familyId, signal, snapshot) {
  if (!Object.hasOwn(FAMILY_DEFINITIONS, familyId))
    throw new Error("策略家族未登记");
  const boards = Object.hasOwn(signal, "consecutiveBoards")
    ? signal.consecutiveBoards
    : signal.height;
  const knownBoards = Number.isInteger(boards) && boards > 0;
  if (familyId === "cash-v1")
    return { eligible: false, reason: "现金防守不新增交易" };
  if (familyId === "first-board-v1")
    return {
      eligible: knownBoards && boards === 1,
      reason: "首板要求已知连续板数为 1",
    };
  if (familyId === "relay-board-v1")
    return {
      eligible: knownBoards && boards >= 2 && boards <= 4,
      reason: "连板要求已知连续板数为 2–4",
    };
  if (familyId === "low-turnover-v1")
    return {
      eligible:
        Number.isFinite(signal.turnover) &&
        signal.turnover >= 1 &&
        signal.turnover <= 8,
      reason: "低换手要求已知换手率为 1%–8%",
    };
  if (familyId === "sector-resonance-v1") {
    const count = new Set(
      snapshot.stocks
        .filter(
          (stock) =>
            stock.sector === signal.sector &&
            Number.isInteger(
              Object.hasOwn(stock, "consecutiveBoards")
                ? stock.consecutiveBoards
                : stock.height,
            ) &&
            (Object.hasOwn(stock, "consecutiveBoards")
              ? stock.consecutiveBoards
              : stock.height) > 0,
        )
        .map((stock) => stock.code),
    ).size;
    return {
      eligible: signal.sectorScore >= 65 && count >= 3,
      reason: "板块共振要求板块评分至少 65 且至少 3 只涨停",
    };
  }
  return { eligible: true, reason: "六因子家族" };
}
export function resolveStrategyProgram(strategy, snapshot) {
  if (!strategy.program) return null;
  const spec = normalizeStrategyProgram(strategy.program);
  const tiers = strategy.exposureTiers ?? EXPOSURE_TIERS_DEFAULTS;
  const emotion = snapshot.emotion;
  const knownEmotion =
    Number.isFinite(emotion) && emotion >= 0 && emotion <= 100;
  const regime = knownEmotion
    ? emotion >= tiers.highEmotion
      ? "high"
      : emotion >= tiers.midEmotion
        ? "mid"
        : "low"
    : "unknown";
  let components;
  if (spec.kind === "ALLOCATION") components = spec.components;
  else {
    const family =
      spec.kind === "FAMILY"
        ? spec.family
        : knownEmotion
          ? spec.regimes[regime]
          : { familyId: "cash-v1", familyVersion: 1 };
    components = [{ id: family.familyId, weightBps: 10000, family }];
  }
  return {
    version: STRATEGY_SPACE_VERSION,
    spec,
    signalDate: snapshot.date,
    emotion: knownEmotion ? emotion : null,
    regime,
    thresholds: {
      highEmotion: tiers.highEmotion,
      midEmotion: tiers.midEmotion,
    },
    components: structuredClone(components),
    holdingsRule: "SHARED_RISK_AND_EXIT",
    allocationPriority: "COMPONENT_ID_ASC",
    cashRule: "ONE_BOOK_NO_SYNTHETIC_TRANSFERS",
  };
}

// 旧仓或已退出的家族仍占用真实敞口；无法归属的旧仓按固定权重预留，绝不复制资金。
export function allocationState(program, book, targetExposure) {
  const ids = new Set(program.components.map((row) => row.id));
  const exposure = Object.fromEntries(
    program.components.map((row) => [row.id, 0]),
  );
  let inherited = 0;
  for (const position of book.positions)
    for (const lot of position.lots) {
      if (!lot.strategyAllocations) {
        inherited += lot.quantity * position.markCents;
        continue;
      }
      if (
        lot.strategyAllocations.some(
          (row) =>
            !Number.isSafeInteger(row.quantity) ||
            row.quantity <= 0 ||
            typeof row.componentId !== "string" ||
            typeof row.familyId !== "string",
        ) ||
        lot.strategyAllocations.reduce((n, row) => n + row.quantity, 0) !==
          lot.quantity
      )
        throw new Error("持仓策略分配与实际数量不一致");
      for (const row of lot.strategyAllocations) {
        if (ids.has(row.componentId))
          exposure[row.componentId] += row.quantity * position.markCents;
        else inherited += row.quantity * position.markCents;
      }
    }
  return program.components.map((row) => ({
    ...row,
    initialExposureCents:
      exposure[row.id] + Math.ceil((inherited * row.weightBps) / 10000),
    attributedExposureCents: exposure[row.id],
    capCents: Math.floor(
      (book.equityCents * targetExposure * row.weightBps) / 10000,
    ),
    plannedCents:
      exposure[row.id] + Math.ceil((inherited * row.weightBps) / 10000),
  }));
}
export function allocateEntry(
  signal,
  snapshot,
  components,
  quantity,
  priceCents,
) {
  let remaining = quantity;
  const allocations = [];
  for (const component of components) {
    if (
      !familyEligibility(component.family.familyId, signal, snapshot).eligible
    )
      continue;
    const allowed =
      Math.floor(
        Math.max(0, component.capCents - component.plannedCents) /
          priceCents /
          100,
      ) * 100;
    const share =
      Math.floor((quantity * component.weightBps) / 10000 / 100) * 100;
    const allocated = Math.min(remaining, allowed, share);
    if (allocated < 100) continue;
    allocations.push({
      componentId: component.id,
      familyId: component.family.familyId,
      quantity: allocated,
    });
    remaining -= allocated;
  }
  return { quantity: quantity - remaining, allocations };
}
export function chargeEntry(components, allocations, priceCents) {
  for (const row of allocations)
    components.find(
      (component) => component.id === row.componentId,
    ).plannedCents += row.quantity * priceCents;
}
// 成交按冻结的成员 id 顺序消耗需求；同股净订单只使用一次容量并收取一次真实费用。
export function fillAllocations(
  order,
  quantity,
  position,
  remainingAllocations = null,
) {
  const demand =
    remainingAllocations ??
    order.strategyAllocations ??
    (position
      ? position.lots.flatMap(
          (lot) =>
            lot.strategyAllocations ?? [
              {
                componentId: "carry",
                familyId: "inherited",
                quantity: lot.quantity,
              },
            ],
        )
      : []);
  if (!demand.length)
    return [{ componentId: "carry", familyId: "inherited", quantity }];
  const consumed = order.allocationFilled ?? {};
  let remaining = quantity;
  const rows = [];
  for (const row of demand) {
    const taken = Math.min(
      remaining,
      Math.max(
        0,
        row.quantity -
          (order.strategyAllocations && !remainingAllocations
            ? (consumed[row.componentId] ?? 0)
            : 0),
      ),
    );
    if (!taken) continue;
    const existing = rows.find(
      (item) =>
        item.componentId === row.componentId && item.familyId === row.familyId,
    );
    if (existing) existing.quantity += taken;
    else rows.push({ ...row, quantity: taken });
    remaining -= taken;
  }
  if (remaining) throw new Error("策略分配需求不足以覆盖实际成交");
  if (order.strategyAllocations) {
    order.allocationFilled ??= {};
    for (const row of rows)
      order.allocationFilled[row.componentId] =
        (consumed[row.componentId] ?? 0) + row.quantity;
  }
  return rows;
}
export function allocateCents(total, rows, quantity) {
  let used = 0;
  return rows.map((row, index) => {
    const value =
      index === rows.length - 1
        ? total - used
        : Math.floor((total * row.quantity) / quantity);
    used += value;
    return value;
  });
}

export function assertProgramPlan(plan, initialBook) {
  if (!plan?.strategy?.program) {
    if (plan?.strategyProgram) throw new Error("计划策略程序缺少参数声明");
    return;
  }
  const spec = normalizeStrategyProgram(plan.strategy.program);
  if (
    plan.strategyProgram?.snapshotDigest !==
    (plan.selectionAudit?.snapshotDigest ?? null)
  )
    throw new Error("策略程序快照引用与冻结选择摘要不一致");
  if (
    plan.executionCostModel !== EXECUTION_COST_MODEL ||
    !plan.executionCostPolicy
  )
    throw new Error("新策略程序必须使用冻结的统一成交成本政策");
  if (!plan.strategyProgram)
    throw new Error("策略程序计划缺少冻结选择与分配声明");
  const expected = resolveStrategyProgram(plan.strategy, {
    date: plan.signalDate,
    emotion: plan.emotion,
  });
  for (const key of [
    "version",
    "spec",
    "signalDate",
    "emotion",
    "regime",
    "thresholds",
    "components",
    "holdingsRule",
    "allocationPriority",
    "cashRule",
  ])
    if (
      JSON.stringify(plan.strategyProgram[key]) !==
      JSON.stringify(expected[key])
    )
      throw new Error("策略程序与冻结的情绪选择或分配声明不一致");
  if (initialBook) {
    const risk = planRiskLimits(plan);
    const tiers = plan.strategy.exposureTiers ?? EXPOSURE_TIERS_DEFAULTS;
    const dd = initialBook.peakEquityCents
      ? 1 - initialBook.equityCents / initialBook.peakEquityCents
      : 0;
    const desiredExposure =
      plan.sourceSnapshotMissing ||
      expected.regime === "unknown" ||
      dd >= risk.maxDrawdown
        ? 0
        : plan.emotion >= tiers.highEmotion
          ? tiers.high
          : plan.emotion >= tiers.midEmotion
            ? tiers.mid
            : tiers.low;
    // 与 createPlan 同一口径：周期闸门叠加账户硬限制。退潮 / 冰点期
    // 冻结的 targetExposure 与 resources 按周期上限计算，这里若只用
    // 账户原始 maxGrossExposure 重算会误报"资金上限与期初账本不一致"。
    const exposure = Math.min(
      desiredExposure,
      resolveExposureCap(risk, plan.cycle),
    );
    const resources = {
      initialEquityCents: initialBook.equityCents,
      components: allocationState(expected, initialBook, exposure),
    };
    if (
      plan.targetExposure !== exposure ||
      JSON.stringify(plan.strategyProgram.resources) !==
        JSON.stringify(resources)
    )
      throw new Error("冻结策略资金上限与实际期初账本不一致");
  }
  if (
    !plan.sourceSnapshotMissing &&
    plan.strategyProgram.regime === "unknown" &&
    plan.orders.some(
      (order) =>
        !order.recovery && (order.side === "BUY" || order.side === "PAIR"),
    )
  )
    throw new Error("情绪未知时不允许新增交易");
  const ids = new Set();
  for (const order of plan.orders) {
    if (ids.has(order.code)) throw new Error("共享策略同股需求未合并");
    ids.add(order.code);
    if (order.strategyAllocations) {
      if (
        new Set(order.strategyAllocations.map((row) => row.componentId))
          .size !== order.strategyAllocations.length ||
        order.side !== "BUY" ||
        order.strategyAllocations.some(
          (row) =>
            !Number.isInteger(row.quantity) ||
            row.quantity <= 0 ||
            !expected.components.some(
              (c) =>
                c.id === row.componentId && c.family.familyId === row.familyId,
            ),
        ) ||
        order.strategyAllocations.reduce((n, row) => n + row.quantity, 0) !==
          order.quantity
      )
        throw new Error("订单策略分配与数量或冻结成员不一致");
    } else if (order.action === "OPEN") throw new Error("建仓订单缺少策略分配");
  }
}

export function remainingEntryAllocations(
  plan,
  book,
  order,
  priceCents,
  feeEstimate,
) {
  if (!order.strategyAllocations) return null;
  const ownerExposure = {};
  for (const position of book.positions)
    for (const lot of position.lots)
      for (const row of lot.strategyAllocations ?? [])
        ownerExposure[row.componentId] =
          (ownerExposure[row.componentId] ?? 0) +
          row.quantity * position.markCents;
  const priorFees =
    book.allocationExecution?.signalDate === plan.signalDate
      ? book.allocationExecution.feesByComponent
      : {};
  return order.strategyAllocations
    .map((row) => {
      const component = plan.strategyProgram.resources.components.find(
        (component) => component.id === row.componentId,
      );
      // 继承旧仓预留固定保留到当日结束；卖出前不借用预计回款。
      const remainingCents =
        component.capCents -
        Math.max(
          0,
          component.initialExposureCents - component.attributedExposureCents,
        ) -
        (ownerExposure[row.componentId] ?? 0) -
        (priorFees[row.componentId] ?? 0);
      const outstanding =
        row.quantity - (order.allocationFilled?.[row.componentId] ?? 0);
      let quantity = Math.min(
        outstanding,
        Math.floor(Math.max(0, remainingCents) / priceCents / 100) * 100,
      );
      const roundingReserve =
        order.strategyAllocations.length > 1
          ? order.strategyAllocations.length + 6
          : 0;
      while (
        quantity > 0 &&
        quantity * priceCents +
          feeEstimate(quantity * priceCents, "BUY") +
          roundingReserve >
          remainingCents
      )
        quantity -= 100;
      return { ...row, quantity };
    })
    .filter((row) => row.quantity > 0);
}

export function recordAllocationFees(book, plan, rows, total, quantity) {
  if (book.allocationExecution?.signalDate !== plan.signalDate)
    book.allocationExecution = {
      signalDate: plan.signalDate,
      feesByComponent: {},
    };
  const parts = allocateCents(total, rows, quantity);
  rows.forEach(
    (row, index) =>
      (book.allocationExecution.feesByComponent[row.componentId] =
        (book.allocationExecution.feesByComponent[row.componentId] ?? 0) +
        parts[index]),
  );
  return parts;
}
