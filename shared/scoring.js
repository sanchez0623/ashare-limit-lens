import { classifySentimentCycle } from "./sentiment-cycle.js";
import { annotateBuyPoint } from "./buy-point-type.js";
import { classifyStock } from "./stock-class.js";

// ============ 标签过滤与权重配置 ============

// 1. 噪声标签黑名单（仅过滤明确的风险事件）
// 基于 246 天回测验证：风险事件太稀少，过滤无影响；但为了代码清晰，保留过滤
const NOISE_THEMES = new Set([
  // 风险事件（负面）
  "ST", "风险警示", "退市", "摘牌",
  "立案调查", "处罚", "警示函", "关注函", "问询函",
  "诉讼", "仲裁", "担保", "占用", "违规担保", "资金占用",
  "业绩预亏", "业绩下滑", "商誉减值", "亏损",
  "复牌", "停牌", "重组审核中止",
]);

// 2. 标签权重表（基于 246 天回测验证结果）
// 权重 > 1 表示增强，< 1 表示降权，0 表示过滤
const TAG_WEIGHTS = {
  // 所有权属性（政策驱动，有效信号）×1.5
  "央企": 1.5, "国企": 1.5, "国资": 1.5, "国企改革": 1.5,
  "北京国资": 1.5, "上海国资": 1.5, "深圳国资": 1.5,
  "央企改革": 1.5, "国企混改": 1.5,
  
  // 公司事件（市场情绪，有效信号）×1.2
  "回购": 1.2, "增持": 1.2, "股权激励": 1.2, "员工持股": 1.2,
  "中标": 1.2, "订单": 1.2, "收购": 1.2, "重组": 1.2,
  "并购": 1.2, "资产注入": 1.2, "控制权变更": 1.2,
  
  // 业绩报告（可能噪声）×0.5
  "一季报增长": 0.5, "二季报增长": 0.5, "三季报增长": 0.5, "年报增长": 0.5,
  "中报预增": 0.5, "半年报增长": 0.5, "业绩预增": 0.5, "业绩快报": 0.5,
  "业绩预告": 0.5, "半年报": 0.5, "年报": 0.5, "季报": 0.5,
  "年报预增": 0.5, "扭亏为盈": 0.5,
  
  // 宽泛概念（市场主线）×1.0（不过滤）
  "人工智能": 1.0, "AI": 1.0, "新能源": 1.0, "数字经济": 1.0,
  "数据要素": 1.0, "科技创新": 1.0, "高端制造": 1.0,
};

// 3. 频率过滤阈值：出现 < 3 次的标签视为噪声
const MIN_TAG_FREQUENCY = 3;

// 解析涨停原因标签
// 输入: "半导体存储+重组审核中止+智慧城市"
// 输出: ["半导体存储", "智慧城市"]（过滤噪声标签）
export function parseThemes(limitUpReason) {
  if (!limitUpReason || typeof limitUpReason !== "string") return [];
  const tags = limitUpReason
    .split(/[+，,、;；/]+/)
    .map(t => t.trim())
    .filter(t => {
      if (!t || t.length < 2) return false;
      // 1. 噪声黑名单过滤
      if (NOISE_THEMES.has(t)) return false;
      // 2. 权重为 0 的标签过滤
      if (TAG_WEIGHTS[t] === 0) return false;
      return true;
    });
  return [...new Set(tags)]; // 去重
}

// 获取标签权重（用于加权计算）
export function getTagWeight(tag) {
  return TAG_WEIGHTS[tag] ?? 1.0; // 默认权重 1.0
}
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
// 双维度协同因子（可选，需要启用）
export const DUAL_SYNERGY_FACTORS = [
  {
    key: "industrySynergy",
    name: "行业协同",
    weight: 8,
    description: "基于行业板块的协同评分",
  },
  {
    key: "themeSynergy",
    name: "题材协同",
    weight: 7,
    description: "基于涨停原因标签的协同评分",
  },
  {
    key: "dualSynergy",
    name: "双维度协同",
    weight: 15,
    description: "行业 + 题材加权协同（80/20）",
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
    // 双维度协同评分：涨停原因和解析后的题材标签
    limitUpReason: row.limitUpReason ?? null,
    themes: parseThemes(row.limitUpReason),
    // 同花顺独有字段（备用）
    maxSealMoney: row.maxSealMoney ?? null,
    isSt: row.isSt ?? false,
    isNew: row.isNew ?? false,
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

// 题材协同分析：按涨停原因标签分组，计算题材热度
// 输入: rows（包含 themes 字段的行）
// 输出: 题材列表，每个题材包含 count、score、members 等
export function themeAnalysis(rows) {
  const themeMap = new Map();
  rows.forEach((row) => {
    const themes = row.themes || [];
    themes.forEach((theme) => {
      if (!themeMap.has(theme)) themeMap.set(theme, []);
      themeMap.get(theme).push(row);
    });
  });

  return [...themeMap]
    .map(([theme, list]) => {
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
        name: theme,
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

// 双维度协同评分：结合行业协同和题材协同
// industryScore: 行业协同分数（来自 sectorAnalysis）
// themeScore: 题材协同分数（来自 themeAnalysis）
// weights: { industry: 0.8, theme: 0.2 } 默认 80/20 权重（246 天回测优化）
export function dualSynergyScore(industryScore, themeScore, weights = { industry: 0.8, theme: 0.2 }) {
  const scores = [];
  if (industryScore !== null && industryScore !== undefined) {
    scores.push({ score: industryScore, weight: weights.industry });
  }
  if (themeScore !== null && themeScore !== undefined) {
    scores.push({ score: themeScore, weight: weights.theme });
  }
  if (scores.length === 0) return null;
  const totalWeight = scores.reduce((s, x) => s + x.weight, 0);
  const combined = scores.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight;
  return Math.round(combined);
}
export function analyzeStock(
  row,
  sectorScore,
  weights = PRESETS.balanced,
  prevRow = null,
  options = {},
  themeScore = null,
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
    // 双维度协同因子
    industrySynergy: sectorScore ?? null,
    themeSynergy: themeScore ?? null,
    dualSynergy: dualSynergyScore(sectorScore, themeScore, options.dualSynergyWeights),
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
  // 添加双维度协同因子（如果启用）
  if (options.enableDualSynergy) {
    const allFactors = [...FACTORS, ...DUAL_SYNERGY_FACTORS];
    factors.push(
      ...DUAL_SYNERGY_FACTORS.map((f) => ({
        ...f,
        weight: f.weight, // 双维度因子使用固定权重
        value: factorValues[f.key],
      })),
    );
  }
  const active = factors.filter((f) => f.value !== null),
    available = active.reduce((s, f) => s + f.weight, 0),
    // 总权重 = 基础因子权重 + 双维度协同权重（如果启用）
    total = weights.reduce((a, b) => a + b, 0) +
      (options.enableDualSynergy
        ? DUAL_SYNERGY_FACTORS.reduce((s, f) => s + f.weight, 0)
        : 0);
  // 覆盖率分母排除"对该来源结构性不适用"的因子。封单强度（capital）对收盘
  // 未封的股票必然缺失——这是模型不适用，不是数据缺口；计入分母会让炸板
  // 候选覆盖率上限卡在 80% 以下（实测质量 30 + 换手 15 + 首封 15 + 板块 15
  // = 75%），永远过不了 coverage >= 80 的建仓门槛，炸板低吸无法建仓。
  // 连板数（ladder）在该来源同样缺失，但那是真实的数据缺口，保留在分母里
  // 反映信息不足。评分本体（raw）不受影响，仍只按已覆盖因子加权。
  const inapplicable =
    row.candidateSource === "broken"
      ? factors
          .filter((f) => f.key === "capital" && f.value === null)
          .reduce((s, f) => s + f.weight, 0)
      : 0;
  const coverageBase = total - inapplicable;
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
    coverage: coverageBase ? Math.round((available / coverageBase) * 100) : 0,
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
  // 题材协同分析（双维度协同评分）
  // 先解析所有行的题材标签，然后按题材分组计算协同分数
  const rowsWithThemes = clean.map(r => ({
    ...r,
    themes: parseThemes(r.limitUpReason),
  }));
  const themes = themeAnalysis(rowsWithThemes),
    byTheme = new Map(themes.map((t) => [t.name, t.score]));
  // 为每只股票计算题材协同分数（取该股票所属题材中的最高分）
  const byStockThemeScore = new Map();
  for (const r of clean) {
    const themes = parseThemes(r.limitUpReason);
    if (themes.length > 0) {
      const themeScores = themes
        .map(t => byTheme.get(t))
        .filter(s => s !== undefined && s !== null);
      if (themeScores.length > 0) {
        byStockThemeScore.set(r.code, Math.max(...themeScores));
      }
    }
  }
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
    // 解析题材标签（用于双维度协同评分）
    const themes = parseThemes(r.limitUpReason);
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
      ...(themes.length > 0 ? { themes } : {}),
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
          byStockThemeScore.get(r.code) ?? null,
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
    themes,
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
