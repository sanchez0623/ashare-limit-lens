# 涨停研究台 · LIMIT LENS

A 股每日涨停评分、板块强度、昨日判断反馈、AI 系统审计与自动模拟交易。盘后冻结下一交易日计划，支持建仓、加仓、减仓、正向/反向 T 与清仓，按真实公开行情结算持仓与净收益。

## 文档

统一入口见 [文档索引](docs/README.md)，包含运行指南、模拟交易说明和设计方案。AI 策略血缘与前瞻影子验证的完整实现方案见 [设计文档](docs/design/ai-strategy-walk-forward.md)，当前状态为待实施。

## 本地运行

需要 Node.js 24。首次执行：

```bash
npm ci
npm run build
NODE_USE_ENV_PROXY=1 npm run dev
```

访问 `http://localhost:3000`。本地 SQLite 保存在忽略提交的 `.sites-runtime/`，迁移自动按顺序应用。生产使用现有 Sites D1；首次迁移保持原样，新表由追加迁移建立。

```bash
npm test
npm run check
npm run verify:paper -- /path/to/limit-lens-paper.json
```

测试覆盖评分、六类交易动作、T+1、成本核算、交易时序、原子防重、完整导出重放与 AI 样本外验证。合成测试数据只用于验证，不写入生产。

## 自动运行与收益核验

**秒级自动交易运行在常驻服务中。Windows 用户见 [启动说明](docs/windows.md)：安装 Docker Desktop 后双击 `scripts/windows/start.cmd`，打开 `http://localhost:3000`。** 默认腾讯 `qt.gtimg.cn` HTTP 短请求默认 10 秒轮询；持久化订单进度，关闭浏览器后继续运行。午休等待，盘后自动复盘与结算；重启后继续未完成订单。容器默认只开放本机端口，登录密码只在本机 `.env`。

Sites 工作日 15:30（Asia/Shanghai）任务继续调用 `POST /api/run-daily`，用于私有网页盘后更新。Sites 单独托管没有秒级常驻执行器；其 D1 与本机 SQLite 账户独立，实时盈亏以本机页面为准。盘后只结算已记录成交，没有实时观测时不补造开盘买卖。非交易日不交易。首次结算只建立 100 万元基准，下一实际交易日起执行冻结计划。首个盘中会话开始前可自定义初始资金；六项交易费用可随时自定义，新配置随新计划冻结，历史记录按原配置核验。

其他系统可填写 `.env` 后运行 `docker compose up --build -d`；已安装 Node.js 24 时可 `npm ci && npm run build && npm start`，必须保持进程运行。`npm run dev` 仅启动开发网页，不启动后台交易循环。

“模拟交易”页面查看净值、费用、持仓、冻结计划、执行反馈和策略版本，可导出全部行情、计划、成交及权益并独立重放。详细成交假设、暂停条件、收益公式、AI 验证门槛及模块说明见 [模拟交易文档](docs/paper-trading.md)。行情异常或漏过交易日时保留账本并暂停，不补造行情或评分。

## 大模型配置

将 `.env.example` 复制为本地 `.env` 并在本机填写。生产通过 Sites 的服务端环境变量设置 `AI_API_KEY`（秘密）、`AI_BASE_URL`、`AI_MODEL`，重新部署使配置生效。不要把密钥提交 GitHub、填入前端或贴到日志。

| 服务     | AI_BASE_URL                                       | 模型                       |
| -------- | ------------------------------------------------- | -------------------------- |
| DeepSeek | https://api.deepseek.com/v1                       | deepseek-chat              |
| OpenAI   | https://api.openai.com/v1                         | 账户可用的模型             |
| 通义     | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-plus                  |
| 火山方舟 | https://ark.cn-beijing.volces.com/api/v3          | 账户可用的模型或推理接入点 |

未配置密钥时规则模拟照常运行，并明确显示 AI 未启用。AI 只读真实训练数据并提出有限参数候选；至少积累 20 日训练和 10 日独立验证后，比较扣费收益、回撤、成交数与数据覆盖。通过后才自动启用新版本，也可选择人工启用。历史计划和账本不改写，不能保证未来收益改善。

## 数据与访问

评分来自东方财富公开涨停池；次日价格、分钟行情及交易日确认来自腾讯。覆盖主板、创业板，排除 ST、科创板和连续一字新股，行业分类不等同于概念题材。评分不是上涨概率，观察收益不等同于可成交收益。模拟成交计入费用、滑点、T+1 和涨跌停约束，仍无法还原真实排队。

前端、API、领域逻辑与存储分别位于 `frontend/`、`backend/routes/`、`backend/domain/`、`backend/storage/`。生产保持现有私有访问边界，写接口检查 Origin；公开发布须另加访问授权。GitHub 源码不含生产密钥和账户数据库。
