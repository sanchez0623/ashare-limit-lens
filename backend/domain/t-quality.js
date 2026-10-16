// 做T质量追踪（方案 7）：量化"做T越做越错"——把 skill 的做T纪律
// 变成可执行的规则。
//
//   1. 每笔做T记录：T买入价 / T卖出价 / 当日T盈亏 / 是否当日了结
//      （paper_t_trades 表，从 paper_ledger 成交派生，随结算落库）；
//   2. 连续做T质量评分：最近 N 笔已了结做T的平均盈亏 < 0 → 标记
//      "做T状态差"；
//   3. 连续 2 笔做T亏损 → 停手 3 个交易日；
//   4. 做T仓位上限按胜率动态调整：> 60% 允许 2 成仓、40%~60% 限
//      1 成、< 40% 禁止做T。
//
// 纯数据与纯函数，不读数据库。调用方：
//   - 主账户结算：从当日 paper_ledger 成交提取记录（恢复腿跨日了结时
//     更新 open 记录），随 settle 批落库；计划冻结时查表汇总成
//     tQuality 冻结摘要传入 createPlan；
//   - 研究重放 / 回测 / 影子：不写表，用同一 extractTTrades 从各自
//     成交流水派生记录，再 summarize——各链路汇总口径一致。
// 计划携带的 tQuality 摘要带 rulesVersion，版本不匹配拒绝生成计划；
// 旧计划（无 tQuality 字段）保持旧语义（tFraction 原样，无闸门）。

// 规则版本（对齐 downgrade 的显式版本冻结模式）：摘要与规则共同进化，
// 计划冻结时写入，重算/核验读到不认识的版本立即报错，不静默换口径。
export const T_QUALITY_RULES_VERSION = 1;
// 质量评分与胜率的样本窗口：最近 N 笔已了结做T。
export const T_QUALITY_SAMPLE_SIZE = 10;
// 停手规则：连续 2 笔亏损 → 停手 3 个交易日。
export const T_STOP_CONSECUTIVE_LOSSES = 2;
export const T_STOP_TRADING_DAYS = 3;

const round6 = (value) =>
  value == null ? null : Math.round(value * 1e6) / 1e6;

// 胜率 → 做T仓位上限（占底仓比例）。无已了结历史返回 null：不设上限，
// 保持策略原 tFraction（数据不足不猜测，与检测器"宁缺毋滥"同一口径）。
export function tCapForWinRate(winRate) {
  if (winRate == null) return null;
  if (winRate > 0.6) return 0.2; // 胜率 > 60%：允许 2 成仓
  if (winRate >= 0.4) return 0.1; // 40%~60%：限 1 成
  return 0; // < 40%：禁止做T
}

// 实时恢复单识别：恢复腿订单 id 以 ":recovery" 结尾（openSession），
// 成交行携带 orderId 字段。盘后旧执行器从不写 pendingRecovery，无
// 恢复腿；":carry" 结尾的盘后续单是未完成减仓，不属于做T恢复。
export function isRecoveryFill(fill) {
  return (
    typeof fill?.orderId === "string" && fill.orderId.endsWith(":recovery")
  );
}

const byDaySequence = (a, b) =>
  String(a.date ?? "").localeCompare(String(b.date ?? "")) ||
  (a.sequence ?? 0) - (b.sequence ?? 0) ||
  String(a.id ?? "").localeCompare(String(b.id ?? ""));

// 空记录骨架（一条做T尝试）。legs：T_FORWARD 先买后卖；T_REVERSE 先卖后买。
function blankRecord(fill) {
  return {
    id: `${fill.date}:${fill.code}`,
    trade_date: fill.date,
    code: fill.code,
    action: fill.action,
    buy_price_cents: null,
    sell_price_cents: null,
    buy_quantity: 0,
    sell_quantity: 0,
    day_pnl_cents: 0,
    total_pnl_cents: 0,
    completed_same_day: 0,
    completed_date: null,
  };
}

// 单腿成交并入记录。卖出腿的已实现盈亏计入 day/total（FIFO 对旧仓，
// 口径与账本 realizedPnlCents 一致）；买入腿无盈亏。
function applyLeg(record, fill) {
  if (fill.side === "BUY") {
    record.buy_price_cents = fill.priceCents;
    record.buy_quantity += fill.quantity ?? 0;
  } else {
    record.sell_price_cents = fill.priceCents;
    record.sell_quantity += fill.quantity ?? 0;
    const pnl = fill.realizedPnlCents ?? 0;
    record.day_pnl_cents += pnl;
    record.total_pnl_cents += pnl;
  }
}

// 恢复腿并入 open 记录：T_FORWARD 补卖出腿（计入盈亏），T_REVERSE 补
// 买入腿。恢复腿数量累计补齐尝试腿数量（T+1 底仓 T 数量）即了结。
export function applyRecoveryFill(record, fill) {
  const updated = { ...record };
  if (fill.side === "SELL") {
    updated.sell_price_cents = fill.priceCents;
    updated.sell_quantity += fill.quantity ?? 0;
    const pnl = fill.realizedPnlCents ?? 0;
    // 当日口径停留在尝试日；恢复腿盈亏只累计进 total（跨日了结）
    updated.total_pnl_cents = (record.total_pnl_cents ?? 0) + pnl;
  } else {
    updated.buy_price_cents = fill.priceCents;
    updated.buy_quantity += fill.quantity ?? 0;
  }
  const target =
    updated.action === "T_FORWARD"
      ? updated.buy_quantity
      : updated.sell_quantity;
  const recovered =
    updated.action === "T_FORWARD"
      ? updated.sell_quantity
      : updated.buy_quantity;
  if (target > 0 && recovered >= target) {
    updated.completed_date = fill.date;
  }
  return updated;
}

// 从成交流水提取全部做T记录（全历史）。fills 需按 (date, sequence) 有序，
// 无序时内部排序。返回 { records, open }：records 为已了结记录，open 为
// 尚待恢复腿的未了结记录——含被更晚新尝试让位的旧 open 记录（旧执行器
// 路径无恢复腿，未了结记录保持 open，不参与质量统计）。
export function extractTTrades(fills) {
  const ordered = [...(fills ?? [])].sort(byDaySequence);
  const openByCode = new Map(); // code → 未了结记录
  const open = [];
  const completed = [];
  const finalize = (record) => {
    record.completed_same_day =
      record.completed_date === record.trade_date ? 1 : 0;
    completed.push(record);
  };
  for (const fill of ordered) {
    if (!fill?.code || !fill?.date) continue;
    if (fill.action === "T_FORWARD" || fill.action === "T_REVERSE") {
      if (fill.side !== "BUY" && fill.side !== "SELL") continue;
      const existing = openByCode.get(fill.code);
      if (existing && existing.trade_date === fill.date) {
        applyLeg(existing, fill);
        // 同日两腿齐 → 当日了结
        if (existing.buy_quantity > 0 && existing.sell_quantity > 0) {
          existing.completed_date = fill.date;
          openByCode.delete(fill.code);
          finalize(existing);
        }
        continue;
      }
      const record = blankRecord(fill);
      applyLeg(record, fill);
      if (record.buy_quantity > 0 && record.sell_quantity > 0) {
        record.completed_date = fill.date;
        finalize(record);
      } else {
        const previous =
          existing && existing.trade_date !== fill.date ? existing : null;
        if (previous) {
          openByCode.delete(fill.code);
          open.push(previous);
        }
        openByCode.set(fill.code, record);
      }
      continue;
    }
    if (isRecoveryFill(fill)) {
      const record = openByCode.get(fill.code);
      if (!record) continue; // 无待恢复的做T尝试（旧数据或已了结），忽略
      const updated = applyRecoveryFill(record, fill);
      if (updated.completed_date) {
        openByCode.delete(fill.code);
        finalize(updated);
      } else {
        openByCode.set(fill.code, updated);
      }
    }
  }
  return { records: completed, open: [...open, ...openByCode.values()] };
}

// 第 n 个交易日（tradingDates 为有序交易日列表）。
function nthTradingDayAfter(fromDate, tradingDates, n) {
  const after = (tradingDates ?? []).filter((day) => day > fromDate);
  return after.length >= n ? after[n - 1] : null;
}

// 汇总做T质量 → 计划冻结的 tQuality 摘要。signalDate 为信号日（计划
// 在其next交易执行）；tradingDates 为覆盖记录窗口的有序交易日列表
// （主账户：结算日历含未来日历；重放/回测：pairs 日期序列）。
// 停手判定：最近 2 笔已了结做T连续亏损，且信号日距第 2 笔了结日不足
// 3 个交易日——即执行日仍落在停手窗口内。
export function summarizeTQuality(
  records,
  { signalDate, tradingDates = [] } = {},
) {
  const completed = [...(records ?? [])]
    .filter((record) => record?.completed_date != null)
    .sort(
      (a, b) =>
        a.completed_date.localeCompare(b.completed_date) ||
        a.id.localeCompare(b.id),
    );
  const sample = completed.slice(-T_QUALITY_SAMPLE_SIZE);
  const wins = sample.filter(
    (record) => (record.total_pnl_cents ?? 0) > 0,
  ).length;
  const winRate = sample.length ? wins / sample.length : null;
  const avgPnl = sample.length
    ? sample.reduce((sum, record) => sum + (record.total_pnl_cents ?? 0), 0) /
      sample.length
    : null;
  let consecutiveLosses = 0;
  for (let index = completed.length - 1; index >= 0; index--) {
    if ((completed[index].total_pnl_cents ?? 0) < 0) consecutiveLosses++;
    else break;
  }
  let blocked = false;
  let blockedUntil = null;
  if (consecutiveLosses >= T_STOP_CONSECUTIVE_LOSSES) {
    // 停手窗口从最近一笔亏损了结日起算：连续第 2 笔亏损了结即触发
    // （停手期内不会有新的做T了结，最近一笔即触发笔）。
    const lastLoss = completed[completed.length - 1];
    const daysBetween = (tradingDates ?? []).filter(
      (day) => day > lastLoss.completed_date && day <= signalDate,
    ).length;
    if (daysBetween < T_STOP_TRADING_DAYS) {
      blocked = true;
      blockedUntil = nthTradingDayAfter(
        lastLoss.completed_date,
        tradingDates,
        T_STOP_TRADING_DAYS,
      );
    }
  }
  return {
    rulesVersion: T_QUALITY_RULES_VERSION,
    sampleSize: T_QUALITY_SAMPLE_SIZE,
    completedCount: completed.length,
    winRate: round6(winRate),
    capTraction: tCapForWinRate(winRate),
    consecutiveLosses,
    statusMark: avgPnl != null && avgPnl < 0 ? "做T状态差" : null,
    blocked,
    blockedUntil,
  };
}
