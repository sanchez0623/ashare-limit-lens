# 方案 7：做 T 质量追踪 —— 量化"做T越做越错"

## 目标（skill 规则 → 量化）

1. **每笔做T记录**：T买入价 / T卖出价 / 当日T盈亏 / 是否当日了结 → 新表 `paper_t_trades`。
2. **质量评分**：最近 N 笔做T平均盈亏 < 0 → 标记"做T状态差"。
3. **停手规则**：连续 2 笔做T亏损 → 停手 3 个交易日。
4. **仓位档位**：胜率 > 60% → 允许 2 成仓做T；40%~60% → 限 1 成；< 40% → 禁止做T。

## 基线（main @ d99b514）

已拉取 main（含方案 6 与用户追加的规则版本冻结修复）。可复用的既有模式：
- **规则显式版本冻结**：`DOWNGRADE_RULES_VERSION` + `downgradeEnabledForPlan(plan)`（计划声明与版本一致性核验）→ 方案 7 用 `T_QUALITY_RULES_VERSION` 同模式。
- **冻结输入随计划**：exitContext（方案 5）/ downgrades 声明（方案 6）→ 方案 7 的 `tQuality` 冻结摘要随计划携带，`assertProgramSnapshot` 回传重算。
- **成交统一落 paper_ledger**：盘后路径在 settle 批内写入；实时路径逐帧 commitObservation 写入 → 做T记录可从当日成交派生。

## 架构决策

- **检测/汇总在计划冻结时完成**（确定性）：createPlan 只消费冻结的 `tQuality` 摘要，不查库；执行器零改动（T 订单数量已冻结）。
- **记录表是成交流水的派生投影**：结算时从当日 paper_ledger 成交 + 恢复单（orderId 以 `:recovery` 结尾）提取，随 settle 同一 CAS 批写入（幂等 INSERT OR REPLACE）。影子/研究重放/回测不写表，用同一纯函数从各自成交流水派生 → 各链路汇总口径一致。
- **停手不用日历存储**：`summarizeTQuality(records, { signalDate, tradingDates })` 由调用方提供有序交易日列表（主账户：结算日历；重放：pairs 日期序列），规则内判定"信号日距第 2 笔亏损了结日不足 3 个交易日 → 停手"。

## 关键口径（假设，验收可调）

- N = 10（最近 10 笔**已了结**做T；未了结的不计胜负，等恢复腿成交后计入）。
- 胜率 = 最近 N 笔中 total_pnl > 0 的占比；> 0.6 → cap 0.2；≥ 0.4 → cap 0.1；否则 0。无历史 → cap null（不设限，保持旧语义）。
- total_pnl = 该笔 T 全部卖出腿的已实现盈亏合计（FIFO 对旧仓，口径与账本一致）。
- 停手判定：最近 2 笔已了结做T连续亏损，且信号日仍在其后 3 个交易日内。
- 每码每日至多一笔 T（计划层既有约束），记录 id = `${trade_date}:${code}`。

## 变更清单

| 文件 | 变更 |
| --- | --- |
| `drizzle/0023_paper_t_trades.sql`（新） | 建表：id/trade_date/code/action/direction/buy_price_cents/sell_price_cents/buy_quantity/sell_quantity/day_pnl_cents/total_pnl_cents/completed_same_day/completed_date/created_at/updated_at + 索引 |
| `backend/domain/t-quality.js`（新） | 常量（版本/样本数/档位）、`extractTTrades(fills)`（同日配对 + `:recovery` 恢复腿匹配，兼容实时 orderId 与盘后 id 前缀两种形状）、`summarizeTQuality(records, {signalDate, tradingDates})` |
| `backend/domain/trading.js` | createPlan：options.tQuality 读入（版本不匹配 throw）；T 分支套用 cap/停手/HOLD 理由（确定性文案）；plan.tQuality 字段；assertProgramSnapshot 回传 plan.tQuality |
| `backend/storage/paper.js` | PaperRepository：`tTradesForDate`/`openTTrades` 查询；`settle` 增加可选 extraStatements（做T记录随同一 CAS 批落库） |
| `backend/services/paper.js` | settlePaperDay：当日成交提取做T记录（盘后用 settlement.ledger；实时查当日 paper_ledger）+ 恢复腿更新 open 记录 → 传入 settle；冻结计划时查表汇总 → options.tQuality；paperOverview 暴露 tQuality 摘要与最近记录 |
| `backend/domain/validation.js` | replayStrategySteps：累积 fills + 交易日序列，逐日 summarize → createPlan options |
| `backend/services/backtest.js` | 回测循环同上 |
| `backend/services/portfolio-runner.js` | freezePortfolioPlan：影子账户从 shadow_ledger 派生做T记录并汇总 |
| `test/t-quality.test.mjs`（新）+ trading.test.mjs 追加 | 提取/汇总/闸门/停手/档位边界/重算一致/结算写入 |

## 验证

1. 新增单测全绿；trading.test.mjs 全绿（旧计划无 tQuality → 语义不变）。
2. 全量回归 `npm test` 0 失败。
3. `npm run check`（prettier）通过。
4. 分支 `feat/t-quality-tracking`（自 main d99b514 切出），提交推送。
