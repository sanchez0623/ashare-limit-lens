// 双维度协同评分 vs 单一维度评分 验证脚本
// 使用 247 日研究数据对比两种评分方法
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { analyze, normalize, PRESETS } from "./shared/scoring.js";
import { spearman } from "./backend/domain/review-metrics.js";

const DATA_DIR = "D:/Sanchez/AI/GithubProjects/ashare-limit-lens-probe/raw-pools-enhanced";

// 加载所有 247 日数据
const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort();
console.log(`=== 验证数据 ===`);
console.log(`文件数量: ${files.length}`);
console.log(`日期范围: ${files[0]} ~ ${files[files.length - 1]}\n`);

// 加载数据
const dataByDate = new Map();
for (const file of files) {
  const content = readFileSync(`${DATA_DIR}/${file}`, 'utf-8');
  const data = JSON.parse(content);
  dataByDate.set(data.date, data);
  if (file === files[0]) {
    console.log(`调试: file=${file}, data.date=${data.date}, info.length=${data.info?.length}`);
  }
}
console.log(`数据加载完成，共 ${dataByDate.size} 条`);

// 转换东财数据为 normalize 格式
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
    hybk: row.hybk ?? "未知", // 从增强数据中读取行业信息
    zttj: null,
    // 双维度协同评分需要
    limitUpReason: row.reason_type,
    maxSealMoney: row.order_amount * 100, // 近似转换
    isSt: false,
    isNew: row.is_new === 1,
  };
}

// 计算单日 IC
function calculateIC(scores, returns) {
  const valid = scores.map((s, i) => ({ score: s, return: returns[i] }))
    .filter(x => x.score !== null && x.return !== null && Number.isFinite(x.return));
  
  if (valid.length < 3) return null;
  
  const ic = spearman(
    valid.map(v => v.score),
    valid.map(v => v.return)
  );
  
  return { ic, count: valid.length };
}

// 主流程
console.log("=== 开始验证 ===\n");
console.log(`files.length = ${files.length}`);
console.log(`files[0] = ${files[0]}`);
console.log(`files[1] = ${files[1]}`);
console.log(`循环次数: ${files.length - 1}`);

const results = {
  standard: [],
  dual: [],
};

let processed = 0;
let errors = 0;

for (let i = 0; i < files.length - 1; i++) {
  const file = files[i];
  const date = file.replace('.json', ''); // 去掉 .json 后缀
  const nextDate = files[i + 1].replace('.json', '');
  const data = dataByDate.get(date);
  const nextData = dataByDate.get(nextDate);
  
  if (!data || !nextData || !data.info || data.info.length === 0) {
    continue;
  }
  
  processed++;
  
  // 调试：打印前 3 天的数据
  if (processed <= 3) {
    console.log(`\n调试 ${date}:`);
    console.log(`  info 数量: ${data.info.length}`);
    console.log(`  info[0] code: ${data.info[0]?.code}, name: ${data.info[0]?.name}`);
    console.log(`  info[0] reason_type: ${data.info[0]?.reason_type}`);
    console.log(`  info[0] change_rate: ${data.info[0]?.change_rate}`);
  }
  
  try {
    // 转换数据
    const rows = data.info.map(convertToNormalized);
    const normalizedRows = rows.map(normalize);
    
    // 1. 标准评分（仅行业协同）
    const standardResult = analyze(
      normalizedRows,
      0, // broken 数量
      null, // previous
      PRESETS.balanced,
      { enableDualSynergy: false }
    );
    
    // 2. 双维度协同评分（行业 + 题材）
    const dualResult = analyze(
      normalizedRows,
      0,
      null,
      PRESETS.balanced,
      {
        enableDualSynergy: true,
        dualSynergyWeights: { industry: 0.6, theme: 0.4 },
      }
    );
    
    // 计算次日收益
    const nextQuotes = new Map(nextData.info.map(r => [r.code, r]));
    
    const standardScores = standardResult.stocks.map(s => s.score);
    const standardReturns = standardResult.stocks.map(s => {
      const next = nextQuotes.get(s.code);
      if (!next) return null;
      // 收益 = (次日收盘 - 当日收盘) / 当日收盘
      const prevClose = s.price;
      const nextClose = next.latest;
      if (!prevClose || !nextClose) return null;
      return (nextClose - prevClose) / prevClose;
    });
    
    const dualScores = dualResult.stocks.map(s => s.score);
    const dualReturns = dualResult.stocks.map(s => {
      const next = nextQuotes.get(s.code);
      if (!next) return null;
      const prevClose = s.price;
      const nextClose = next.latest;
      if (!prevClose || !nextClose) return null;
      return (nextClose - prevClose) / prevClose;
    });
    
    // 计算 IC
    const standardIC = calculateIC(standardScores, standardReturns);
    const dualIC = calculateIC(dualScores, dualReturns);
    
    if (standardIC) {
      results.standard.push({ date, ic: standardIC.ic, count: standardIC.count });
    }
    if (dualIC) {
      results.dual.push({ date, ic: dualIC.ic, count: dualIC.count });
    }
    
  } catch (err) {
    errors++;
    if (errors <= 5) {
      console.log(`  错误 (${date}): ${err.message}`);
    }
  }
  
  if (processed % 50 === 0) {
    console.log(`  已处理 ${processed}/${files.length - 1} 天`);
  }
}

console.log(`\n=== 处理完成 ===`);
console.log(`有效天数: ${processed - errors}/${processed}`);
console.log(`错误天数: ${errors}\n`);

// 汇总结果
console.log("\n=== 汇总对比 ===\n");

const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const std = (arr) => {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
};

const standardICs = results.standard.map(r => r.ic).filter(i => i !== null);
const dualICs = results.dual.map(r => r.ic).filter(i => i !== null);

console.log(`标准评分 (单一维度):`);
console.log(`  IC 均值: ${mean(standardICs)?.toFixed(4) ?? "N/A"}`);
console.log(`  IC 标准差: ${std(standardICs)?.toFixed(4) ?? "N/A"}`);
console.log(`  IC > 0 天数: ${standardICs.filter(i => i > 0).length}/${standardICs.length}`);
console.log(`  有效天数: ${standardICs.length}`);

console.log(`\n双维度协同评分:`);
console.log(`  IC 均值: ${mean(dualICs)?.toFixed(4) ?? "N/A"}`);
console.log(`  IC 标准差: ${std(dualICs)?.toFixed(4) ?? "N/A"}`);
console.log(`  IC > 0 天数: ${dualICs.filter(i => i > 0).length}/${dualICs.length}`);
console.log(`  有效天数: ${dualICs.length}`);

// 统计检验
console.log(`\n=== 统计检验 ===`);
const diffICs = standardICs.map((ic, i) => {
  // 找到对应的 dual IC
  const dualResult = results.dual.find(r => r.date === results.standard[i]?.date);
  return dualResult ? dualResult.ic - ic : null;
}).filter(i => i !== null);

const diffMean = mean(diffICs);
console.log(`双维度 - 标准 IC 差异均值: ${diffMean?.toFixed(4) ?? "N/A"}`);
console.log(`差异 > 0 天数: ${diffICs.filter(i => i > 0).length}/${diffICs.length}`);

// 结论
console.log(`\n=== 结论 ===`);
if (mean(dualICs) > mean(standardICs)) {
  const improvement = ((mean(dualICs) - mean(standardICs)) / Math.abs(mean(standardICs)) * 100).toFixed(2);
  console.log(`✅ 双维度协同优于单一维度 (IC 提升 ${improvement}%)`);
  console.log(`   标准 IC: ${mean(standardICs)?.toFixed(4)} → 双维度 IC: ${mean(dualICs)?.toFixed(4)}`);
} else {
  console.log(`❌ 双维度协同未优于单一维度`);
  console.log(`   标准 IC: ${mean(standardICs)?.toFixed(4)} → 双维度 IC: ${mean(dualICs)?.toFixed(4)}`);
}

// 保存详细结果
const outputPath = "validation-results.json";
const output = {
  summary: {
    standardMeanIC: mean(standardICs),
    dualMeanIC: mean(dualICs),
    standardICStd: std(standardICs),
    dualICStd: std(dualICs),
    days: standardICs.length,
    improvement: mean(dualICs) > mean(standardICs) ? (mean(dualICs) - mean(standardICs)) / Math.abs(mean(standardICs)) * 100 : null,
  },
  standard: results.standard,
  dual: results.dual,
};
writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`\n详细结果已保存: ${outputPath}`);
