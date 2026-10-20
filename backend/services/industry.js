// 行业数据服务
// 从 QuanQuant stock.db 提取行业代码映射，为市场数据提供行业信息

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

// QuanQuant stock.db 路径
const STOCK_DB_PATH = "D:/Sanchez/QuanQuant/hikyuu-quan/stock/stock.db";

// 行业代码到名称的映射（基于常见申万行业分类）
const INDUSTRY_NAMES = {
  1: "银行", 2: "房地产", 3: "钢铁", 4: "交通运输", 5: "食品饮料",
  6: "高速公路", 7: "汽车", 8: "机场港口", 9: "医药生物", 10: "化工",
  11: "纺织服饰", 12: "家电", 13: "轻工制造", 14: "商业百货", 15: "旅游酒店",
  16: "电力", 17: "燃气水务", 18: "农林牧渔", 19: "化工材料", 20: "煤炭",
  21: "石油石化", 22: "贵金属", 23: "有色金属", 24: "通信", 25: "电子",
  26: "计算机", 27: "传媒", 28: "国防军工", 29: "机械设备", 30: "电气设备",
  31: "房地产服务", 32: "建筑装饰", 33: "建筑材料", 34: "水泥建材", 35: "环境治理",
  36: "稀土小金属", 37: "锂业", 38: "造纸印刷", 39: "环保", 40: "公用事业",
  41: "综合", 42: "传媒", 43: "新能源", 44: "光伏", 45: "储能", 46: "半导体",
  47: "消费电子", 48: "汽车整车", 49: "汽车零部件", 50: "电池",
};

// 缓存行业映射
let _industryMapping = null;
let _lastLoadTime = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 小时缓存

/**
 * 加载行业数据映射
 * @returns {Map<string, {name: string, industry: number}>} 股票代码 -> 行业信息
 */
export function loadIndustryMapping() {
  const now = Date.now();
  if (_industryMapping && (now - _lastLoadTime) < CACHE_TTL) {
    return _industryMapping;
  }
  
  if (!existsSync(STOCK_DB_PATH)) {
    console.warn(`[industry] stock.db 不存在：${STOCK_DB_PATH}`);
    return new Map();
  }
  
  try {
    const db = new DatabaseSync(STOCK_DB_PATH);
    db.exec("PRAGMA busy_timeout=5000;");
    
    const rows = db.prepare(`
      SELECT s.code, s.name, f.industry 
      FROM Stock s 
      LEFT JOIN stkfinance f ON s.stockid = f.stockid 
      WHERE s.type = 1 AND f.industry > 0
    `).all();
    
    const mapping = new Map();
    for (const row of rows) {
      mapping.set(row.code, {
        name: row.name,
        industry: row.industry,
        industryName: INDUSTRY_NAMES[row.industry] ?? `行业${row.industry}`,
      });
    }
    
    db.close();
    
    _industryMapping = mapping;
    _lastLoadTime = now;
    
    console.log(`[industry] 加载行业映射：${mapping.size} 只股票`);
    return mapping;
  } catch (err) {
    console.error(`[industry] 加载行业映射失败：${err.message}`);
    return _industryMapping ?? new Map();
  }
}

/**
 * 获取股票的行业信息
 * @param {string} code 股票代码
 * @returns {{name: string, industry: number, industryName: string} | null}
 */
export function getIndustryInfo(code) {
  const mapping = loadIndustryMapping();
  return mapping.get(code) ?? null;
}

/**
 * 为市场数据添加行业信息
 * @param {Array} rows 市场数据行
 * @returns {Array} 添加了 hybk 字段的数据行
 */
export function enrichWithIndustry(rows) {
  if (!Array.isArray(rows)) return rows;
  
  const mapping = loadIndustryMapping();
  let matched = 0;
  
  return rows.map(row => {
    const info = mapping.get(row.c ?? row.code);
    if (info && info.industry > 0) {
      row.hybk = info.industryName;
      row._industryCode = info.industry;
      matched++;
    } else {
      row.hybk = row.hybk ?? "未知";
      // 不添加 _industryCode 字段，保持测试兼容性
    }
    return row;
  });
}

/**
 * 获取行业分布统计
 * @returns {Array<{name: string, count: number}>}
 */
export function getIndustryDistribution() {
  const mapping = loadIndustryMapping();
  const distribution = new Map();
  
  for (const [code, info] of mapping.entries()) {
    const name = info.industryName;
    distribution.set(name, (distribution.get(name) ?? 0) + 1);
  }
  
  return [...distribution.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 清除缓存（用于测试或强制刷新）
 */
export function clearCache() {
  _industryMapping = null;
  _lastLoadTime = 0;
}

/**
 * 检查行业数据是否可用
 * @returns {boolean}
 */
export function isAvailable() {
  return existsSync(STOCK_DB_PATH);
}
