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
//  - lateSession: 尾盘时点标记，由调用方依据观测时刻声明（北京时间
//    14:30 后或收盘后为 true）；未知时不设置，尾盘跳水买点不触发
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
  // 回撤必须以真实涨停价为基准：涨停价 = 昨收 × (1 + boardLimit/100)，
  // 当前价 = 昨收 × (1 + change/100)，故
  //   pullback = (boardLimit - change) / (100 + boardLimit) × 100
  // 例：主板涨 9.5% → 回撤 0.5/110 ≈ 0.45%（刚开板，安全垫不足）
  // 例：主板涨 4.5% → 回撤 5.5/110 = 5%（符合 3%~7%）
  // 例：20% 板涨 15% → 回撤 5/120 ≈ 4.17%（符合）
  // 例：20% 板涨 6%  → 回撤 14/120 ≈ 11.67%（回落过深）
  // 分母用 (100 + boardLimit) 而非 boardLimit：回撤百分比相对的是涨停价
  // 本身（含昨日收盘基数），不是涨停幅度。
  if (row.isLimitUp) return null;
  const breaks = num(row.breaks);
  const change = num(row.change);
  if (breaks === null || breaks <= 0) return null;
  if (change === null) return null;
  const boardLimit = num(row.boardLimit) ?? 10;
  const pullback = ((boardLimit - change) / (100 + boardLimit)) * 100;
  if (pullback < 3 || pullback > 7) return null;
  return {
    type: BUY_POINT_TYPES.BROKEN_BOARD_DIP,
    confidence: 0.75,
    reason: `盘中炸板 ${breaks} 次，相对涨停价回撤 ${pullback.toFixed(2)}%（当前涨 ${change.toFixed(2)}%），符合 3%~7% 安全垫`,
  };
}

// 首阴低吸的连板门槛（昨日连板数下限），默认与 skill 文档对齐为 3。
// 可通过 analyze options.firstNegMinPrevHeight 配置（settings 表
// buyPointParams.firstNegMinPrevHeight），当前 2/3 的优劣尚未定论，
// 留作可调研究参数。
export const FIRST_NEG_MIN_PREV_HEIGHT_DEFAULT = 3;

function testFirstNegative(row, options = {}) {
  // 首阴低吸：连板股（昨日 >= minPrevHeight 连板）中断后的首根实体阴线，
  // 5 日均线未破。门槛可配置（默认 3，对齐 skill 文档）。
  // 严格校验 K 线与序列条件：
  //   1. 今日连板中断：当前 height 必须为 0（阴线日本身不可能涨停；
  //      height 未知时由 change<0 间接保证，显式 height>0 视为数据矛盾拒绝）
  //   2. 昨日连板数 >= firstNegMinPrevHeight（默认 3）
  //   3. 今日开 > 收（实体阴线，而非"跌但收阳线"）
  //   4. 今日 change 在 -5% ~ 0 之间（阴线实体不大）
  //   5. MA5 必须已知且未破（收盘 > MA5）；未知时无法验证，拒绝
  const height = num(row.height);
  if (height !== null && height !== 0) return null; // 今日仍在连板，不是首阴
  const minPrevHeight = Math.max(
    1,
    num(options.firstNegMinPrevHeight) ?? FIRST_NEG_MIN_PREV_HEIGHT_DEFAULT,
  );
  const prevHeight = num(row.prevHeight);
  if (prevHeight === null || prevHeight < minPrevHeight) return null; // 昨日连板数不足门槛
  const open = num(row.open);
  const close = num(row.close) ?? num(row.price);
  if (open === null || close === null) return null;
  if (open <= close) return null; // 必须是实体阴线（开高收低）
  const change = num(row.change);
  if (change === null || change >= 0) return null;
  if (change < -5) return null; // 阴线实体过大
  const ma5 = num(row.ma5);
  if (ma5 === null || close < ma5) return null; // MA5 未知无法验证未破线，拒绝
  return {
    type: BUY_POINT_TYPES.FIRST_NEG_DIP,
    confidence: 0.7,
    reason: `昨日 ${prevHeight} 连板后首根实体阴线（开 ${open} 收 ${close}），跌幅 ${change.toFixed(2)}%，未破 5 日线`,
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
  // 假阴校验：昨日必须是实体阴线（prevOpen > prevClose）且涨跌幅在
  // 平盘附近（-2%~+2%）。昨日开收盘未知时保持未知——不猜测阴阳，
  // 宁可漏标也不把阴阳不明的 K 线当成假阴。
  if (prevOpen === null || prevClose === null) return null;
  if (prevOpen <= prevClose) return null; // 昨日阳线/平盘，不是假阴
  if (prevChange < -2 || prevChange > 2) return null;
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

export function classifyBuyPoint(row = {}, options = {}) {
  const hits = [
    testMomentum(row),
    testBrokenBoard(row),
    testFirstNegative(row, options),
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
// 接收 normalize 后的 row + 可选的昨日快照（prevRow）+ 可选配置（options，
// 如 firstNegMinPrevHeight），透传给分类器。
export function annotateBuyPoint(row, prevRow = null, options = {}) {
  if (!row) return row;
  const merged = { ...row };
  if (prevRow) {
    merged.prevChange = prevRow.change;
    merged.prevBreaks = prevRow.breaks;
    merged.prevHeight = prevRow.height;
    merged.prevOpen = prevRow.open;
    // 历史重构行只保存 price（无 close 字段），回退取 price 作为昨收，
    // 否则历史链路无法推导竞价涨跌幅（openChange）。
    merged.prevClose = prevRow.close ?? prevRow.price ?? null;
  }
  // 数据链路缺字段时从价量数据推导，保证竞价买点在真实链路可用：
  //  - openChange：今日开盘相对昨收的涨跌幅（竞价低开幅度）
  //  - intradayDrawdownFromHigh：最高价到当前/收盘的回落幅度
  // 注意：lateSession（尾盘时点）不在此推导——盘中 10 点的报价同样有
  // "最高到现价回落"，无脑置 true 会把全天回撤误标为尾盘跳水。
  // 尾盘时点必须由调用方依据观测时刻声明（analyze options.lateSession，
  // 北京时间 14:30 后或收盘后），未知时保持未设置，尾盘跳水不触发。
  const derived = {};
  const open = num(merged.open);
  const prevClose = num(merged.prevClose);
  if (
    num(merged.openChange) === null &&
    open !== null &&
    prevClose !== null &&
    prevClose > 0
  ) {
    derived.openChange = ((open - prevClose) / prevClose) * 100;
    merged.openChange = derived.openChange;
  }
  const high = num(merged.high);
  const close = num(merged.close) ?? num(merged.price);
  if (
    num(merged.intradayDrawdownFromHigh) === null &&
    high !== null &&
    close !== null &&
    high > 0
  ) {
    derived.intradayDrawdownFromHigh = ((high - close) / high) * 100;
    merged.intradayDrawdownFromHigh = derived.intradayDrawdownFromHigh;
  }
  const classification = classifyBuyPoint(merged, options);
  return {
    ...row,
    ...derived,
    buyPoint: classification,
  };
}
