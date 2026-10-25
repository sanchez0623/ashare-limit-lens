import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// 新增回归文件须先确认属于 V5 链路，再登记到对应分组。
const suites = {
  "V5 评分、分类与买点": [
    "model",
    "stock-class",
    "sentiment-cycle",
    "buy-point-type",
    "daily-closes",
    "eod-candidates",
    "observation-grade",
    "signal-selection",
  ],
  "V5 行情与冻结输入": [
    "market",
    "market-sources",
    "price-inputs",
    "intraday-inputs",
  ],
  "V5 执行、持仓与账本": [
    "intraday-entry",
    "trading",
    "realtime",
    "trading-runner-schedule",
    "fees",
    "execution-cost",
    "exit-signals",
    "downgrade",
    "t-quality",
    "t-quality-recovery",
    "ledger-pagination",
    "trading-cutover",
  ],
  "V5 影子观察、复盘与严格回放": [
    "entry-observation-candidates",
    "entry-observation-ledger",
    "entry-observation-progress",
    "execution-review",
    "v5-history",
    "build-artifact",
  ],
};
const files = Object.values(suites)
  .flat()
  .map((name) => `test/${name}.test.mjs`);
const registered = new Set(files);
const discovered = readdirSync(new URL("../test/", import.meta.url))
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => `test/${name}`);
const unexpected = discovered.filter((file) => !registered.has(file));
const missing = files.filter((file) => !discovered.includes(file));

if (registered.size !== files.length || unexpected.length || missing.length) {
  console.error("V5 回归清单与 test/ 不一致，请核对测试范围：", {
    unexpected,
    missing,
    duplicate: registered.size !== files.length,
  });
  process.exitCode = 1;
} else if (process.argv.length === 3 && process.argv[2] === "--list") {
  for (const [scope, names] of Object.entries(suites)) {
    console.log(`${scope}：`);
    for (const name of names) console.log(`  test/${name}.test.mjs`);
  }
  console.log(`V5 回归共 ${files.length} 个测试文件。`);
} else if (process.argv.length !== 2) {
  console.error("用法：node scripts/run-v5-regression.mjs [--list]");
  process.exitCode = 1;
} else {
  console.log(`运行 V5 回归：${files.length} 个测试文件。`);
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
}
