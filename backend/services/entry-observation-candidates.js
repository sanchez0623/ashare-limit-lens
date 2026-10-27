import { ShadowAccountRepository } from "../storage/shadow.js";
import { normalizePageRequest } from "../storage/paper.js";
import { frozenProgramSignal } from "../storage/strategy-signals.js";
import { ENTRY_OBSERVER_ID } from "./entry-observation.js";
import { BUY_POINT_LABELS } from "../../shared/buy-point-type.js";
import {
  OBSERVATION_CLASS_LABELS,
  OBSERVATION_SOURCE_LABELS,
} from "../../shared/entry-observation-display.js";

const scoreOf = (row) => row?.scoreValue ?? row?.score ?? null;
const finite = (value) => (Number.isFinite(value) ? value : null);
const billion = (value) =>
  Number.isFinite(value) ? `${(value / 1e8).toFixed(2)} 亿` : "未知";

function entryChecks(history, rules) {
  if (!history)
    return [
      { key: "history", label: "冻结日线历史", passed: false, value: "缺失" },
    ];
  const amount = finite(history.amount),
    minimum = finite(rules.minTurnoverCny);
  return [
    { key: "history", label: "冻结日线历史", passed: true, value: "已保存" },
    {
      key: "recentLimitUp",
      label: "近期涨停基因",
      passed: history.recentLimitUp === true,
      value: history.recentLimitUp === true ? "已确认" : "未确认",
    },
    {
      key: "stockClass",
      label: "股票分类",
      passed: ["relay-leader", "strong-reversal", "swing-range"].includes(
        history.stockClass,
      ),
      value: OBSERVATION_CLASS_LABELS[history.stockClass] ?? "未分类",
    },
    {
      key: "amount",
      label: "成交额准入",
      passed: amount === null || minimum === null ? null : amount >= minimum,
      value: `信号日 ${billion(amount)}；门槛 ${billion(minimum)}`,
    },
    {
      key: "sector",
      label: "行业分类",
      passed: !!history.sector && history.sector !== "未分类",
      value: history.sector ?? "未分类",
    },
    {
      key: "price",
      label: "信号日收盘价",
      passed: history.previousCloseCents > 0,
      value:
        history.previousCloseCents > 0
          ? `¥ ${(history.previousCloseCents / 100).toFixed(2)}`
          : "缺失",
    },
    {
      key: "name",
      label: "名称检查",
      passed:
        typeof history.name === "string" &&
        !!history.name &&
        !/ST|退/i.test(history.name),
      value: history.name ?? "缺失",
    },
  ];
}

// 名单、分数、标签和判定依据全部来自指定的冻结计划与其摘要绑定的原始快照。
// 不读取当前评分，不重新选股，不把原开盘计划的 SELECTED 审计状态当成盘中买入资格。
export async function entryObservationCandidates(env, options = {}) {
  const shadows = new ShadowAccountRepository(env);
  const plan = options.signalDate
    ? await shadows.plan(ENTRY_OBSERVER_ID, options.signalDate)
    : await shadows.latestPlan(ENTRY_OBSERVER_ID);
  if (!plan?.entryExecutionPolicy) return null;
  const snapshot = await frozenProgramSignal(shadows.db, plan);
  if (!snapshot) throw new Error("冻结候选原始快照缺失，暂无法展示入池依据");
  const policy = plan.entryExecutionPolicy,
    rules = policy.rules ?? {};
  const dragon = plan.tradingPolicyVersion === "dragon-risk-v1";
  const sources = new Map();
  for (const [source, items] of [
    ["limit-up", snapshot.stocks],
    ["broken", snapshot.brokenStocks],
    ["extra", snapshot.extraStocks],
  ]) {
    for (const row of items ?? []) {
      const existing = sources.get(row.code);
      if (!existing || (scoreOf(row) ?? 0) > (scoreOf(existing.row) ?? 0))
        sources.set(row.code, { source, row });
    }
  }
  const allRows = policy.candidates.map((code, index) => {
    const history = policy.history?.[code];
    const archived = sources.get(code),
      row = archived?.row;
    const source = archived?.source ?? "history";
    const points = [
      row?.buyPoint?.primary,
      ...(row?.buyPoint?.all ?? []),
    ].filter(Boolean);
    const buyPoints = [
      ...new Map(
        points.map((point) => [
          point.type,
          {
            type: point.type,
            label: BUY_POINT_LABELS[point.type] ?? point.type,
            reason: point.reason ?? "未保存细分判定说明",
          },
        ]),
      ).values(),
    ];
    const checks = entryChecks(history, rules);
    const pending = checks.filter((check) => check.passed !== true);
    const waitingTurnover = pending.length === 1 && pending[0].key === "amount";
    const stockClass = Object.hasOwn(
      OBSERVATION_CLASS_LABELS,
      history?.stockClass,
    )
      ? history.stockClass
      : "unclassified";
    return {
      rank: index + 1,
      code,
      name: history?.name ?? row?.name ?? code,
      sector: history?.sector ?? row?.sector ?? "未分类",
      stockClass,
      stockClassLabel: OBSERVATION_CLASS_LABELS[stockClass],
      stockClassReason:
        row?.stockClass === stockClass && row?.stockClassReason
          ? row.stockClassReason
          : "分类已冻结，未保存细分判定说明",
      source,
      sourceLabel: OBSERVATION_SOURCE_LABELS[source],
      score: finite(scoreOf(row)),
      scoring: row
        ? {
            rawScore: finite(row.rawScore),
            deduction: finite(row.deduction),
            factors: (row.factors ?? []).map(
              ({ name, weight, value, description }) => ({
                name,
                weight,
                value,
                description,
              }),
            ),
            risks: (row.risks ?? [])
              .map((risk) =>
                typeof risk === "string"
                  ? risk
                  : (risk.label ?? risk.name ?? risk.reason),
              )
              .filter(Boolean),
          }
        : null,
      amountCny: finite(history?.amount),
      previousCloseCents: finite(history?.previousCloseCents),
      buyPoints,
      entryReason: dragon
        ? "来自冻结历史，按信号日成交额与代码进入观察池；触发后按买点优先级分配风险预算"
        : archived
          ? `来自${OBSERVATION_SOURCE_LABELS[source]}，有已冻结日线历史；按快照分数降序、同分代码升序进入观察池`
          : "由已冻结历史准入范围补充，按代码升序加入观察池",
      checks,
      readiness:
        pending.length === 0
          ? "STATIC_READY"
          : waitingTurnover
            ? "WAITING_TURNOVER"
            : "DATA_INSUFFICIENT",
      readinessReason:
        pending.length === 0
          ? "信号日静态准入通过；仍须等待当日市场、板块、买点及成交条件"
          : waitingTurnover
            ? "信号日成交额尚未达到冻结门槛，需盘中有效成交额确认后才能买入"
            : `仍需确认：${pending.map((check) => check.label).join("、")}`,
    };
  });
  const q = String(options.q ?? "").trim();
  // 共用评分说明按整份冻结名单去重，不受当前筛选、页码或历史补充股影响。
  const scoringRules = new Map();
  for (const row of allRows) {
    if (!row.scoring?.factors.length) continue;
    const factors = row.scoring.factors.map(
      ({ name, weight, description }) => ({ name, weight, description }),
    );
    const key = JSON.stringify(factors);
    if (!scoringRules.has(key))
      scoringRules.set(key, {
        factors,
        stockClasses: new Set(),
        candidateCount: 0,
      });
    const group = scoringRules.get(key);
    group.stockClasses.add(row.stockClassLabel);
    group.candidateCount++;
  }
  const stockClass = options.stockClass ?? "",
    buyPoint = options.buyPoint ?? "";
  const filtered = allRows.filter(
    (row) =>
      (!q ||
        `${row.code} ${row.name}`.toLowerCase().includes(q.toLowerCase())) &&
      (!stockClass || row.stockClass === stockClass) &&
      (!buyPoint ||
        (buyPoint === "unclassified"
          ? !row.buyPoints.length
          : row.buyPoints.some((point) => point.type === buyPoint))),
  );
  const { page, pageSize } = normalizePageRequest(options, 10);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const count = (labels, match) =>
    Object.entries(labels)
      .map(([key, label]) => ({
        key,
        label,
        count: allRows.filter((row) => match(row, key)).length,
      }))
      .filter((row) => row.count > 0);
  return {
    signalDate: plan.signalDate,
    frozenAt: plan.createdAt,
    planDigest: plan.digest,
    candidateTotal: allRows.length,
    total: filtered.length,
    page: currentPage,
    pageSize,
    totalPages,
    filters: { q, stockClass, buyPoint },
    rules: {
      ...rules,
      firstNegMinPrevHeight: policy.firstNegMinPrevHeight,
      ordering: dragon ? "BUY_POINT_AMOUNT_CODE" : "LEGACY_SCORE",
    },
    scoringRules: [...scoringRules.values()].map(
      ({ stockClasses, ...group }) => ({
        ...group,
        stockClasses: [...stockClasses],
      }),
    ),
    summary: {
      stockClasses: count(
        OBSERVATION_CLASS_LABELS,
        (row, key) => row.stockClass === key,
      ),
      buyPoints: count(
        { ...BUY_POINT_LABELS, unclassified: "待盘中识别" },
        (row, key) =>
          key === "unclassified"
            ? !row.buyPoints.length
            : row.buyPoints.some((point) => point.type === key),
      ),
      staticReady: allRows.filter((row) => row.readiness === "STATIC_READY")
        .length,
      waitingTurnover: allRows.filter(
        (row) => row.readiness === "WAITING_TURNOVER",
      ).length,
    },
    rows: filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
  };
}
