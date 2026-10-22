// 细分标签类别验证：分别测试不同类别标签的影响
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { analyze, normalize, PRESETS } from "./shared/scoring.js";
import { spearman } from "./backend/domain/review-metrics.js";

const DATA_DIR = "D:/Sanchez/AI/GithubProjects/ashare-limit-lens-probe/raw-pools-enhanced";

// ============ 标签分类 ============

const CATEGORIES = {
  // 风险事件（负面）
  risk: new Set([
    "ST", "风险警示", "退市", "摘牌", "立案调查", "处罚", "警示函", "关注函", "问询函",
    "诉讼", "仲裁", "担保", "占用", "违规担保", "资金占用", "业绩预亏", "业绩下滑",
    "商誉减值", "亏损", "复牌", "停牌", "重组审核中止",
  ]),
  
  // 公司事件（中性/正面）
  companyEvent: new Set([
    "回购", "增持", "股权激励", "员工持股", "战略合作", "合作协议", "框架协议",
    "中标", "订单", "涨价", "降价", "提价", "投产", "达产", "试产",
    "收购", "重组", "并购", "资产注入", "借壳", "转型", "跨界",
    "控制权变更", "扭亏为盈",
  ]),
  
  // 业绩报告（基本面）
  performance: new Set([
    "一季报增长", "二季报增长", "三季报增长", "年报增长",
    "中报预增", "半年报增长", "业绩预增", "业绩快报", "业绩预告",
    "半年报", "年报", "季报", "年报预增",
  ]),
  
  // 所有权属性（政策）
  ownership: new Set([
    "央企", "国企", "国资", "地方国企", "北京国资", "上海国资", "福建国资", "山东国资",
    "深圳国资", "江苏国资", "浙江国资", "广东国资", "四川国资", "湖北国资",
    "湖南国资", "河南国资", "河北国资", "江西国资", "安徽国资", "辽宁国资",
    "国企改革", "央企改革", "国企混改",
  ]),
  
  // 宽泛概念（主线）
  broadConcept: new Set([
    "人工智能", "AI", "新能源", "数字经济", "数据要素",
    "科技创新", "自主创新", "高端制造", "智能制造", "工业互联网",
  ]),
};

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

// ============ 标签过滤 ============

function filterTags(tags, filterSet) {
  if (!filterSet || filterSet.size === 0) return tags;
  return tags.filter(t => !filterSet.has(t));
}

// ============ 验证 ============

console.log(`\n=== 开始验证 ===`);

// 测试方案
const scenarios = [
  { name: "不过滤（基线）", filters: {} },
  { name: "过滤风险", filters: { risk: CATEGORIES.risk } },
  { name: "过滤业绩", filters: { performance: CATEGORIES.performance } },
  { name: "过滤所有权", filters: { ownership: CATEGORIES.ownership } },
  { name: "过滤宽泛概念", filters: { broadConcept: CATEGORIES.broadConcept } },
  { name: "过滤公司事件", filters: { companyEvent: CATEGORIES.companyEvent } },
  { name: "过滤所有非行业", filters: { 
      risk: CATEGORIES.risk, 
      performance: CATEGORIES.performance,
      ownership: CATEGORIES.ownership,
      broadConcept: CATEGORIES.broadConcept,
      companyEvent: CATEGORIES.companyEvent,
    }
  },
];

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
    const rows = data.info.map(convertToNormalized);
    
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
    
    // 对每个方案计算 IC
    for (const scenario of scenarios) {
      const scenarioRows = rows.map(row => {
        let tags = row.limitUpReason 
          ? row.limitUpReason.split(/[+，,、;；/]+/).map(t => t.trim()).filter(t => t.length >= 2)
          : [];
        
        // 应用过滤
        for (const [key, filterSet] of Object.entries(scenario.filters)) {
          tags = filterTags(tags, filterSet);
        }
        
        return { ...row, limitUpReason: tags.length > 0 ? tags.join('+') : null };
      }).map(normalize);
      
      const result = analyze(scenarioRows, 0, null, PRESETS.balanced, {
        enableDualSynergy: true,
        dualSynergyWeights: { industry: 0.6, theme: 0.4 },
      });
      
      const icResult = calculateIC(result.stocks.map(s => s.score), calcReturns(result.stocks));
      
      if (icResult) {
        if (!results[scenario.name]) results[scenario.name] = [];
        results[scenario.name].push({ date, ic: icResult.ic, count: icResult.count });
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

console.log(`\n=== 汇总对比 ===\n`);

const summaries = {};
for (const scenario of scenarios) {
  const name = scenario.name;
  const ics = (results[name] ?? []).map(r => r.ic).filter(i => i !== null);
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

// ============ 分析 ============

console.log(`=== 分析 ===\n`);

// 计算每个过滤相对于基线的差异
const baseline = summaries["不过滤（基线）"];
console.log(`基线 IC: ${baseline.meanIC?.toFixed(4)}`);
console.log();

for (const scenario of scenarios.slice(1)) {
  const s = summaries[scenario.name];
  const diff = (s.meanIC ?? 0) - (baseline.meanIC ?? 0);
  const diffPercent = baseline.meanIC !== 0 ? (diff / baseline.meanIC * 100).toFixed(2) : 0;
  console.log(`${scenario.name}: ${diff > 0 ? '+' : ''}${diff.toFixed(4)} (${diffPercent}%)`);
}

// 保存结果
writeFileSync("tag-category-validation.json", JSON.stringify({
  categories: {
    risk: [...CATEGORIES.risk],
    companyEvent: [...CATEGORIES.companyEvent],
    performance: [...CATEGORIES.performance],
    ownership: [...CATEGORIES.ownership],
    broadConcept: [...CATEGORIES.broadConcept],
  },
  summaries,
  results,
}, null, 2));
console.log(`\n详细结果已保存: tag-category-validation.json`);
