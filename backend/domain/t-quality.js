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
//
// 盈亏口径：配对腿净现金流（含双边费用）——卖出腿 cashDelta 为正、
// 买入腿为负，净额即该笔 T 的价差盈亏。不用 realizedPnlCents：卖出
// 腮的已实现盈亏按旧仓 FIFO 成本计，随旧仓成本漂移会反转胜负。
//
// 了结口径：按交易日聚合——同码同日的全部做T腿属于同一笔尝试（计划
// 层每码每日至多一笔 T），日终买卖两腿都有成交才算当日了结；分批
// 成交不会提前关闭记录。跨日由恢复腿（orderId 以 :recovery 结尾）
// 补齐尝试腿数量后了结。
//
// 质量摘要的证据冻结：tQualityEvidence（records + tradingDates）随
// 计划冻结，核验方（assertProgramSnapshot / verifyExport）用证据
// 独立重算摘要与声明比对——摘要不可直接声明。两个输入窗口由
// evidenceWindow 统一截断，保证所有调用方重算一致。

// 规则版本（对齐 downgrade 的显式版本冻结模式）：摘要与规则共同进化，
// 计划冻结时写入，重算/核验读到不认识的版本立即报错，不静默换口径。
export const T_QUALITY_RULES_VERSION = 1;
// 质量评分与胜率的样本窗口：最近 N 笔已了结做T。
export const T_QUALITY_SAMPLE_SIZE = 10;
// 停手规则：连续 2 笔亏损 → 停手 3 个交易日。
export const T_STOP_CONSECUTIVE_LOSSES = 2;
export const T_STOP_TRADING_DAYS = 3;
// 证据窗口：摘要只基于最近 40 笔已了结记录与最近 40 个交易日——
// 停手窗口（连续亏损尾部 + 3 个交易日）远小于该窗口，截断不影响
// 结论，且让计划内的冻结证据体积有界。
export const T_QUALITY_EVIDENCE_WINDOW = 40;

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

// 了结顺序：了结日期 → 了结时成交序号 → id。同日多笔按实际了结先后
// 统计，不得按代码字典序（否则连续亏损会被打乱漏判）。
const byCompletion = (a, b) =>
  String(a.completed_date ?? "").localeCompare(
    String(b.completed_date ?? ""),
  ) ||
  (a.completed_sequence ?? 0) - (b.completed_sequence ?? 0) ||
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
    completed_sequence: 0,
  };
}

// 单腿现金流：卖出腿为正、买入腿为负（含费用）。成交行缺 cashDelta
// 时按 notional 近似（旧数据兼容），盈亏精度让位于可用性。
function legCashDelta(fill) {
  if (Number.isFinite(fill?.cashDeltaCents)) return fill.cashDeltaCents;
  const notional = (fill?.priceCents ?? 0) * (fill?.quantity ?? 0);
  return fill?.side === "SELL" ? notional : -notional;
}

// 单腿成交并入记录：数量/名义额累计（均价落库前折算），盈亏累计配对
// 现金流，completed_sequence 跟随最后一条成交（了结序号）。
function applyLeg(record, fill) {
  const quantity = fill.quantity ?? 0;
  const notional = (fill.priceCents ?? 0) * quantity;
  if (fill.side === "BUY") {
    record.buy_quantity += quantity;
    record._buy_notional = (record._buy_notional ?? 0) + notional;
  } else {
    record.sell_quantity += quantity;
    record._sell_notional = (record._sell_notional ?? 0) + notional;
  }
  const cash = legCashDelta(fill);
  if (fill.date === record.trade_date) record.day_pnl_cents += cash;
  record.total_pnl_cents += cash;
  record.completed_sequence = fill.sequence ?? record.completed_sequence ?? 0;
}

// 恢复腿并入 open 记录：T_FORWARD 补卖出腿，T_REVERSE 补买入腿。
// 恢复腿现金流只累计进 total（当日口径停留在尝试日）；补齐尝试腿
// 数量即了结。
export function applyRecoveryFill(record, fill) {
  const updated = { ...record };
  if (fill.side === "SELL") {
    updated.sell_quantity += fill.quantity ?? 0;
    updated.sell_price_cents = fill.priceCents;
    updated._sell_notional =
      (record._sell_notional ?? 0) +
      (fill.priceCents ?? 0) * (fill.quantity ?? 0);
  } else {
    updated.buy_quantity += fill.quantity ?? 0;
    updated.buy_price_cents = fill.priceCents;
    updated._buy_notional =
      (record._buy_notional ?? 0) +
      (fill.priceCents ?? 0) * (fill.quantity ?? 0);
  }
  const cash = legCashDelta(fill);
  if (fill.side === "SELL")
    updated.total_pnl_cents = (record.total_pnl_cents ?? 0) + cash;
  updated.completed_sequence = fill.sequence ?? record.completed_sequence ?? 0;
  const target =
    updated.action === "T_FORWARD"
      ? updated.buy_quantity
      : updated.sell_quantity;
  const recovered =
    updated.action === "T_FORWARD"
      ? updated.sell_quantity
      : updated.buy_quantity;
  if (target > 0 && recovered >= target) updated.completed_date = fill.date;
  return updated;
}

// 落库/汇总前的记录整形：均价折算（去内部名义额累计字段）。
function settleRecord(record) {
  const shaped = { ...record };
  shaped.buy_price_cents = shaped.buy_quantity
    ? Math.round((shaped._buy_notional ?? 0) / shaped.buy_quantity)
    : null;
  shaped.sell_price_cents = shaped.sell_quantity
    ? Math.round((shaped._sell_notional ?? 0) / shaped.sell_quantity)
    : null;
  delete shaped._buy_notional;
  delete shaped._sell_notional;
  return shaped;
}

// 从成交流水提取全部做T记录（全历史）。fills 需按 (date, sequence) 有序，
// 无序时内部排序。了结按交易日聚合：同码同日的全部做T腿先聚合，日终
// 买卖两腿都有成交才判当日了结——分批成交不会提前关闭记录。返回
// { records, open }：records 为已了结记录，open 为尚待恢复腿的未了结
// 记录（含被更晚新尝试让位的旧 open 记录，不参与质量统计）。
export function extractTTrades(fills) {
  const ordered = [...(fills ?? [])].sort(byDaySequence);
  const openByCode = new Map(); // code → 跨日未了结记录（等待恢复腿）
  const dayByCode = new Map(); // code → 当日尝试记录（日终判定去留）
  const open = [];
  const completed = [];
  let currentDay = null;
  const finalize = (record) => {
    record.completed_same_day =
      record.completed_date === record.trade_date ? 1 : 0;
    completed.push(settleRecord(record));
  };
  const closeDay = () => {
    for (const record of dayByCode.values()) {
      if (record.buy_quantity > 0 && record.sell_quantity > 0) {
        record.completed_date = record.trade_date;
        finalize(record);
      } else {
        openByCode.set(record.code, record); // 单腿尝试，等待恢复腿
      }
    }
    dayByCode.clear();
  };
  for (const fill of ordered) {
    if (!fill?.code || !fill?.date) continue;
    if (fill.date !== currentDay) {
      closeDay();
      currentDay = fill.date;
    }
    if (fill.action === "T_FORWARD" || fill.action === "T_REVERSE") {
      if (fill.side !== "BUY" && fill.side !== "SELL") continue;
      let record = dayByCode.get(fill.code);
      if (!record) {
        record = blankRecord(fill);
        dayByCode.set(fill.code, record);
      }
      applyLeg(record, fill);
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
  closeDay();
  return { records: completed, open: [...open, ...openByCode.values()] };
}

// 证据窗口：摘要与其冻结证据共用同一截断（已了结记录按了结顺序取
// 最近 W 笔；交易日去重排序取最近 W 天）——所有调用方重算一致。
function evidenceWindow(records, tradingDates) {
  const completed = [...(records ?? [])]
    .filter((record) => record?.completed_date != null)
    .sort(byCompletion)
    .slice(-T_QUALITY_EVIDENCE_WINDOW);
  const dates = [...new Set(tradingDates ?? [])]
    .filter((day) => typeof day === "string" && day)
    .sort()
    .slice(-T_QUALITY_EVIDENCE_WINDOW);
  return { completed, dates };
}

// 冻结证据（计划顶层 tQualityEvidence 字段）：支撑摘要的做T记录与
// 交易日列表。无已了结记录时日期列表一并置空——空历史的摘要与日期
// 无关，主账户/影子/重放对同一空状态冻结出完全相同的证据。
export function buildTQualityEvidence(records, tradingDates) {
  const { completed, dates } = evidenceWindow(records, tradingDates);
  // 无已了结记录时日期列表一并置空——空历史的摘要与日期无关，主账户
  // /影子/重放对同一空状态冻结出完全相同的证据。
  return {
    records: completed.map((record) => settleRecord(record)),
    tradingDates: completed.length ? dates : [],
  };
}

// 第 n 个交易日（tradingDates 为有序交易日列表）。
function nthTradingDayAfter(fromDate, tradingDates, n) {
  const after = (tradingDates ?? []).filter((day) => day > fromDate);
  return after.length >= n ? after[n - 1] : null;
}

// 汇总做T质量 → 计划冻结的 tQuality 摘要。signalDate 为信号日（计划
// 在其下一交易日执行）；tradingDates 为截至信号日（含）的有序交易日
// 列表——主账户/影子取结算日历，重放/回测取自身日期序列，同一信号日
// 得到同一列表。停手判定：最近 2 笔已了结做T连续亏损，且信号日距最近
// 一笔亏损了结日不足 3 个交易日（停手期内不会有新的做T了结，最近一
// 笔即触发笔）。摘要只依赖截至信号日的输入，不含未来日历。
export function summarizeTQuality(
  records,
  { signalDate, tradingDates = [] } = {},
) {
  const { completed, dates } = evidenceWindow(records, tradingDates);
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
  let stopTriggerDate = null;
  if (consecutiveLosses >= T_STOP_CONSECUTIVE_LOSSES) {
    const lastLoss = completed[completed.length - 1];
    const daysBetween = dates.filter(
      (day) => day > lastLoss.completed_date && day <= signalDate,
    ).length;
    if (daysBetween < T_STOP_TRADING_DAYS) {
      blocked = true;
      stopTriggerDate = lastLoss.completed_date;
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
    stopTriggerDate,
  };
}
