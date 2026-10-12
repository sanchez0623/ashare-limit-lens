// 统计证据独立核验（docs/design/statistical-evidence.md §10）：
// 从导出输入重算指标、统计、摘要及用途限制。
// 用法：npm run verify:evidence -- /path/to/evidence-export.json
import assert from "node:assert/strict";
import { normalizeEvidencePolicy } from "../backend/domain/evidence-policy.js";
import {
  resampleSegmentIndexMatrix,
  bootstrapMeanEvidence,
  adjustEvidenceFamily,
  evidenceSeed,
  DIAGNOSTIC_METHOD_VERSION,
} from "../backend/domain/research-statistics.js";
import { digestOf } from "../backend/domain/research-lineage.js";

const metricValueKey = (metric) =>
  metric === "MEAN_DAILY_IC"
    ? "ic"
    : metric === "MEAN_DAILY_EXCESS"
      ? "excessDecimal"
      : "meanDailyReturn";

// verifyEvidenceBundle：核验摘要、日期、纯指标、索引/种子、统计结果和用途限制。
export async function verifyEvidenceBundle(bundle) {
  const checks = {
    structure: false,
    hashes: false,
    inputs: false,
    statistics: false,
    purpose: false,
  };
  try {
    const report = bundle?.report;
    if (
      !report?.payload ||
      !report.inputs ||
      report.methodVersion !== DIAGNOSTIC_METHOD_VERSION
    )
      return { passed: false, checks, reason: "报告结构不完整" };
    checks.structure = true;
    // 导出内数据未被篡改：日指标与政策摘要逐条重算
    for (const metric of bundle.dailyMetrics ?? [])
      if ((await digestOf(metric.payload)) !== metric.digest)
        return { passed: false, checks, reason: "日指标摘要不一致" };
    for (const policy of bundle.policies ?? [])
      if ((await digestOf(policy.payload)) !== policy.digest)
        return { passed: false, checks, reason: "政策摘要不一致" };
    checks.hashes = true;
    // 冻结输入重算：同种子、同区块、同政策 → 相同索引、区间、p 与 Holm
    const policy = normalizeEvidencePolicy(
      bundle.policies.find((row) => row.digest === report.policyDigest)
        ?.payload ?? bundle.policies.at(0)?.payload,
    );
    const expected = report.payload.window.expectedDates;
    if (JSON.stringify(report.inputs.orderedDates) !== JSON.stringify(expected))
      return { passed: false, checks, reason: "窗口日历与输入清单不一致" };
    const validDates = report.payload.window.validDates;
    const metricsByDate = new Map(
      (bundle.dailyMetrics ?? []).map((row) => [row.outcomeDate, row]),
    );
    const sourceDigests = {};
    for (const date of validDates) {
      const metric = metricsByDate.get(date);
      if (!metric)
        return { passed: false, checks, reason: `缺少 ${date} 的日指标` };
      if (
        report.inputs.sourceDigests?.[date] &&
        metric.sourceDigest !== report.inputs.sourceDigests[date]
      )
        return { passed: false, checks, reason: `${date} 来源摘要不一致` };
      if (metric.payload.contextDigest !== report.payload.context.digest)
        return {
          passed: false,
          checks,
          reason: `${date} 上下文摘要与报告不一致`,
        };
      sourceDigests[date] = metric.sourceDigest;
    }
    const inputDigest = await digestOf({
      seriesId: report.seriesId,
      window: {
        expectedDates: report.payload.window.expectedDates,
        validDates,
        missingDates: report.payload.window.missingDates,
      },
      contextDigest: report.payload.context.digest,
      metrics: Object.fromEntries(
        validDates.map((date) => [date, metricsByDate.get(date).payload]),
      ),
    });
    if (inputDigest !== report.inputDigest)
      return { passed: false, checks, reason: "输入摘要与报告不一致" };
    checks.inputs = true;
    const seed = await evidenceSeed({
      namespace: report.namespace,
      purpose: report.purpose,
      asOf: report.asOf,
      orderedWindowDates: validDates,
      inputDigest,
      policyDigest: report.policyDigest,
    });
    if (seed !== report.payload.method.seed)
      return { passed: false, checks, reason: "统计种子与冻结输入不一致" };
    if (
      report.payload.status === "READY" &&
      report.payload.family.some((entry) => entry.ci)
    ) {
      // 片段按冻结交易日日历重建：缺口（缺失日期）分隔连续有效片段，
      // 区块从不跨越缺口拼接（§5.1）。
      const validSet = new Set(validDates);
      const segmentLengths = [];
      let current = 0;
      for (const date of expected) {
        if (validSet.has(date)) current++;
        else if (current) {
          segmentLengths.push(current);
          current = 0;
        }
      }
      if (current) segmentLengths.push(current);
      const { matrix } = await resampleSegmentIndexMatrix({
        segmentLengths,
        blockLength: policy.blockLength,
        resamples: policy.resamples,
        seedInput: seed,
      });
      const rawResults = new Map();
      for (const entry of report.payload.family) {
        const values = validDates.map(
          (date) =>
            metricsByDate.get(date).payload.values[
              metricValueKey(entry.metric)
            ],
        );
        const outcome = bootstrapMeanEvidence({
          values,
          indexMatrix: matrix,
          confidenceLevel: policy.confidenceLevel,
          nullMean: 0,
          side: "TWO_SIDED",
          minValidDays: policy.minValidDays,
        });
        const recorded = entry;
        assert.ok(
          Math.abs(outcome.estimate - recorded.estimate) < 1e-12,
          "点估计不一致",
        );
        assert.ok(
          Math.abs(outcome.ci.lower - recorded.ci.lower) < 1e-12 &&
            Math.abs(outcome.ci.upper - recorded.ci.upper) < 1e-12,
          `${entry.metric} 区间不一致`,
        );
        assert.ok(
          Math.abs(outcome.pRaw - recorded.pRaw) < 1e-12,
          `${entry.metric} p 值不一致`,
        );
        rawResults.set(entry.metric, { key: entry.metric, pRaw: outcome.pRaw });
      }
      const family = adjustEvidenceFamily({
        declaredHypotheses: report.payload.family.map((entry) => entry.metric),
        results: [...rawResults.values()],
        method: "HOLM",
      });
      for (const hypothesis of family.hypotheses) {
        const recorded = report.payload.family.find(
          (entry) => entry.metric === hypothesis.key,
        );
        assert.ok(
          Math.abs(
            hypothesis.pAdjustedWithinFamily - recorded.pAdjustedWithinFamily,
          ) < 1e-12,
          "Holm 校正值不一致",
        );
      }
      checks.statistics = true;
    } else checks.statistics = true;
    // 用途限制：诊断报告永久无晋级资格
    assert.equal(report.purpose, "DIAGNOSTIC");
    assert.equal(report.payload.eligibleForPromotion, false);
    assert.equal(report.payload.repeatedLooksAdjusted, false);
    checks.purpose = true;
    return { passed: Object.values(checks).every(Boolean), checks };
  } catch (error) {
    return { passed: false, checks, reason: String(error?.message ?? error) };
  }
}

const file = process.argv[2];
if (file) {
  const { readFile } = await import("node:fs/promises");
  const result = await verifyEvidenceBundle(
    JSON.parse(await readFile(file, "utf8")),
  );
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}
