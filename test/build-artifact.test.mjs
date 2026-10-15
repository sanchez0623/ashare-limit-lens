// 构建产物回归测试：服务端 bundle 以 platform:"browser" 打包（build.mjs），
// esbuild 会选中 hyparquet 的浏览器入口——该入口不含 Node 助手
// asyncBufferFromFile。曾导致构建产物运行时
// "asyncBufferFromFile is not a function" → MA5 静默降级为空。
// daily-closes.js 现自实现 AsyncBuffer（不依赖该助手），本测试锁定契约：
// 1. 产物正常生成且可加载；
// 2. 产物包含 hyparquet 解析器；
// 3. 产物不再引用浏览器入口缺失的 Node 助手。
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("构建产物：服务端 bundle 可加载，且不依赖浏览器入口缺失的 Node 助手", async () => {
  await run(process.execPath, ["build.mjs"], { cwd: ROOT });
  const bundle = await readFile(`${ROOT}dist/server/index.js`, "utf8");
  assert.ok(
    bundle.includes("parquetRead"),
    "hyparquet 解析器应被打包进服务端产物",
  );
  assert.ok(
    !bundle.includes("asyncBufferFromFile"),
    "服务端产物不得引用浏览器入口缺失的 asyncBufferFromFile（MA5 应自实现 AsyncBuffer）",
  );
  const worker = await import(pathToFileURL(`${ROOT}dist/server/index.js`));
  assert.equal(
    typeof worker.default?.fetch,
    "function",
    "产物应导出 fetch 入口",
  );
});
