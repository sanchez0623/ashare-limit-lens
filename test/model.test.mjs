import test from "node:test";
import assert from "node:assert/strict";
import {
  normalize,
  analyze,
  analyzeStock,
  PRESETS,
} from "../shared/scoring.js";
import { BUY_POINT_TYPES } from "../shared/buy-point-type.js";
import { parseModelJson } from "../backend/services/review.js";
const base = {
  c: "002001",
  n: "测试股份",
  p: 10000,
  hybk: "测试行业",
  amount: 1e8,
  fund: 1e7,
  hs: 8,
  fbt: 93500,
  lbt: 93500,
  zbc: 0,
  lbc: 2,
};
test("单位转换正确，缺失指标重新归一化而非当零分", () => {
  const row = normalize(base);
  assert.equal(row.price, 10);
  assert.equal(analyzeStock(row, 100).score, 99);
  const missing = analyzeStock(normalize({ ...base, fund: null }), 100);
  assert.equal(missing.coverage, 80);
  assert.equal(missing.factors.find((f) => f.key === "capital").value, null);
  assert.ok(missing.score >= 98);
});
test("涨停与炸板分母一致，ST个股剔除并保留说明", () => {
  const result = analyze(
    [normalize(base), normalize({ ...base, c: "002002", n: "ST测试" })],
    1,
  );
  assert.equal(result.count, 1);
  assert.equal(result.excluded, 1);
  assert.ok(Math.abs(result.sealRate - 200 / 3) < 0.01);
  assert.equal(analyze([normalize(base)], null).sealRate, null);
});
test("炸板池候选独立产出，涨停池口径与板块/情绪统计完全不变", () => {
  const limitUp = normalize(base);
  const broken = normalize({
    ...base,
    c: "002003",
    n: "炸板样本",
    zdp: 4.5,
    zbc: 2,
    fund: null,
    lbc: 0,
  });
  const baseline = analyze([limitUp], 1, null, PRESETS.balanced, {
    lateSession: true,
  });
  const withBroken = analyze([limitUp], 1, null, PRESETS.balanced, {
    lateSession: true,
    brokenRows: [broken],
  });
  // 口径隔离：炸板候选只补充候选，不进入涨停池派生的任何统计
  assert.deepEqual(withBroken.stocks, baseline.stocks);
  assert.deepEqual(withBroken.sectors, baseline.sectors);
  for (const key of [
    "count",
    "excluded",
    "first",
    "relay",
    "height",
    "sealRate",
    "emotion",
    "emotionCoverage",
    "promotion",
    "previousCount",
    "cycle",
  ])
    assert.deepEqual(withBroken[key], baseline[key]);
  // 炸板候选单独成组，携带来源标记，涨停池行不带
  assert.equal(withBroken.brokenStocks.length, 1);
  assert.equal(withBroken.brokenStocks[0].code, "002003");
  assert.equal(withBroken.brokenStocks[0].candidateSource, "broken");
  assert.equal(baseline.stocks[0].candidateSource, undefined);
  // 未传炸板行时形状稳定为空候选，不影响既有调用方
  assert.deepEqual(baseline.brokenStocks, []);
  assert.deepEqual(
    analyze([limitUp], 1, null, PRESETS.balanced).brokenStocks,
    [],
  );
});
test("覆盖率分母排除未封板股票的封单强度：炸板候选不因结构性缺字段被门槛挡住", () => {
  const missingSeal = normalize({ ...base, fund: null });
  // 封单缺失的涨停池行：按数据缺口计入分母，覆盖率 80%（既有口径不变）
  assert.equal(analyzeStock(missingSeal, 70).coverage, 80);
  // 同一行标上炸板来源后，封单强度属模型不适用，从分母排除
  const broken = analyzeStock(
    { ...missingSeal, candidateSource: "broken" },
    70,
  );
  assert.equal(broken.coverage, 100);
  assert.equal(broken.factors.find((f) => f.key === "capital").value, null);
  // 评分本体不受影响：仍只按已覆盖因子加权
  assert.equal(analyzeStock(missingSeal, 70).score, broken.score);
  // 真实炸板池形态（连板数缺失）：涨停池口径下覆盖率 75%，卡在建仓门槛
  // 80% 之下、炸板低吸永远无法建仓；排除封单强度后 94%，过线
  const realBroken = analyzeStock(
    { ...missingSeal, candidateSource: "broken", height: null },
    70,
  );
  assert.equal(realBroken.coverage, 94);
  assert.equal(analyzeStock({ ...missingSeal, height: null }, 70).coverage, 75);
  // 连板数作为真实数据缺口保留在分母里反映信息不足
  assert.equal(realBroken.factors.find((f) => f.key === "ladder").value, null);
  // 显式携带 candidateSource 但封单实际存在时，不触发排除
  assert.equal(
    analyzeStock({ ...normalize(base), candidateSource: "broken" }, 70)
      .coverage,
    100,
  );
});
test("炸板池行触发炸板低吸：回落安全垫落在 3%~7% 区间", () => {
  const row = normalize({
    ...base,
    c: "002005",
    n: "炸板低吸样本",
    zdp: 4.5,
    zbc: 2,
    fund: null,
    lbc: 0,
  });
  const a = analyze([], 0, null, PRESETS.balanced, { brokenRows: [row] });
  assert.equal(
    a.brokenStocks[0].buyPoint.primary.type,
    BUY_POINT_TYPES.BROKEN_BOARD_DIP,
  );
  assert.equal(a.brokenStocks[0].buyPoint.primary.confidence, 0.75);
});
test("尾盘炸板收在涨停价附近时按池成员资格判 isLimitUp，不误标打板", () => {
  // 收盘 +9.8%（主板 boardLimit 10）：涨幅判定会算出 isLimitUp=true，
  // 但池成员资格是"盘中触板、收盘未封"的权威来源——不能靠涨幅反推。
  const row = normalize({
    ...base,
    c: "002006",
    n: "尾盘炸板",
    zdp: 9.8,
    zbc: 2,
    fund: null,
    lbc: 0,
    lbt: 145500,
  });
  const asLimitUp = analyze([row], 0, null, PRESETS.balanced);
  assert.equal(asLimitUp.stocks[0].isLimitUp, true);
  assert.equal(
    asLimitUp.stocks[0].buyPoint.primary?.type,
    BUY_POINT_TYPES.LIMIT_UP_MOMENTUM,
  );
  const asBroken = analyze([], 0, null, PRESETS.balanced, {
    brokenRows: [row],
  });
  assert.equal(asBroken.brokenStocks[0].isLimitUp, false);
  // 收盘未封就不是涨停，打板标签必须撤销
  assert.equal(asBroken.brokenStocks[0].buyPoint.primary, null);
});
test("连板数兼容昨日池 ylbc，保持当日 lbc 优先级", () => {
  assert.equal(normalize({ ...base, lbc: undefined, ylbc: "1" }).height, 1);
  assert.equal(normalize({ ...base, lbc: null, ylbc: 3 }).height, 3);
  assert.equal(normalize({ ...base, ylbc: 1 }).height, 2);
  assert.equal(normalize({ ...base, lbc: "invalid", ylbc: 1 }).height, 1);
  assert.equal(normalize({ ...base, lbc: undefined }).height, null);
});
test("昨日池只含 ylbc 时，两样本一晋级为 50%，无人晋级为 0%", () => {
  const previous = [
    { ...base, lbc: undefined, ylbc: 1 },
    { ...base, c: "002002", lbc: undefined, ylbc: 2 },
  ].map(normalize);
  const promoted = analyze([normalize(base)], 0, previous);
  assert.equal(promoted.previousCount, 2);
  assert.equal(promoted.promotion, 50);
  assert.equal(
    analyze([normalize({ ...base, lbc: 1 })], 0, previous).promotion,
    0,
  );
  assert.equal(analyze([], 0, previous).promotion, 0);
  assert.equal(
    analyze([normalize({ ...base, n: "ST测试" })], 0, previous).promotion,
    0,
  );
});
test("缺昨日样本或有效连板数时晋级率暂缺，不误报零晋级", () => {
  const rows = [normalize(base)];
  assert.equal(analyze(rows, 0, null).promotion, null);
  assert.equal(analyze(rows, 0, []).promotion, null);
  for (const height of [undefined, null, "invalid", 0, -1, 1.5]) {
    const previous = [normalize({ ...base, lbc: undefined, ylbc: height })];
    assert.equal(analyze(rows, 0, previous).promotion, null);
  }
});
test("多项风险扣分最多20分，不能将一字封板当成易成交", () => {
  const row = normalize({ ...base, lbc: 6, hs: 45, zbc: 4, lbt: 145500 });
  const r = analyzeStock(row, 90);
  assert.equal(r.deduction, 20);
  assert.ok(r.risks.some((x) => x.text === "高位连板"));
  assert.ok(r.score >= 0 && r.score <= 100);
});

test("AI评价解析兼容代码围栏、前后空白与多余说明文字", () => {
  const grade = {
    score: 60,
    confidence: "medium",
    summary: "x",
    evidence: ["a"],
    failures: [],
    suggestions: [],
  };
  const json = JSON.stringify(grade);
  assert.deepEqual(parseModelJson(json), grade);
  assert.deepEqual(parseModelJson(`\n\`\`\`json\n${json}\n\`\`\`\n`), grade);
  assert.deepEqual(parseModelJson(`\`\`\`\n${json}\n\`\`\``), grade);
  assert.deepEqual(parseModelJson(`评价结果：${json}，请参考。`), grade);
  assert.equal(parseModelJson("不是JSON输出"), null);
  assert.equal(parseModelJson(""), null);
});
