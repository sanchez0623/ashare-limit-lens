# 项目记忆

记录需跨任务保留的故障经验。事故核查结果以注明的时间为准，不代替后续实时健康检查。

## MEM-001：升级后冻结计划与执行版本失配，阻断主账户执行

- 记录日期：2026-10-27，北京时间。
- 重复情况：用户明确反馈同类问题已出现两次。首次发生时间未核实，不将另一种评分版本错误当作该问题的第二次记录。
- 本次报错：`新政策独立冻结依据、配置或执行指纹不一致`。
- 本次状态：09:53 核查时，联合行情仍有新鲜报价；自动轮询心跳持续更新，但 `health.status=ERROR`，当日主交易会话尚未创建，主账户盘中观测数为 0。此时不能报告“正常监控执行”，也不能解释为无买点而正常空仓。

### 已核实的原因

本次主账户冻结计划与 `scope='main'` 的计划绑定相符，配置摘要相符，登记配置的执行指纹也与计划相符；失配项是**当前执行实现指纹与冻结计划指纹不同**。因此完整性保护拒绝执行。不能把报错笼统归为配置损坏，也不能把其他影子账户的绑定当作主账户绑定检查。

主要实现位置：

- `backend/storage/dragon-risk.js`：`assertStoredDragonPlan`，检查绑定、配置摘要、来源及执行指纹。
- `backend/domain/execution-build.js`：`executionEngineBuildDigest`，定义影响执行指纹的源码范围。
- `backend/services/realtime.js`：`pollTrading` 与 `realtimeStatus`，区分实际执行状态和轮询存活。
- `backend/services/dragon-risk.js`、`backend/services/industry-repair.js`：已有版本生命周期及限定范围的修订、续跑逻辑；使用前核对适用条件。

### 后续修改与发布要求

1. 修改指纹涉及的源码前，检查是否已有冻结的主计划、当日会话、持仓、未完成 T 或影子计划；判断修改会影响哪些运行版本。
2. 在合法计划边界登记新执行版本。盘前尚未使用的计划，按既有生命周期保留修订并一致更新配置、计划与绑定；已执行会话保留原冻结依据。
3. 盘中不得倒填盘前时间、补造漏掉的观测或成交，也不得覆盖历史计划、摘要或执行指纹来绕过保护。
4. 只有已实现、适用且通过完整重放核验的不可改写续跑证明，才能支持旧会话继续执行。不得把行业修复的专用证明挪作任意代码升级的通行证。没有合法衔接路径时明确阻断原因及影响，不能把暂停说成已恢复。
5. 代码修改、构建产物、实际运行进程必须一致。构建成功不代表常驻服务已加载；源文件和已加载的 bundle 可能使用不同版本。
6. 回归至少覆盖：已有冻结计划后升级、尚未执行与已经执行的会话、重复重启幂等、主账户与影子账户绑定隔离、历史账本与原始观测不改写。

### 恢复验收：必须检查业务链路

- 读取 `/api/paper/live`：核对 `health.status`、`reason`、`checkedAt`、`stale`、`session`、`sequence` 和 `lastObservedAt`。`running: true` 只表示心跳仍在，不代表交易已正常执行。
- 在交易时段，确认合法的当日会话存在，并跨至少一个实际轮询间隔检查主观测是否继续推进。行情帧新鲜不能替代主账户消费观测的证明；没有成交也不一定异常，仍需区分正常无信号、风控暂停与执行报错。
- 非交易时段按预期的休市、待开盘或已结算状态判断，不要求制造会话或成交以通过验收。
- 主计划查询必须匹配正确日期与 `scope='main'`；分别核对计划摘要、配置摘要、配置来源、登记构建与当前运行构建，不因同日期存在影子绑定而误判。
- 报告分别说明行情采集、评分、主账户执行的状态。服务能响应、数据 worker 健康或告警心跳新鲜，都不能单独证明主账户正在执行。

### 相关经验：评分恢复不等于交易恢复

同轮排查还出现过 `同版本评分政策已改变，必须登记新版本`。评分政策冻结了 `implementationDigest`；本轮通过登记 `dragon-observation-score-v4` 保留旧政策及游标，相关测试与构建通过，重启后确认 v4 已加载。但主执行仍被 MEM-001 拦截，因此不能据评分接口恢复就报告全链路恢复。

以后评分或其指纹依赖发生变化，也须登记新政策版本，不覆盖同版本历史政策，不删除旧游标。运行进程若因系统权限无法重启，应明确报告“代码已修复、运行版本尚未切换”，并说明实际拒绝原因。

### 本次记录的恢复状态

截至上述 09:53 核查，**尚未确认主交易执行恢复**。后续确实恢复后，应追加实际恢复时间、所用衔接机制和观测推进证据，不提前标记已解决。

## MEM-002：同类指纹失配第三次复发——升级发生在 09:30 衔接窗口之后，当日全阻断

- 记录日期：2026-10-27，北京时间 13:3x 核查。告警 `inc-2026-10-15T06:57:06.506Z-38b6c9d7#18`：`LOOP_FAILED / primary / RUNNER_FAILED`，13:15 触发，持续 225 分钟（约自 09:30 开盘起）。

### 已核实事实

- `/api/paper/live`：`running:true`、心跳新鲜，但 `health.status=ERROR`，reason 仍为“新政策独立冻结依据、配置或执行指纹不一致”；`session:null`，`paper_live_sessions` 表为空——当日主账户零会话、零执行，不是无买点空仓。
- 指纹对比：
  - 冻结主计划（`paper_plans.signal_date=2026-10-26`，09:26:46 北京冻结，`scope='main'` 绑定 config `dragon-engine-d63742fc…`）：`engineBuild=3eec234d…`。
  - 当前源码与 dist bundle：`b29bba9b…`。dist 构建于 12:15:38 北京；常驻进程为两个 `node ./server.mjs`，均 12:20 北京启动，确认加载 b29bba9b。
- 账户 book：`lastDate=2026-10-26`、`positions=0`、`dragonTransition.configId=d63742fc`、`pendingDragonConfigId=dragon-engine-b5144c37…`（即 b29bba9b 新版本只排队、未生效）。
- 时间线：09:26:46 冻结 3eec234d 计划 → 09:47:20 注册 4fee2912 → 10:27:26 注册 b29bba9b。后两者均在 09:30 衔接窗口关闭之后。

### 反复发生的直接原因

`applyDragonLifecycle`（`backend/services/dragon-risk.js:976`）只在三个窗口允许把未执行旧计划迁移到新指纹：当日 `>=15:05`、次日 `<09:30`、新周期特殊窗。`refreshDragonEngine` 在窗口外检测到指纹变化时只设置 `pendingDragonConfigId`，不改动已冻结计划；而 `assertStoredDragonPlan` 每轮仍严格校验“冻结指纹 == 当前运行指纹”。因此**只要执行白名单源码在 09:30 之后、当日 15:05 之前被改动并重建/重启，主账户就必然全天阻断、每 10 秒报 RUNNER_FAILED**。10-23 至 10-27 的 `dragon_config_versions` 显示 ENGINE_UPGRADE 几乎每个交易日都在盘中/盘后注册，同类拦截因而反复出现。

### 本次阻断结论与下一合法窗口

- 13:3x 时点：今日 `>=15:05` 窗口条件是 `clock.date === lastDate(2026-10-26)`，不成立；今日 `<09:30` 窗口已过——**当日无合法衔接路径，主账户 10-27 全天不执行**。不做改指纹、清库、伪造计划等任何绕过操作。
- 下一合法窗口：**2026-10-28 开盘前（时钟日期晚于 lastDate 且北京时 < 09:30）**，前提是执行白名单源码不再变动（否则 `applyDragonLifecycle` 会抛“待生效配置执行指纹已变化，请重新验证”），且常驻服务在运行。迁移成功时旧计划会存入 `paper_plan_revisions`，以原冻结信号重冻新指纹计划。
- 发布纪律（防止第四次）：执行源码改动+构建+重启只能安排在收盘后 `>=15:05`，或次日 09:30 前完成；09:30–15:05 之间不得上线新执行指纹。恢复验收仍按 MEM-001：health 转 OK、当日会话建立、跨轮询间隔主观测推进，三者齐备才算恢复。

### 后续恢复结果（2026-10-27 15:05 已确认恢复）

- 15:05:24 曾报 `SETTLEMENT_LATE / SETTLEMENT_FAILED`，经查是**结算流程执行中途（开始约 20 秒后）触发的短暂迟延告警**，并非最终失败。
- 15:05:45（北京）`runDaily` 完成：空仓补结算 10-27（零成交，notice 明确“登记构建 3eec234d 与当前 b29bba9b 不同，按空仓补结算”）、`lastDate` 推进至 2026-10-27、`pendingDragonConfigId` 清空、新配置 `dragon-engine-b5144c37…`（engineBuild=b29bba9b）正式 ACTIVE、已冻结 10-28 交易计划。
- 新计划核验：engineBuild=b29bba9b 与当前运行一致，候选池 57 只，`entryExecutionPolicy`/`executionCostPolicy` 齐全，`scope='main'` 绑定与计划摘要一致。
- 待最终确认：2026-10-28 开盘后当日实时会话建立、主观测跨轮询推进。计划/指纹/账户三者已一致。

### 后续改动：结算备注上界面 + 结算告警加时间闸门（2026-10-27 下午）

- 多进程排查：15:05:23 那次“结算失败”根因不是“采样太早”，而是**三个 node 实例并发操作同一库**：PID 33908（手动从 Windows Terminal 启动，唯一持有 3000 端口）为正常实例；PID 28276、3356 是 codex app-tools（`launch_codex_app_tools_mcp.cmd ./server.mjs`）在 12:20 重复拉起的无端口实例，其交易循环 CAS 竞争产生 `settled:false`，触发误报。用户要求先排查不擅自杀进程，处置待用户决定。
- 界面：交易页“下一交易日计划”区块下新增“结算备注”折叠区（`paper-settlement-notices`，渲染 `run.notices`，数据本就经 `/api/paper` 返回），默认展开；无备注时隐藏。
- 告警闸门：`classifyOperationalFacts(input, policy)` 增加 policy 参数；daily 失败若发生在 AFTER_CLOSE 且北京时 `< settlementLateWarningAt`（默认 15:20）则不产生告警事件（宽限窗），到点仍失败才报 WARNING、15:30 升 CRITICAL。`recordOperationEvents` 改为读取已存规则版本的 policy 后传入。
- 指纹安全：本次改动文件（alert-rules.js、services/alerts.js、前端）均**不在执行引擎白名单**，构建后执行指纹仍为 b29bba9b，10-28 计划与账户绑定不受影响。已构建；告警测试 35/35、sessionless 测试 4/4 通过。
- 运行加载状态：**常驻进程尚未重启，仍运行 12:15 的旧构建**；告警闸门与界面改动需重启 server 后才在运行实例生效（前端静态资源刷新即可见新备注，后端闸门需重启）。重启须由用户确认，重启时间不受窗口限制（这些文件不改执行指纹）。

## MEM-003：进程停摆导致漏日结算缺失，账户连续性永久卡死——漏日自动补结算落地

- 记录日期：2026-11-05，北京时间。
- 事故：11-04 11:06 与 11-05 10:41 执行进程两次停摆。11-04 的实时会话带真实成交但收盘结算从未运行，`lastDate` 停在 11-03，11-05 全天 `SESSION_BLOCKED / MISSING_SETTLEMENT` 零执行。原架构下自动恢复不可能：`runDaily` 只结算当天，盘前补结算仅覆盖"lastDate 无计划"场景，而 11-04 有计划有会话。

### 硬件根因证据（2026-11-05 16:30 采集，未做内存诊断）

- **WHEA-Logger Event 19（已更正硬件错误）10-27 21:58 至 11-04 23:06 共 68 次**，全部为"处理器核心 / Corrected Machine Check / **Internal parity error**"，APIC ID 0 与 1 交替。按日：10-27 3、10-28 9、10-29 21、10-30 13、10-31 4、11-01 1、11-02 3、11-03 9、11-04 5。**11-04 11:04:28 那条正好在服务 11:06 静默死亡之前 2 分钟**，与停摆时间吻合。
- 近 4 天 5 次内核崩溃（`C:\Windows\Minidump`）：11-02 10:20 `0x0A` IRQL_NOT_LESS_OR_EQUAL、11-02 15:25、11-02 16:42、11-03 22:26 `0x50` PAGE_FAULT_IN_NONPAGED_AREA、11-05 12:22 `0x7F(8)` DOUBLE_FAULT。三类 BugCheck 组合指向 CPU 缓存/内存控制器或内存条，而非存储。
- 磁盘侧排除：`chkdsk C: /scan`（提权在线扫描，1.92 分钟）阶段 1-3 与 USN 日志全部通过，"Windows 已扫描文件系统，没有发现问题"；`Get-PhysicalDisk` HealthStatus=Healthy，存储为 YMTC YMSS2ED08D25MC SSD（954GB，C/D 两卷均 Healthy）。
- 内存配置：2×16GB SK Hynix HMCG78AGBSA092N DDR5-5600 双通道（Controller0/1 ChannelA）。
- 驱动与更新：最近驱动为 10-09/10-10，Windows 更新止于 10-19；而硬件错误自 10-27 起量级暴增，**不是新驱动或系统更新直接引入**。
- 机器里还有 11-05 10:51 应用 API 触发的睡眠与 12:22 意外重启（Kernel-Power 41/6008、事件 1005 磁盘 IO 报错）。
- 用户决定：暂不执行内存诊断重启（`{memdiag}` 引导项已确认可用但**未设置 bootsequence**），仅保留证据。因此**内存诊断尚未运行**，不得声称已完成。
- 处置建议（未实施）：内存诊断 memtest 全轮次 → 关 XMP/降频 → 检查散热与 BIOS/微码 → 换内存条复测 → 仍复现则怀疑 CPU/主板。硬件问题未排除前，软件层只能缩短故障时长，不能保证交易日内不中断。

### 已落地的修复（paper.js / historical-quotes.js 均不在执行白名单，指纹保持 b29bba9b）

1. 漏日自动补结算（paper.js）：结算时发现 `lastDate` 落后于上一交易日且处于收盘后窗口（`afterClose`）时，按序递归重放缺失交易日；连续性、事前计划、成本政策、执行指纹逐项核验，任何一天失败即保持原样阻断。盘中只阻断不重放（防止盘中推进 lastDate 打开当日会话）。
2. 历史日线兜底（historical-quotes.js）：实时快照只覆盖当天，补结算历史日的持仓收盘价从腾讯 fqkline 日线（qfq 前复权）构造。注意：**fqkline 不带 `,qfq` 后缀时对个股返回空数据**；若结算日至今发生除权，前复权昨收与账面原价不一致，由 closeSession 除权守卫原样阻断，不静默混口径。
3. 漏日仅重估结算（paper.js `sessionlessHeld`）：计划错过执行日冻结截止（`planFreezeDeadline`）时，retro-open 会话在 openSession/openDragonSession 守卫下永不合法，但零成交的持仓重估必须完成否则连续性断裂。构造结算专用零帧会话仅重估持仓：当日存在成交记录视为数据异常阻断；非 dragon 账本有在途单据（pendingOrders/Exits/Recovery）时阻断（closeSession 按会话订单重建在途状态，零订单会话会丢状态；dragon 由持仓自带 dragon.t/dragon.exit 结转，安全）；**结算专用会话不落 paper_live_sessions 行**——它没有 regime 等执行态字段，落行会让 `/api/paper/live` 读 `session.regime.phase` 报错（本次实际踩坑）。
4. 保活（Layer A）：`scripts/keepalive.mjs` + 计划任务 "LimitLens Keepalive"（每 2 分钟，当前用户注册；SYSTEM/ONLOGON 需管理员未注册）。端口在监听即视为存活（用 `net.connect` 探测，不依赖认证）；否则 detached 拉起 server.mjs，日志在 `.sites-runtime/logs/`。两个必须遵守的实现约束：(a) **脚本不得调用 `process.exit()`**——异步句柄未清理时计划任务会把成功运行记为 1067（进程异常终止）；(b) **子进程 stdout/stderr 必须直接写日志文件描述符**，用 pipe 时父进程退出会关闭管道，常驻服务写 stdout 触发 EPIPE 可能被带崩。任务本身用 XML 注册，`MultipleInstancesPolicy=Parallel` + `ExecutionTimeLimit=PT1M` + `StartWhenAvailable=true`：早期用 `/SC MINUTE` 默认 IgnoreNew 时，一次僵死实例会让后续所有触发被静默忽略、保活整体失效（实测 Last Run Time 停在 16:06 三分钟不再推进）。
   验收方式：杀掉监听进程后端口应在 2 分钟内被自动重新占用，且任务 `Last Result=0`、`Last Run Time` 持续按周期推进（已实测：38 秒恢复、连续两个周期结果均为 0）。
   电源策略本就是接通电源从不睡眠；10:51 的睡眠是应用 API 主动触发，空闲超时防护覆盖不了。
5. 工具（Layer 兜底）：`scripts/replay-settlement.mjs`（收盘后手动/计划任务触发漏日重放，窗口前拒绝执行；计划任务 cwd 是 System32，必须显式 `loadEnvFile(项目根/.env)`）。

### 验收记录

- 2026-11-05 15:52 重放完成：11-04（历史日线兜底，601086/603258 按真实收盘重估）与 11-05（仅重估、零成交、notice 如实声明）均 SETTLED，`lastDate=2026-11-05`，plan(signal_date=11-05) 已冻结，净值行两天齐且 complete=1。
- 回归：settlement-catchup 新用例 2/2、全量 V5 回归 465/465。
- 新构建已构建并经 keepalive 拉起生效（指纹 b29bba9b 不变，冻结计划/绑定不受影响）。
- 2026-11-05 16:20 复核：`lastDate=2026-11-05`，`signal_date=2026-11-05` 的 `scope='main'` 绑定存在，计划 engineBuild=b29bba9b 与当前源码/dist 一致，`assertStoredProgramPlan` 实跑通过（EXECUTION GUARD: PASS）——次日开盘具备建立会话的全部前提。
- 待最终确认：11-06 开盘当日会话建立、主观测跨轮询推进；SESSION_BLOCKED 与 REQUIRED_QUOTE_STALE 两个 incident 在真实恢复证据出现后自动转 RESOLVED。
