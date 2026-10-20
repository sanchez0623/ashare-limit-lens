// 标签贡献度数据库
// 记录每个标签的历史效果，数据驱动权重调整

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../../data");
const DB_PATH = join(DB_DIR, "tag-contribution.db");

// 确保数据目录存在
if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

/**
 * 初始化数据库
 */
function initDB(db) {
  db.exec(`
    -- 标签贡献度表
    CREATE TABLE IF NOT EXISTS tag_contributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT NOT NULL,
      date TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      avg_return REAL DEFAULT 0,
      positive_ratio REAL DEFAULT 0.5,
      total_return REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tag, date)
    );
    
    -- 标签权重表（定期更新）
    CREATE TABLE IF NOT EXISTS tag_weights (
      tag TEXT PRIMARY KEY,
      weight REAL DEFAULT 1.0,
      confidence REAL DEFAULT 0.0,
      sample_count INTEGER DEFAULT 0,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    -- 标签出现记录（原始数据）
    CREATE TABLE IF NOT EXISTS tag_appearances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT,
      tag TEXT NOT NULL,
      next_day_return REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    -- 索引优化
    CREATE INDEX IF NOT EXISTS idx_tag_contributions_tag_date ON tag_contributions(tag, date);
    CREATE INDEX IF NOT EXISTS idx_tag_appearances_date ON tag_appearances(date);
    CREATE INDEX IF NOT EXISTS idx_tag_appearances_tag ON tag_appearances(tag);
    CREATE INDEX IF NOT EXISTS idx_tag_appearances_code ON tag_appearances(code);
  `);
}

/**
 * 获取数据库连接（单例）
 */
let _db = null;
export function getDB() {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    _db.exec("PRAGMA busy_timeout=5000;");
    initDB(_db);
  }
  return _db;
}

/**
 * 记录标签出现
 * @param {string} date 日期
 * @param {string} code 股票代码
 * @param {string} name 股票名称
 * @param {string} tag 标签
 */
export function recordTagAppearance(date, code, name, tag) {
  const db = getDB();
  db.prepare(`
    INSERT INTO tag_appearances (date, code, name, tag)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date, code, tag) DO NOTHING
  `).run(date, code, name, tag);
}

/**
 * 记录标签次日收益
 * @param {string} date 日期
 * @param {string} code 股票代码
 * @param {number} nextDayReturn 次日收益
 */
export function recordTagReturn(date, code, nextDayReturn) {
  const db = getDB();
  db.prepare(`
    UPDATE tag_appearances 
    SET next_day_return = ?
    WHERE date = ? AND code = ?
  `).run(nextDayReturn, date, code);
}

/**
 * 批量记录标签出现和收益
 * @param {string} date 日期
 * @param {Array} records [{code, name, tag, nextDayReturn}]
 */
export function batchRecordTagData(date, records) {
  const db = getDB();
  db.exec("BEGIN TRANSACTION;");
  
  try {
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO tag_appearances (date, code, name, tag, next_day_return)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    for (const rec of records) {
      insertStmt.run(date, rec.code, rec.name, rec.tag, rec.nextDayReturn ?? null);
    }
    
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

/**
 * 计算标签贡献度
 * @param {string} tag 标签
 * @returns {{count: number, avgReturn: number, positiveRatio: number, weight: number}}
 */
export function calculateTagContribution(tag) {
  const db = getDB();
  const result = db.prepare(`
    SELECT 
      COUNT(*) as count,
      AVG(next_day_return) as avgReturn,
      AVG(CASE WHEN next_day_return > 0 THEN 1 ELSE 0 END) as positiveRatio,
      SUM(next_day_return) as totalReturn
    FROM tag_appearances
    WHERE tag = ? AND next_day_return IS NOT NULL
  `).get(tag);
  
  if (!result || result.count === 0) {
    return { count: 0, avgReturn: 0, positiveRatio: 0.5, weight: 1.0 };
  }
  
  // 基于收益计算权重
  // 权重范围：0.5 (差) 到 2.0 (好)
  // 基准：平均收益 0.5% 对应权重 1.0
  const baseReturn = 0.005; // 0.5%
  const weight = Math.max(0.5, Math.min(2.0, 1 + (result.avgReturn - baseReturn) / baseReturn));
  
  return {
    count: result.count,
    avgReturn: result.avgReturn,
    positiveRatio: result.positiveRatio,
    weight: weight,
  };
}

/**
 * 获取所有标签的权重
 * @returns {Map<string, number>} 标签 -> 权重
 */
export function getAllTagWeights() {
  const db = getDB();
  const rows = db.prepare(`
    SELECT tag, weight
    FROM tag_weights
    WHERE sample_count >= 10
  `).all();
  
  const weights = new Map();
  for (const row of rows) {
    weights.set(row.tag, row.weight);
  }
  
  return weights;
}

/**
 * 更新标签权重（定期任务）
 */
export function updateTagWeights() {
  const db = getDB();
  db.exec("BEGIN TRANSACTION;");
  
  try {
    // 计算所有标签的贡献度并更新权重
    const tags = db.prepare(`
      SELECT DISTINCT tag
      FROM tag_appearances
      WHERE next_day_return IS NOT NULL
    `).all();
    
    for (const { tag } of tags) {
      const contribution = calculateTagContribution(tag);
      if (contribution.count >= 10) {
        db.prepare(`
          INSERT OR REPLACE INTO tag_weights (tag, weight, confidence, sample_count, last_updated)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(tag, contribution.weight, contribution.positiveRatio, contribution.count);
      }
    }
    
    db.exec("COMMIT;");
    return { updated: tags.length };
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

/**
 * 获取标签权重（带默认值）
 * @param {string} tag 标签
 * @returns {number} 权重
 */
export function getTagWeightWithDefault(tag, defaultWeight = 1.0) {
  const weights = getAllTagWeights();
  return weights.get(tag) ?? defaultWeight;
}

/**
 * 获取统计信息
 */
export function getStats() {
  const db = getDB();
  return {
    totalAppearances: db.prepare("SELECT COUNT(*) as count FROM tag_appearances").get().count,
    tagsWithReturns: db.prepare("SELECT COUNT(DISTINCT tag) as count FROM tag_appearances WHERE next_day_return IS NOT NULL").get().count,
    tagsWithWeights: db.prepare("SELECT COUNT(*) as count FROM tag_weights").get().count,
    dbPath: DB_PATH,
  };
}

/**
 * 清除数据库（测试用）
 */
export function clearDB() {
  const db = getDB();
  db.exec("DELETE FROM tag_appearances;");
  db.exec("DELETE FROM tag_weights;");
  db.exec("DELETE FROM tag_contributions;");
}

/**
 * 关闭数据库连接
 */
export function closeDB() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
