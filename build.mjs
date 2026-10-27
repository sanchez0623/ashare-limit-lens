import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { executionEngineBuildDigest } from "./backend/domain/execution-build.js";
import { observationScoreBuildDigest } from "./backend/domain/observation-score-build.js";
import { marketEnvironmentBuildDigest } from "./backend/domain/market-environment-build.js";
await mkdir(".sites-runtime", { recursive: true });
await mkdir("dist/client/assets", { recursive: true });
const client = await build({
  entryPoints: ["frontend/app.js"],
  bundle: true,
  format: "esm",
  target: "es2022",
  write: false,
  minify: true,
});
const js = client.outputFiles[0].text;
const css = (
  await Promise.all(
    ["frontend/styles.css", "frontend/observatory.css"].map((path) =>
      readFile(path, "utf8"),
    ),
  )
).join("\n");
const html = await readFile("frontend/index.html", "utf8");
const assets = {
  "/": { body: html, type: "text/html; charset=utf-8" },
  "/assets/app.js": { body: js, type: "text/javascript; charset=utf-8" },
  "/assets/styles.css": { body: css, type: "text/css; charset=utf-8" },
};
await Promise.all([
  writeFile("dist/client/index.html", html),
  writeFile("dist/client/assets/app.js", js),
  writeFile("dist/client/assets/styles.css", css),
  writeFile(
    ".sites-runtime/assets.js",
    `export const ASSETS = ${JSON.stringify(assets)};`,
  ),
]);
await build({
  entryPoints: ["backend/worker.js"],
  define: {
    __MARKET_ENVIRONMENT_BUILD__: JSON.stringify(
      await marketEnvironmentBuildDigest(),
    ),
    __OBSERVATION_SCORE_BUILD__: JSON.stringify(
      await observationScoreBuildDigest(),
    ),
    __EXECUTION_ENGINE_BUILD__: JSON.stringify(
      await executionEngineBuildDigest(),
    ),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  external: [
    "node:sqlite",
    "node:fs",
    "node:path",
    "node:url",
    "node:fs/promises",
  ],
  target: "es2022",
  outfile: "dist/server/index.js",
});
console.log("Built separate browser assets and Node-compatible server bundle");
