import { digestOf } from "./research-lineage.js";
import { buildExecutionReview } from "./execution-review.js";
import {
  PRACTICE_REVIEW_KIND,
  PRACTICE_SCHEMA_VERSION,
  PRACTICE_FEATURE_VERSION,
} from "../../shared/practice.js";

const qty = (p) => (p?.lots ?? []).reduce((n, l) => n + l.quantity, 0);
const basis = (p) => (p?.lots ?? []).reduce((n, l) => n + l.costCents, 0);
const finite = Number.isFinite;
const total = (rows, field) =>
  rows.every((r) => finite(r[field]))
    ? rows.reduce((n, r) => n + r[field], 0)
    : null;

export function completedPracticeCycles(fills) {
  const groups = new Map();
  for (const f of fills) {
    if (!f.cycleId) continue;
    if (!groups.has(f.cycleId)) groups.set(f.cycleId, []);
    groups.get(f.cycleId).push(f);
  }
  return [...groups].flatMap(([id, rows]) => {
    rows.sort(
      (a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence,
    );
    // A carried position with no archived OPEN is not a newly observed round.
    if (rows[0].intent !== "OPEN" && rows[0].action !== "OPEN") return [];
    let balance = 0;
    for (const f of rows) {
      balance += f.side === "BUY" ? f.quantity : -f.quantity;
      if (balance < 0 || !Number.isSafeInteger(f.cashDeltaCents)) return [];
    }
    if (balance !== 0) return [];
    const first = rows[0],
      last = rows.at(-1);
    return [
      {
        id,
        code: first.code,
        openedDate: first.date,
        closedDate: last.date,
        buyPoint: first.buyPoint ?? first.entryEvidence?.buyPoint ?? null,
        phase: first.entryEvidence?.phase ?? "unknown",
        operations: [
          ...new Set(
            rows
              .map((f) => f.intent ?? f.action)
              .filter((v) => /^(ADD_|T_)/.test(v)),
          ),
        ].sort(),
        operationCombination:
          [
            ...new Set(
              rows
                .map((f) => f.intent ?? f.action)
                .filter((v) => /^(ADD_|T_)/.test(v)),
            ),
          ]
            .sort()
            .join("+") || "OPEN_EXIT",
        protectiveExit: rows.some((f) =>
          ["EXIT", "REDUCE"].includes(f.intent ?? f.action),
        ),
        netPnlCents: total(rows, "cashDeltaCents"),
        feeCents: total(rows, "feeCents"),
        holdingCalendarDays: Math.round(
          (Date.parse(last.date) - Date.parse(first.date)) / 86400000,
        ),
      },
    ];
  });
}

function cycleStats(cycles) {
  const gains = cycles.filter((c) => c.netPnlCents > 0);
  const losses = cycles.filter((c) => c.netPnlCents < 0);
  const gain = gains.reduce((n, c) => n + c.netPnlCents, 0);
  const loss = -losses.reduce((n, c) => n + c.netPnlCents, 0);
  return {
    completedRounds: cycles.length,
    winRate: cycles.length ? gains.length / cycles.length : null,
    profitFactor: loss ? gain / loss : null,
    averageWinLossRatio:
      gains.length && losses.length
        ? gain / gains.length / (loss / losses.length)
        : null,
    netPnlCents: cycles.reduce((n, c) => n + c.netPnlCents, 0),
    averageHoldingCalendarDays: cycles.length
      ? cycles.reduce((n, c) => n + c.holdingCalendarDays, 0) / cycles.length
      : null,
    protectiveExitRounds: cycles.filter((c) => c.protectiveExit).length,
  };
}

export function practiceCycleGroups(cycles, field) {
  const keys = [...new Set(cycles.map((c) => c[field] ?? "unknown"))].sort();
  return keys.map((key) => ({
    key,
    ...cycleStats(cycles.filter((c) => (c[field] ?? "unknown") === key)),
  }));
}

export async function buildPracticeReview({
  date,
  session,
  fills,
  dataset,
  equity,
  coverage,
  historicalFills = [],
  observations = [],
  createdAt = new Date().toISOString(),
}) {
  const traded = await buildExecutionReview({
    date,
    session,
    fills,
    dataset,
    equity,
    createdAt,
  });
  const opening = session.initialBook;
  const closing = session.closingBook;
  const openingPositions = new Map(
    (opening.positions ?? []).map((p) => [p.code, p]),
  );
  const closingPositions = new Map(
    (closing?.positions ?? []).map((p) => [p.code, p]),
  );
  const histories = session.plan.entryExecutionPolicy?.history ?? {};
  const decisions = structuredClone(
    Object.values(session.practice?.decisions ?? {}),
  );
  const candidates = Object.keys(session.entryState?.admissions ?? {});
  const codes = [
    ...new Set([
      ...openingPositions.keys(),
      ...closingPositions.keys(),
      ...candidates,
      ...fills.map((f) => f.code),
      ...(session.orders ?? []).map((o) => o.code),
    ]),
  ].sort();
  const reasons = [...traded.sourceReasons];
  if (!closing) reasons.push("缺少不可变期末持仓与风险状态");
  const accountVerified =
    !!closing &&
    ["cashCents", "equityCents", "feesCents", "realizedPnlCents"].every(
      (k) => Number.isSafeInteger(closing[k]) && closing[k] === equity[k],
    ) &&
    Number.isSafeInteger(opening.equityCents) &&
    opening.equityCents > 0 &&
    traded.sourceReasons.length === 0;
  if (closing && !accountVerified) reasons.push("期末账本与权威收盘结算不一致");
  const rows = codes.map((code) => {
    const initial = openingPositions.get(code),
      final = closingPositions.get(code);
    const existing = traded.rows.find((r) => r.code === code);
    const trades = fills.filter((f) => f.code === code);
    const localDecisions = decisions
      .filter((d) => d.code === code)
      .sort(
        (a, b) =>
          String(a.last.observedAt).localeCompare(String(b.last.observedAt)) ||
          a.last.observationSequence - b.last.observationSequence,
      );
    const cash = trades.reduce((n, f) => n + f.cashDeltaCents, 0);
    const initialValue = qty(initial) * (initial?.markCents ?? 0);
    const finalValue = qty(final) * (final?.markCents ?? 0);
    const expectedQuantity =
      qty(initial) +
      trades.reduce(
        (n, f) => n + (f.side === "BUY" ? f.quantity : -f.quantity),
        0,
      );
    const verified = accountVerified && expectedQuantity === qty(final);
    const firstEntry = trades.find((f) => (f.intent ?? f.action) === "OPEN");
    const enteredAt = firstEntry?.entryEvidence?.observedAt;
    const prices = enteredAt
      ? observations
          .filter(
            (o) =>
              o.observedAt >= enteredAt &&
              o.quotes?.[code]?.date === date &&
              finite(o.quotes[code].closeCents),
          )
          .map((o) => o.quotes[code].closeCents)
      : [];
    const price = firstEntry?.priceCents;
    const entryRisk = initial?.dragon ?? final?.dragon;
    const risk = entryRisk
      ? {
          p0Cents: entryRisk.p0Cents,
          r0Cents: entryRisk.r0Cents,
          stopCents: entryRisk.stopCents,
          stage: entryRisk.stage,
          heldDays: final?.heldDays ?? initial?.heldDays,
          pendingExit: !!entryRisk.exit,
          pendingT: !!final?.dragon?.t,
          currentR:
            entryRisk.r0Cents > 0 && final
              ? (final.markCents - entryRisk.p0Cents) / entryRisk.r0Cents
              : null,
        }
      : null;
    return {
      ...(existing ?? {}),
      code,
      name:
        existing?.name ??
        initial?.name ??
        final?.name ??
        histories[code]?.name ??
        code,
      sector:
        existing?.sector ??
        initial?.sector ??
        final?.sector ??
        histories[code]?.sector ??
        "未知行业",
      role: initial || final || trades.length ? "POSITION" : "CANDIDATE",
      openingQuantity: qty(initial),
      endingQuantity: qty(final),
      fillCount: trades.length,
      actions: [...new Set(trades.map((f) => f.intent ?? f.action))],
      buyPoints: existing?.buyPoints ?? [],
      buy: existing?.buy ?? {
        quantity: 0,
        notionalCents: 0,
        averagePriceCents: null,
      },
      sell: existing?.sell ?? {
        quantity: 0,
        notionalCents: 0,
        averagePriceCents: null,
      },
      dailyPnlCents: verified ? cash + finalValue - initialValue : null,
      realizedPnlCents: verified
        ? trades.reduce((n, f) => n + f.realizedPnlCents, 0)
        : null,
      unrealizedPnlCents: verified ? finalValue - basis(final) : null,
      feeCents: verified ? trades.reduce((n, f) => n + f.feeCents, 0) : null,
      actualCloseCents:
        final?.markCents ?? dataset.quotes?.[code]?.closeCents ?? null,
      available: verified,
      financialAvailable: verified,
      reasons: [
        ...(existing?.reasons ?? []),
        ...(!verified ? ["逐股期初、成交及期末状态未核对"] : []),
      ],
      execution: (session.orders ?? [])
        .filter((o) => o.code === code)
        .map((o) => ({
          id: o.id,
          action: o.intent ?? o.action,
          status: o.status,
          reason: o.reason ?? null,
          quantity: o.quantity,
          filledQuantity: o.filledQuantity,
          stopCents: o.stopCents ?? null,
        })),
      risk,
      decisions: localDecisions,
      observationStatus: trades.length
        ? "FILLED"
        : (localDecisions.at(-1)?.reasonCode ?? "UNKNOWN"),
      observedExcursion:
        prices.length && coverage?.complete && price > 0
          ? {
              favorable: Math.max(...prices) / price - 1,
              adverse: Math.min(...prices) / price - 1,
              scope: "ENTRY_TO_LAST_OBSERVED",
              count: prices.length,
            }
          : null,
      fills: structuredClone(trades),
    };
  });
  const dailyPnl = accountVerified
    ? closing.equityCents - opening.equityCents
    : null;
  const reconciled =
    dailyPnl !== null && total(rows, "dailyPnlCents") === dailyPnl;
  if (accountVerified && !reconciled)
    reasons.push("全账户与逐股当日损益无法加总核对");
  const valid = accountVerified && reconciled;
  const cycles = completedPracticeCycles([
    ...historicalFills.filter((f) => f.date < date),
    ...fills,
  ]);
  const todayCycles = cycles.filter((c) => c.closedDate === date);
  const tRecords = (closing?.dragonTRecords ?? []).filter(
    (t) => t.completedDate === date,
  );
  const operationKeys = [
    ...new Set(fills.map((f) => f.intent ?? f.action)),
  ].sort();
  const operations = operationKeys.map((key) => {
    const selected = fills.filter((f) => (f.intent ?? f.action) === key);
    return {
      key,
      fillCount: selected.length,
      quantity: selected.reduce((n, f) => n + f.quantity, 0),
      feeCents: total(selected, "feeCents"),
      notionalCents: total(selected, "notionalCents"),
    };
  });
  const summary = {
    stockCount: rows.filter((r) => r.fillCount > 0).length,
    positionCount: closing?.positions.length ?? null,
    candidateCount: candidates.length,
    fillCount: fills.length,
    validCount: rows.filter((r) => r.available).length,
    dailyPnlCents: valid ? dailyPnl : null,
    realizedPnlCents: valid
      ? closing.realizedPnlCents - opening.realizedPnlCents
      : null,
    unrealizedPnlCents: valid ? equity.unrealizedPnlCents : null,
    feeCents: valid ? closing.feesCents - opening.feesCents : null,
    buyNotionalCents: fills
      .filter((f) => f.side === "BUY")
      .reduce((n, f) => n + f.notionalCents, 0),
    sellNotionalCents: fills
      .filter((f) => f.side === "SELL")
      .reduce((n, f) => n + f.notionalCents, 0),
    ...cycleStats(todayCycles),
    completedTNetPnlCents: tRecords
      .filter((r) => r.status === "COMPLETED")
      .reduce((n, r) => n + r.netPnlCents, 0),
    completedTCount: tRecords.filter((r) => r.status === "COMPLETED").length,
    incompleteTCount: (closing?.positions ?? []).filter((p) => p.dragon?.t)
      .length,
  };
  // cycleStats.netPnlCents is closed-cycle P&L, not today's account P&L.
  const account = {
    verified: valid,
    openingEquityCents: opening.equityCents,
    closingEquityCents: valid ? closing.equityCents : null,
    cashCents: valid ? closing.cashCents : null,
    marketValueCents: valid ? closing.equityCents - closing.cashCents : null,
    dailyPnlCents: valid ? dailyPnl : null,
    dailyReturn: valid ? dailyPnl / opening.equityCents : null,
    drawdown: valid ? equity.drawdown : null,
    maxObservedDrawdown: valid
      ? (equity.maxObservedDrawdown ?? equity.drawdown)
      : null,
    maxObservedDailyLoss: valid ? (equity.maxObservedDailyLoss ?? null) : null,
    grossExposure: valid ? 1 - closing.cashCents / closing.equityCents : null,
    halted: closing?.dragonHalted ?? null,
    dailyPaused: session.dailyPaused ?? null,
    riskLimits: structuredClone(
      session.plan.dragonPolicy?.config?.risk ?? null,
    ),
  };
  const sources = {
    ...traded.sources,
    closingBookDigest: closing ? await digestOf(closing) : null,
    decisionDigest: await digestOf(decisions),
    coverageDigest: await digestOf(coverage ?? null),
    cycleHistoryDigest: await digestOf(cycles),
    observationDigest: await digestOf(observations),
  };
  const status = !valid ? "PARTIAL" : !fills.length ? "NO_TRADES" : "COMPLETE";
  const result = {
    ...traded,
    reviewKind: PRACTICE_REVIEW_KIND,
    schemaVersion: PRACTICE_SCHEMA_VERSION,
    modelVersion: PRACTICE_FEATURE_VERSION,
    status,
    summary,
    account,
    rows,
    total: rows.length,
    validCount: summary.validCount,
    coverage: coverage ?? { complete: false, reasons: ["缺少完整观测核验"] },
    financialStatus: valid ? "VERIFIED" : "UNVERIFIABLE",
    researchEligible:
      valid &&
      coverage?.complete === true &&
      session.practice?.startedSequence === 0,
    aiEligible: valid || decisions.length > 0,
    policy: {
      ...traded.policy,
      tradingCycleId: opening.tradingCycleId ?? null,
    },
    decisions,
    cycles: todayCycles,
    tRecords,
    attribution: {
      byBuyPoint: practiceCycleGroups(todayCycles, "buyPoint"),
      byPhase: practiceCycleGroups(todayCycles, "phase"),
      byOperationCombination: practiceCycleGroups(
        todayCycles,
        "operationCombination",
      ),
      operations,
      note: "完整周期按首次建仓买点、市场阶段及实际加仓/做T组合分组，组合组互斥。操作表只统计成交与费用；组合相关性不代表单项操作的因果收益。",
    },
    sectors: [...new Set(rows.map((r) => r.sector))].map((name) => {
      const selected = rows.filter((r) => r.sector === name);
      return {
        name,
        stockCount: selected.length,
        fillCount: selected.reduce((n, r) => n + r.fillCount, 0),
        dailyPnlCents: total(selected, "dailyPnlCents"),
        feeCents: total(selected, "feeCents"),
      };
    }),
    sources,
    sourceDigest: await digestOf(sources),
    sourceReasons: [...new Set(reasons)],
    conclusion: !valid
      ? "账户归档尚不能完整核对，已知事实与缺口分别保留。"
      : !fills.length
        ? "当日无成交；全账户持仓损益及候选过程已核对，空仓或未成交原因见执行记录。"
        : "全账户损益已与权益变化核对；盈利模式结论须经独立对照验证。",
    caveat:
      "成交费用及执行成本已经入账；做T净价差属于账户收益的一部分。完整周期统计、当日损益和持仓浮盈采用不同口径，不能直接相加；未知数据不按零处理。",
  };
  result.sources.featureDigest = await digestOf(practiceFeatures(result));
  result.sourceDigest = await digestOf(result.sources);
  return result;
}

// This deliberately projects objective fields only: never copy ai_payload or prose.
export function practiceFeatures(review) {
  const grouped = new Map();
  for (const d of review.decisions ?? []) {
    const key = [d.intent, d.reasonCode, d.phase, d.buyPoint ?? ""].join("|");
    const item = grouped.get(key) ?? {
      intent: d.intent,
      reasonCode: d.reasonCode,
      phase: d.phase,
      buyPoint: d.buyPoint,
      codes: new Set(),
      observations: 0,
    };
    if (d.code) item.codes.add(d.code);
    item.observations += d.observations;
    grouped.set(key, item);
  }
  return {
    version: PRACTICE_FEATURE_VERSION,
    date: review.date,
    policy: structuredClone(review.policy),
    status: review.status,
    account: structuredClone(review.account),
    summary: structuredClone(review.summary),
    coverage: structuredClone(review.coverage),
    researchEligible: review.researchEligible,
    attribution: structuredClone(review.attribution),
    decisions: [...grouped.values()].map(({ codes, ...entry }) => ({
      ...entry,
      candidateCount: codes.size,
    })),
    positions: (review.rows ?? [])
      .filter((r) => r.role === "POSITION")
      .map((r) => ({
        code: r.code,
        openingQuantity: r.openingQuantity,
        endingQuantity: r.endingQuantity,
        dailyPnlCents: r.dailyPnlCents,
        feeCents: r.feeCents,
        risk: r.risk,
        observedExcursion: r.observedExcursion,
      })),
    cycles: structuredClone(review.cycles ?? []),
  };
}
