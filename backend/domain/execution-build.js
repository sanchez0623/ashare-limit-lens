import { digestOf } from "./research-lineage.js";

// 构建时按实际执行源码生成；源码运行与离线 verifier 使用同一文件清单。
// 仅执行相关文件影响指纹，文档或其他页面变更不会改变冻结窗口。
const files = [
  "backend/domain/trading.js",
  "backend/domain/realtime.js",
  "backend/domain/execution-cost.js",
  "backend/domain/validation.js",
  "backend/domain/execution-stress.js",
  "backend/domain/execution-build.js",
  "backend/domain/historical-execution.js",
  "backend/domain/historical-input.js",
  "backend/domain/signal-selection.js",
  "backend/domain/strategy-program.js",
  "backend/domain/research-lineage.js",
  "shared/execution-cost.js",
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
