// 重新验证：只过滤明确噪声（风险事件）
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { analyze, normalize, PRESETS } from "./shared/scoring.js";
import { spearman } from "./backend/domain/review-metrics.js";

const DATA_DIR = "D:/Sanchez/AI/GithubProjects/ashare-limit-lens-probe/raw-pools-enhanced";

// ============ 噪声分类（修正版）============

// 1. 风险事件类（绝对噪声，必须过滤）
const RISK_EVENTS = new Set([
  "ST", "风险警示", "退市", "摘牌", "立案调查", "处罚", "警示函", "关注函", "问询函",
  "诉讼", "仲裁", "担保", "占用", "违规担保", "资金占用", "业绩预亏", "业绩下滑",
  "商誉减值", "亏损", "复牌", "停牌", "重组审核中止",
]);

// 2. 公司个体事件类（可能有信息，不过滤）
// 回购、增持、中标等可能代表公司看好自己或市场看好公司

// 3. 业绩报告类（反映基本面，不过滤）
// 一季报增长、业绩预增等反映公司基本面和行业景气度

// 4. 所有权属性类（反映政策方向，不过滤）
// 央企、国企改革等反映政策驱动方向

// 5. 宽泛概念类（反映市场主线，不过滤）
// AI、新能源等虽然宽泛，但代表市场主线方向

// 只过滤风险事件
const ALL_NOISE = new Set([...RISK_EVENTS]);

// 频率阈值：出现 < 3 次的标签视为噪声（降低阈值）
const MIN_FREQUENCY = 3;

// ============ 标签解析 ============

function parseTags(limitUpReason, tagFrequencyMap, filterMode) {
  if (!limitUpReason || typeof limitUpReason !== "string") return [];
  
  const tags = limitUpReason
    .split(/[+，,、;；/]+/)
    .map(t => t.trim())
    .filter(t => {
      if (!t || t.length < 2) return false;
      
      // 模式 1: 不过滤（原始标签）
      if (filterMode === "none") return true;
      
      // 模式 2: 只过滤风险事件
      if (filterMode === "risk_only") {
        if (ALL_NOISE.has(t)) return false;
        return true;
      }
      
      // 模式 3: 风险事件 + 频率过滤
      if (filterMode === "risk_frequency") {
        if (ALL_NOISE.has(t)) return false;
        if (tagFrequencyMap && (tagFrequencyMap.get(t) ?? 0) < MIN_FREQUENCY) return false;
        return true;
      }
      
      return true;
    });
  
  return [...new Set(tags)];
}

// ============ 加载数据 ============

const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort();
console.log(`=== 加载数据 ===`);
console.log(`文件数量: ${files.length}`);

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
console.log(`低于频率阈值 (< ${MIN_FREQUENCY} 次) 的标签: ${[...tagFrequencyMap.values()].filter(v => v < MIN_FREQUENCY).length}`);

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
  dualNone: [],      // 不过滤
  dualRisk: [],      // 只过滤风险
  dualRiskFreq: [],  // 风险 + 频率
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
    
    // 1. 标准评分
    const standardRows = rows.map(normalize);
    const standardResult = analyze(standardRows, 0, null, PRESETS.balanced, { enableDualSynergy: false });
    
    // 2. 双维度（不过滤）
    const dualNoneRows = rows.map(normalize);
    const dualNoneResult = analyze(dualNoneRows, 0, null, PRESETS.balanced, {
      enableDualSynergy: true,
      dualSynergyWeights: { industry: 0.6, theme: 0.4 },
    });
    
    // 3. 双维度（只过滤风险）
    const dualRiskRows = rows.map(row => {
      const filteredTags = parseTags(row.limitUpReason, null, "risk_only");
      return { ...row, limitUpReason: filteredTags.length > 0 ? filteredTags.join('+') : null };
    }).map(normalize);
    const dualRiskResult = analyze(dualRiskRows, 0, null, PRESETS.balanced, {
      enableDualSynergy: true,
      dualSynergyWeights: { industry: 0.6, theme: 0.4 },
    });
    
    // 4. 双维度（风险 + 频率）
    const dualRiskFreqRows = rows.map(row => {
      const filteredTags = parseTags(row.limitUpReason, tagFrequencyMap, "risk_frequency");
      return { ...row, limitUpReason: filteredTags.length > 0 ? filteredTags.join('+') : null };
    }).map(normalize);
    const dualRiskFreqResult = analyze(dualRiskFreqRows, 0, null, PRESETS.balanced, {
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
    const dualNoneIC = calculateIC(dualNoneResult.stocks.map(s => s.score), calcReturns(dualNoneResult.stocks));
    const dualRiskIC = calculateIC(dualRiskResult.stocks.map(s => s.score), calcReturns(dualRiskResult.stocks));
    const dualRiskFreqIC = calculateIC(dualRiskFreqResult.stocks.map(s => s.score), calcReturns(dualRiskFreqResult.stocks));
    
    if (standardIC) results.standard.push({ date, ic: standardIC.ic, count: standardIC.count });
    if (dualNoneIC) results.dualNone.push({ date, ic: dualNoneIC.ic, count: dualNoneIC.count });
    if (dualRiskIC) results.dualRisk.push({ date, ic: dualRiskIC.ic, count: dualRiskIC.count });
    if (dualRiskFreqIC) results.dualRiskFreq.push({ date, ic: dualRiskFreqIC.ic, count: dualRiskFreqIC.count });
    
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
  ['双维度（不过滤）', results.dualNone],
  ['双维度（只过滤风险）', results.dualRisk],
  ['双维度（风险 + 频率 < 3 次）', results.dualRiskFreq],
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
const sorted = Object.entries(summaries).sort((a, b) => (b[1].meanIC ?? 0) - (a[1].meanIC ?? 0));
sorted.forEach(([name, s]) => {
  console.log(`${name}: IC ${s.meanIC?.toFixed(4)}, IC>0 ${s.positiveDays}/${s.totalDays}`);
});

const best = sorted[0];
console.log(`\n最佳方案: ${best[0]}`);

// 保存结果
writeFileSync("tag-filter-v2.json", JSON.stringify({
  filterModes: {
    none: "不过滤",
    risk_only: "只过滤风险事件",
    risk_frequency: "风险事件 + 频率 < 3 次",
  },
  riskEvents: [...RISK_EVENTS],
  minFrequency: MIN_FREQUENCY,
  summaries,
  results,
}, null, 2));
console.log(`\n详细结果已保存: tag-filter-v2.json`);
