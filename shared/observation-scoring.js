import { BUY_POINT_LABELS } from "./buy-point-type.js";
import {
  ADAPTIVE_RISK_POLICY,
  ADAPTIVE_RISK_POLICY_V1,
  ADAPTIVE_RISK_POLICY_V2,
  NEUTRAL_ADAPTIVE_RISK_POLICY,
  adaptiveEffective,
  adaptiveRiskView,
} from "./adaptive-risk.js";

const freeze = (v) => {
  for (const child of Object.values(v))
    if (child && typeof child === "object") freeze(child);
  return Object.freeze(v);
};
// The persisted policy also freezes observationScoreBuildDigest(). Changes to
// its scoring/risk implementation require a new version, even with equal weights.
export const OBSERVATION_SCORE_POLICY = freeze({
  version: "dragon-observation-score-v6",
  purpose: "OBSERVATION_ONLY",
  eligibleForPromotion: false,
  entryRuleVersion: "intraday-entry-v1",
  adaptiveRiskVersion: ADAPTIVE_RISK_POLICY.version,
  adaptiveRiskVersions: [
    ADAPTIVE_RISK_POLICY_V1.version,
    ADAPTIVE_RISK_POLICY_V2.version,
    NEUTRAL_ADAPTIVE_RISK_POLICY.version,
    ADAPTIVE_RISK_POLICY.version,
  ],
  identity: {
    "relay-leader": 100,
    "strong-reversal": 75,
    "swing-range": 50,
    mediocre: 0,
  },
  weights: {
    "limit-up-momentum": { L: 25, E: 20, F: 30, C: 25 },
    "broken-board-dip": { L: 20, E: 15, F: 25, C: 40 },
    "first-neg-dip": { L: 20, E: 15, F: 35, C: 30 },
    "fake-neg-limit-dip": { L: 25, E: 15, F: 30, C: 30 },
    "auction-dip": { L: 20, E: 20, F: 25, C: 35 },
    "late-dip": { L: 15, E: 20, F: 25, C: 40 },
  },
  definitions: {
    L: "身份匹配：沿用冻结股票分类",
    E: "板块配合：同一时点东财行业强度",
    F: "形态匹配：已证实结构条件占比",
    C: "连续确认：有效报价与增量成交量，五次确认满分",
  },
  stableQuotesFull: 5,
  qualityBins: [60, 80],
  riskBins: [34, 67],
  minimumCycles: 30,
  minimumEntryDates: 20,
  minimumBinCycles: 5,
  note: "固定规则的匹配程度，不是胜率；不同买点不混排。风险压力独立展示，评分不改变交易。",
});
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;
const fresh = (stamp, at, age) =>
  Number.isFinite(Date.parse(stamp)) &&
  Date.parse(at) >= Date.parse(stamp) &&
  Date.parse(at) - Date.parse(stamp) <= age;
const test = (key, label, known, passed, value = null) => ({
  key,
  label,
  passed: known ? !!passed : null,
  value,
});
const between = (key, label, value, low, high) =>
  test(
    key,
    label,
    finite(value),
    value >= low && value <= high,
    finite(value) ? value : null,
  );

// Structural predicates from intraday-entry-v1; identity, time and permissions
// remain independent gates. Unknown facts never become a smaller denominator.
export function observationShapeChecks(
  type,
  {
    history: h = {},
    quote: q = {},
    path: p = {},
    auction: a,
    date,
    rules = {},
  } = {},
) {
  const pct =
    positive(q.previousCloseCents) && positive(q.closeCents)
      ? (q.closeCents / q.previousCloseCents - 1) * 100
      : null;
  const gap =
    positive(q.previousCloseCents) && positive(q.openCents)
      ? (q.openCents / q.previousCloseCents - 1) * 100
      : null;
  const level =
    positive(q.limitUpCents) && positive(q.previousCloseCents)
      ? (q.limitUpCents / q.previousCloseCents) * 100 - 100
      : null;
  const pullback =
    positive(q.limitUpCents) && positive(q.closeCents)
      ? (1 - q.closeCents / q.limitUpCents) * 100
      : null;
  const ma5 =
    positive(h.lastFourCloseSumCents) && positive(q.closeCents)
      ? (h.lastFourCloseSumCents + q.closeCents) / 5
      : null;
  const auction = () =>
    test(
      "auction",
      "竞价终态与开盘价、昨收核对",
      !!a && positive(q.openCents) && positive(q.previousCloseCents),
      a?.date === date &&
        a.final === true &&
        a.openCents === q.openCents &&
        a.previousCloseCents === q.previousCloseCents,
    );
  switch (type) {
    case "limit-up-momentum": {
      const time = Number.isFinite(Date.parse(p.lastObservedAt))
        ? new Date(Date.parse(p.lastObservedAt) + 28800000)
            .toISOString()
            .slice(11, 19)
        : null;
      return [
        test(
          "touch",
          "最近60秒采样确认触板",
          !!p.lastObservedAt,
          Number.isFinite(Date.parse(p.momentumAt)) &&
            Date.parse(p.lastObservedAt) >= Date.parse(p.momentumAt) &&
            Date.parse(p.lastObservedAt) - Date.parse(p.momentumAt) <= 60000,
        ),
        test(
          "nearLimit",
          "现价达到涨停价99%",
          positive(q.closeCents) && positive(q.limitUpCents),
          q.closeCents >= q.limitUpCents * 0.99,
        ),
        test(
          "reseal",
          "午后须有采样确认回封",
          !!time,
          time < "13:00:00" || !!p.resealedAt,
        ),
      ];
    }
    case "broken-board-dip":
      return [
        test(
          "touch",
          "当日有触板证据",
          typeof p.touched === "boolean",
          p.touched,
        ),
        between("pullback", "相对涨停回撤3%至7%", pullback, 3, 7),
      ];
    case "first-neg-dip":
      return [
        test(
          "height",
          "此前连板达到首阴门槛",
          finite(h.previousHeight) && finite(rules.firstNegMinPrevHeight),
          h.previousHeight >= rules.firstNegMinPrevHeight,
          h.previousHeight ?? null,
        ),
        test(
          "negative",
          "现价低于当日开盘",
          positive(q.openCents) && positive(q.closeCents),
          q.openCents > q.closeCents,
        ),
        test(
          "change",
          "跌幅不超过5%且为下跌",
          finite(pct),
          pct < 0 && pct >= -5,
          pct,
        ),
        test(
          "ma5",
          "现价不低于可核验五日均线",
          positive(ma5),
          q.closeCents >= ma5,
          ma5,
        ),
      ];
    case "fake-neg-limit-dip":
      return [
        test(
          "previousNegative",
          "昨日高开低走假阴",
          positive(h.previousOpenCents) && positive(h.previousCloseCents),
          h.previousOpenCents > h.previousCloseCents,
        ),
        between(
          "previousChange",
          "昨日涨跌幅在正负2%内",
          h.previousChange,
          -2,
          2,
        ),
        test(
          "previousTouch",
          "昨日有触板证据",
          typeof h.previousTouchedLimit === "boolean",
          h.previousTouchedLimit,
        ),
        auction(),
        test("gap", "开盘低开至少8%", finite(gap), gap <= -8, gap),
        test(
          "aboveLimitDown",
          "现价高于跌停价",
          positive(q.closeCents) && positive(q.limitDownCents),
          q.closeCents > q.limitDownCents,
        ),
      ];
    case "auction-dip":
      return [
        test(
          "previousChange",
          "信号日涨幅至少5%",
          finite(h.previousChange),
          h.previousChange >= 5,
          h.previousChange ?? null,
        ),
        auction(),
        test(
          "gap",
          "低开至少5%且未逼近跌停边界",
          finite(gap) && finite(level),
          gap <= -5 && gap > -level + 0.5,
          gap,
        ),
      ];
    case "late-dip": {
      const pull =
        positive(p.tailHighCents) && positive(q.closeCents)
          ? (1 - q.closeCents / p.tailHighCents) * 100
          : null;
      return [
        between("tailPullback", "从实际观测尾盘高点回撤3%至5%", pull, 3, 5),
        test(
          "unlocked",
          "现价位于涨跌停之间",
          positive(q.closeCents) &&
            positive(q.limitDownCents) &&
            positive(q.limitUpCents),
          q.closeCents > q.limitDownCents && q.closeCents < q.limitUpCents,
        ),
      ];
    }
    default:
      throw new Error("未知买点评分卡");
  }
}

export function observationRisk(
  config,
  state,
  { code, sector, observedAt, paused = false } = {},
) {
  if (!state || !config)
    return {
      value: null,
      level: "未知",
      reason: "尚无动态风险观测",
      layers: null,
      effective: null,
    };
  const view = adaptiveRiskView(config, state, { observedAt });
  const layers = {
    market: view.market,
    sector: view.sectors[sector] ?? null,
    stock: view.stocks[code] ?? null,
  };
  const effective = adaptiveEffective(config, state, {
    code,
    sector,
    observedAt,
    paused,
  });
  if (!Object.values(layers).every((v) => v?.available))
    return {
      value: null,
      level: "待确认",
      reason: "风险观测预热、缺失或过期",
      layers,
      effective,
    };
  const value = Math.round(100 * (1 - effective.factor));
  return {
    value,
    level: value < 34 ? "低" : value < 67 ? "中" : "高",
    reason: "动态风险上限的约束强度，不是损失概率",
    layers,
    effective,
  };
}

export function scoreObservation({
  code,
  plan,
  session = null,
  observation = null,
  ledger = [],
  book = null,
}) {
  const history = plan?.entryExecutionPolicy?.history?.[code] ?? {};
  const asOf = observation?.observedAt ?? plan?.createdAt ?? null;
  const date = session?.date ?? observation?.quotes?.[code]?.date ?? null;
  const quote = observation?.quotes?.[code];
  const quoteValid =
    quote?.date === date &&
    positive(quote.closeCents) &&
    fresh(quote.timestamp, asOf, ADAPTIVE_RISK_POLICY.quoteMaxAgeMs);
  const market = observation?.entryInputs?.market;
  const sector = market?.sectors?.find((s) => s.name === history.sector);
  const environment =
    market?.date === date &&
    fresh(market.observedAt, asOf, ADAPTIVE_RISK_POLICY.marketMaxAgeMs) &&
    finite(sector?.score) &&
    sector.score >= 0 &&
    sector.score <= 100
      ? sector.score
      : null;
  const identity = Object.hasOwn(
    OBSERVATION_SCORE_POLICY.identity,
    history.stockClass,
  )
    ? OBSERVATION_SCORE_POLICY.identity[history.stockClass]
    : null;
  const path = quoteValid ? session?.entryState?.paths?.[code] : null;
  const risk = observationRisk(
    plan?.dragonPolicy?.config,
    session?.adaptiveRisk,
    {
      code,
      sector: history.sector,
      observedAt: asOf,
      paused: !!session?.dailyPaused || !!book?.dragonHalted,
    },
  );
  const decisions = Object.values(session?.practice?.decisions ?? {}).filter(
    (d) => d.code === code && d.intent === "OPEN",
  );
  const current = decisions.filter(
    (d) => d.last?.observationSequence === session?.sequence,
  );
  const cards = Object.entries(OBSERVATION_SCORE_POLICY.weights).map(
    ([type, weights]) => {
      const isLeader = history.stockClass === "relay-leader";
      const isStrong = isLeader || history.stockClass === "strong-reversal";
      const applicable =
        identity === null
          ? null
          : ["limit-up-momentum", "broken-board-dip"].includes(type)
            ? isLeader
            : type === "late-dip"
              ? identity > 0
              : isStrong;
      const ranges = plan?.entryExecutionPolicy?.rules?.windows?.[type];
      const clock = Number.isFinite(Date.parse(asOf))
        ? new Date(Date.parse(asOf) + 28800000).toISOString().slice(11, 19)
        : null;
      const inWindow =
        observation && ranges && clock
          ? ranges.some(([start, end]) => clock >= start && clock <= end)
          : null;
      const checks = observationShapeChecks(type, {
        history,
        quote: quoteValid ? quote : {},
        path: path ?? {},
        auction: observation?.entryInputs?.auction?.[code],
        date,
        rules: {
          ...plan?.entryExecutionPolicy?.rules,
          firstNegMinPrevHeight:
            plan?.entryExecutionPolicy?.firstNegMinPrevHeight,
        },
      });
      const F = checks.every((c) => c.passed !== null)
        ? (checks.filter((c) => c.passed).length / checks.length) * 100
        : null;
      const C =
        path && finite(path.stableQuotes)
          ? 100 * Math.min(path.stableQuotes / 5, 1)
          : null;
      const components = { L: identity, E: environment, F, C };
      const missing = Object.keys(components).filter(
        (key) => components[key] === null,
      );
      const value = missing.length
        ? null
        : Math.round(
            Object.entries(weights).reduce(
              (n, [key, weight]) => n + (components[key] * weight) / 100,
              0,
            ),
          );
      const enabled = plan?.dragonPolicy?.config?.buyPoints?.[type] === true;
      const matching = current.filter(
        (d) => !d.buyPoint || d.buyPoint === type,
      );
      const filled = ledger.some(
        (f) =>
          f.code === code &&
          (f.intent ?? f.action) === "OPEN" &&
          f.buyPoint === type,
      );
      const triggered = matching.some(
        (d) =>
          d.buyPoint === type &&
          ["BUY_POINT_TRIGGERED", "FILLED"].includes(d.reasonCode),
      );
      const block = matching.find(
        (d) =>
          ![
            "ADMITTED",
            "NO_BUY_POINT",
            "WAITING_CONFIRMATION",
            "BUY_POINT_TRIGGERED",
            "FILLED",
          ].includes(d.reasonCode),
      );
      const admitted = !!session?.entryState?.admissions?.[code];
      const status = !enabled
        ? "DISABLED"
        : !observation
          ? "PREMARKET"
          : !quoteValid
            ? "WAITING_DATA"
            : filled
              ? "FILLED"
              : block
                ? "BLOCKED"
                : applicable === false
                  ? "INELIGIBLE"
                  : inWindow === false
                    ? "OUTSIDE_WINDOW"
                    : triggered
                      ? "TRIGGERED"
                      : admitted
                        ? "WAITING_TRIGGER"
                        : "NOT_OBSERVED";
      return {
        type,
        label: BUY_POINT_LABELS[type],
        enabled,
        applicable,
        inWindow,
        value,
        components,
        weights,
        checks,
        coverage: (4 - missing.length) / 4,
        missing,
        status,
        reason:
          block?.reason ??
          (filled
            ? "实际首次建仓成交"
            : triggered
              ? "实际执行器已观测触发"
              : applicable === false
                ? "股票分类不符合该买点的硬准入条件"
                : inWindow === false
                  ? "当前不在该买点的冻结交易窗口"
                  : !quoteValid && observation
                    ? "报价缺失、过期或无效"
                    : "以实际执行器触发及权限为准"),
      };
    },
  );
  return {
    version: OBSERVATION_SCORE_POLICY.version,
    purpose: "OBSERVATION_ONLY",
    code,
    name: history.name ?? code,
    sector: history.sector ?? null,
    stockClass: history.stockClass ?? null,
    identity,
    asOf,
    date,
    signalDate: plan?.signalDate ?? null,
    risk,
    cards,
  };
}
