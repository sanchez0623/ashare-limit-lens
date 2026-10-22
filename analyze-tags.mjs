// 分析 raw-pools 数据中的题材标签分布，识别噪声
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const DATA_DIR = "D:/Sanchez/AI/GithubProjects/ashare-limit-lens-probe/raw-pools-enhanced";
const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort();

// 统计所有标签
const tagCount = new Map();
const tagStocks = new Map(); // 标签 -> 股票数量
let totalTags = 0;
let totalStocks = 0;

for (const file of files) {
  const content = readFileSync(`${DATA_DIR}/${file}`, 'utf-8');
  const data = JSON.parse(content);
  if (!data.info) continue;
  
  for (const row of data.info) {
    totalStocks++;
    if (!row.reason_type) continue;
    
    // 分割标签
    const tags = row.reason_type.split(/[+，,、;；/]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 2);
    
    totalTags += tags.length;
    for (const tag of tags) {
      tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
      if (!tagStocks.has(tag)) tagStocks.set(tag, new Set());
      tagStocks.get(tag).add(row.code);
    }
  }
}

console.log(`=== 标签统计 ===`);
console.log(`总股票数: ${totalStocks}`);
console.log(`总标签数: ${totalTags}`);
console.log(`唯一标签数: ${tagCount.size}`);
console.log(`平均每只股票标签数: ${(totalTags / totalStocks).toFixed(2)}\n`);

// 按频率排序
const sortedTags = [...tagCount.entries()]
  .map(([tag, count]) => ({
    tag,
    count,
    stocks: tagStocks.get(tag)?.size ?? 0,
    frequency: (count / totalStocks * 100).toFixed(2),
  }))
  .sort((a, b) => b.count - a.count);

console.log(`=== 高频标签（Top 50）===`);
console.log(`标签\t\t\t\t次数\t股票数\t频率`);
console.log(`-${'-'.repeat(60)}`);
sortedTags.slice(0, 50).forEach(t => {
  console.log(`${t.tag}\t\t\t${t.count}\t${t.stocks}\t${t.frequency}%`);
});

// 低频标签分析
console.log(`\n=== 低频标签分析 ===`);
const lowFreq = sortedTags.filter(t => t.count < 10);
console.log(`出现 < 10 次的标签: ${lowFreq.length}/${sortedTags.length} (${(lowFreq.length/sortedTags.length*100).toFixed(1)}%)`);
console.log(`这些标签占总标签数的: ${(lowFreq.reduce((s, t) => s + t.count, 0) / totalTags * 100).toFixed(2)}%`);

console.log(`\n低频标签 Sample（前 30）:`);
lowFreq.slice(0, 30).forEach(t => console.log(`  ${t.tag} (${t.count}次)`));

// 可能的噪声标签（基于语义判断）
const potentialNoise = [
  "回购", "增持", "减持", "质押", "解禁",
  "业绩预告", "业绩快报", "年报", "半年报", "季报",
  "股东大会", "董事会", "监事会",
  "股权激励", "员工持股",
  "战略合作", "合作协议", "框架协议",
  "中标", "签订", "合同", "订单",
  "涨价", "降价", "提价",
  "投产", "达产", "试产", "投产",
  "收购", "重组", "并购", "资产注入",
  "借壳", "转型", "跨界",
  "国资", "央企", "地方国企", "民营",
  "新能源", "光伏", "风电", "储能", "锂电", "氢能源",
  "人工智能", "AI", "大模型", "算力", "芯片", "半导体",
  "数字经济", "数据要素", "东数西算",
  "一带一路", "雄安", "自贸区", "长三角", "大湾区",
  "国企改革", "混改", "重组",
  "ST", "风险警示", "退市", "摘牌",
  "立案调查", "处罚", "警示函", "关注函", "问询函",
  "诉讼", "仲裁", "担保", "占用",
  "商誉减值", "业绩预亏", "业绩下滑", "亏损",
  "复牌", "停牌", "停牌", "重组审核中止",
];

console.log(`\n=== 潜在噪声标签检查 ===`);
const foundNoise = potentialNoise.filter(t => tagCount.has(t));
console.log(`找到 ${foundNoise.length} 个潜在噪声标签:`);
foundNoise.forEach(t => {
  console.log(`  ${t}: ${tagCount.get(t)}次, ${tagStocks.get(t)?.size ?? 0}只股票`);
});

// 高频标签中的噪声
console.log(`\n=== 高频标签中的噪声 ===`);
const highFreqNoise = sortedTags.slice(0, 50).filter(t => potentialNoise.includes(t.tag));
if (highFreqNoise.length > 0) {
  highFreqNoise.forEach(t => {
    console.log(`  ${t.tag}: ${t.count}次 (${t.frequency}%) - 建议过滤`);
  });
} else {
  console.log(`  高频标签中没有发现明显噪声`);
}

// 输出完整标签列表
console.log(`\n=== 完整标签列表已保存 ===`);
const outputPath = "tag-analysis.json";
writeFileSync(outputPath, JSON.stringify({
  totalStocks,
  totalTags,
  uniqueTags: tagCount.size,
  tags: sortedTags,
}, null, 2));
console.log(`  ${outputPath}`);
