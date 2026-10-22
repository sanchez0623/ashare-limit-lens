// 增强的题材标签噪声过滤
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { analyze, normalize, PRESETS } from "./shared/scoring.js";
import { spearman } from "./backend/domain/review-metrics.js";

const DATA_DIR = "D:/Sanchez/AI/GithubProjects/ashare-limit-lens-probe/raw-pools-enhanced";

// ============ 噪声标签分类 ============

// 1. 风险事件类（绝对噪声）
const RISK_EVENTS = new Set([
  "ST", "风险警示", "退市", "摘牌", "立案调查", "处罚", "警示函", "关注函", "问询函",
  "诉讼", "仲裁", "担保", "占用", "违规担保", "资金占用", "业绩预亏", "业绩下滑",
  "商誉减值", "亏损", "复牌", "停牌", "重组审核中止", "减持",
]);

// 2. 公司个体事件类（非行业题材）
const COMPANY_EVENTS = new Set([
  "回购", "增持", "股权激励", "员工持股", "战略合作", "合作协议", "框架协议",
  "中标", "订单", "涨价", "降价", "提价", "投产", "达产", "试产",
  "收购", "重组", "并购", "资产注入", "借壳", "转型", "跨界",
  "控制权变更", "扭亏为盈", "股权激励计划",
]);

// 3. 业绩报告类（非行业题材）
const PERFORMANCE_REPORTS = new Set([
  "一季报增长", "二季报增长", "三季报增长", "年报增长",
  "中报预增", "半年报增长", "业绩预增", "业绩快报", "业绩预告",
  "半年报", "年报", "季报", "年报预增",
]);

// 4. 所有权属性类（非行业题材，但可作为标签）
const OWNERSHIP_ATTRS = new Set([
  "央企", "国企", "国资", "地方国企", "北京国资", "上海国资", "福建国资", "山东国资",
  "深圳国资", "江苏国资", "浙江国资", "广东国资", "四川国资", "湖北国资",
  "湖南国资", "河南国资", "河北国资", "江西国资", "安徽国资", "辽宁国资",
  "吉林国资", "黑龙江国资", "内蒙古国资", "广西国资", "海南国资", "重庆国资",
  "贵州国资", "云南国资", "西藏国资", "陕西国资", "甘肃国资", "青海国资",
  "宁夏国资", "新疆国资", "兵团国资", "中央国企", "地方国企",
]);

// 5. 过于宽泛的概念（不够具体）
const BROAD_CONCEPTS = new Set([
  "人工智能", "AI", "新能源", "数字经济", "数据要素", "数字经济",
  "科技创新", "自主创新", "高端制造", "智能制造", "工业互联网",
]);

// 所有噪声标签合并
const ALL_NOISE = new Set([...RISK_EVENTS, ...COMPANY_EVENTS, ...PERFORMANCE_REPORTS, ...OWNERSHIP_ATTRS, ...BROAD_CONCEPTS]);

// 频率阈值：出现 < 5 次的标签视为噪声
const MIN_FREQUENCY = 5;

// ============ 标签解析与过滤 ============

function parseAndFilterTags(limitUpReason, tagFrequencyMap) {
  if (!limitUpReason || typeof limitUpReason !== "string") return [];
  
  const tags = limitUpReason
    .split(/[+，,、;；/]+/)
    .map(t => t.trim())
    .filter(t => {
      if (!t || t.length < 2) return false;
      // 1. 噪声标签过滤
      if (ALL_NOISE.has(t)) return false;
      // 2. 频率过滤
      if (tagFrequencyMap && (tagFrequencyMap.get(t) ?? 0) < MIN_FREQUENCY) return false;
      return true;
    });
  
  return [...new Set(tags)];
}

// ============ 加载数据 ============

const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort();
console.log(`=== 加载数据 ===`);
console.log(`文件数量: ${files.length}`);

// 加载所有数据
const dataByDate = new Map();
for (const file of files) {
  const content = readFileSync(`${DATA_DIR}/${file}`, 'utf-8');
  const data = JSON.parse(content);
  dataByDate.set(file.replace('.json', ''), data);
}

// 统计标签频率
const tagFrequencyMap = new Map();
for (const [date, data] of dataByDate.entries()) {
  if (!data.info) continue;
  for (const row of data.info) {
    if (!row.reason_type) continue;
    const tags = row.reason_type.split(/[+，,、;；/]+/).map(t => t.trim()).filter(t => t.length >= 2);
    for (const tag of tags) {
      tagFrequencyMap.set(tag, (tagFrequencyMap.get(tag) ?? 0) + 1);
    }
  }
}

console.log(`唯一标签数: ${tagFrequencyMap.size}`);
console.log(`低于频率阈值的标签: ${[...tagFrequencyMap.values()].filter(v => v < MIN_FREQUENCY).length}`);

// ============ 转换数据 ============

function convertToNormalized(row) {
  return {
    c: row.code,
    n: row.name,
    p: row.latest ? Math.round(row.latest * 1000) : null,
    o: null,
    h: null,
    zdp: row.change_rate,
    amount: row.order_amount,
    ltsz: row.currency_value,
    hs: row.turnover_rate,
    fbt: row.first_limit_up_time ? parseInt(row.first_limit_up_time.slice(-6)) : null,
    lbt: row.last_limit_up_time ? parseInt(row.last_limit_up_time.slice(-6)) : null,
    zbc: row.open_num,
    lbc: row.high_days_value ? parseInt(row.high_days_value.toString().slice(-2)) : null,
    hybk: row.hybk ?? "未知",
    zttj: null,
    limitUpReason: row.reason_type,
    maxSealMoney: row.order_amount * 100,
    isSt: false,
    isNew: row.is_new === 1,
  };
}

// ============ IC 计算 ============

function calculateIC(scores, returns) {
  const valid = scores.map((s, i) => ({ score: s, return: returns[i] }))
    .filter(x => x.score !== null && x.return !== null && Number.isFinite(x.return));
  if (valid.length < 3) return null;
  return {
    ic: spearman(valid.map(v => v.score), valid.map(v => v.return)),
    count: valid.length,
  };
}

// ============ 验证 ============

console.log(`\n=== 开始验证 ===`);

const results = {
  standard: [],
  dualOriginal: [],
  dualFiltered: [],
};

let processed = 0;
let errors = 0;

for (let i = 0; i < files.length - 1; i++) {
  const date = files[i].replace('.json', '');
  const nextDate = files[i + 1].replace('.json', '');
  const data = dataByDate.get(date);
  const nextData = dataByDate.get(nextDate);
  
  if (!data || !nextData || !data.info || data.info.length === 0) continue;
  
  processed++;
  
  try {
    const rows = data.info.map(convertToNormalized);
    const normalizedRows = rows.map(normalize);
    
    // 1. 标准评分
    const standardResult = analyze(normalizedRows, 0, null, PRESETS.balanced, { enableDualSynergy: false });
    
    // 2. 双维度（原始标签）
    const dualOriginalResult = analyze(normalizedRows, 0, null, PRESETS.balanced, {
      enableDualSynergy: true,
      dualSynergyWeights: { industry: 0.6, theme: 0.4 },
    });
    
    // 3. 双维度（过滤标签）
    // 需要修改 analyze 函数支持自定义标签解析，这里简化处理
    // 通过修改 limitUpReason 来实现
    const filteredRows = rows.map(row => {
      const filteredTags = parseAndFilterTags(row.limitUpReason, tagFrequencyMap);
      return { ...row, limitUpReason: filteredTags.length > 0 ? filteredTags.join('+') : null };
    });
    const filteredNormalizedRows = filteredRows.map(normalize);
    const dualFilteredResult = analyze(filteredNormalizedRows, 0, null, PRESETS.balanced, {
      enableDualSynergy: true,
      dualSynergyWeights: { industry: 0.6, theme: 0.4 },
    });
    
    // 计算次日收益
    const nextQuotes = new Map(nextData.info.map(r => [r.code, r]));
    
    const calcReturns = (stocks) => stocks.map(s => {
      const next = nextQuotes.get(s.code);
      if (!next) return null;
      const prevClose = s.price;
      const nextClose = next.latest;
      if (!prevClose || !nextClose) return null;
      return (nextClose - prevClose) / prevClose;
    });
    
    // 计算 IC
    const standardIC = calculateIC(standardResult.stocks.map(s => s.score), calcReturns(standardResult.stocks));
    const dualOriginalIC = calculateIC(dualOriginalResult.stocks.map(s => s.score), calcReturns(dualOriginalResult.stocks));
    const dualFilteredIC = calculateIC(dualFilteredResult.stocks.map(s => s.score), calcReturns(dualFilteredResult.stocks));
    
    if (standardIC) results.standard.push({ date, ic: standardIC.ic, count: standardIC.count });
    if (dualOriginalIC) results.dualOriginal.push({ date, ic: dualOriginalIC.ic, count: dualOriginalIC.count });
    if (dualFilteredIC) results.dualFiltered.push({ date, ic: dualFilteredIC.ic, count: dualFilteredIC.count });
    
  } catch (err) {
    errors++;
    if (errors <= 3) console.log(`  错误 (${date}): ${err.message}`);
  }
  
  if (processed % 50 === 0) console.log(`  已处理 ${processed}/${files.length - 1} 天`);
}

console.log(`\n=== 处理完成 ===`);
console.log(`有效天数: ${processed - errors}/${processed}`);

// ============ 汇总 ============

const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const std = (arr) => {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
};

console.log(`\n=== 汇总对比 ===\n`);

const formats = [
  ['标准评分（单一行业协同）', results.standard],
  ['双维度协同（原始标签）', results.dualOriginal],
  ['双维度协同（过滤标签）', results.dualFiltered],
];

const summaries = {};
for (const [name, results] of formats) {
  const ics = results.map(r => r.ic).filter(i => i !== null);
  summaries[name] = {
    meanIC: mean(ics),
    stdIC: std(ics),
    positiveDays: ics.filter(i => i > 0).length,
    totalDays: ics.length,
  };
  console.log(`${name}:`);
  console.log(`  IC 均值: ${summaries[name].meanIC?.toFixed(4) ?? "N/A"}`);
  console.log(`  IC 标准差: ${summaries[name].stdIC?.toFixed(4) ?? "N/A"}`);
  console.log(`  IC > 0 天数: ${summaries[name].positiveDays}/${summaries[name].totalDays}`);
  console.log();
}

// ============ 结论 ============

console.log(`=== 结论 ===`);
const best = Object.entries(summaries).sort((a, b) => (b[1].meanIC ?? 0) - (a[1].meanIC ?? 0))[0];
console.log(`最佳方案: ${best[0]}`);
console.log(`IC 均值: ${best[1].meanIC?.toFixed(4)}`);

// 保存结果
writeFileSync("tag-filter-validation.json", JSON.stringify({
  tagFilterConfig: {
    noiseCategories: {
      riskEvents: [...RISK_EVENTS],
      companyEvents: [...COMPANY_EVENTS],
      performanceReports: [...PERFORMANCE_REPORTS],
      ownershipAttrs: [...OWNERSHIP_ATTRS],
      broadConcepts: [...BROAD_CONCEPTS],
    },
    minFrequency: MIN_FREQUENCY,
    totalNoiseTags: ALL_NOISE.size,
  },
  summaries,
  results,
}, null, 2));
console.log(`\n详细结果已保存: tag-filter-validation.json`);
