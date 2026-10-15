import test from "node:test";
import assert from "node:assert/strict";
import { classifyStock, STOCK_CLASSES } from "../shared/stock-class.js";

const base = { height: 1, amount: 5e8, sector: "软件服务", isLimitUp: true };

test("连板龙头：≥3 连板 + 板块最高板 + 成交额≥3亿（无需历史特征）", () => {
  const r = classifyStock({
    row: { ...base, height: 4 },
    sectorMaxHeight: 4,
    history: null,
  });
  assert.equal(r.stockClass, STOCK_CLASSES.RELAY_LEADER);
  assert.match(r.reason, /4 连板/);
});

test("连板数≥3 但非板块最高板 → 不判龙头（无历史时未分类）", () => {
  const r = classifyStock({
    row: { ...base, height: 3 },
    sectorMaxHeight: 5,
    history: null,
  });
  assert.equal(r, null);
});

test("连板数≥3 但成交额不足 3 亿 → 不判龙头", () => {
  const r = classifyStock({
    row: { ...base, height: 3, amount: 2e8 },
    sectorMaxHeight: 3,
    history: null,
  });
  assert.equal(r, null);
});

test("强势反包：近10日有涨停基因且收盘站上20日线", () => {
  const r = classifyStock({
    row: { ...base, height: 0, close: 11 },
    sectorMaxHeight: 4,
    history: { limitUp10d: true, ma20: 10, amplitude20: 40 },
  });
  assert.equal(r.stockClass, STOCK_CLASSES.STRONG_REVERSAL);
});

test("有涨停基因但收盘跌破20日线、振幅超波段区间 → 平庸", () => {
  const r = classifyStock({
    row: { ...base, height: 0, close: 9.5 },
    sectorMaxHeight: 4,
    history: { limitUp10d: true, ma20: 10, amplitude20: 40 },
  });
  assert.equal(r.stockClass, STOCK_CLASSES.MEDIOCRE);
});

test("波段震荡：有题材标签 + 20日振幅 10%~25% + 非涨停股", () => {
  const r = classifyStock({
    row: { ...base, height: 0, isLimitUp: false, close: 10 },
    sectorMaxHeight: 4,
    history: { limitUp10d: false, ma20: 9, amplitude20: 18 },
  });
  assert.equal(r.stockClass, STOCK_CLASSES.SWING_RANGE);
});

test("波段震荡：涨停但非首板（2 连板）→ 平庸", () => {
  const r = classifyStock({
    row: { ...base, height: 2, isLimitUp: true, close: 10 },
    sectorMaxHeight: 4,
    history: { limitUp10d: false, ma20: 9, amplitude20: 18 },
  });
  assert.equal(r.stockClass, STOCK_CLASSES.MEDIOCRE);
});

test("无题材标签（未分类板块）→ 不判波段", () => {
  const r = classifyStock({
    row: {
      ...base,
      height: 0,
      isLimitUp: false,
      sector: "未分类",
      close: 10,
    },
    sectorMaxHeight: 4,
    history: { limitUp10d: false, ma20: 9, amplitude20: 18 },
  });
  assert.equal(r.stockClass, STOCK_CLASSES.MEDIOCRE);
});

test("20日振幅越界（<10% 或 >25%）→ 不判波段", () => {
  for (const amplitude20 of [8, 30]) {
    const r = classifyStock({
      row: { ...base, height: 0, isLimitUp: false, close: 10 },
      sectorMaxHeight: 4,
      history: { limitUp10d: false, ma20: 9, amplitude20 },
    });
    assert.equal(r.stockClass, STOCK_CLASSES.MEDIOCRE, `amplitude=${amplitude20}`);
  }
});

test("历史特征缺失且非龙头 → 返回 null（数据缺失不能断言平庸）", () => {
  assert.equal(
    classifyStock({
      row: { ...base, height: 0 },
      sectorMaxHeight: 2,
      history: null,
    }),
    null,
  );
  assert.equal(
    classifyStock({
      row: { ...base, height: 0 },
      sectorMaxHeight: 2,
      history: undefined,
    }),
    null,
  );
});

test("历史特征不齐全（仅 15 根日线 → MA20/振幅为 null）→ 保持未分类", () => {
  // 复现：15 根日线时 MA20/振幅均为 null，此前被误判平庸并剔除
  const r = classifyStock({
    row: { ...base, height: 0, isLimitUp: false, close: 10 },
    sectorMaxHeight: 2,
    history: { limitUp10d: false, ma20: null, amplitude20: null },
  });
  assert.equal(r, null);
});
