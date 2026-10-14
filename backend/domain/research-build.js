import { digestOf } from "./research-lineage.js";
let cached;
export function researchForwardBuildDigest() {
  if (typeof __RESEARCH_FORWARD_BUILD__ !== "undefined")
    return Promise.resolve(__RESEARCH_FORWARD_BUILD__);
  cached ??= (async () => {
    const { readFileSync } = await import("node:fs");
    return digestOf(
      [
        "backend/domain/research-build.js",
        "backend/domain/research-policy.js",
        "backend/domain/cohort-policy.js",
        "backend/domain/cohort-metrics.js",
        "backend/domain/research-statistics.js",
        "backend/domain/research-verifier.js",
        "backend/services/portfolio-runner.js",
        "backend/services/strategy-tournament.js",
        "backend/services/promotion.js",
        "backend/services/walk-forward.js",
        "backend/storage/walk-forward.js",
      ].map((path) => [
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
