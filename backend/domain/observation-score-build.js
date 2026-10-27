import { digestOf } from "./research-lineage.js";
let cached;
export function observationScoreBuildDigest() {
  if (typeof __OBSERVATION_SCORE_BUILD__ !== "undefined")
    return Promise.resolve(__OBSERVATION_SCORE_BUILD__);
  cached ??= (async () => {
    const { readFile } = await import("node:fs/promises");
    const paths = [
      "shared/observation-scoring.js",
      "shared/adaptive-risk.js",
      "shared/adaptive-risk-v1.js",
      "shared/adaptive-risk-v2.js",
      "shared/market-environment.js",
      "backend/domain/score-calibration.js",
    ];
    const sources = await Promise.all(
      paths.map(async (path) => [
        path,
        (
          await readFile(new URL(`../../${path}`, import.meta.url), "utf8")
        ).replaceAll("\r\n", "\n"),
      ]),
    );
    return digestOf(sources);
  })();
  return cached;
}
