// 从 stock.db 提取行业代码映射，并生成增强后的 raw-pools 数据
throw new Error(
  "此历史脚本已停用：财务库行业数字代码未经正式契约核验，不能用手写名称表猜测行业。请使用数据管理中按股票代码发布的东财行业快照；旧原始数据保留。",
);
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("D:/Sanchez/QuanQuant/hikyuu-quan/stock/stock.db");
db.exec("PRAGMA busy_timeout=5000;");

// 加载所有股票的行业代码
console.log("=== 加载行业代码映射 ===");
const industryMapping = new Map();
const rows = db
  .prepare(
    `
  SELECT s.code, s.name, f.industry 
  FROM Stock s 
  LEFT JOIN stkfinance f ON s.stockid = f.stockid 
  WHERE s.type = 1 AND f.industry > 0
`,
  )
  .all();

for (const row of rows) {
  industryMapping.set(row.code, {
    name: row.name,
    industry: row.industry,
  });
}
console.log(`共 ${industryMapping.size} 只股票有行业代码`);

// 行业代码到名称的映射（基于常见申万行业分类）
const industryNames = {
  1: "银行",
  2: "房地产",
  3: "钢铁",
  4: "交通运输",
  5: "食品饮料",
  6: "高速公路",
  7: "汽车",
  8: "机场港口",
  9: "医药生物",
  10: "化工",
  11: "纺织服饰",
  12: "家电",
  13: "轻工制造",
  14: "商业百货",
  15: "旅游酒店",
  16: "电力",
  17: "燃气水务",
  18: "农林牧渔",
  19: "化工材料",
  20: "煤炭",
  21: "石油石化",
  22: "贵金属",
  23: "有色金属",
  24: "通信",
  25: "电子",
  26: "计算机",
  27: "传媒",
  28: "国防军工",
  29: "机械设备",
  30: "电气设备",
  31: "房地产服务",
  32: "建筑装饰",
  33: "建筑材料",
  34: "水泥建材",
  35: "环境治理",
  36: "稀土小金属",
  37: "锂业",
  38: "造纸印刷",
  39: "环保",
  40: "公用事业",
  41: "综合",
  42: "传媒",
  43: "新能源",
  44: "光伏",
  45: "储能",
  46: "半导体",
  47: "消费电子",
  48: "汽车整车",
  49: "汽车零部件",
  50: "电池",
};

// 创建行业名称查询函数
function getIndustryName(industryCode) {
  return industryNames[industryCode] ?? `行业${industryCode}`;
}

// 检查 raw-pools 数据
const DATA_DIR =
  "D:/Sanchez/AI/GithubProjects/ashare-limit-lens-probe/raw-pools";
const OUTPUT_DIR =
  "D:/Sanchez/AI/GithubProjects/ashare-limit-lens-probe/raw-pools-enhanced";

// 创建输出目录
import { mkdirSync, existsSync } from "node:fs";
if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

const files = readdirSync(DATA_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();
console.log(`\n=== 处理 ${files.length} 个文件 ===`);

let processed = 0;
let matched = 0;
let unmatched = 0;

for (const file of files) {
  const content = readFileSync(`${DATA_DIR}/${file}`, "utf-8");
  const data = JSON.parse(content);

  if (!data.info) continue;

  // 为每只股票添加行业信息
  for (const row of data.info) {
    const mapping = industryMapping.get(row.code);
    if (mapping && mapping.industry > 0) {
      row.hybk = getIndustryName(mapping.industry);
      row._industryCode = mapping.industry;
      matched++;
    } else {
      row.hybk = "未知";
      row._industryCode = 0;
      unmatched++;
    }
  }

  // 保存增强后的数据
  writeFileSync(`${OUTPUT_DIR}/${file}`, JSON.stringify(data));
  processed++;

  if (processed % 50 === 0) {
    console.log(`  已处理 ${processed}/${files.length} 个文件`);
  }
}

console.log(`\n=== 处理完成 ===`);
console.log(`处理文件: ${processed}`);
console.log(`匹配行业: ${matched}`);
console.log(`未匹配: ${unmatched}`);
console.log(`匹配率: ${((matched / (matched + unmatched)) * 100).toFixed(2)}%`);

// 检查行业分布
const industryCount = new Map();
for (const [code, mapping] of industryMapping.entries()) {
  const name = getIndustryName(mapping.industry);
  industryCount.set(name, (industryCount.get(name) ?? 0) + 1);
}

console.log(`\n=== 行业分布（前 20）===`);
[...industryCount.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .forEach(([name, count]) => console.log(`  ${name}: ${count}`));

db.close();
