// 统计方法独立模拟验收（docs/design/statistical-evidence.md §10）：
// npm run verify:evidence-simulation
// 固定公开种子、 IID/AR(1)/波动聚集/正效应、长度 20/60/120，各不少于
// 1000 条模拟序列；验收阈值：95% 区间对真实效应的经验覆盖至少 90%
// （零效应情景真实均值为 0，正效应情景为已知效应 0.002），零效应拒绝率
// （I 类错误）至多 7%（双侧 raw p<0.05）；正效应情景的拒绝率按检验力
// 记录，不做 I 类错误验收。同时给出 Monte Carlo 二项区间。
// 本脚本只验证诊断方法（DIAGNOSTIC_BASIC_BLOCK_V1），不代表正式极小 α。
import {
  resampleSegmentIndexMatrix,
  bootstrapMeanEvidence,
  evidenceSeed,
} from "../backend/domain/research-statistics.js";

const SERIES_PER_CONFIG = 1000;
const RESAMPLES = 1000;
const CONFIDENCE = 0.95;
const BLOCK_LENGTH = 5;
const ALPHA = 0.05;
const GLOBAL_SEED = "evidence-simulation-v1";

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedToUint32(hex) {
  return Number(BigInt(`0x${hex.slice(0, 8)}`) & 0xffffffffn) >>> 0;
}
function gaussian(random) {
  const u = Math.max(random(), 1e-12),
    v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const SCENARIOS = {
  IID_NULL: {
    label: "IID 零效应",
    trueMean: 0,
    generate: (random, n) =>
      Array.from({ length: n }, () => gaussian(random) * 0.01),
  },
  AR1_NULL: {
    label: "AR(1) φ=0.3 零效应",
    trueMean: 0,
    generate: (random, n) => {
      const out = [];
      let last = 0;
      for (let i = 0; i < n; i++) {
        last = 0.3 * last + gaussian(random) * 0.01;
        out.push(last);
      }
      return out;
    },
  },
  VOL_CLUSTER_NULL: {
    label: "波动聚集零效应",
    trueMean: 0,
    generate: (random, n) => {
      const out = [];
      let sigma = 0.01;
      for (let i = 0; i < n; i++) {
        const shock = gaussian(random) * sigma;
        out.push(shock);
        sigma = Math.min(
          0.03,
          Math.max(
            0.003,
            Math.sqrt(0.7 * sigma ** 2 + 0.3 * shock ** 2 + 4e-6),
          ),
        );
      }
      return out;
    },
  },
  IID_POSITIVE: {
    label: "IID 正效应 0.2σ",
    // 覆盖率目标必须对准真实效应 0.002，而不是零（P2-2）。
    trueMean: 0.002,
    generate: (random, n) =>
      Array.from({ length: n }, () => gaussian(random) * 0.01 + 0.002),
  },
};
const LENGTHS = [20, 60, 120];

function binomialInterval(proportion, count, level = 1.96) {
  const se = Math.sqrt((proportion * (1 - proportion)) / Math.max(1, count));
  return [proportion - level * se, proportion + level * se];
}

async function runConfig(scenarioKey, length) {
  const scenario = SCENARIOS[scenarioKey];
  const seedRandom = mulberry32(
    seedToUint32(
      await evidenceSeed({
        namespace: "simulation",
        purpose: "DIAGNOSTIC",
        asOf: GLOBAL_SEED,
        orderedWindowDates: [scenarioKey, String(length)],
        inputDigest: "simulation",
        policyDigest: "simulation",
      }),
    ),
  );
  let covered = 0;
  let rejected = 0;
  let estimable = 0;
  for (let s = 0; s < SERIES_PER_CONFIG; s++) {
    const values = scenario.generate(seedRandom, length);
    const seed = await evidenceSeed({
      namespace: "simulation",
      purpose: "DIAGNOSTIC",
      asOf: GLOBAL_SEED,
      orderedWindowDates: [scenarioKey, String(length), String(s)],
      inputDigest: "simulation",
      policyDigest: "simulation",
    });
    const { matrix } = await resampleSegmentIndexMatrix({
      segmentLengths: [length],
      blockLength: BLOCK_LENGTH,
      resamples: RESAMPLES,
      seedInput: seed,
    });
    const outcome = bootstrapMeanEvidence({
      values,
      indexMatrix: matrix,
      confidenceLevel: CONFIDENCE,
      nullMean: 0,
      side: "TWO_SIDED",
    });
    if (outcome.status !== "READY") continue;
    estimable++;
    // 覆盖率 = 区间包含真实效应的比例（P2-2）：零效应为 0，
    // 正效应为已知效应 0.002，不能一律对零判定。
    if (
      outcome.ci.lower <= scenario.trueMean &&
      outcome.ci.upper >= scenario.trueMean
    )
      covered++;
    if (outcome.pRaw < ALPHA) rejected++;
  }
  const coverage = {
    value: covered / estimable,
    low: binomialInterval(covered / estimable, estimable)[0],
    high: binomialInterval(covered / estimable, estimable)[1],
  };
  // 零效应情景的拒绝率是 I 类错误；正效应情景的拒绝率是检验力（P2-2）。
  const isNull = scenario.trueMean === 0;
  const rejection = {
    role: isNull ? "TYPE_I_ERROR" : "POWER",
    value: rejected / estimable,
    low: binomialInterval(rejected / estimable, estimable)[0],
    high: binomialInterval(rejected / estimable, estimable)[1],
  };
  return {
    scenario: scenarioKey,
    label: scenario.label,
    length,
    trueMean: scenario.trueMean,
    estimable,
    coverage,
    rejection,
  };
}

const results = [];
for (const scenarioKey of Object.keys(SCENARIOS))
  for (const length of LENGTHS)
    results.push(await runConfig(scenarioKey, length));

const failures = [];
for (const row of results) {
  const isNull = row.rejection.role === "TYPE_I_ERROR";
  if (row.coverage.value < 0.9)
    failures.push(
      `${row.scenario} h${row.length} 对真实效应 ${row.trueMean} 的覆盖率 ${row.coverage.value.toFixed(3)} 低于 0.90`,
    );
  if (isNull && row.rejection.value > 0.07)
    failures.push(
      `${row.scenario} h${row.length} 零效应拒绝率 ${row.rejection.value.toFixed(3)} 超过 0.07`,
    );
}
// 如实输出全部情景：未达阈值者列入 limitations，产品层降为受限探索展示
// （§10 兜底条款），不通过挑种子、换区块长度或隐藏失败情景制造“验收通过”。
console.log(
  JSON.stringify(
    {
      method: "DIAGNOSTIC_BASIC_BLOCK_V1",
      globalSeed: GLOBAL_SEED,
      seriesPerConfig: SERIES_PER_CONFIG,
      resamples: RESAMPLES,
      blockLength: BLOCK_LENGTH,
      thresholds: { minCoverage: 0.9, maxTypeI: 0.07 },
      // 只要存在未达标配置，passed 即 false：方法在该窗口/场景降为受限探索。
      passed: failures.length === 0,
      limitations: failures,
      qualifiedHorizons: [
        ...new Set(
          results
            .filter(
              (row) =>
                row.rejection.role === "TYPE_I_ERROR" &&
                row.coverage.value >= 0.9 &&
                row.rejection.value <= 0.07,
            )
            .map((row) => row.length),
        ),
      ],
      results: results.map((row) => ({
        scenario: row.scenario,
        length: row.length,
        trueMean: row.trueMean,
        estimable: row.estimable,
        coverage: {
          value: Number(row.coverage.value.toFixed(4)),
          ci95: [
            Number(row.coverage.low.toFixed(4)),
            Number(row.coverage.high.toFixed(4)),
          ],
        },
        rejection: {
          role: row.rejection.role,
          value: Number(row.rejection.value.toFixed(4)),
          ci95: [
            Number(row.rejection.low.toFixed(4)),
            Number(row.rejection.high.toFixed(4)),
          ],
        },
      })),
    },
    null,
    2,
  ),
);
process.exitCode = 0;
