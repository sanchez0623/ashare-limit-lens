# 方案 8：观察池 A/B/C 分级

## Summary

把 skill 中的“重点关注 / 一般关注 / 备选观察”量化为 A/B/C 三级，在新分支 `feat/observation-grade` 实现。分级在纯排序内核 `backend/domain/signal-selection.js` 中计算，由 `scoreSignals` 排序后统一注解到每个信号上；`createPlan` 把 `grade` / `gradeReason` 写入 `selectionAudit.candidates`，并在审计根记录独立的 `gradeRulesVersion`。前端“选股依据”表新增“分级”列并显示 A/B/C 数量。

分级只用于展示与观察池排序，不参与 `rankSignals` 排序、不改变建仓资格判断、不进入订单或执行语义。

## Current State Analysis

- `backend/domain/signal-selection.js`（118 行）是选股政策与纯排序内核：
  - `LEGACY_SELECTION_VERSION` / `SELECTION_VERSION_V2` / `DEFAULT_SELECTION_VERSION` 三套固定政策与 SHA-256 摘要；
  - `rankSignals(signals, policy)` 只做排序（整数 score → code；或 `scoreRankKey` → `liquidityAmountCents` → code）。
- `backend/domain/trading.js`：
  - `scoreSignals` 产出 `score`（整数）、`scoreValue`、`scoreRankKey`、`liquidityAmountCents`、`sectorScore`，最后 `return rankSignals(signals, policy)`；
  - `createPlan` 构造 `selectionAudit`，candidates 已含 `score`、`stockClass`、`buyPoint` 等字段；
  - v3 平庸型只在“新增买入”阶段跳过（`stockClassRouting && signal.stockClass === STOCK_CLASSES.MEDIOCRE`），信号本身保留，供持仓风控使用；
  - 建仓订单在 `addOrder({...})` 中显式挑选字段，新增 `grade` 不会泄漏到 orders；
  - `assertProgramSnapshot` 只比对 `strategyProgram/orders/targetExposure/emotion/downgradeRulesVersion/downgrades`，不比对 `selectionAudit`，新增字段不会破坏旧计划重算。
- `shared/buy-point-type.js`：
  - `BUY_POINT_TYPES.LIMIT_UP_MOMENTUM = "limit-up-momentum"`（打板）、`BROKEN_BOARD_DIP = "broken-board-dip"`（炸板低吸）；
  - `classifyBuyPoint` 返回 `{ primary: {type, confidence, reason} | null, all, labels, labelNames }`，`labels` 为全部命中类型。
- `shared/stock-class.js`：
  - `STOCK_CLASSES`：`relay-leader` / `strong-reversal` / `swing-range` / `mediocre`；
  - 特征不足返回 `null`（未分类），未分类不等同平庸。
- `frontend/paper.js` 的 `paper-selection-audit` 用原生 JS 渲染 `plan.selectionAudit.candidates` 表格，列为“顺序 / 个股 / 精确评分 / 信号日成交额 / 选择结果”。
- `docs/design/signal-selection.md` 明确 `score` 为整数，80/88/82 等阈值使用整数口径。
- 现有测试：`test/signal-selection.test.mjs` 使用 `snapshot()` fixture + `createPlan`；`package.json` 的 `test` 为 `node --test test/*.test.mjs`，新增测试文件会被自动纳入。

## Proposed Changes

### 1. `backend/domain/signal-selection.js`：新增分级规则与注解函数

**What**：新增独立规则常量、分级纯函数和批量注解函数；不改动任何 `policies`、`digests`、`rankSignals`。

**Why**：分级是展示维度，不能改选股政策内容/摘要，否则历史 v1–v3 计划核验会失效；分级必须在排序之后执行，不能影响排名。

**How**：

1. 顶部新增导入：

```js
import { BUY_POINT_TYPES } from "../../shared/buy-point-type.js";
import { STOCK_CLASSES } from "../../shared/stock-class.js";
```

2. 在 `rankSignals` 之前新增：

```js
// 观察池分级（方案 8）：独立规则版本，不进入选股政策与摘要。
// 评分决定下限、股票分类决定上限；grade 仅展示，不参与排序与交易决策。
export const OBSERVATION_GRADE_RULES_VERSION = 1;
export const OBSERVATION_GRADES = Object.freeze({ A: "A", B: "B", C: "C" });

const GRADE_ORDER = Object.freeze({ A: 0, B: 1, C: 2 });
const CLASS_LABELS = Object.freeze({
  [STOCK_CLASSES.RELAY_LEADER]: "连板龙头型",
  [STOCK_CLASSES.STRONG_REVERSAL]: "强势反包型",
  [STOCK_CLASSES.SWING_RANGE]: "波段震荡型",
});
// 类别封顶：连板龙头最高 A、强势反包最高 B、波段震荡最高 C、
// 未分类（null/未知）最高 B。
const CLASS_CEILING = Object.freeze({
  [STOCK_CLASSES.RELAY_LEADER]: "A",
  [STOCK_CLASSES.STRONG_REVERSAL]: "B",
  [STOCK_CLASSES.SWING_RANGE]: "C",
});
const A_GRADE_BUY_POINTS = new Set([
  BUY_POINT_TYPES.LIMIT_UP_MOMENTUM,
  BUY_POINT_TYPES.BROKEN_BOARD_DIP,
]);
const buyPointTypes = (buyPoint) =>
  buyPoint?.labels ??
  (buyPoint?.primary?.type ? [buyPoint.primary.type] : []);
```

3. 新增导出函数（判定顺序：硬排除 → 评分下限 → 类别上限 → A 级买点校验）：

```js
export function observationGrade(signal = {}) {
  const score = signal.score;
  if (!Number.isFinite(score))
    return { grade: null, gradeReason: "缺少有效评分" };
  if (score < 40) return { grade: null, gradeReason: "评分低于 40" };
  if (signal.stockClass === STOCK_CLASSES.MEDIOCRE)
    return { grade: null, gradeReason: "平庸型" };

  const floor = score >= 80 ? "A" : score >= 60 ? "B" : "C";
  const ceiling = CLASS_CEILING[signal.stockClass] ?? "B";
  let grade = GRADE_ORDER[floor] >= GRADE_ORDER[ceiling] ? floor : ceiling;

  const qualifiedBuyPoint = buyPointTypes(signal.buyPoint).some((type) =>
    A_GRADE_BUY_POINTS.has(type),
  );
  if (grade === "A" && !qualifiedBuyPoint) grade = "B";

  const classLabel =
    CLASS_LABELS[signal.stockClass] ?? "未分类（最高 B）";
  const reasonParts = [`评分 ${score}`, classLabel];
  if (floor === "A" && !qualifiedBuyPoint)
    reasonParts.push("买点未命中打板/炸板低吸，降为 B");
  else if (GRADE_ORDER[ceiling] > GRADE_ORDER[floor])
    reasonParts.push(`按类别封顶为 ${ceiling}`);
  return { grade, gradeReason: reasonParts.join(" · ") };
}

export function annotateObservationGrades(signals) {
  return signals.map((signal) => ({ ...signal, ...observationGrade(signal) }));
}
```

返回值形状固定为 `{ grade: "A"|"B"|"C"|null, gradeReason: string }`。`grade: null` 只表示“剔除观察池”，不删除信号、不改变交易动作。

### 2. `backend/domain/trading.js`：排序后注解 + 审计透出

**What**：
- 导入 `annotateObservationGrades`、`OBSERVATION_GRADE_RULES_VERSION`；
- `scoreSignals` 末尾改为 `return annotateObservationGrades(rankSignals(signals, policy));`
- `selectionAudit` 根新增 `gradeRulesVersion`；
- candidates 新增 `grade`、`gradeReason`。

**Why**：`scoreSignals` 是唯一生产信号的入口，排序后统一注解可保证与 `rank` 一致；审计是前端/研究回放的唯一读取面。

**How**：

1. 导入块（约 60–69 行）追加：

```js
  annotateObservationGrades,
  OBSERVATION_GRADE_RULES_VERSION,
```

2. `scoreSignals` 最后一行改为：

```js
  return annotateObservationGrades(rankSignals(signals, policy));
```

3. `selectionAudit` 根对象（约 434 行）在 `snapshotDigest` 后新增：

```js
    gradeRulesVersion: OBSERVATION_GRADE_RULES_VERSION,
```

4. candidates 映射在 `stockClass` 后新增：

```js
      grade: s.grade ?? null,
      gradeReason: s.gradeReason ?? null,
```

不改动 `rankSignals`、平庸型排除逻辑、订单字段与 `assertProgramSnapshot`。

### 3. `frontend/paper.js`：审计表新增分级列与数量

**What**：在“选股依据”折叠标题追加 A/B/C 数量；表格新增“分级”列。

**Why**：用户选择“审计表 + 数量”的展示方式；分级信息必须能被实际使用者看到。

**How**：

1. 在 `const candidates = ...` 后计算：

```js
  const graded = candidates.filter((c) => c.grade !== undefined);
  const gradeSummary = graded.length
    ? ` · A ${candidates.filter((c) => c.grade === "A").length} / B ${candidates.filter((c) => c.grade === "B").length} / C ${candidates.filter((c) => c.grade === "C").length}`
    : "";
  const gradeCell = (candidate) => {
    if (candidate.grade === undefined) return "未分级";
    if (candidate.grade === null)
      return `剔除<span class="stock-code">${escape(candidate.gradeReason)}</span>`;
    const label =
      candidate.grade === "A"
        ? "重点关注"
        : candidate.grade === "B"
          ? "一般关注"
          : "备选观察";
    return `${candidate.grade} 级<span class="stock-code">${label} · ${escape(candidate.gradeReason)}</span>`;
  };
```

2. `<summary>` 文案改为：

```js
`选股依据 · ${candidates.filter((c) => c.status === "SELECTED").length} 只入选 / ${candidates.length} 只候选${gradeSummary}`
```

3. 表头在“个股”后插入 `<th>分级</th>`；行内对应插入 `<td>${gradeCell(c)}</td>`。

兼容：旧计划的 candidate 没有 `grade` 字段，显示“未分级”，不计入数量；`grade === null` 显示“剔除”+原因。计划订单表不改。

### 4. 新增 `test/observation-grade.test.mjs`

**What**：覆盖分级规则边界、类别封顶、买点约束、排除、批量注解保序，以及 `createPlan` 审计透出。

**Why**：分级是纯规则，必须把每个阈值与封顶组合固定下来，防止后续改动漂移。

**How**：使用 `node:test` + `node:assert/strict`，直接导入 `observationGrade`、`annotateObservationGrades`、`OBSERVATION_GRADE_RULES_VERSION`，以及 `STOCK_CLASSES`、`BUY_POINT_TYPES`、`scoreSignals`、`createPlan`、`BASE_STRATEGY`、`snapshot`/`dateAt` fixture。

至少覆盖：

- A 级：`80 + relay-leader + labels:["limit-up-momentum"]`；`95 + relay-leader + labels:["broken-board-dip","first-neg-dip"]`；`labels` 缺失但 `primary.type = broken-board-dip` 回退命中。
- A 降 B：`90 + relay-leader + labels:["first-neg-dip"]`；`90 + relay-leader` 无 buyPoint；`79 + relay-leader + 打板`（评分不足）。
- 类别封顶：`90 + strong-reversal + 打板 → B`；`90 + swing-range → C`；`90 + stockClass=null → B`；未知类别字符串 → B。
- 边界：`score 80 → A 下限`、`79 → B`、`60 → B`、`59 → C`、`40 → C`、`39 → null`；`score null → null`。
- 排除：`90 + mediocre → null/"平庸型"`；`39 + mediocre → null/"评分低于 40"`（排除顺序固定）。
- `annotateObservationGrades`：返回新数组、保持原顺序、不修改原对象、每个元素都有 `grade/gradeReason`。
- `scoreSignals`：输出中每只信号都带 `grade` 字段。
- `createPlan`：`plan.selectionAudit.gradeRulesVersion === OBSERVATION_GRADE_RULES_VERSION`，candidates 均含 `grade`/`gradeReason`；构造一只 `stockClass = relay-leader` 且带 `buyPoint.labels` 的快照股票时，审计 grade 与 `observationGrade` 结果一致。

### 5. `docs/design/signal-selection.md`：补充方案 8 说明

在“计划与审计”之后新增“观察池分级（方案 8）”小节：

- A/B/C/剔除规则表；
- “评分定下限、类别定上限”的封顶规则（连板龙头 A / 强势反包 B / 波段震荡 C / 未分类 B）；
- A 级额外要求买点属于打板或炸板低吸，未命中降 B；
- `gradeRulesVersion` 独立于 `selectionPolicy`，不新增 v4、不改摘要；旧计划无该字段仍有效；
- `grade = null` 只表示剔除观察池，信号仍保留用于持仓风控，不改变排序、建仓资格与订单。

## Assumptions & Decisions

1. **阈值使用整数 `score`**：与现有 80/88/82 阈值口径一致，`scoreValue` 不参与分级。
2. **类别封顶（用户已选）**：先按评分得到下限，再按 `stockClass` 取上限，最终取更保守一级；强势反包最高 B、波段震荡最高 C、未分类最高 B、连板龙头最高 A。
3. **独立规则版本（用户已选）**：新增 `OBSERVATION_GRADE_RULES_VERSION = 1` 并写入 `selectionAudit.gradeRulesVersion`；不改 `selectionPolicy`、不新增 `signal-ranking-v4`、不重算政策摘要。
4. **展示范围（用户已选）**：只在“选股依据”审计表新增分级列与 A/B/C 数量，计划订单表不改。
5. **买点判定来源**：优先 `buyPoint.labels`，缺失时回退 `buyPoint.primary.type`；两者都没有视为未命中。现有 `classifyBuyPoint` 无 `secondary` 字段，不引入该依赖。
6. **平庸型与未分类区分**：`stockClass === "mediocre"` 直接剔除；`stockClass === null` 不代表平庸，按“未分类（最高 B）”处理。
7. **不改交易语义**：`grade` 不进入 `rankSignals`、不进入订单、不参与 `assertProgramSnapshot` 比对；历史 v1/v2/v3 计划重算不受影响。
8. **分支**：从最新 main 新建 `feat/observation-grade`。

## Verification

1. 新增测试：`node --test test/observation-grade.test.mjs`
2. 相关回归：`node --test test/signal-selection.test.mjs test/trading.test.mjs`
3. 格式：`npm run format`，随后 `npm run check`
4. 全量：`npm test`
5. 前端构建：`npm run build`
6. 人工核对：生成一份含 `selectionAudit` 的计划，确认前端“选股依据”显示 A/B/C 数量与分级列；旧计划打开显示“未分级”且不报错。
