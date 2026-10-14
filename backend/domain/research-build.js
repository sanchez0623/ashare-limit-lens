import { digestOf } from "./research-lineage.js";
// 30e1a2c：本次仅修复摘要/原子守卫/审计存储，不改变该版本的经济与统计规则。
// 旧窗口仍须通过当前完整重放与审计；任意其他源码指纹继续拒绝。
export const LEGACY_FORWARD_BUILD =
  "6bc2075feac2d09f371ab2a405afc93e98803d1184bce6f94bea2ab0fe526b02";
export const isLegacyForwardBuild = (value) => value === LEGACY_FORWARD_BUILD;
export async function researchForwardBuildMatches(value) {
  return (
    value === (await researchForwardBuildDigest()) ||
    isLegacyForwardBuild(value)
  );
}
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
        "backend/domain/research-samples.js",
        "backend/domain/research-switches.js",
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
