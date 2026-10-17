import test from "node:test";
import assert from "node:assert/strict";
import {
  observationGrade,
  annotateObservationGrades,
  OBSERVATION_GRADE_RULES_VERSION,
} from "../backend/domain/signal-selection.js";
import {
  BASE_STRATEGY,
  newBook,
  scoreSignals,
  createPlan,
} from "../backend/domain/trading.js";
import { STOCK_CLASSES } from "../shared/stock-class.js";
import { BUY_POINT_TYPES } from "../shared/buy-point-type.js";
import { snapshot, dateAt } from "./fixtures/trading.mjs";

const gradeOf = (score, stockClass, labels) =>
  observationGrade({
    score,
    stockClass,
    ...(labels ? { buyPoint: { labels } } : {}),
  });

test("A 级：连板龙头 + 评分≥80 + 打板/炸板低吸", () => {
  assert.deepEqual(
    gradeOf(80, STOCK_CLASSES.RELAY_LEADER, [
      BUY_POINT_TYPES.LIMIT_UP_MOMENTUM,
    ]),
    { grade: "A", gradeReason: "评分 80 · 连板龙头型" },
  );
  const multiple = gradeOf(95, STOCK_CLASSES.RELAY_LEADER, [
    BUY_POINT_TYPES.BROKEN_BOARD_DIP,
    BUY_POINT_TYPES.FIRST_NEG_DIP,
  ]);
  assert.equal(multiple.grade, "A");
});

test("A 级：labels 缺失时回退 primary.type", () => {
  const result = observationGrade({
    score: 82,
    stockClass: STOCK_CLASSES.RELAY_LEADER,
    buyPoint: { primary: { type: BUY_POINT_TYPES.BROKEN_BOARD_DIP } },
  });
  assert.equal(result.grade, "A");
});

test("A 降 B：买点未命中或买点缺失", () => {
  const firstNeg = gradeOf(90, STOCK_CLASSES.RELAY_LEADER, [
    BUY_POINT_TYPES.FIRST_NEG_DIP,
  ]);
  assert.equal(firstNeg.grade, "B");
  assert.match(firstNeg.gradeReason, /买点未命中打板\/炸板低吸，降为 B/);

  assert.equal(gradeOf(90, STOCK_CLASSES.RELAY_LEADER).grade, "B");
  assert.equal(gradeOf(90, STOCK_CLASSES.RELAY_LEADER, []).grade, "B");
});

test("类别封顶：强势反包最高 B、波段震荡最高 C、未分类最高 B", () => {
  assert.equal(
    gradeOf(90, STOCK_CLASSES.STRONG_REVERSAL, [
      BUY_POINT_TYPES.LIMIT_UP_MOMENTUM,
    ]).grade,
    "B",
  );
  const swing = gradeOf(90, STOCK_CLASSES.SWING_RANGE, [
    BUY_POINT_TYPES.LIMIT_UP_MOMENTUM,
  ]);
  assert.equal(swing.grade, "C");
  assert.match(swing.gradeReason, /按类别封顶为 C/);

  assert.equal(
    gradeOf(90, null, [BUY_POINT_TYPES.LIMIT_UP_MOMENTUM]).grade,
    "B",
  );
  assert.equal(
    gradeOf(90, "unknown-class", [BUY_POINT_TYPES.LIMIT_UP_MOMENTUM]).grade,
    "B",
  );
});

test("类别已封顶时，缺少 A 级买点不能把原因误写为降至 B", () => {
  for (const [stockClass, expectedGrade] of [
    [STOCK_CLASSES.SWING_RANGE, "C"],
    [STOCK_CLASSES.STRONG_REVERSAL, "B"],
    [null, "B"],
  ]) {
    for (const labels of [undefined, [], [BUY_POINT_TYPES.FIRST_NEG_DIP]]) {
      const result = gradeOf(90, stockClass, labels);
      assert.equal(result.grade, expectedGrade);
      assert.match(
        result.gradeReason,
        new RegExp(`按类别封顶为 ${expectedGrade}`),
      );
      assert.doesNotMatch(result.gradeReason, /买点未命中|降为 B/);
    }
  }
});

test("评分边界：80/79、60/59、40/39", () => {
  assert.equal(
    gradeOf(79, STOCK_CLASSES.RELAY_LEADER, ["limit-up-momentum"]).grade,
    "B",
  );
  assert.equal(
    gradeOf(60, STOCK_CLASSES.RELAY_LEADER, ["limit-up-momentum"]).grade,
    "B",
  );
  assert.equal(
    gradeOf(59, STOCK_CLASSES.RELAY_LEADER, ["limit-up-momentum"]).grade,
    "C",
  );
  assert.equal(
    gradeOf(40, STOCK_CLASSES.RELAY_LEADER, ["limit-up-momentum"]).grade,
    "C",
  );

  assert.deepEqual(gradeOf(39, STOCK_CLASSES.RELAY_LEADER), {
    grade: null,
    gradeReason: "评分低于 40",
  });
  assert.deepEqual(gradeOf(null, STOCK_CLASSES.RELAY_LEADER), {
    grade: null,
    gradeReason: "缺少有效评分",
  });
});

test("排除：平庸型优先于评分下限之外的其他规则", () => {
  assert.deepEqual(gradeOf(90, STOCK_CLASSES.MEDIOCRE), {
    grade: null,
    gradeReason: "平庸型",
  });
  // 低于 40 先于平庸型判定，口径固定。
  assert.deepEqual(gradeOf(39, STOCK_CLASSES.MEDIOCRE), {
    grade: null,
    gradeReason: "评分低于 40",
  });
});

test("annotateObservationGrades 保序、返回新对象且不修改入参", () => {
  const input = [
    {
      code: "600001",
      score: 90,
      stockClass: STOCK_CLASSES.SWING_RANGE,
      buyPoint: { labels: [BUY_POINT_TYPES.LIMIT_UP_MOMENTUM] },
    },
    { code: "600002", score: 30 },
  ];
  const output = annotateObservationGrades(input);
  assert.notEqual(output, input);
  assert.deepEqual(
    output.map((signal) => signal.code),
    ["600001", "600002"],
  );
  assert.equal(output[0].grade, "C");
  assert.equal(output[1].grade, null);
  assert.equal(Object.hasOwn(input[0], "grade"), false);
  assert.ok(output.every((signal) => typeof signal.gradeReason === "string"));
});

test("scoreSignals 为每只信号附带 grade", () => {
  const signals = scoreSignals(snapshot(dateAt(0)), BASE_STRATEGY);
  assert.equal(signals.length, 2);
  for (const signal of signals) {
    assert.ok(Object.hasOwn(signal, "grade"));
    assert.equal(typeof signal.gradeReason, "string");
  }
  // 未分类：评分再高也按 B 封顶。
  assert.deepEqual(
    signals.map((signal) => signal.grade),
    ["B", "B"],
  );
});

test("createPlan 审计透出 gradeRulesVersion 与分级字段", () => {
  const snap = snapshot(dateAt(0));
  snap.stocks[0].stockClass = STOCK_CLASSES.RELAY_LEADER;
  snap.stocks[0].buyPoint = {
    labels: [BUY_POINT_TYPES.LIMIT_UP_MOMENTUM],
  };
  const plan = createPlan(
    snap,
    newBook(),
    BASE_STRATEGY,
    "fixture-v",
    snap.createdAt,
  );
  assert.equal(
    plan.selectionAudit.gradeRulesVersion,
    OBSERVATION_GRADE_RULES_VERSION,
  );
  assert.equal(plan.selectionAudit.candidates.length, 2);
  for (const candidate of plan.selectionAudit.candidates) {
    assert.ok(Object.hasOwn(candidate, "grade"));
    assert.ok(Object.hasOwn(candidate, "gradeReason"));
  }

  const signal = scoreSignals(snap, BASE_STRATEGY).find(
    (item) => item.code === "600001",
  );
  const candidate = plan.selectionAudit.candidates.find(
    (item) => item.code === "600001",
  );
  assert.equal(candidate.grade, "A");
  assert.equal(candidate.grade, observationGrade(signal).grade);
});
