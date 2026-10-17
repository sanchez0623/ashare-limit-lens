# 龙头低吸战法接入模拟交易：缺口分析

> 配套文档：[dragon-head-dip-buy.md](./dragon-head-dip-buy.md)（8 方案设计）
> 分支：`feat/observation-grade`
> 评估范围：判断"dragon-head-dip-buy 完整接入系统模拟交易"还缺哪些**数据**与**系统功能调整**。

## 一、8 方案实现状态（feature 层全部已落地）

| 方案 | 状态 | 实现位置 |
|---|---|---|
| 1 情绪周期仓位闸门 | ✅ 已驱动决策 | `shared/sentiment-cycle.js` + `backend/domain/trading.js:373-417,882`（cycle 闸门、冰点禁开仓） |
| 2 买点类型标签 | ⚠️ 仅标签 / 未驱动决策 | `shared/buy-point-type.js` + `shared/scoring.js:251` annotate；只到 A 级展示 + 成交记录 |
| 3 股票分类路由 | ✅ 已驱动决策 | `shared/stock-class.js` + `backend/domain/signal-selection.js` v3 `stockClassRouting`，平庸型排除建仓 |
| 4 金字塔减仓参数化 | ✅ 已参数化 | `strategy.pyramidReduce` 向量 |
| 5 卖出信号检测器 | ✅ 已接入 | `shared/exit-signals.js` + `backend/services/exit-context.js` + `trading.js:549` |
| 6 降级检测器 | ✅ 已接入 | `shared/downgrade.js` + `CLASS_MANAGEMENT`，快照版本门控 |
| 7 做 T 质量追踪 | ✅ 已接入 | `backend/domain/t-quality.js` + `paper_t_trades` + 停手闸门 |
| 8 观察池 A/B/C 分级 | ✅ 已落地（最新 commit） | `backend/domain/signal-selection.js#observationGrade` |

**结论**：8 方案"功能"都做了；问题不在缺功能，在**方案 2（买点标签）没有从"标签层"升级到"决策层"，且标签本身有 4/6 在数据链路里根本触发不了**。

---

## 二、核心缺口

### 缺口 A：候选宇宙过窄 —— "6 种买点数据不完整"的根因

`marketData()`（`backend/services/market.js:49-92`）返回的候选行 `rows` = **`getTopicZTPool`（当日封板涨停股）**。`saveSnapshot` → `analyze(rows, broken, previous, ...)` 只对**涨停池行**评分 + 打买点标签（`shared/scoring.js:285 analyze` 的 `clean = rows.filter(...)`）。

`broken` 只传了**家数**（`brokenRows` 个股行存在但没喂进 `analyze` 当候选），`previous` = 昨日涨停池。

**6 种买点在"选股候选池"里的实际可得性：**

| 买点 | 触发条件 | 候选池能否触发 | 原因 |
|---|---|---|---|
| 打板 | 涨停 + 首封 10:30 前 + 有换手 | ✅ 稳定触发 | 候选全是封板涨停股 |
| 炸板低吸 | isLimitUp=false + breaks + 回落 3–7% | ❌ 结构性无法触发 | 候选全是 isLimitUp=true；炸板股在 `brokenRows` 里没进候选 |
| 首阴低吸 | height=0 + prevHeight≥3 + 实体阴 + 未破 MA5 | ❌ 结构性无法触发 | 候选全是今日涨停(height≥1)；首阴股今日未涨停不在池 |
| 假阴跌停低吸 | 昨日假阴 + 今日低开≥8% | ❌ 结构性无法触发 | prevRow=昨日涨停池(prevChange≈+10%，不可能是假阴) |
| 早盘竞价低吸 | 昨日涨≥5% + 今日竞价低开≥5% | ⚠️ 部分触发 | 仅"低开后又封板涨停"的地天板子集；低开未封的不在候选 |
| 尾盘跳水低吸 | isLimitUp=false + 日内回落≥3% + 尾盘 | ❌ 结构性无法触发 | 候选全是涨停(isLimitUp=true) |

**6 种里只有打板能稳定跑，其余 4 种连行都没有。** 这正是"数据不够完整"。

### 缺口 B：买点不驱动决策

`buyPoint` 是 annotation-only：

- `observationGrade`（`backend/domain/signal-selection.js:135`）用它卡 A 级上限，但注释明确"grade 仅展示，不参与排序与交易决策"
- OPEN 建仓门槛（`trading.js:843-872`）只看 score / sectorScore / coverage / 家族资格 / 情绪 / 回撤 / 冰点，**完全不看 buyPoint**
- `buyPoint` 只被带上 OPEN 订单（`trading.js:938`）和成交回填（`trading.js:2046`），供 `backend/domain/cohort-metrics.js` 赛马统计

设计文档核心论点（`dragon-head-dip-buy.md:323`）：超额收益的两个量化杠杆 = **情绪周期闸门（已驱动）+ 买点类型分化（未驱动）**。所以即使数据齐了，不把买点变成建仓闸门，dragon-head-dip-buy 仍只是展示层。

### 缺口 C：prevRow 来源不支持假阴跌停低吸

`analyze` 的 prevRow 来自 `previous` = 昨日涨停池（封板股）。假阴跌停需要"昨日收假阴"（prevOpen>prevClose 且 prevChange≈0），但昨日封板涨停股 prevChange≈+10%、阳线，不可能是假阴。要触发假阴跌停，prevRow 必须来自**昨日炸板池**或**昨日日线 parquet**。

### 缺口 D：实时盘中路径 —— 不是缺口（已确认）

buyPoint 在盘后 analyze→snapshot→createPlan 时冻结进 plan；盘中实时执行器只按冻结的 `buyTriggerCents` / `sellTriggerCents` 触发（`backend/services/realtime.js:451,467`），不重算买点。`lateSession` 在盘后=true 也成立。**所以买点决策纯粹是盘后的事，盘中无需改造。**

---

## 三、数据其实存在，缺的是"接进候选宇宙"的管道

| 买点所需数据 | 是否已存在 | 位置 |
|---|---|---|
| 涨停池行（first/turnover/breaks/height/open/high/close） | ✅ | `getTopicZTPool` + `normalize` |
| 炸板池个股行（zbc/o/h/p/change） | ✅ 存在但未进候选 | `market.brokenRows`（`getTopicZBPool`），目前只被 `exit-context` 用作出池持仓炸板次数 |
| 全市场日线 EOD（open/close/high/change/volume/limitUpPct） | ✅ 任意 code 都有 | `backend/services/daily-closes.js` parquet `computeExitEodRowsByCode`（全 universe 遍历，不限持仓） |
| MA5（首阴要） | ✅ 任意 code 都有 | `computeMa5ByCode` |
| 昨日假阴的 prevOpen/prevClose/prevChange/prevBreaks | ✅ 存在 | 昨日日线 parquet（或额外抓昨日炸板池） |
| lateSession（尾盘跳水要） | ✅ 盘后已传 true | `backend/services/review.js:114` |

**即：数据在系统里都有，问题是 `analyze()` 只把涨停池当候选行喂给买点分类器。**

---

## 四、所需调整（数据侧 + 系统功能侧）

### 数据侧

1. **扩展候选宇宙到炸板池**：`analyze` 增加候选行来源 = `brokenRows`（炸板池个股，normalize 后 isLimitUp=false、breaks 有值）。让炸板低吸、尾盘跳水低吸有行可判。需核对 `getTopicZBPool` 行是否带 `o/h`（`normalize` 已读 `row.o/h/p`，两个池字段口径可能不同）。
2. **从全市场日线 parquet 构造"连板中断收阴"候选行**：筛 prevHeight≥3 + 今日未涨停 + 实体阴 + 未破 MA5 的 code，用 EOD 行构造 today-row 喂进候选池，让首阴低吸有候选。prevHeight 从昨日涨停池或昨日 parquet 取。
3. **prevRow 来源扩展支持假阴跌停**：对候选行，prevRow 改为优先从昨日日线 parquet 取（含 prevOpen/prevClose/prevChange/prevBreaks），昨日涨停池只作 fallback。或额外抓取昨日炸板池（`getYesterdayZBPool`，当前未抓）。
4. **字段口径核对**：确认涨停池 / 炸板池 / parquet EOD 三套行的 `o/h/p/change/zbc` 字段一致或做归一适配，避免买点分类器在炸板池行上拿不到 open/high。

### 系统功能侧

5. **选股政策 v4（signal-ranking-v4）+ 买点建仓闸门**（推荐路径 A）：
   - `signal-selection.js` 新增 `SELECTION_VERSION_V4 = "signal-ranking-v4"`，加 `buyPointGate: true` 字段 + SHA-256 摘要（对齐 v1/v2/v3 的 `selectionPolicyDigest`）
   - `createPlan` 新建仓循环（`trading.js:843-872`）加硬过滤：`policy.buyPointGate` 时 OPEN 候选必须带合格 `buyPoint.primary`，audit.reason 记"未命中任何买点"
   - 快照版本门控（对齐 `downgradeEnabledForSnapshot` / `tQualityEnabledForSnapshot` 模式）：新规则只对新快照生效，旧快照 / 旧账户保持 v3 语义，重算收敛
   - 闸门范围（合格买点集合）作为可配置项，初版建议对齐 A 级口径 = {打板, 炸板低吸}，逐步放宽

6. **（可选）路径 B：注册 dragon-head-dip-v1 家族**：在 `FAMILY_DEFINITIONS` + `STRATEGY_FAMILIES` 登记，`familyEligibility` 按 `signal.buyPoint` 判资格，走赛马锦标赛 + 前瞻验证晋级。更正式但更重，建议路径 A 落地后再做。

7. **计划冻结完整性**：新选股政策必须在 `createPlan` 创建时连政策 + 摘要一起冻结进计划，否则 `assertProgramPlan` / `assertStoredProgramPlan` / `frozenSelectionPolicy` 核验会失败。

8. **验证闸门**：先在影子账户 / 导出重放（`verifyExport` 重放选股）跑通，确认扩展后的候选宇宙里 4 种买点能触发、成交符合预期，再开主账户。对齐代码库纪律：不追溯改规则、新规则只对新快照生效、计划冻结内容寻址核验。

---

## 五、落地顺序建议

1. 先做**数据侧 1–4**（扩展候选宇宙 + prevRow 来源 + 字段核对）——这是让 4 种买点"能触发"的前提，不改决策语义、风险最低。
2. 在扩展后的候选宇宙上跑一遍历史快照，统计 6 种买点的实际命中率和分布（验证"数据够不够"）。
3. 再做**系统功能侧 5**（选股政策 v4 + 买点建仓闸门 + 快照版本门控），让买点真正驱动建仓。
4. 影子 / 重放验证通过后开主账户。
5. 路径 B（家族赛马）作为后续分化手段。

---

## 六、假设

- `getTopicZBPool`（炸板池）行字段口径与涨停池兼容或可归一（待核对）。
- `QUAN_DATA_DIR` parquet 覆盖快照日（首阴 / 假阴的 MA5 与 EOD 依赖此；未配置时对应买点按"宁缺毋滥"不触发，不阻断）。
- 买点决策仅盘后冻结，盘中不重算（已确认）。
- 闸门合格买点集合初版对齐 A 级口径（打板 + 炸板低吸），可后续调宽。
