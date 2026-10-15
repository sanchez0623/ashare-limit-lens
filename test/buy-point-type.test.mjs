import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBuyPoint,
  annotateBuyPoint,
  BUY_POINT_TYPES,
} from "../shared/buy-point-type.js";

test("打板：早盘封板且有换手", () => {
  const result = classifyBuyPoint({
    isLimitUp: true,
    first: 93500,
    last: 93500,
    turnover: 8,
    height: 2,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.LIMIT_UP_MOMENTUM);
  assert.ok(result.primary.confidence >= 0.8);
});

test("一字板（低换手）不触发打板", () => {
  const result = classifyBuyPoint({
    isLimitUp: true,
    first: 92500,
    last: 92500,
    turnover: 0.5,
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.LIMIT_UP_MOMENTUM);
});

test("炸板低吸：主板涨 4.5%，真实回撤 (10-4.5)/110 = 5%，符合 3%~7%", () => {
  const result = classifyBuyPoint({
    isLimitUp: false,
    breaks: 2,
    change: 4.5,
    boardLimit: 10,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.BROKEN_BOARD_DIP);
});

test("主板涨 9.5%：真实回撤仅 0.5/110 ≈ 0.45%，安全垫不足不触发", () => {
  const result = classifyBuyPoint({
    isLimitUp: false,
    breaks: 2,
    change: 9.5,
    boardLimit: 10,
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.BROKEN_BOARD_DIP);
});

test("炸板低吸：20% 板涨 15%，真实回撤 5/120 ≈ 4.17%，触发", () => {
  const result = classifyBuyPoint({
    isLimitUp: false,
    breaks: 2,
    change: 15,
    boardLimit: 20,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.BROKEN_BOARD_DIP);
});

test("20% 板涨 6%：真实回撤 14/120 ≈ 11.67%，回落过深不触发", () => {
  const result = classifyBuyPoint({
    isLimitUp: false,
    breaks: 2,
    change: 6,
    boardLimit: 20,
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.BROKEN_BOARD_DIP);
});

test("首阴低吸：连板中断（height=0）、昨日 3 连板、开高收低、MA5 未破", () => {
  const result = classifyBuyPoint({
    height: 0,
    prevHeight: 3,
    open: 11,
    close: 10.5,
    change: -3,
    ma5: 10,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.FIRST_NEG_DIP);
});

test("首阴但今日仍在连板（height>0）不触发", () => {
  const result = classifyBuyPoint({
    height: 3,
    prevHeight: 3,
    open: 11,
    close: 10.5,
    change: -3,
    ma5: 10,
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.FIRST_NEG_DIP);
});

test("首阴但破5日线不触发", () => {
  const result = classifyBuyPoint({
    height: 0,
    prevHeight: 3,
    open: 11,
    close: 10.5,
    change: -3,
    ma5: 11, // MA5 高于收盘 → 破 5 日线
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.FIRST_NEG_DIP);
});

test("首阴但 MA5 未知不触发（无法验证未破线，拒绝）", () => {
  const result = classifyBuyPoint({
    height: 0,
    prevHeight: 3,
    open: 11,
    close: 10.5,
    change: -3,
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.FIRST_NEG_DIP);
});

test("首阴但昨日不足 3 连板（prevHeight=2）不触发，与 skill 门槛对齐", () => {
  const result = classifyBuyPoint({
    height: 0,
    prevHeight: 2,
    open: 11,
    close: 10.5,
    change: -3,
    ma5: 10,
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.FIRST_NEG_DIP);
});

test("首阴门槛可配置：firstNegMinPrevHeight=2 时 2 连板首阴触发", () => {
  const result = classifyBuyPoint(
    {
      height: 0,
      prevHeight: 2,
      open: 11,
      close: 10.5,
      change: -3,
      ma5: 10,
    },
    { firstNegMinPrevHeight: 2 },
  );
  assert.equal(result.primary.type, BUY_POINT_TYPES.FIRST_NEG_DIP);
});

test("首阴门槛非法配置（非数值）回退默认 3", () => {
  const result = classifyBuyPoint(
    {
      height: 0,
      prevHeight: 2,
      open: 11,
      close: 10.5,
      change: -3,
      ma5: 10,
    },
    { firstNegMinPrevHeight: "很多" },
  );
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.FIRST_NEG_DIP);
});

test("首阴但收阳线（close > open）不触发", () => {
  const result = classifyBuyPoint({
    height: 0,
    prevHeight: 3,
    open: 10,
    close: 10.5,
    change: -1,
    ma5: 10,
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.FIRST_NEG_DIP);
});

test("假阴跌停低吸：昨日假阴（开高收低微涨）+今日竞价大幅低开", () => {
  const result = classifyBuyPoint({
    prevChange: 1.5,
    prevBreaks: 1,
    prevOpen: 10.5,
    prevClose: 10.2,
    openChange: -9.5,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP);
});

test("假阴：昨日开收盘未知不触发（不猜测阴阳）", () => {
  const result = classifyBuyPoint({
    prevChange: 1.5,
    prevBreaks: 1,
    openChange: -9.5,
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP);
});

test("假阴：昨日明确为实体阴线（开高收低、微涨）时触发", () => {
  const result = classifyBuyPoint({
    prevChange: 0.5,
    prevBreaks: 1,
    prevOpen: 10.5,
    prevClose: 10.2,
    openChange: -9,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP);
});

test("假阴：昨日明确为阳线（开低收高）时不触发", () => {
  const result = classifyBuyPoint({
    prevChange: 1.5,
    prevBreaks: 1,
    prevOpen: 10,
    prevClose: 10.5,
    openChange: -9,
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP);
});

test("早盘竞价低吸：昨日涨停+今日低开5%以上但未跌停", () => {
  const result = classifyBuyPoint({
    prevChange: 10,
    openChange: -6,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.AUCTION_DIP);
});

test("尾盘跳水低吸：lateSession 且从高点回落 4%", () => {
  const result = classifyBuyPoint({
    isLimitUp: false,
    intradayDrawdownFromHigh: 4,
    change: -2,
    lateSession: true,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.LATE_DIP);
});

test("annotateBuyPoint：缺字段时从价量推导 openChange 与回落幅度", () => {
  // 昨收 9.5，今开 9.6（+1.05% 微高开），最高 10.5 收 10（回落 4.76%）。
  const row = annotateBuyPoint(
    {
      code: "600001",
      open: 9.6,
      close: 10,
      high: 10.5,
      change: 1.01,
      isLimitUp: false,
    },
    {
      code: "600001",
      change: 10,
      breaks: 0,
      height: 1,
      open: 9.5,
      close: 9.5,
    },
  );
  // openChange = (9.6 - 9.5) / 9.5 ≈ +1.05%，昨日涨 10% → 竞价低吸条件不满足
  //（低开需 <= -5%），此处只验证推导本身与尾盘回落标签。
  assert.ok(Math.abs(row.openChange - 1.0526) < 1e-3);
  assert.ok(Math.abs(row.intradayDrawdownFromHigh - 4.7619) < 1e-3);
  // 尾盘时点未知（调用方未声明 lateSession）→ 尾盘跳水不触发，
  // 避免盘中报价的全天回撤被误标。
  assert.equal(row.buyPoint.primary, null);
});

test("annotateBuyPoint：调用方声明 lateSession 后尾盘跳水才触发", () => {
  const row = annotateBuyPoint({
    code: "600001",
    open: 9.6,
    close: 10,
    high: 10.5,
    change: 1.01,
    isLimitUp: false,
    lateSession: true, // 观测时刻在尾盘之后（如收盘后复盘）
  });
  assert.equal(row.buyPoint.primary?.type, BUY_POINT_TYPES.LATE_DIP);
});

test("annotateBuyPoint：昨日涨停 + 今日竞价低开 6% 推导出竞价低吸", () => {
  const row = annotateBuyPoint(
    {
      code: "600001",
      open: 8.9,
      close: 9.2,
      high: 9.6,
      change: -3.16,
      isLimitUp: false,
    },
    {
      code: "600001",
      change: 10,
      breaks: 0,
      height: 1,
      open: 9.4,
      close: 9.5,
    },
  );
  // openChange = (8.9 - 9.5) / 9.5 ≈ -6.32%，昨日涨 10% → 竞价低吸命中。
  assert.ok(Math.abs(row.openChange + 6.3158) < 1e-3);
  assert.equal(row.buyPoint.primary?.type, BUY_POINT_TYPES.AUCTION_DIP);
});

test("无任何买点触发时返回 null", () => {
  const result = classifyBuyPoint({
    isLimitUp: false,
    change: 0.5,
  });
  assert.equal(result.primary, null);
  assert.equal(result.all.length, 0);
});

test("多个买点同时命中时按优先级排序（打板 > 假阴 > 炸板 > 首阴 > 竞价 > 尾盘）", () => {
  const result = classifyBuyPoint({
    isLimitUp: true,
    first: 94500,
    turnover: 8,
    breaks: 1,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.LIMIT_UP_MOMENTUM);
});
