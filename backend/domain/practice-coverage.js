import {
  ADAPTIVE_RISK_POLICY,
  hasAdaptiveMarketEvidence,
} from "../../shared/adaptive-risk.js";
const at = (date, time) => Date.parse(`${date}T${time}+08:00`);
const localTime = (stamp) =>
  new Date(Date.parse(stamp) + 8 * 3600000).toISOString().slice(11, 19);
const fresh = (stamp, now, maxAge = 15000) =>
  Number.isFinite(Date.parse(stamp)) &&
  now >= Date.parse(stamp) &&
  now - Date.parse(stamp) <= maxAge;

// Coverage is independent from profitability and never fills a missing path.
export function practiceCoverage({
  date,
  session,
  frames = [],
  closingFrames = [],
}) {
  const gaps = new Map();
  const gap = (field, code = null) => {
    const key = `${field}:${code}`;
    const old = gaps.get(key);
    gaps.set(key, { field, code, occurrences: (old?.occurrences ?? 0) + 1 });
  };
  const observations = frames.map((f) => f.payload ?? f);
  const times = [];
  const previous = new Map();
  const admissions = session.entryState?.admissions ?? {};
  const held = (session.initialBook.positions ?? []).map((p) => p.code);
  const codes = [...new Set([...Object.keys(admissions), ...held])];
  const dynamic = !!session.plan.dragonPolicy?.adaptiveRiskPolicy;
  let last = -Infinity;
  for (const o of observations) {
    const time = Date.parse(o.observedAt);
    if (!Number.isFinite(time) || time <= last) {
      gap("frameOrder");
      continue;
    }
    last = time;
    const clock = localTime(o.observedAt);
    if (
      !(
        (clock >= "09:30:00" && clock <= "11:30:00") ||
        (clock >= "13:00:00" && clock < "14:57:00")
      )
    )
      continue;
    if (o.pollIntervalSeconds > 20 || !(o.pollIntervalSeconds > 0))
      gap("pollInterval");
    times.push(time);
    const market = o.entryInputs?.market;
    if (
      market?.date !== date ||
      !fresh(
        market.observedAt,
        time,
        dynamic ? ADAPTIVE_RISK_POLICY.marketMaxAgeMs : 120000,
      ) ||
      (dynamic
        ? !hasAdaptiveMarketEvidence(market)
        : !["rising", "climax", "ebbing", "freezing"].includes(
            market.cycle?.phase,
          ))
    )
      gap("market");
    for (const code of codes) {
      const admitted = Date.parse(
        admissions[code]?.admittedAt ?? session.plan.createdAt,
      );
      if (!held.includes(code) && time < admitted) continue;
      const q = o.quotes?.[code];
      if (!q || q.date !== date || !fresh(q.timestamp, time)) {
        gap("quote", code);
        continue;
      }
      if (
        ![
          "closeCents",
          "previousCloseCents",
          "openCents",
          "highCents",
          "lowCents",
          "limitUpCents",
          "limitDownCents",
        ].every((k) => q[k] > 0) ||
        !Number.isFinite(q.volumeShares) ||
        q.volumeShares < 0
      )
        gap("priceVolume", code);
      const book = q.orderBookObservation ?? q;
      if (
        (q.orderBookObservation
          ? book.quality !== "OBSERVED"
          : q.orderBookQuality !== "OK") ||
        !fresh(q.orderBookTimestamp, time) ||
        !["bid1Cents", "ask1Cents", "bid1Shares", "ask1Shares"].every(
          (k) => Number.isFinite(book[k]) && book[k] >= 0,
        )
      )
        gap("orderBook", code);
      const old = previous.get(code);
      if (
        old &&
        ((time - old.at > 20000 &&
          !(old.clock < "11:30:01" && clock >= "13:00:00")) ||
          q.volumeShares < old.volume)
      )
        gap("quoteGap", code);
      previous.set(code, { at: time, clock, volume: q.volumeShares });
      const history = session.plan.entryExecutionPolicy?.history?.[code];
      if (
        history &&
        !(market?.sectors ?? []).some(
          (s) => s.name === history.sector && Number.isFinite(s.score),
        )
      )
        gap("sector", code);
      const points = session.plan.dragonPolicy?.config?.buyPoints ?? {};
      if (
        clock <= "10:00:00" &&
        (points["auction-dip"] || points["fake-neg-limit-dip"]) &&
        ["relay-leader", "strong-reversal"].includes(history?.stockClass)
      ) {
        const auction = o.entryInputs?.auction?.[code];
        if (
          auction?.date !== date ||
          auction.final !== true ||
          auction.openCents !== q.openCents ||
          auction.previousCloseCents !== q.previousCloseCents
        )
          gap("auction", code);
      }
    }
  }
  for (const [start, end] of [
    ["09:30:00", "11:30:00"],
    ["13:00:00", "14:56:50"],
  ]) {
    const from = at(date, start),
      to = at(date, end);
    const part = times.filter((t) => t >= from && t <= to);
    if (
      !part.length ||
      part[0] - from > 10000 ||
      to - part.at(-1) > 10000 ||
      part.some((t, i) => i && t - part[i - 1] > 20000)
    )
      gap(`session:${start}-${end}`);
  }
  const closing = closingFrames
    .map((f) => f.payload ?? f)
    .find((o) => {
      const time = Date.parse(o.observedAt);
      return (
        time >= at(date, "15:00:00") &&
        time <= at(date, "15:05:00") &&
        codes.every((code) => {
          const q = o.quotes?.[code];
          return (
            q?.date === date &&
            q.closeCents > 0 &&
            Date.parse(q.timestamp) >= at(date, "15:00:00") &&
            fresh(q.timestamp, time, 5 * 60000)
          );
        })
      );
    });
  if (!closing) gap("closingFrame");
  if (!session.practice || session.practice.startedSequence !== 0)
    gap("decisionTrace");
  return {
    complete: gaps.size === 0,
    frameCount: observations.length,
    candidateCount: Object.keys(admissions).length,
    closingFramePresent: !!closing,
    gaps: [...gaps.values()],
    note: "观测次数不作为独立交易样本；缺失路径不插值、不补造。",
  };
}
