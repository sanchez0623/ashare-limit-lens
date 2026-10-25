import { digestOf } from "./research-lineage.js";

// 构建时按实际执行源码生成；源码运行与离线 verifier 使用同一文件清单。
// 仅执行相关文件影响指纹，文档或其他页面变更不会改变冻结窗口。
const files = [
  "shared/observation-schedule.js",
  "shared/dragon-risk-config.js",
  "backend/domain/dragon-risk.js",
  "backend/domain/dragon-self-check.js",
  "backend/storage/dragon-risk.js",
  "backend/services/dragon-risk.js",
  "backend/services/dragon-research.js",
  "backend/services/research-cancellation.js",
  "backend/services/archived-backtest.js",
  "backend/services/v5-reconstruction.js",
  "backend/domain/trading.js",
  "backend/domain/realtime.js",
  "backend/domain/intraday-entry.js",
  "backend/services/intraday-inputs.js",
  "backend/services/entry-observation.js",
  "backend/services/price-history.js",
  "backend/services/price-supplement.js",
  "backend/domain/execution-cost.js",
  "backend/domain/validation.js",
  "backend/domain/execution-stress.js",
  "backend/domain/execution-build.js",
  "backend/domain/historical-execution.js",
  "backend/domain/historical-input.js",
  "backend/domain/signal-selection.js",
  "backend/domain/strategy-program.js",
  "backend/domain/research-lineage.js",
  // 做T质量追踪（方案 7）：停手与胜率档位规则直接收紧计划的做T闸门，
  // 必须纳入指纹防研究期间规则漂移。
  "backend/domain/t-quality.js",
  // 评分与股票分类（方案 3）：PRESETS 权重与 CLASS_WEIGHT_PRESETS 路由
  // 直接决定候选评分与候选池，必须纳入指纹防规则漂移。
  "shared/scoring.js",
  // V5 的候选构造与买点资格会影响实际建仓，冻结窗口须绑定同一实现。
  "shared/buy-point-type.js",
  "backend/services/eod-candidates.js",
  "backend/services/daily-closes.js",
  "shared/stock-class.js",
  "shared/execution-cost.js",
  "shared/exit-signals.js",
  // 降级检测器（方案 6）：降级链与 CLASS_MANAGEMENT 系数直接改变计划
  // 与保护单的执行语义，必须纳入指纹防研究期间规则漂移。
  "shared/downgrade.js",
  "shared/fees.js",
  "shared/risk-limits.js",
  "shared/strategy-params.js",
  "shared/strategy-program.js",
];
let cached;
export function executionEngineBuildDigest() {
  if (typeof __EXECUTION_ENGINE_BUILD__ !== "undefined")
    return Promise.resolve(__EXECUTION_ENGINE_BUILD__);
  cached ??= (async () => {
    const { readFileSync } = await import("node:fs");
    return digestOf(
      files.map((path) => [
        path,
        readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(
          /\r\n/g,
          "\n",
        ),
      ]),
    );
  })();
  return cached;
}
