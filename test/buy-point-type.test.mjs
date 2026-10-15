import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBuyPoint,
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

test("炸板低吸：涨停后从涨停价回落 3%~7%（change=9.5%, boardLimit=10%）", () => {
  const result = classifyBuyPoint({
    isLimitUp: false,
    breaks: 2,
    change: 9.5,
    boardLimit: 10,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.BROKEN_BOARD_DIP);
});

test("炸板但回落到 1%（change=9.9%，不够安全垫）不触发", () => {
  const result = classifyBuyPoint({
    isLimitUp: false,
    breaks: 2,
    change: 9.9,
    boardLimit: 10,
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.BROKEN_BOARD_DIP);
});

test("首阴低吸：3连板后首根实体阴线（开高收低，未破5日线）", () => {
  const result = classifyBuyPoint({
    height: 3,
    prevHeight: 2,
    open: 11,
    close: 10.5,
    change: -3,
    ma5Broken: false,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.FIRST_NEG_DIP);
});

test("首阴但破5日线不触发", () => {
  const result = classifyBuyPoint({
    height: 3,
    prevHeight: 2,
    open: 11,
    close: 10.5,
    change: -3,
    ma5: 11, // MA5 高于收盘 → 破 5 日线
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.FIRST_NEG_DIP);
});

test("首阴但没有昨日连板（prevHeight 不足）不触发", () => {
  const result = classifyBuyPoint({
    height: 3,
    prevHeight: 0,
    open: 11,
    close: 10.5,
    change: -3,
  });
  assert.notEqual(result.primary?.type, BUY_POINT_TYPES.FIRST_NEG_DIP);
});

test("假阴跌停低吸：昨日假阴+今日竞价大幅低开", () => {
  const result = classifyBuyPoint({
    prevChange: 1.5,
    prevBreaks: 1,
    openChange: -9.5,
  });
  assert.equal(result.primary.type, BUY_POINT_TYPES.FAKE_NEG_LIMIT_DIP);
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
