import test from "node:test";
import assert from "node:assert/strict";
import {
  classifySentimentCycle,
  CYCLE_PHASES,
  CYCLE_MAX_EXPOSURE,
  applyCycleGate,
} from "../shared/sentiment-cycle.js";

test("情绪上升期：涨停多、封板率高、高度打开", () => {
  const result = classifySentimentCycle({
    limitUp: 90,
    broken: 10,
    height: 6,
    heightAvg5: 4,
    premium: 3,
  });
  assert.equal(result.phase, CYCLE_PHASES.RISING);
  assert.ok(result.score >= 0.7);
  assert.equal(result.maxGrossExposure, CYCLE_MAX_EXPOSURE.rising);
});

test("情绪冰点期：涨停稀少、跌停多", () => {
  const result = classifySentimentCycle({
    limitUp: 5,
    broken: 20,
    limitDown: 30,
    height: 2,
    heightAvg5: 3,
    premium: -4,
  });
  assert.equal(result.phase, CYCLE_PHASES.FREEZING);
  assert.ok(result.score < 0.3);
  assert.equal(result.maxGrossExposure, 0);
});

test("情绪退潮期：封板率下降、高度压缩", () => {
  const result = classifySentimentCycle({
    limitUp: 25,
    broken: 25,
    height: 3,
    heightAvg5: 5,
    premium: -1,
  });
  assert.equal(result.phase, CYCLE_PHASES.EBBING);
  assert.ok(result.score < 0.5 && result.score >= 0.3);
  assert.equal(result.maxGrossExposure, 0.2);
});

test("情绪高潮期：高位但有过热迹象", () => {
  // 涨停数中等、封板率一般、高度偏高、溢价回落 → 0.5~0.7 区间
  const result = classifySentimentCycle({
    limitUp: 40,
    broken: 20,
    height: 7,
    heightAvg5: 6,
    premium: 0,
  });
  assert.equal(result.phase, CYCLE_PHASES.CLIMAX);
  assert.equal(result.maxGrossExposure, 0.5);
});

test("缺数据时降级中性，不抛错", () => {
  const result = classifySentimentCycle({});
  assert.ok(result.score >= 0 && result.score <= 1);
  assert.ok(result.phase);
});

test("applyCycleGate 在账户风险限制上叠加 effectiveExposureCap（不改写 maxGrossExposure）", () => {
  const limits = { maxGrossExposure: 0.6, maxPositionWeight: 0.2 };
  const frozenCycle = { maxGrossExposure: 0.2 };
  const gated = applyCycleGate(limits, frozenCycle);
  assert.equal(gated.maxGrossExposure, 0.6); // 账户硬限制保持不变
  assert.equal(gated.effectiveExposureCap, 0.2); // 周期闸门通过新字段叠加
  assert.equal(gated.maxPositionWeight, 0.2);
});

test("applyCycleGate 闸门更宽松时 effectiveExposureCap 仍记录周期上限", () => {
  const limits = { maxGrossExposure: 0.3, maxPositionWeight: 0.1 };
  const rising = { maxGrossExposure: 0.8 };
  const gated = applyCycleGate(limits, rising);
  assert.equal(gated.maxGrossExposure, 0.3); // 不放大账户硬限制
  assert.equal(gated.effectiveExposureCap, 0.8); // 但记录周期上限
});
