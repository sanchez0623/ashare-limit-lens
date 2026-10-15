// 卖出信号检测器（方案 5）：在固定止损之外增加主动止盈/卖出信号。
//
// 六类主动卖出信号（与 skill 文档对齐）：
//   放量滞涨 volume-stall：今日成交量 > 20日均量 × 1.5，且涨幅 < 2%
//   炸板不回封 broken-no-reseal：盘中炸板 ≥2 次，且收盘未封住涨停
//     （EOD 快照语义："14:30 后未回封"以收盘仍未封板为准——收盘封住的
//      股票不触发；盘中时点判定超出 EOD 数据能力）
//   跌破5日均线 below-ma5：收盘价 < MA5（短线趋势破位）
//   高位长上影 high-upper-shadow：(最高价 - max(开,收)) / 收盘价 > 3%，
//     且收盘处于 20 日新高（收盘 ≥ 前 19 根最高价）
//   板块集体退潮 sector-ebb：同行业涨停数较昨日减少 ≥50%
//   情绪周期切换 phase-shift：情绪周期由高潮期跌入退潮期（方案 1 输出）
//
// 输入约定（marketData）：
//   row：当日快照行（normalize 后：change / isLimitUp / breaks / open /
//        close|price / high），可为 null（持仓股掉出当日池）
//   features：日线历史特征 { ma5, vol20Avg, todayVolume, high20Prev }，
//        字段可缺失（数据不足 → 对应信号跳过，不猜）
//   sectorLimitDrop / phaseShift：布尔或 null，由调用方从昨日对照计算
//
// 任一信号成立 → exit: true（建议清仓该持仓），reason 汇总全部命中信号。
// 特征缺失的信号直接跳过——缺失数据不产生卖出建议，也不阻止其他信号。

const num = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : Number(v);

export const EXIT_SIGNALS = Object.freeze({
  VOLUME_STALL: "volume-stall", // 放量滞涨
  BROKEN_NO_RESEAL: "broken-no-reseal", // 炸板不回封
  BELOW_MA5: "below-ma5", // 跌破5日均线
  HIGH_UPPER_SHADOW: "high-upper-shadow", // 高位长上影
  SECTOR_EBB: "sector-ebb", // 板块集体退潮
  PHASE_SHIFT: "phase-shift", // 情绪周期切换
});

export const VOLUME_STALL_RATIO = 1.5; // 今日量 / 20日均量 阈值
export const VOLUME_STALL_MAX_CHANGE = 2; // 滞涨的涨幅上限（%）
export const BROKEN_MIN_COUNT = 2; // 炸板次数下限
export const UPPER_SHADOW_MIN_PCT = 3; // 长上影最小幅度（%）
export const SECTOR_EBB_DROP_RATIO = 0.5; // 板块涨停数较昨日降幅
export const EXIT_LOOKBACK_DAYS = 20; // 卖出特征回溯窗口（日）

// position：持仓（仅需 code 供定位）；marketData：{
//   row, features, sectorLimitDrop, phaseShift }
// 返回 { exit: boolean, signals: [{ type, reason }], reason }。
export function checkExitSignals(position, marketData = {}) {
  const row = marketData.row ?? null;
  const features = marketData.features ?? null;
  const signals = [];

  if (row) {
    const change = num(row.change);
    const close = num(row.close) ?? num(row.price);
    const high = num(row.high);
    const open = num(row.open);
    const todayVolume = num(features?.todayVolume);
    const vol20Avg = num(features?.vol20Avg);
    const ma5 = num(features?.ma5);
    const high20Prev = num(features?.high20Prev);

    // 放量滞涨
    if (
      todayVolume !== null &&
      vol20Avg !== null &&
      vol20Avg > 0 &&
      todayVolume > vol20Avg * VOLUME_STALL_RATIO &&
      change !== null &&
      change < VOLUME_STALL_MAX_CHANGE
    )
      signals.push({
        type: EXIT_SIGNALS.VOLUME_STALL,
        reason: `成交量 ${Math.round(todayVolume / 1e4)} 万手为 20 日均量 ${Math.round(vol20Avg / 1e4)} 万手的 ${(todayVolume / vol20Avg).toFixed(1)} 倍，但涨幅仅 ${change.toFixed(2)}%`,
      });

    // 炸板不回封
    const breaks = num(row.breaks);
    if (
      row.isLimitUp === false &&
      breaks !== null &&
      breaks >= BROKEN_MIN_COUNT
    )
      signals.push({
        type: EXIT_SIGNALS.BROKEN_NO_RESEAL,
        reason: `盘中炸板 ${breaks} 次且收盘未回封涨停`,
      });

    // 跌破 5 日均线
    if (ma5 !== null && close !== null && close < ma5)
      signals.push({
        type: EXIT_SIGNALS.BELOW_MA5,
        reason: `收盘 ${close.toFixed(2)} 跌破 5 日均线 ${ma5.toFixed(2)}`,
      });

    // 高位长上影
    if (
      high !== null &&
      open !== null &&
      close !== null &&
      close > 0 &&
      high20Prev !== null &&
      close >= high20Prev
    ) {
      const shadowPct = ((high - Math.max(open, close)) / close) * 100;
      if (shadowPct > UPPER_SHADOW_MIN_PCT)
        signals.push({
          type: EXIT_SIGNALS.HIGH_UPPER_SHADOW,
          reason: `20 日新高位长上影：上影 ${shadowPct.toFixed(2)}%`,
        });
    }
  }

  // 板块集体退潮
  if (marketData.sectorLimitDrop === true)
    signals.push({
      type: EXIT_SIGNALS.SECTOR_EBB,
      reason: "同行业涨停数较昨日减少 ≥50%，板块集体退潮",
    });

  // 情绪周期切换
  if (marketData.phaseShift === true)
    signals.push({
      type: EXIT_SIGNALS.PHASE_SHIFT,
      reason: "情绪周期由高潮期跌入退潮期",
    });

  return {
    exit: signals.length > 0,
    signals,
    reason: signals.map((s) => s.reason).join("；"),
  };
}

// 板块退潮统计：今日/昨日涨停池 → 同板块涨停数降幅 ≥50% 的板块集合。
// 输入统一规范化：
//   - 今日池：normalize() 后行（sector/height），height = lbc ?? ylbc；
//   - 昨日池：原始行（hybk/ylbc 字段；部分数据可能回填 lbc），
//     昨日连板数以 ylbc 为准，缺失时回退 lbc，与 normalize 的 height 对齐。
// 昨日无数据时返回空 Map（不产生该信号）。
export function sectorLimitUpDrops(todayRows, previousRows) {
  const drops = new Map();
  if (!Array.isArray(previousRows) || previousRows.length === 0) return drops;
  const countBy = (rows, sectorKey, heightKeys) => {
    const map = new Map();
    for (const row of rows ?? []) {
      const sector = row?.[sectorKey];
      if (!sector) continue;
      const height =
        Number(row?.[heightKeys[0]]) || Number(row?.[heightKeys[1]]) || 0;
      if (height < 1) continue;
      map.set(sector, (map.get(sector) ?? 0) + 1);
    }
    return map;
  };
  const today = countBy(todayRows, "sector", ["height"]);
  const yesterday = countBy(previousRows, "hybk", ["ylbc", "lbc"]);
  // 以昨日板块为基准遍历：板块今日涨停清零同样构成 ≥50% 退潮
  for (const [sector, yesterdayCount] of yesterday) {
    const todayCount = today.get(sector) ?? 0;
    if (
      yesterdayCount > 0 &&
      todayCount <= yesterdayCount * (1 - SECTOR_EBB_DROP_RATIO)
    )
      drops.set(sector, true);
  }
  return drops;
}
