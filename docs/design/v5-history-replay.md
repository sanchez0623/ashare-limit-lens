# V5 历史候选重构与六类严格回放

状态：已实施，真实区间可执行性取决于逐日证据验收。2026-10-22。

## 使用

复盘反馈页面的「V5 历史候选与六类回放」支持选择执行区间、重构并验收、读取报告和下载逐日缺口。当前主账户策略、费用、风险、成本政策在研究批次中冻结；初始资金 100 万元，空仓，固定 V5 和盘中条件执行。已有主账户计划和影子观察不改变。

本地批量验收：

```powershell
node scripts/v5-history-audit.mjs --start=2026-01-01 --end=2026-10-22
```

默认报告输出到 `.sites-runtime/v5-history-2026-01-01-2026-10-22/`，包含说明、完整 JSON 和 UTF-8 CSV。目录、数据库和原始块不提交到 Git。中断的失败任务可通过 `--resume=hjob-...` 续传；已发布的 READY/PARTIAL/BLOCKED 数据集须新建导入，不允许原地升级。

`--candidate=hds-...` 可复用已发布候选版本，另建归档帧版本并重新验收；同一报告目录已存在时，新结果保存到运行 ID 子目录。

## 数据与时间

- `V5_RECONSTRUCTION`：本地未复权日线和逐日因子、同花顺按日期的完整涨停/炸板分页。评分和 EOD 构造复用线上函数，独立保存 `stocks`、`brokenStocks`、`extraStocks`、冻结准入历史及卖出输入。
- 请求区间表示**执行日**。额外保存首日前一交易日的信号，至少 21 个交易日预热；昨日价格严格由相邻日线计算。执行日最终名单不会用来筛选当日早盘候选。
- 日期交叉核对本地日历、全市场日线日期与同花顺历史可用日期。末端尚未更新的日历不冒充完整日历；无独立日期证明时列为缺口。
- 缺少的候选历史日线只调用固定历史区间接口，原始/前复权成对校验，与重叠本地未复权收盘核对，再按信号日切片；不调用最新价格快照、不改写线上历史缓存。
- 本地源文件摘要、原始日线、元数据及 API 分页保存在独立研究库与原始块文件中。中断后源文件变化要求新建数据集，不能混合输入。缺名单不等于空名单。
- `createdAt` 和 API 抓取时间均为真实导入时间；`decisionAt` 是独立的研究虚拟时间。只有研究视图向执行内核传入虚拟冻结时间；原始重构快照不变，来源始终为 `HISTORICAL_RECONSTRUCTED`。
- 当前名称、行业、退市状态和股票范围不能证明过去时点的完整性，单列可信度。历史池缺少的首封、最后封板、流通市值等字段不猜补；候选可部分重构，但无法声明全部六因子完整。

## 行情归档与严格执行

`OBSERVATIONS` 必须指定同区间的 V5 候选数据集，先克隆为新版本，再复制主库真正归档的联合行情帧和 `entryInputs`，保留原始帧摘要、序号、观测/写入时间，并另记复制时间。不会读取其他日期的实时接口。

`ARCHIVED_OBSERVATIONS_V1` 与既有 `MINUTE_SAMPLE_V1` 独立。严格模式先检查整个区间，再复用 `createPlan → openSession → advanceSession → closeSession`。两段连续竞价均须连续覆盖（至 14:56:50）及真实收盘帧；按实际候选准入时刻检查报价、盘口、竞价终态、板块、情绪、周期和逐帧候选发现。逐股新鲜度、连续确认、仓位、现金、成本、整手和 T+1 均由同一实时内核执行。

报价时间和帧时间分开；报价可在新鲜度内保持同一时间，帧重复/倒序、序号缺失、超时断流、必要字段缺失、盘口缺失、分钟采样来源均不能通过。盘口真实为零挂单可以证明无法成交，与盘口未知区分。竞价异动榜不能替代经开盘报价核对的终态。

整段有任一缺口即 `BLOCKED`，账本、净值和收益均不发布；不能跨缺失日拼接收益。完整数据未触发是 `VERIFIED_NO_TRIGGER`，缺少数据是 `UNVERIFIABLE`，实际成交是 `TRIGGERED`。五分钟 OHLC 不能展开为十秒路径。运行结果绑定数据集摘要、执行内核指纹和冻结初始配置，详情可从原始帧独立复算并核对已保存计划、账本、净值。

历史结果始终 `researchOnly: true`、`primaryShadowQualification: false`，不写真实影子验证资格。

## 接口

```text
GET  /api/history/capabilities?provider=local-fuyao-v5&start=...&end=...
POST /api/history/imports
     { kind: "V5_RECONSTRUCTION", start, end }
POST /api/history/imports/:id/run
POST /api/history/imports
     { kind: "OBSERVATIONS", datasetId, start, end }
POST /api/history/imports/:id/run
POST /api/backtests
     { datasetId, executionModel: "ARCHIVED_OBSERVATIONS_V1" }
GET  /api/backtests/:id
```

原有历史类型、评分版本和分钟采样回测继续沿用原语义。

## 验证

`test/v5-history.test.mjs` 覆盖分页完整/空/失败、三类候选与线上构造对齐、首阴/假阴及昨日字段、未来数据隔离、六类完整合成帧、整段阻断、盘口/竞价/市场输入缺失、分钟替代拒绝、重复帧、JSON 重启、现金、T+1、中断续传、元数据 BigInt、成对历史日线校验、不可变发布、研究库隔离和结果篡改。

接口依据：[历史日线](https://fuyao.aicubes.cn/docs/api-reference/prices/)、[竞价](https://fuyao.aicubes.cn/docs/api-reference/auction/)、[竞价机会](https://fuyao.aicubes.cn/docs/api-reference/auction-opportunities/)。
