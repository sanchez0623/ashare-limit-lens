// 行业数据服务
// 从 QuanQuant stock.db 提取行业代码映射，为市场数据提供行业信息

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

// QuanQuant stock.db 路径
const STOCK_DB_PATH = "D:/Sanchez/QuanQuant/hikyuu-quan/stock/stock.db";

// 行业代码到名称的映射（基于 raw-pools-enhanced 数据学习）
const INDUSTRY_NAMES = {
  1: "银行证券", 2: "房地产", 3: "钢铁", 4: "家居建材", 5: "有色金属",
  6: "电力设备", 7: "汽车", 8: "交通运输", 9: "医药生物", 10: "旅游酒店",
  11: "房地产", 12: "商业百货", 13: "电子信息", 14: "食品饮料", 15: "纺织服饰",
  16: "电力", 17: "农林牧渔", 18: "传媒影视", 19: "化工", 20: "煤炭",
  21: "建筑装饰", 22: "水泥建材", 23: "家电", 24: "通信", 25: "综合",
  26: "机械设备", 27: "化工材料", 28: "基础化工", 29: "电力设备", 30: "电气设备",
  31: "房地产服务", 32: "建筑装饰", 33: "建筑材料", 34: "医药生物", 35: "环境治理",
  36: "稀土小金属", 37: "食品饮料", 38: "造纸印刷", 39: "环保", 40: "公用事业",
  41: "纺织服饰", 42: "公用事业", 43: "新能源", 44: "光伏", 45: "机械设备",
  46: "传媒", 47: "塑料橡胶", 48: "玻璃", 49: "国防军工", 50: "国防军工",
  51: "电子信息", 52: "综合",
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
      WHERE (s.type = 1 OR s.type = 8) AND f.industry > 0
      ORDER BY s.type ASC
    `).all();
    
    const mapping = new Map();
    for (const row of rows) {
      // 优先选择 type=1 (A 股)，如果有重复代码
      if (mapping.has(row.code)) {
        const existing = mapping.get(row.code);
        if (row.industry > 0 && existing.industry === 0) {
          // 如果现有的是无效行业代码，用新的替换
          mapping.set(row.code, {
            name: row.name,
            industry: row.industry,
            industryName: INDUSTRY_NAMES[row.industry] ?? `行业${row.industry}`,
          });
        }
      } else {
        mapping.set(row.code, {
          name: row.name,
          industry: row.industry,
          industryName: INDUSTRY_NAMES[row.industry] ?? `行业${row.industry}`,
        });
      }
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
