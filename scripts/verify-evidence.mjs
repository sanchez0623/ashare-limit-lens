// 统计证据独立核验（docs/design/statistical-evidence.md §10）：
// 从导出输入重算指标、统计、摘要及用途限制。
// 核验覆盖（P1-6）：报告与 manifest 摘要、方法元数据、窗口覆盖、
// 全部族成员（含合法退化为 null 区间的组合）、整体状态与方向一致性、
// 用途限制；不再只核验 READY 且带区间的报告，也不拒绝合法退化组合。
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

const fail = (checks, reason) => ({ passed: false, checks, reason });

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
      report.methodVersion !== DIAGNOSTIC_METHOD_VERSION ||
      report.payload.method?.version !== DIAGNOSTIC_METHOD_VERSION
    )
      return fail(checks, "报告结构不完整");
    checks.structure = true;
    // 导出内数据未被篡改：日指标、政策与报告 payload 摘要逐条重算。
    // 报告 payload 摘要覆盖 status/direction/tags 等全部字段（P1-6）。
    if ((await digestOf(report.payload)) !== report.digest)
      return fail(checks, "报告摘要不一致");
    for (const metric of bundle.dailyMetrics ?? [])
      if ((await digestOf(metric.payload)) !== metric.digest)
        return fail(checks, "日指标摘要不一致");
    for (const policy of bundle.policies ?? [])
      if ((await digestOf(policy.payload)) !== policy.digest)
        return fail(checks, "政策摘要不一致");
    // 输入清单自身完整性：manifest 摘要覆盖冻结的每日指标（P1-5/P1-6）。
    // contextDigest 未单独落列：发布时 inputs.contextDigest 与
    // payload.context.digest 恒为同一值，核验按 payload 重建。
    const manifest = {
      orderedDates: report.inputs.orderedDates,
      sourceRefs: report.inputs.sourceRefs,
      sourceDigests: report.inputs.sourceDigests,
      contextDigest: report.payload.context.digest,
      // 旧版导出无冻结指标字段：按旧口径重建 manifest 摘要。
      ...(Array.isArray(report.inputs.metrics)
        ? { metrics: report.inputs.metrics }
        : {}),
    };
    if ((await digestOf(manifest)) !== report.inputs.manifestDigest)
      return fail(checks, "输入清单摘要不一致");
    checks.hashes = true;
    // 政策必须按报告的 policyDigest 找回；默认政策（未入库）按摘要回退。
    let policy;
    const policyRow = (bundle.policies ?? []).find(
      (row) => row.digest === report.policyDigest,
    );
    if (policyRow) policy = normalizeEvidencePolicy(policyRow.payload);
    else {
      const fallback = normalizeEvidencePolicy(undefined);
      if ((await digestOf(fallback)) !== report.policyDigest)
        return fail(checks, "导出缺少与报告政策摘要一致的政策");
      policy = fallback;
    }
    // 冻结输入重算：同种子、同区块、同政策 → 相同索引、区间、p 与 Holm
    const expected = report.payload.window.expectedDates;
    if (JSON.stringify(report.inputs.orderedDates) !== JSON.stringify(expected))
      return fail(checks, "窗口日历与输入清单不一致");
    const validDates = report.payload.window.validDates;
    const metricsByDate = new Map(
      (bundle.dailyMetrics ?? []).map((row) => [row.outcomeDate, row]),
    );
    const sourceDigests = {};
    for (const date of validDates) {
      const metric = metricsByDate.get(date);
      if (!metric) return fail(checks, `缺少 ${date} 的日指标`);
      if (
        report.inputs.sourceDigests?.[date] &&
        metric.sourceDigest !== report.inputs.sourceDigests[date]
      )
        return fail(checks, `${date} 来源摘要不一致`);
      if (metric.payload.contextDigest !== report.payload.context.digest)
        return fail(checks, `${date} 上下文摘要与报告不一致`);
      sourceDigests[date] = metric.sourceDigest;
    }
    // 冻结清单与有效日期一一对应（P1-6）。
    const manifestDates = (report.inputs.metrics ?? [])
      .map((row) => row.outcomeDate)
      .sort();
    if (
      JSON.stringify(manifestDates) !== JSON.stringify([...validDates].sort())
    )
      return fail(checks, "冻结输入指标与窗口有效日期不一致");
    // 窗口划分与覆盖率如实（P1-3/P1-6）：有效/缺失/质量剔除互斥且并集
    // 等于冻结日历，覆盖率等于有效占比。
    const missingDates = report.payload.window.missingDates ?? [];
    const excludedDates = report.payload.window.excludedDates ?? [];
    const partition = [...validDates, ...missingDates, ...excludedDates].sort();
    if (JSON.stringify(partition) !== JSON.stringify([...expected].sort()))
      return fail(checks, "窗口日期划分与冻结日历不一致");
    const expectedCoverage = validDates.length / expected.length;
    if (
      Math.abs((report.payload.window.coverage ?? 0) - expectedCoverage) > 1e-9
    )
      return fail(checks, "窗口覆盖率与有效日期不一致");
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
      return fail(checks, "输入摘要与报告不一致");
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
      return fail(checks, "统计种子与冻结输入不一致");
    // 方法元数据一致性（P1-6）：区块长度与重采样次数必须与政策一致。
    if (report.payload.method.blockLength !== policy.blockLength)
      return fail(checks, "报告区块长度与政策不一致");
    if (report.payload.method.resamples !== policy.resamples)
      return fail(checks, "报告重采样次数与政策不一致");
    if (!validDates.length) {
      // 无有效日指标：只允许样本不足/不完整状态，不得给出可结论状态。
      if (
        !["PENDING", "INSUFFICIENT_SAMPLE", "INCOMPLETE_DATA"].includes(
          report.payload.status,
        )
      )
        return fail(checks, "无有效日指标时不应输出可结论状态");
    } else {
      // 片段按冻结交易日日历重建：缺口（缺失与质量剔除日期）分隔连续
      // 有效片段，区块从不跨越缺口拼接（§5.1）。
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
      if (!report.payload.family?.length) {
        if (
          !["PENDING", "INSUFFICIENT_SAMPLE", "INCOMPLETE_DATA"].includes(
            report.payload.status,
          )
        )
          return fail(checks, "无检验结果的报告不应输出可结论状态");
      } else if (!matrix) {
        if (report.payload.status !== "INCOMPLETE_DATA")
          return fail(checks, "片段短于区块长度时报告应标注 INCOMPLETE_DATA");
      } else {
        // 全量重算全部族成员（P1-6）：不再跳过非 READY 报告，也不再
        // 假设所有成员都有区间——合法退化组合（区间为 null）按重算
        // 状态逐项核对。
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
          const degenerate =
            outcome.status === "DEGENERATE" ||
            (outcome.degenerateResampleRatio ?? 0) >
              policy.maxDegenerateResampleRatio;
          const estimable = outcome.status === "READY" && !degenerate;
          if (estimable) {
            if (!entry.ci)
              return fail(checks, `${entry.metric} 缺少应输出的区间`);
            assert.ok(
              Math.abs(outcome.estimate - entry.estimate) < 1e-12,
              "点估计不一致",
            );
            assert.ok(
              Math.abs(outcome.ci.lower - entry.ci.lower) < 1e-12 &&
                Math.abs(outcome.ci.upper - entry.ci.upper) < 1e-12,
              `${entry.metric} 区间不一致`,
            );
            assert.ok(
              Math.abs(outcome.pRaw - entry.pRaw) < 1e-12,
              `${entry.metric} p 值不一致`,
            );
          } else {
            const expectedStatus = degenerate ? "DEGENERATE" : outcome.status;
            if (entry.ci) return fail(checks, `${entry.metric} 不应携带区间`);
            if (entry.pRaw != null)
              return fail(checks, `${entry.metric} 不可估计时不应携带 p 值`);
            if (entry.status !== expectedStatus)
              return fail(checks, `${entry.metric} 状态与重算不一致`);
            if (outcome.estimate != null) {
              assert.ok(
                entry.estimate != null &&
                  Math.abs(outcome.estimate - entry.estimate) < 1e-12,
                "点估计不一致",
              );
            }
          }
          rawResults.set(entry.metric, {
            key: entry.metric,
            pRaw: estimable ? outcome.pRaw : null,
            reason: estimable ? null : (entry.reasons?.at(0) ?? "检验不可估计"),
          });
        }
        const family = adjustEvidenceFamily({
          declaredHypotheses: report.payload.family.map(
            (entry) => entry.metric,
          ),
          results: [...rawResults.values()],
          method: "HOLM",
        });
        for (const hypothesis of family.hypotheses) {
          const recorded = report.payload.family.find(
            (entry) => entry.metric === hypothesis.key,
          );
          if (!hypothesis.estimable) {
            if (recorded.pAdjustedWithinFamily != null)
              return fail(checks, "不可估计检验不应有校正 p 值");
            continue;
          }
          assert.ok(
            Math.abs(
              hypothesis.pAdjustedWithinFamily - recorded.pAdjustedWithinFamily,
            ) < 1e-12,
            "Holm 校正值不一致",
          );
        }
        // 整体状态与方向一致性（P1-6）。
        const anyReady = report.payload.family.some((entry) => entry.ci);
        const expectedStatus = report.payload.context?.mixedContext
          ? anyReady
            ? "MIXED_CONTEXT"
            : "INSUFFICIENT_SAMPLE"
          : anyReady
            ? "READY"
            : report.payload.family[0].status;
        if (report.payload.status !== expectedStatus)
          return fail(checks, "报告整体状态与重算不一致");
        for (const entry of report.payload.family) {
          const expectedDirection = !entry.ci
            ? null
            : entry.ci.lower > 0
              ? "POSITIVE"
              : entry.ci.upper < 0
                ? "NEGATIVE"
                : "INCLUDES_ZERO";
          if (entry.direction !== expectedDirection)
            return fail(checks, `${entry.metric} 方向与区间不一致`);
        }
      }
    }
    checks.statistics = true;
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
