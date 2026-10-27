import { PRACTICE_REASONS } from "../../shared/practice.js";
import { adaptiveEffective } from "../../shared/adaptive-risk.js";

// Aggregated facts are committed with the same account CAS as the observation.
// Counts describe observations, never independent trades or opportunities.
export function recordPracticeDecision(session, code, reasonCode, facts = {}) {
  if (session.practice?.disabled) return;
  if (!session.practice) {
    session.practice = {
      version: 1,
      startedSequence: session.sequence ?? 0,
      decisions: {},
    };
  }
  const phase = session.regime?.phase ?? "unknown";
  if (session.adaptiveRisk && !facts.adaptiveRisk) {
    const state = session.adaptiveRisk;
    const sector = state.stocks[code]?.sector;
    facts = {
      ...facts,
      adaptiveRisk: {
        version: state.version,
        observedAt: state.observedAt,
        marketTimestamp: state.market.observedAt,
        effective: adaptiveEffective(session.plan.dragonPolicy.config, state, {
          code: code ?? undefined,
          sector,
        }),
        reasons: [
          state.market.reasons,
          state.sectors[sector]?.reasons ?? [],
          state.stocks[code]?.reasons ?? [],
        ],
      },
    };
  }
  const intent = facts.intent ?? "OPEN";
  const key = [
    code ?? "account",
    intent,
    reasonCode,
    facts.buyPoint ?? "",
    phase,
  ].join("|");
  const at = session.lastObservedAt;
  const previous = session.practice.decisions[key];
  const reference = {
    observedAt: at,
    observationSequence: session.sequence,
    quoteTimestamp:
      session.quotes?.[code]?.timestamp ?? facts.quoteTimestamp ?? null,
    marketTimestamp: session.regime?.marketStamp ?? null,
  };
  session.practice.decisions[key] = {
    code,
    intent,
    reasonCode,
    reason: PRACTICE_REASONS[reasonCode] ?? reasonCode,
    phase,
    buyPoint: facts.buyPoint ?? null,
    first: previous?.first ?? reference,
    last: reference,
    observations: (previous?.observations ?? 0) + 1,
    facts: structuredClone(facts),
  };
}

export function observePracticeRisk(session, book) {
  session.practice ??= {
    version: 1,
    startedSequence: Math.max(0, session.sequence - 1),
    decisions: {},
  };
  session.practice.maxDrawdown = Math.max(
    session.practice.maxDrawdown ?? 0,
    1 - book.equityCents / book.peakEquityCents,
  );
  session.practice.maxDailyLoss = Math.max(
    session.practice.maxDailyLoss ?? 0,
    1 - book.equityCents / session.initialBook.equityCents,
  );
}
