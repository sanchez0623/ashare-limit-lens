import { OBSERVATION_SCORE_POLICY as P } from "../../shared/observation-scoring.js";

const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const qualityBin = (n) => (n < 60 ? "<60" : n < 80 ? "60–79" : "≥80");
const riskBin = (n) => (n < 34 ? "低" : n < 67 ? "中" : "高");
function summary(samples) {
  return {
    cycles: samples.length,
    entryDates: new Set(samples.map((s) => s.openedDate)).size,
    netPnlCents: samples.reduce((n, s) => n + s.netPnlCents, 0),
    winRate: samples.length
      ? samples.filter((s) => s.netPnlCents > 0).length / samples.length
      : null,
    meanNetR: mean(
      samples.filter((s) => Number.isFinite(s.netR)).map((s) => s.netR),
    ),
    rCycles: samples.filter((s) => Number.isFinite(s.netR)).length,
    averageHoldingDays: mean(samples.map((s) => s.holdingCalendarDays)),
    meanFeesCents: mean(samples.map((s) => s.feeCents)),
  };
}

// One complete actual account cycle is one sample. OPEN partials only affect the
// denominator; ADD and T remain part of net P&L, never additional observations.
export function buildScoreCalibration({ cycles, entries, fills, asOf }) {
  const entryByCycle = new Map(entries.map((e) => [e.cycleId, e]));
  const samples = [],
    excluded = [];
  for (const cycle of cycles.filter((c) => c.closedDate <= asOf)) {
    const entry = entryByCycle.get(cycle.id);
    if (!entry) continue;
    const card = entry.profile.cards.find((c) => c.type === entry.buyPoint);
    if (!Number.isFinite(cycle.netPnlCents) || !Number.isFinite(card?.value)) {
      excluded.push({
        cycleId: cycle.id,
        reason: "首次建仓评分或完整资金来源不足",
      });
      continue;
    }
    const initialFills = fills.filter(
      (f) => f.cycleId === cycle.id && (f.intent ?? f.action) === "OPEN",
    );
    const quantity = initialFills.reduce((n, f) => n + f.quantity, 0);
    const riskCents =
      Number.isSafeInteger(entry.initialR0Cents) &&
      entry.initialR0Cents > 0 &&
      quantity > 0
        ? entry.initialR0Cents * quantity
        : null;
    samples.push({
      ...cycle,
      version: entry.profile.version,
      engineBuild: entry.engineBuild,
      configDigest: entry.configDigest,
      feeDigest: entry.feeDigest,
      stockClass: entry.profile.stockClass,
      phase: entry.phase,
      quality: card.value,
      risk: entry.profile.risk.value,
      prospective: entry.prospective === true,
      initialRiskCents: riskCents,
      netR: riskCents > 0 ? cycle.netPnlCents / riskCents : null,
    });
  }
  const grouped = new Map();
  for (const s of samples) {
    const key = JSON.stringify([
      s.version,
      s.engineBuild,
      s.configDigest,
      s.feeDigest,
      s.buyPoint,
      s.phase,
      s.stockClass,
      s.prospective,
    ]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(s);
  }
  const groups = [...grouped.values()].map((rows) => {
    const s = rows[0],
      all = summary(rows);
    const quality = ["<60", "60–79", "≥80"].map((bin) => ({
      bin,
      ...summary(rows.filter((r) => qualityBin(r.quality) === bin)),
    }));
    const risk = ["低", "中", "高"].map((bin) => ({
      bin,
      ...summary(
        rows.filter((r) => Number.isFinite(r.risk) && riskBin(r.risk) === bin),
      ),
    }));
    const enough =
      s.prospective &&
      all.cycles >= P.minimumCycles &&
      all.entryDates >= P.minimumEntryDates &&
      quality.every((b) => b.rCycles >= P.minimumBinCycles);
    const means = quality.map((b) => b.meanNetR);
    const direction = !enough
      ? "INSUFFICIENT"
      : means[0] < means[1] && means[1] < means[2]
        ? "POSITIVE"
        : means[0] > means[1] && means[1] > means[2]
          ? "REVERSE"
          : "FLAT";
    return {
      version: s.version,
      engineBuild: s.engineBuild,
      configDigest: s.configDigest,
      feeDigest: s.feeDigest,
      buyPoint: s.buyPoint,
      phase: s.phase,
      stockClass: s.stockClass,
      mode: s.prospective ? "FORWARD_OBSERVATION" : "REPLAY_DIAGNOSTIC",
      ...all,
      quality,
      risk,
      direction,
      reason: !s.prospective
        ? "规则发布前记录，仅供回放诊断"
        : !enough
          ? "样本或分箱覆盖不足，仅供描述"
          : "固定分箱的描述性区分，不授予交易或晋级资格",
    };
  });
  return {
    version: P.version,
    asOf,
    purpose: "DIAGNOSTIC",
    eligibleForPromotion: false,
    predictiveWinRate: null,
    sampleCount: samples.length,
    excluded,
    groups,
    samples,
    note: "仅统计有首次建仓评分的已完成真实模拟周期；净R含加仓及做T影响，不能归因于单一操作。不自动学习或发布权重。",
  };
}
