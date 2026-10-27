import { digestOf } from "./research-lineage.js";
let cached;
export function marketEnvironmentBuildDigest() {
  if (typeof __MARKET_ENVIRONMENT_BUILD__ !== "undefined")
    return Promise.resolve(__MARKET_ENVIRONMENT_BUILD__);
  cached ??= (async () => {
    const { readFile } = await import("node:fs/promises");
    const paths = [
      "shared/market-environment.js",
      "shared/adaptive-risk.js",
      "shared/adaptive-risk-v2.js",
      "backend/domain/environment-report.js",
    ];
    return digestOf(
      await Promise.all(
        paths.map(async (path) => [
          path,
          (
            await readFile(new URL(`../../${path}`, import.meta.url), "utf8")
          ).replaceAll("\r\n", "\n"),
        ]),
      ),
    );
  })();
  return cached;
}
