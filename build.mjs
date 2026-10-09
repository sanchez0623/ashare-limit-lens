import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
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
const css = await readFile("frontend/styles.css", "utf8");
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
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/server/index.js",
});
console.log("Built separate browser assets and Cloudflare Worker");
