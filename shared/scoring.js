import { classifySentimentCycle } from "./sentiment-cycle.js";
import { annotateBuyPoint } from "./buy-point-type.js";
import { classifyStock } from "./stock-class.js";
export const FACTORS = [
  {
    key: "quality",
    name: "封板质量",
    weight: 30,
    description: "100 − 炸板次数 × 15，最低 10 分",
  },
  {
    key: "capital",
    name: "封单强度",
    weight: 20,
    description: "封单金额 ÷ 成交额 ÷ 10%，上限 100 分",
  },
  {
    key: "liquidity",
    name: "换手结构",
    weight: 15,
    description: "4–12%：95；12–25%：80；1–4%：65；25–40%：50；其余：30",
  },
  {
    key: "timing",
    name: "首封时点",
    weight: 15,
    description: "09:45 前 100；10:30 前 85；11:30 前 65；14:00 前 45；其余 25",
  },
  {
    key: "sector",
    name: "板块协同",
    weight: 15,
    description: "使用同日、同一行业的板块评分",
  },
  {
    key: "ladder",
    name: "连板结构",
    weight: 5,
    description: "首板 75；2–3 板 100；4 板 65；5 板及以上 40",
  },
];
export const PRESETS = {
  balanced: [30, 20, 15, 15, 15, 5],
  first: [30, 20, 15, 20, 12, 3],
  relay: [30, 20, 10, 10, 20, 10],
};
export const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
export const num = (value) =>
  value === null ||
  value === undefined ||
  value === "" ||
  !Number.isFinite(Number(value))
    ? null
    : Number(value);
export function timeLabel(value) {
  if (value === null || value === undefined) return "—";
  const s = String(value).padStart(6, "0");
  return /^\d{6}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2, 4)}` : "—";
}
export function normalize(row) {
  return {
    code: String(row.c || ""),
    name: String(row.n || ""),
    sector: String(row.hybk || "未分类"),
    price: num(row.p) === null ? null : Number(row.p) / 1000,
    // 买点分类器需要开/收/最高价做 K 线阴阳校验，缺字段时为 null。
    open: num(row.o) === null ? null : Number(row.o) / 1000,
    close: num(row.p) === null ? null : Number(row.p) / 1000,
    high: num(row.h) === null ? null : Number(row.h) / 1000,
    change: num(row.zdp),
    amount: num(row.amount),
    floatCap: num(row.ltsz),
    seal: num(row.fund),
    turnover: num(row.hs),
    first: num(row.fbt),
    last: num(row.lbt),
    breaks: num(row.zbc),
    // 当日涨停池使用 lbc，昨日涨停池使用 ylbc（昨日连板数）。
    height: num(row.lbc) ?? num(row.ylbc),
    history: row.zttj ? `${row.zttj.days} 天 ${row.zttj.ct} 板` : null,
  };
}
function mean(rows, key) {
  const vals = rows.map((r) => r[key]).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
export function sectorAnalysis(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    if (!groups.has(row.sector)) groups.set(row.sector, []);
    groups.get(row.sector).push(row);
  });
  return [...groups]
    .map(([name, list]) => {
      const known = list.filter((r) => r.breaks !== null),
        quality = known.length
          ? mean(
              known.map((r) => ({ ...r, q: clamp(100 - r.breaks * 15, 10) })),
              "q",
            )
          : null;
      const height = Math.max(0, ...list.map((r) => r.height || 0));
      const components = [
        { name: "涨停集聚", weight: 35, value: clamp((list.length / 6) * 100) },
        { name: "连板高度", weight: 25, value: clamp((height / 5) * 100) },
        { name: "封板稳定", weight: 25, value: quality },
        {
          name: "早盘联动",
          weight: 15,
          value: list.filter((r) => r.first !== null).length
            ? (list.filter((r) => r.first !== null && r.first < 103000).length /
                list.filter((r) => r.first !== null).length) *
              100
            : null,
        },
      ];
      const weight = components
        .filter((c) => c.value !== null)
        .reduce((s, c) => s + c.weight, 0);
      const score = Math.round(
        components.reduce(
          (s, c) => s + (c.value === null ? 0 : c.value * c.weight),
          0,
        ) / weight,
      );
      return {
        name,
        count: list.length,
        height,
        quality,
        score,
        coverage: weight,
        components,
        amount: list.reduce((s, r) => s + (r.amount || 0), 0),
        members: list.map((r) => r.code),
      };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count);
}
export function analyzeStock(
  row,
  sectorScore,
  weights = PRESETS.balanced,
  prevRow = null,
  options = {},
) {
  const factorValues = {
    quality: row.breaks === null ? null : clamp(100 - row.breaks * 15, 10),
    capital:
      row.seal === null || !row.amount
        ? null
        : clamp((row.seal / row.amount / 0.1) * 100),
    liquidity:
      row.turnover === null
        ? null
        : row.turnover >= 4 && row.turnover <= 12
          ? 95
          : row.turnover > 12 && row.turnover <= 25
            ? 80
            : row.turnover >= 1 && row.turnover < 4
              ? 65
              : row.turnover > 25 && row.turnover <= 40
                ? 50
                : 30,
    timing:
      row.first === null
        ? null
        : row.first < 94500
          ? 100
          : row.first < 103000
            ? 85
            : row.first < 113000
              ? 65
              : row.first < 140000
                ? 45
                : 25,
    sector: sectorScore ?? null,
    ladder:
      row.height === null
        ? null
        : row.height === 1
          ? 75
          : row.height <= 3
            ? 100
            : row.height === 4
              ? 65
              : 40,
  };
  const risks = [];
  if (row.height >= 5)
    risks.push({
      text: "高位连板",
      penalty: 8,
      detail: "5 板及以上，分歧与退潮风险上升。",
    });
  if (row.turnover > 40)
    risks.push({
      text: "高换手",
      penalty: 8,
      detail: "换手率超过 40%，筹码交换剧烈。",
    });
  if (row.breaks >= 3)
    risks.push({
      text: "反复炸板",
      penalty: 5,
      detail: "盘中至少 3 次开板，封板稳定性偏弱。",
    });
  if (
    row.first === 92500 &&
    row.last === 92500 &&
    row.turnover !== null &&
    row.turnover < 1
  )
    risks.push({
      text: "一字特征",
      penalty: 10,
      detail: "竞价封板且低换手，实际成交机会可能有限。",
    });
  if (row.last !== null && row.last >= 145000)
    risks.push({
      text: "尾盘回封",
      penalty: 4,
      detail: "最后封板时间接近收盘，需观察次日承接。",
    });
  const factors = FACTORS.map((f, i) => ({
    ...f,
    weight: weights[i],
    value: factorValues[f.key],
  }));
  const active = factors.filter((f) => f.value !== null),
    available = active.reduce((s, f) => s + f.weight, 0),
    total = weights.reduce((a, b) => a + b, 0);
  const raw = available
    ? active.reduce((s, f) => s + f.value * f.weight, 0) / available
    : null;
  const deduction = Math.min(
    20,
    risks.reduce((s, r) => s + r.penalty, 0),
  );
  const enriched = {
    ...row,
    score: raw === null ? null : Math.round(clamp(raw - deduction)),
    rawScore: raw,
    deduction,
    factors,
    risks,
    coverage: total ? Math.round((available / total) * 100) : 0,
    sealRatio:
      row.seal !== null && row.amount > 0 ? row.seal / row.amount : null,
  };
  return annotateBuyPoint(enriched, prevRow, options);
}
// 只计算晋级统计，供实时评分和旧归档展示共用，不重算冻结评分。
export function promotionStats(rows, previous = null) {
  const clean = rows.filter((r) => r.code && !/ST|退/.test(r.name));
  const prevCodes = previous ? new Set(previous.map((r) => r.code)) : null;
  const prevEligible = previous?.filter(
    (r) => Number.isInteger(r.height) && r.height > 0,
  );
  return {
    promotion: prevEligible?.length
      ? (prevEligible.filter((r) =>
          clean.some(
            (s) =>
              s.code === r.code &&
              Number.isInteger(s.height) &&
              s.height > r.height,
          ),
        ).length /
          prevEligible.length) *
        100
      : null,
    previousCount: prevCodes ? prevCodes.size : null,
  };
}
// MA5 查表：ma5ByCode 支持 Map（服务端）或普通对象（前端 JSON payload）。
function ma5Of(ma5ByCode, code) {
  if (!ma5ByCode || !code) return null;
  const v =
    typeof ma5ByCode.get === "function" ? ma5ByCode.get(code) : ma5ByCode[code];
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function analyze(
  rows,
  broken = null,
  previous = null,
  weights = PRESETS.balanced,
  options = {},
) {
  const clean = rows.filter((r) => r.code && !/ST|退/.test(r.name));
  // 炸板池候选行：炸板低吸 / 尾盘跳水低吸 的候选来源（analyze 之前只对
  // 涨停池打分，这两类买点的目标股不在候选行里，结构性无法触发）。
  // 池成员资格是"盘中触板、收盘未封"的权威来源，isLimitUp 据此强制
  // false，不能用涨幅反推：尾盘炸板仍收在涨停价 -0.3 以内（主板 +9.8%）
  // 时涨幅判定会算出 isLimitUp=true，导致 testMomentum 误标"打板"、
  // testBrokenBoard 被 isLimitUp 守卫屏蔽——恰是要救的买点。
  // 口径隔离：炸板行只补充候选，绝不进入 sectorAnalysis / promotion /
  // emotion / count / cycle 的输入（这些仍只由涨停池派生）。
  const brokenClean = (options.brokenRows ?? []).filter(
    (r) => r.code && !/ST|退/.test(r.name),
  );
  const sectors = sectorAnalysis(clean),
    bySector = new Map(sectors.map((s) => [s.name, s.score]));
  // 昨日同代码行作为 prevRow 传入，供买点分类器计算 prevChange/prevBreaks。
  const prevByCode = previous
    ? new Map(previous.map((r) => [r.code, r]))
    : null;
  // 补齐买点分类器需要的派生字段：isLimitUp / boardLimit / openChange / ma5。
  // isLimitUp 用 boardLimit 感知判断：创业板/科创板 20% 涨停不能按 9.7% 一刀切。
  // 判定条件：change >= boardLimit - 0.3（容差），且有首封时间或连板数 >=1。
  // ma5 来自 options.ma5ByCode（backend/services/daily-closes.js 直读
  // parquet 计算），未知时不写字段——首阴分类器按"MA5 未知即拒绝"处理。
  // lateSession（尾盘时点）由调用方声明：仅在观测时刻确认处于尾盘或盘后
  // 时传 true；盘中报价不传，避免全天回撤被误标为尾盘跳水。
  // 股票分类（方案 3）：options.historyByCode 提供 { limitUp10d, ma20,
  // amplitude20 } 历史特征时，为每只股票判定类别（连板龙头/强势反包/
  // 波段震荡/平庸）并附加 stockClass / stockClassReason；特征不足返回
  // null（未分类）。板块内最高板由当日快照统计，无需历史数据。
  const sectorMaxHeight = new Map();
  for (const r of clean) {
    const h = Number(r.height) || 0;
    if (h > (sectorMaxHeight.get(r.sector) ?? 0))
      sectorMaxHeight.set(r.sector, h);
  }
  const historyOf = (code) =>
    options.historyByCode instanceof Map
      ? (options.historyByCode.get(code) ?? null)
      : (options.historyByCode?.[code] ?? null);
  // 两池共用同一套派生与分类逻辑（sectorScore / ma5 / stockClass /
  // buyPoint 口径完全一致），唯一差别是 isLimitUp 判定来源：涨停池按
  // 涨幅判定，炸板池按池成员资格强制 false。sectorMaxHeight 仍取自
  // 涨停池（板块领涨口径不把炸板股算作板块最高板）。
  const enrichRow = (r, source) => {
    const change = num(r.change);
    const boardLimit = r.boardLimit ?? (r.code?.startsWith("30") ? 20 : 10);
    const isLimitUp =
      source === "broken"
        ? false
        : change !== null &&
          change >= boardLimit - 0.3 &&
          (r.first !== null || (r.height ?? 0) >= 1);
    const openChange = num(r.openChange);
    const ma5 = ma5Of(options.ma5ByCode, r.code);
    const classification =
      options.historyByCode !== undefined
        ? classifyStock({
            row: { ...r, isLimitUp },
            sectorMaxHeight: sectorMaxHeight.get(r.sector) ?? null,
            history: historyOf(r.code),
          })
        : null;
    return {
      ...r,
      isLimitUp,
      boardLimit,
      // 溯源标记只在炸板行写：涨停池行保持既有形状不变（摘要变更最小）；
      // 下游按 candidateSource 存在与否区分来源，缺失即涨停池。
      ...(source === "broken" ? { candidateSource: source } : {}),
      ...(openChange !== null ? { openChange } : {}),
      ...(ma5 !== null ? { ma5 } : {}),
      ...(options.lateSession === true ? { lateSession: true } : {}),
      ...(classification
        ? {
            stockClass: classification.stockClass,
            stockClassReason: classification.reason,
          }
        : {}),
    };
  };
  const enriched = clean.map((r) => enrichRow(r, "limit-up"));
  const brokenEnriched = brokenClean.map((r) => enrichRow(r, "broken"));
  const scoreAndSort = (enrichedRows) =>
    enrichedRows
      .map((r) =>
        analyzeStock(
          r,
          bySector.get(r.sector),
          weights,
          prevByCode?.get(r.code) ?? null,
          options,
        ),
      )
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const stocks = scoreAndSort(enriched);
  const brokenStocks = scoreAndSort(brokenEnriched);
  const sealRate =
    broken === null
      ? null
      : rows.length + broken
        ? (rows.length / (rows.length + broken)) * 100
        : null;
  const height = Math.max(0, ...clean.map((r) => r.height || 0)),
    first = clean.filter((r) => r.height === 1).length,
    relay = clean.filter((r) => r.height > 1).length;
  const emotionFactors = [
    { weight: 40, value: clamp((clean.length / 80) * 100) },
    { weight: 35, value: sealRate },
    { weight: 25, value: clamp((height / 7) * 100) },
  ];
  const eWeight = emotionFactors
    .filter((f) => f.value !== null)
    .reduce((s, f) => s + f.weight, 0);
  const emotion = clean.length
    ? Math.round(
        emotionFactors.reduce((s, f) => s + (f.value ?? 0) * f.weight, 0) /
          eWeight,
      )
    : null;
  const { promotion, previousCount } = promotionStats(clean, previous);
  const cycle = classifySentimentCycle({
    limitUp: clean.length,
    broken,
    height,
  });
  return {
    stocks,
    brokenStocks,
    sectors,
    count: clean.length,
    excluded: rows.length - clean.length,
    first,
    relay,
    height,
    sealRate,
    emotion,
    emotionCoverage: eWeight,
    promotion,
    previousCount,
    cycle,
  };
}
