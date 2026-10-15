// 买点类型分类器：把 skill 里描述的 6 种买点（打板/炸板低吸/首阴低吸/
// 假阴跌停低吸/早盘竞价低吸/尾盘跳水低吸）映射成可量化的标签。
//
// 输入：单只股票的当日快照（normalize 后的字段 + 可选的昨日/前日字段）。
// 输出：一个或多个 buyPointType + 置信度 + 触发原因。
//
// 设计原则：
// 1. 纯函数；缺失字段时对应规则不触发，不抛错。
// 2. 同一只股票可能同时命中多个标签（例如炸板低吸 + 首阴低吸），
//    按优先级返回主要标签 + 全部标签列表。
// 3. 阈值与 skill 文档对齐，作为后续赛马分化的基础维度。
//
// 字段说明（与 shared/scoring.js normalize 对齐）：
//  - isLimitUp: 是否当日涨停（收盘封板）
//  - change: 当日涨跌幅 (%)
//  - open: 当日开盘价（元）
//  - close: 当日收盘价（元），缺省等于 price
//  - high: 当日最高价（元）
//  - prevChange: 昨日涨跌幅 (%)
//  - prevOpen: 昨日开盘价（元）
//  - prevClose: 昨日收盘价（元）
//  - prevHeight: 昨日连板数
//  - prevBreaks: 昨日炸板次数
//  - height: 当前连板数（涨停股）
//  - breaks: 当日炸板次数
//  - first: 首次封板时间 HHMMSS（整数）
//  - last: 最后一次封板时间 HHMMSS
//  - openChange: 当日开盘相对昨收的涨跌幅 (%)（竞价低开幅度）
//  - intradayDrawdownFromHigh: 当日最高价到当前/收盘的回落幅度 (%)
//  - ma5: 当日 5 日均线值（元），缺省表示未知
//  - turnover: 当日换手率 (%)

export const BUY_POINT_TYPES = Object.freeze({
  LIMIT_UP_MOMENTUM: "limit-up-momentum", // 打板
  BROKEN_BOARD_DIP: "broken-board-dip", // 炸板低吸
  FIRST_NEG_DIP: "first-neg-dip", // 首阴低吸
  FAKE_NEG_LIMIT_DIP: "fake-neg-limit-dip", // 假阴跌停低吸
  AUCTION_DIP: "auction-dip", // 早盘竞价低吸
  LATE_DIP: "late-dip", // 尾盘跳水低吸
});

export const BUY_POINT_LABELS = Object.freeze({
  [BUY_POINT_TYPES.LIMIT_UP_MOMENTUM]: "打板",
  [BUY_POINT_TYPES.BROKEN_BOARD_DIP]: "炸板低吸",
  [BUY_POINT_TYPES.FIRST_NEG_DIP]: "首阴低吸",
  [BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP]: "假阴跌停低吸",
  [BUY_POINT_TYPES.AUCTION_DIP]: "早盘竞价低吸",
  [BUY_POINT_TYPES.LATE_DIP]: "尾盘跳水低吸",
});

// 优先级（数字越小越优先，主要标签按此顺序取）。
const PRIORITY = {
  [BUY_POINT_TYPES.LIMIT_UP_MOMENTUM]: 0,
  [BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP]: 1,
  [BUY_POINT_TYPES.BROKEN_BOARD_DIP]: 2,
  [BUY_POINT_TYPES.FIRST_NEG_DIP]: 3,
  [BUY_POINT_TYPES.AUCTION_DIP]: 4,
  [BUY_POINT_TYPES.LATE_DIP]: 5,
};

const num = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : Number(v);

function testMomentum(row) {
  // 打板：当日涨停且首封在 10:30 前，非一字（turnover >= 1）。
  if (!row.isLimitUp) return null;
  const first = num(row.first);
  const turnover = num(row.turnover);
  if (first !== null && first > 103000) return null;
  if (turnover !== null && turnover < 1) return null; // 一字板，跳过
  return {
    type: BUY_POINT_TYPES.LIMIT_UP_MOMENTUM,
    confidence: first && first < 94500 ? 0.9 : 0.7,
    reason: first
      ? `首封时间 ${first}，收盘涨停，有换手`
      : "收盘涨停，有换手",
  };
}

function testBrokenBoard(row) {
  // 炸板低吸：当日曾涨停但收盘未封，从涨停价回落 3%~7%。
  // 回撤幅度必须基于真实涨停价计算，不能用 change% 区间近似：
  //   pullback = (boardLimit - change) / boardLimit * 100
  // 例：20% 涨停股，收盘涨 6% → 回撤 = (20-6)/20 = 70% 的涨停幅度 = 11.67%
  // 例：20% 涨停股，收盘涨 15% → 回撤 = (20-15)/20 = 25% = 4.17%
  if (row.isLimitUp) return null;
  const breaks = num(row.breaks);
  const change = num(row.change);
  if (breaks === null || breaks <= 0) return null;
  if (change === null) return null;
  const boardLimit = num(row.boardLimit) ?? 10;
  // 回撤幅度：从涨停价回落到当前价的百分比（相对涨停价）。
  const pullback = ((boardLimit - change) / boardLimit) * 100;
  if (pullback < 3 || pullback > 7) return null;
  return {
    type: BUY_POINT_TYPES.BROKEN_BOARD_DIP,
    confidence: 0.75,
    reason: `盘中炸板 ${breaks} 次，相对涨停价回撤 ${pullback.toFixed(2)}%（当前涨 ${change.toFixed(2)}%），符合 3%~7% 安全垫`,
  };
}

function testFirstNegative(row) {
  // 首阴低吸：连板 >=3 后首次收阴，阴线实体 <=5%，5 日均线未破。
  // 严格校验 K 线条件：
  //   1. 当前 height >= 3（连板高度足够）
  //   2. 昨日 height >= 2（昨天还在连板，保证"首次"从连板中断）
  //   3. 今日开 > 收（实体阴线，而非"跌但收阳线"）
  //   4. 今日 change 在 -5% ~ 0 之间（阴线实体不大）
  //   5. MA5 已知且未破（收盘 > MA5）
  const height = num(row.height);
  if (height === null || height < 3) return null;
  const prevHeight = num(row.prevHeight);
  if (prevHeight === null || prevHeight < 2) return null; // 昨日不在连板中，不算"首阴"
  const open = num(row.open);
  const close = num(row.close) ?? num(row.price);
  if (open === null || close === null) return null;
  if (open <= close) return null; // 必须是实体阴线（开高收低）
  const change = num(row.change);
  if (change === null || change >= 0) return null;
  if (change < -5) return null; // 阴线实体过大
  // MA5 已知时才校验，未知则跳过（不通过也不拒绝）
  const ma5 = num(row.ma5);
  if (ma5 !== null && close < ma5) return null;
  return {
    type: BUY_POINT_TYPES.FIRST_NEG_DIP,
    confidence: 0.7,
    reason: `连板 ${height} 后首根实体阴线（开 ${open} 收 ${close}），跌幅 ${change.toFixed(2)}%，未破 5 日线`,
  };
}

function testFakeNegativeLimit(row) {
  // 假阴跌停低吸：
  //  - 昨日：实体阴线（prevOpen > prevClose）但 prevChange 接近 0（"假阴"——实际
  //    收在昨收附近，只是开高走低才收阴），且昨日涨停过（breaks>0 或 prevHeight>=1）
  //  - 今日：openChange <= -8%（大幅低开或跌停开）
  const prevChange = num(row.prevChange);
  const prevBreaks = num(row.prevBreaks);
  const prevHeight = num(row.prevHeight);
  const prevOpen = num(row.prevOpen);
  const prevClose = num(row.prevClose);
  const openChange = num(row.openChange);
  if (prevChange === null || openChange === null) return null;
  // 昨日有涨停特征：炸过板或连板数 >=1
  const prevWasLimitUp =
    (prevBreaks !== null && prevBreaks > 0) ||
    (prevHeight !== null && prevHeight >= 1);
  if (!prevWasLimitUp) return null;
  // 假阴校验：昨日开高收低（prevOpen > prevClose）但涨跌幅在 -2%~+2% 之间
  // （实体阴线但相对昨收几乎平盘，这才叫"假阴"）
  if (prevOpen !== null && prevClose !== null && prevOpen > prevClose) {
    // 实体阴线，且涨跌幅在平盘附近
    if (prevChange < -2 || prevChange > 2) return null;
  } else {
    // 没有昨日开收盘数据时，回退到旧规则：prevChange 在 -2%~+4%
    if (prevChange < -2 || prevChange > 4) return null;
  }
  if (openChange > -8) return null;
  return {
    type: BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP,
    confidence: 0.85,
    reason: `昨日假阴（实体阴线但涨 ${prevChange.toFixed(2)}%），今日竞价低开 ${openChange.toFixed(2)}%，恐慌盘集中释放`,
  };
}

function testAuctionDip(row) {
  // 早盘竞价低吸：昨日强势（涨停或大涨 >=5%），今日竞价低开 >=5%，非跌停。
  const prevChange = num(row.prevChange);
  const openChange = num(row.openChange);
  if (prevChange === null || openChange === null) return null;
  if (prevChange < 5) return null;
  if (openChange > -5) return null;
  if (openChange <= -9.5) return null; // 跌停开归入假阴跌停
  return {
    type: BUY_POINT_TYPES.AUCTION_DIP,
    confidence: 0.65,
    reason: `昨日涨幅 ${prevChange.toFixed(2)}%，今日竞价低开 ${openChange.toFixed(2)}%`,
  };
}

function testLateDip(row) {
  // 尾盘跳水低吸：当日最高价到当前回落 >=3%，非跌停，非涨停。
  if (row.isLimitUp) return null;
  const drawdown = num(row.intradayDrawdownFromHigh);
  const change = num(row.change);
  if (drawdown === null || drawdown < 3) return null;
  if (change !== null && change <= -9) return null; // 接近跌停
  // 尾盘跳水需要时间上下文：last 在 14:30 后或当前时间传入为 lateSession。
  if (row.lateSession !== true) return null;
  return {
    type: BUY_POINT_TYPES.LATE_DIP,
    confidence: 0.55,
    reason: `尾盘从高点回落 ${drawdown.toFixed(2)}%，非跌停`,
  };
}

export function classifyBuyPoint(row = {}) {
  const hits = [
    testMomentum(row),
    testBrokenBoard(row),
    testFirstNegative(row),
    testFakeNegativeLimit(row),
    testAuctionDip(row),
    testLateDip(row),
  ].filter(Boolean);

  if (hits.length === 0) {
    return { primary: null, all: [], labels: [] };
  }
  hits.sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type]);
  const primary = hits[0];
  return {
    primary,
    all: hits,
    labels: hits.map((h) => h.type),
    labelNames: hits.map((h) => BUY_POINT_LABELS[h.type]),
  };
}

// 给 analyze 输出追加 buyPointType 字段的便利函数。
// 接收 normalize 后的 row + 可选的昨日快照（prevRow）。
// 合并昨日的 prevChange / prevBreaks / prevHeight / prevOpen / prevClose
// 等字段，供买点分类器做 K 线阴阳校验。
export function annotateBuyPoint(row, prevRow = null) {
  if (!row) return row;
  const merged = { ...row };
  if (prevRow) {
    merged.prevChange = prevRow.change;
    merged.prevBreaks = prevRow.breaks;
    merged.prevHeight = prevRow.height;
    merged.prevOpen = prevRow.open;
    merged.prevClose = prevRow.close;
  }
  const classification = classifyBuyPoint(merged);
  return {
    ...row,
    buyPoint: classification,
  };
}
