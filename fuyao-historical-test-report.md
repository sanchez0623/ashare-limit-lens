# 同花顺金融数据 API 接口测试报告

- **测试目标**：`GET /api/a-share/prices/historical`（MCP 工具 `get_a_share_prices_historical`）
- **Base URL**：`https://fuyao.aicubes.cn`
- **文档**：<https://fuyao.aicubes.cn/docs/mcp/tools/get_a_share_prices_historical/> / <https://fuyao.aicubes.cn/docs/api-reference/prices/>
- **鉴权**：请求头 `X-api-key`（本工程 `.env` 中 `FU_YAO_API_KEY`）
- **测试时间**：2026-10-22（Asia/Shanghai）
- **原始响应存档**：`.sites-runtime/fuyao-historical-test.jsonl`

## 1. 正常取数（Happy Path）

`thscode=600519.SH&interval=1d&adjust=forward`，窗口约 1 年（`start=1760918400000` → `end=1792454400000`）：

| 项 | 结果 |
|---|---|
| `code` | `0`（success） |
| 返回 K 线数 | **242**（约等于 A 股一年交易日数 ✓） |
| 首根 K 线 | `date_ms=1760976000000` open=1407.02 close=1410.28 vol=2544267 |
| 末根 K 线 | `date_ms=1792425600000` open=1321.01 close=1331.88 |
| 收盘价区间 | 1168.63 ~ 1526.98 |
| `data.timestamp` | 1792425600000（序列最新 K 线上游有效时间） |

数据语义合理（贵州茅台价格区间符合实际）。

## 2. 复权方式对比（同窗口首根 K 线）

| adjust | 首根 open | 首根 close | 根数 |
|---|---|---|---|
| `none`（不复权） | 1459.00 | 1462.26 | 242 |
| `forward`（前复权） | 1407.02 | 1410.28 | 242 |
| `backward`（后复权） | 9722.10 | 9740.45 | 242 |

三者数量一致，价格关系 `backward > none > forward`，符合现金分红股票的复权方向预期 ✓。

## 3. 参数校验与错误码

| 测试场景 | 期望(文档) | 实际 code | 实际 message | 是否一致 |
|---|---|---|---|---|
| 缺 `thscode` | 1001 | **1001** | Missing required parameter: thscode | ✅ |
| 缺 `end` | 1001 | **1001** | Missing required parameter: end | ✅ |
| `thscode` 含逗号 | 1002 | **1002** | Invalid parameter format: thscode (only one code per request) | ✅ |
| 窗口 > 10 年 | 1003 | **1003** | Parameter value out of range: [start, end] must span at most 10 years | ✅ |
| 无 `X-api-key` | 2001 | **2003** | Missing X-api-key | ⚠️ 不符 |
| 无效 `X-api-key` | 2001 | **2003** | Invalid or revoked API key | ⚠️ 不符 |
| 非法 `adjust=quarterly` | 1003(枚举非法) | **1002** | Invalid parameter format: adjust | ⚠️ 不符 |
| 不存在标的 `999999.SH` | 3001(标的不存在) | **1002** | Unknown thscode: 999999.SH | ⚠️ 不符 |
| 裸代码 `600519` | — | **1002** | Unknown thscode: 600519 | （文档未明确，合理） |

## 4. interval 取值探测

| interval | 结果 | items | 说明 |
|---|---|---|---|
| `1d` | code=0 | 242 | 日线 ✅ |
| `1w` | code=0 | **52** | 周线 ✅ |
| `1M` / `1m` / `60` / `1h` / `5` / `30` / `D` / `W` / `M` / `2d` / `invalid` | code=1002 | 0 | "Invalid parameter format: interval" |

## 5. 结论

接口**可用且取数正确**，统一响应信封 `ApiResponse` 与 HTTP 200 行为符合文档。

发现以下**文档与实际行为不一致**，建议反馈服务方或据此修正文档：

1. **鉴权错误码**：文档约定 `X-api-key` 缺失/无效返回 `code=2001`，实际返回 `code=2003`。
2. **interval 支持范围**：文档称“当前仅支持 `1d`”，实际**额外支持 `1w`（周线）**。
3. **响应字段更丰富**：文档 `HistoricalData` 仅列 `timestamp`、`item`，实际 `data` 还回显 `thscode`、`interval`、`adjust`。
4. **非法枚举归入格式错误**：非法 `adjust` 返回 `1002`（格式错误）而非文档错误码表中的 `1003`（取值越界）。
5. **未知标的归入格式错误**：不存在/裸代码标的返回 `1002`（"Unknown thscode"）而非 `3001`（标的不存在）。

> 备注：参数校验顺序经观察约为 `thscode → interval → end/start`；缺 `start` 时若同时缺 `interval`，会先报 `interval` 缺失。
