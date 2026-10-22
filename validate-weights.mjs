// 测试不同行业/题材权重组合的效果
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { analyze, normalize, PRESETS } from "./shared/scoring.js";
import { spearman } from "./backend/domain/review-metrics.js";

const DATA_DIR = "D:/Sanchez/AI/GithubProjects/ashare-limit-lens-probe/raw-pools-enhanced";

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

// ============ 权重组合 ============

const weightCombos = [
  { industry: 0.3, theme: 0.7 },
  { industry: 0.4, theme: 0.6 },
  { industry: 0.5, theme: 0.5 },
  { industry: 0.6, theme: 0.4 },  // 当前默认
  { industry: 0.7, theme: 0.3 },
  { industry: 0.8, theme: 0.2 },
  { industry: 0.9, theme: 0.1 },
];

// ============ 验证 ============

console.log(`\n=== 开始验证 ===`);

const results = {};

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
    const rows = data.info.map(convertToNormalized).map(normalize);
    
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
    
    // 对每个权重组合计算 IC
    for (const weights of weightCombos) {
      const result = analyze(rows, 0, null, PRESETS.balanced, {
        enableDualSynergy: true,
        dualSynergyWeights: weights,
      });
      
      const icResult = calculateIC(result.stocks.map(s => s.score), calcReturns(result.stocks));
      
      if (icResult) {
        const key = `${weights.industry}/${weights.theme}`;
        if (!results[key]) results[key] = [];
        results[key].push({ date, ic: icResult.ic, count: icResult.count });
      }
    }
    
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

console.log(`\n=== 权重组合对比 ===\n`);

const summaries = {};
for (const weights of weightCombos) {
  const key = `${weights.industry}/${weights.theme}`;
  const ics = (results[key] ?? []).map(r => r.ic).filter(i => i !== null);
  summaries[key] = {
    meanIC: mean(ics),
    stdIC: std(ics),
    positiveDays: ics.filter(i => i > 0).length,
    totalDays: ics.length,
  };
}

// 排序显示
const sorted = Object.entries(summaries).sort((a, b) => (b[1].meanIC ?? 0) - (a[1].meanIC ?? 0));

console.log(`权重 (行业/题材)\tIC 均值\tIC 标准差\tIC>0 天数`);
console.log(`${'-'.repeat(50)}`);
for (const [key, s] of sorted) {
  console.log(`${key}\t\t${s.meanIC?.toFixed(4)}\t${s.stdIC?.toFixed(4)}\t${s.positiveDays}/${s.totalDays}`);
}

// ============ 分析 ============

console.log(`\n=== 分析 ===\n`);

const best = sorted[0];
const worst = sorted[sorted.length - 1];

console.log(`最佳权重: ${best[0]} (IC ${best[1].meanIC?.toFixed(4)})`);
console.log(`最差权重: ${worst[0]} (IC ${worst[1].meanIC?.toFixed(4)})`);
console.log(`IC 差异: ${(best[1].meanIC - worst[1].meanIC).toFixed(4)}`);

// 保存结果
writeFileSync("weight-optimization.json", JSON.stringify({
  weightCombos: weightCombos.map(w => ({ industry: w.industry, theme: w.theme })),
  summaries: Object.fromEntries(sorted),
  results,
}, null, 2));
console.log(`\n详细结果已保存: weight-optimization.json`);
