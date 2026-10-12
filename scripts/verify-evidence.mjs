// 统计证据独立核验（docs/design/statistical-evidence.md §10）：
// 从导出输入重算指标、统计、摘要及用途限制。
// 核验覆盖（P1-6）：报告与 manifest 摘要、方法元数据、窗口覆盖、
// 全部族成员（含合法退化为 null 区间的组合）、整体状态与方向一致性、
// 用途限制；不再只核验 READY 且带区间的报告，也不拒绝合法退化组合。
// 用法：npm run verify:evidence -- /path/to/evidence-export.json
import assert from "node:assert/strict";
import {
  normalizeEvidencePolicy,
  SERIES_METRIC_FAMILIES,
  REVIEW_EVIDENCE_SERIES,
  ACCOUNT_EVIDENCE_SERIES,
  METHOD_QUALIFIED_HORIZONS,
  SECTOR_SECONDARY_METRIC,
  SECTOR_AGGREGATE_METRIC,
  SECTOR_MIN_VALID_STOCKS,
  MIN_SECTOR_COUNT,
} from "../backend/domain/evidence-policy.js";
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
      : metric === "SECTOR_RETURN_IC"
        ? "sectorReturnIc"
        : "meanDailyReturn";

const metricUnit = (metric) =>
  metric === "MEAN_DAILY_IC" || metric === "SECTOR_RETURN_IC"
    ? "CORRELATION"
    : metric === "MEAN_DAILY_EXCESS" ||
        metric === "MEAN_DAILY_RETURN" ||
        metric === "MEAN_SECTOR_EXCESS"
      ? "DECIMAL_RETURN"
      : "UNKNOWN";

const fail = (checks, reason) => ({ passed: false, checks, reason });

// 板块次要检验族的独立重算（§3.2/§6.4 批次 C）：从冻结输入重建板块宇宙、
// 逐板块向量与 Holm 校正。此处独立实现，不 import 发布端函数（§10：
// 不能只用生产函数生成核验答案）。
function expectedSecondaryFamilies({
  policy,
  validDates,
  metricsByDate,
  matrix,
}) {
  const payloads = validDates.map((date) => metricsByDate.get(date).payload);
  const minSectorStocks = Math.min(
    SECTOR_MIN_VALID_STOCKS,
    policy.minValidStocks,
  );
  const universeDays = new Map();
  for (const payload of payloads)
    for (const sector of payload.sectors ?? [])
      if (
        Number.isFinite(sector.excessDecimal) &&
        sector.validStocks >= minSectorStocks
      )
        universeDays.set(sector.name, (universeDays.get(sector.name) ?? 0) + 1);
  const threshold = Math.ceil(validDates.length * 0.5);
  const declared = [...universeDays.entries()]
    .filter(([, days]) => days >= threshold)
    .map(([name]) => name)
    .sort();
  const sectorValues = new Map(
    declared.map((name) => [
      name,
      payloads.map((payload) => {
        const sector = payload.sectors?.find((item) => item.name === name);
        const value = sector?.excessDecimal;
        return Number.isFinite(value) ? value : null;
      }),
    ]),
  );
  const sectorOutcomes = new Map();
  const rawResults = [];
  for (const name of declared) {
    const values = sectorValues.get(name);
    const complete = values.every((value) => value !== null);
    const outcome = complete
      ? bootstrapMeanEvidence({
          values,
          indexMatrix: matrix,
          confidenceLevel: policy.confidenceLevel,
          nullMean: 0,
          side: "TWO_SIDED",
          minValidDays: policy.minValidDays,
        })
      : {
          status: "INSUFFICIENT_SAMPLE",
          estimate: null,
          ci: null,
          pRaw: null,
          standardError: null,
          reasons: ["窗口内板块序列不完整（板块成员逐日变化），不输出区间"],
          validDays: values.filter((value) => value !== null).length,
        };
    sectorOutcomes.set(name, { outcome, values });
    rawResults.push({
      key: name,
      pRaw: outcome.pRaw,
      reason: outcome.reasons?.at(0) ?? null,
    });
  }
  // 族为空时没有可校正的假设：Holm 调用要求非空族（§6.4），直接空输出。
  const excessFamily = declared.length
    ? adjustEvidenceFamily({
        declaredHypotheses: declared,
        results: rawResults,
        method: "HOLM",
      })
    : { hypotheses: [] };
  const adjustedByKey = new Map(
    excessFamily.hypotheses.map((row) => [row.key, row]),
  );
  const excessEntries = declared.map((name) => {
    const { outcome, values } = sectorOutcomes.get(name);
    const adjusted = adjustedByKey.get(name);
    const degenerate =
      outcome.status === "DEGENERATE" ||
      (outcome.degenerateResampleRatio ?? 0) >
        policy.maxDegenerateResampleRatio;
    const ci =
      outcome.status === "READY" && !degenerate
        ? { ...outcome.ci, scope: "POINTWISE" }
        : null;
    return {
      metric: SECTOR_SECONDARY_METRIC,
      sector: name,
      unit: metricUnit(SECTOR_SECONDARY_METRIC),
      status: degenerate ? "DEGENERATE" : outcome.status,
      estimate: outcome.estimate ?? null,
      ci,
      pRaw: outcome.pRaw ?? null,
      pAdjustedWithinFamily: adjusted.pAdjustedWithinFamily,
      standardError: outcome.standardError ?? null,
      validDays: values.filter((value) => value !== null).length,
      direction:
        degenerate || outcome.status !== "READY" ? null : directionOf(ci),
    };
  });
  // 板块聚合秩相关（辅助视图）。
  const icValues = payloads.map((payload) => payload.values?.sectorReturnIc);
  const icComplete = icValues.every((value) => Number.isFinite(value));
  const icOutcome = icComplete
    ? bootstrapMeanEvidence({
        values: icValues,
        indexMatrix: matrix,
        confidenceLevel: policy.confidenceLevel,
        nullMean: 0,
        side: "TWO_SIDED",
        minValidDays: policy.minValidDays,
      })
    : {
        status: "INSUFFICIENT_SAMPLE",
        estimate: null,
        ci: null,
        pRaw: null,
        standardError: null,
        validDays: icValues.filter((value) => Number.isFinite(value)).length,
      };
  const icDegenerate =
    icOutcome.status === "DEGENERATE" ||
    (icOutcome.degenerateResampleRatio ?? 0) >
      policy.maxDegenerateResampleRatio;
  const icCi =
    icOutcome.status === "READY" && !icDegenerate
      ? { ...icOutcome.ci, scope: "POINTWISE" }
      : null;
  const aggregateEntries = [
    {
      metric: SECTOR_AGGREGATE_METRIC,
      unit: metricUnit(SECTOR_AGGREGATE_METRIC),
      status: icDegenerate ? "DEGENERATE" : icOutcome.status,
      estimate: icOutcome.estimate ?? null,
      ci: icCi,
      pRaw: icOutcome.pRaw ?? null,
      pAdjustedWithinFamily: icOutcome.pRaw ?? null,
      standardError: icOutcome.standardError ?? null,
      validDays: icOutcome.validDays ?? validDates.length,
      direction:
        icDegenerate || icOutcome.status !== "READY" ? null : directionOf(icCi),
    },
  ];
  return [
    {
      name: "SECTOR_SECONDARY_EXCESS",
      role: "SECONDARY",
      familySize: declared.length,
      entries: excessEntries,
      outcomes: sectorOutcomes,
    },
    {
      name: "SECTOR_AGGREGATE_IC",
      role: "SECONDARY",
      familySize: 1,
      entries: aggregateEntries,
    },
  ];
}

function directionOf(ci) {
  if (!ci) return null;
  if (ci.lower > 0) return "POSITIVE";
  if (ci.upper < 0) return "NEGATIVE";
  return "INCLUDES_ZERO";
}

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
    // 报告 id 由冻结标识派生（P1）：标识字段（seriesId/asOf/horizon/
    // purpose/inputDigest/policyDigest/methodVersion）与 id 必须自洽——
    // 同步改写窗口与全部摘要的深伪造在 id 对不上时仍被拒绝。
    const expectedId = `evidence-${await digestOf({
      seriesId: report.seriesId,
      asOf: report.asOf,
      horizon: report.horizon,
      purpose: report.purpose,
      inputDigest: report.inputDigest,
      policyDigest: report.policyDigest,
      methodVersion: report.methodVersion,
    })}`;
    if (expectedId !== report.id)
      return fail(checks, "报告 id 与冻结标识不一致");
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
    // 冻结清单与有效日期一一对应（P1-6）。迁移前旧报告无冻结指标列
    // （metrics 为 null）：指标取自导出回退，跳过清单对应检查（P2-2）。
    if (Array.isArray(report.inputs.metrics)) {
      const manifestDates = report.inputs.metrics
        .map((row) => row.outcomeDate)
        .sort();
      if (
        JSON.stringify(manifestDates) !== JSON.stringify([...validDates].sort())
      )
        return fail(checks, "冻结输入指标与窗口有效日期不一致");
      // 上下文标记一致性：窗口参与计算的指标上下文唯一性必须与
      // mixedContext 一致，防止改标记后切换状态分支。
      const contextMixed =
        new Set(report.inputs.metrics.map((row) => row.payload.contextDigest))
          .size > 1;
      if (contextMixed !== !!report.payload.context?.mixedContext)
        return fail(checks, "上下文标记与窗口指标不一致");
    }
    // 窗口划分与覆盖率如实（P1-3/P1-6）：有效/缺失/质量剔除互斥且并集
    // 等于冻结日历，覆盖率等于有效占比。报告覆盖率按 4 位小数发布，
    // 核验容差 1e-4（P1-1）：不因精度舍入拒绝合法报告。
    const missingDates = report.payload.window.missingDates ?? [];
    const excludedDates = report.payload.window.excludedDates ?? [];
    const partition = [...validDates, ...missingDates, ...excludedDates].sort();
    if (JSON.stringify(partition) !== JSON.stringify([...expected].sort()))
      return fail(checks, "窗口日期划分与冻结日历不一致");
    const expectedCoverage = validDates.length / expected.length;
    if (
      Math.abs((report.payload.window.coverage ?? 0) - expectedCoverage) > 1e-4
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
      // 无有效日指标（P1-2）：有质量剔除日说明样本被闸门拒绝
      // （INSUFFICIENT_SAMPLE），否则只是尚未积累（PENDING）。
      const expectedNoValid = (report.payload.window.excludedDates ?? []).length
        ? "INSUFFICIENT_SAMPLE"
        : "PENDING";
      if (report.payload.status !== expectedNoValid)
        return fail(checks, "无有效日指标时的状态与窗口结构不一致");
      // 无有效日指标时发布端不输出任何检验结果（P1-2）：不能因为无有效日
      // 就跳过族核验——零样本报告塞入编造的区间与 p 值必须被拒绝。
      if ((report.payload.family ?? []).length)
        return fail(checks, "无有效日指标时不得输出检验结果");
      if (
        (report.payload.secondaryFamilies ?? []).some(
          (family) => family.entries?.length,
        )
      )
        return fail(checks, "无有效日指标时不得输出次要检验族结果");
    } else {
      // 检验族预登记核对（§6.4/P1-2）：已知系列的族不得删减或替换；
      // 空族的合法性由覆盖/片段状态在下方核验（发布端仅在覆盖不足、
      // 片段过短或无有效日时输出空族）。
      const declaredFamily = SERIES_METRIC_FAMILIES[report.seriesId];
      const recordedMetrics = report.payload.family?.map(
        (entry) => entry.metric,
      );
      if (
        declaredFamily &&
        recordedMetrics.length &&
        JSON.stringify([...recordedMetrics].sort()) !==
          JSON.stringify([...declaredFamily].sort())
      )
        return fail(checks, "检验族与该系列预登记的指标族不一致");
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
      if (!matrix) {
        // 片段过短（P1-2）：发布端此时不输出任何检验结果——族必须为空，
        // 编造的区间与 p 值在这里被拒绝。
        if (recordedMetrics.length)
          return fail(checks, "片段短于区块长度时不得输出检验结果");
        if (report.payload.status !== "INCOMPLETE_DATA")
          return fail(checks, "片段短于区块长度时报告应标注 INCOMPLETE_DATA");
        if (
          (report.payload.secondaryFamilies ?? []).some(
            (family) => family.entries?.length,
          )
        )
          return fail(checks, "片段短于区块长度时不得输出次要检验族结果");
      } else if (!recordedMetrics.length) {
        // 可重采样时清空检验族改 PENDING 必须被拒绝（P1-2）：覆盖达标
        // 却无检验结果，或覆盖不足却未如实标注 INCOMPLETE_DATA。
        if ((report.payload.window.coverage ?? 0) >= policy.minWindowCoverage)
          return fail(checks, "窗口覆盖达标却无检验结果，不应输出空检验族");
        if (report.payload.status !== "INCOMPLETE_DATA")
          return fail(checks, "覆盖不足的空检验族报告应标注 INCOMPLETE_DATA");
        if (
          (report.payload.secondaryFamilies ?? []).some(
            (family) => family.entries?.length,
          )
        )
          return fail(checks, "覆盖不足时不得输出次要检验族结果");
      } else {
        // 覆盖闸门（P1-1）：发布端覆盖不足时族恒为空——即使攻击者用
        // 真实算法重算族塞入并改 READY，也必须被覆盖率闸门拒绝。
        if ((report.payload.window.coverage ?? 0) < policy.minWindowCoverage)
          return fail(checks, "窗口覆盖低于政策最低要求，不得输出检验结果");
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
            // 单项状态必须与重算一致（P2-1）：READY 改 DEGENERATE 但
            // 保留区间与 p 值的篡改在此被拒。
            if (entry.status !== "READY")
              return fail(checks, `${entry.metric} 状态与重算不一致`);
            if (!entry.ci)
              return fail(checks, `${entry.metric} 缺少应输出的区间`);
            // 其余字段逐项核对（P2-1 同类封口）：单位、有效天数、区间
            // 参数与标准误不得脱离重算结果单独篡改。
            if (entry.unit !== metricUnit(entry.metric))
              return fail(checks, `${entry.metric} 单位与指标不一致`);
            if (entry.validDays !== validDates.length)
              return fail(checks, `${entry.metric} 有效天数与窗口不一致`);
            if (
              entry.ci.level !== policy.confidenceLevel ||
              entry.ci.scope !== "POINTWISE"
            )
              return fail(checks, `${entry.metric} 区间参数与政策不一致`);
            assert.ok(
              Math.abs((entry.standardError ?? NaN) - outcome.standardError) <
                1e-12,
              `${entry.metric} 标准误不一致`,
            );
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
            if (entry.unit !== metricUnit(entry.metric))
              return fail(checks, `${entry.metric} 单位与指标不一致`);
            if (entry.validDays !== validDates.length)
              return fail(checks, `${entry.metric} 有效天数与窗口不一致`);
            const expectedError = outcome.standardError ?? null;
            if (
              (entry.standardError ?? null) === null
                ? expectedError !== null
                : expectedError === null ||
                  Math.abs(entry.standardError - expectedError) >= 1e-12
            )
              return fail(checks, `${entry.metric} 标准误与重算不一致`);
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
        // 板块次要检验族核验（§3.2/§6.4 批次 C）：独立重算并与报告逐项
        // 核对族大小、板块集合、状态、区间、p 值与 Holm 校正；账户系列
        // 不输出板块族（口径不同，混入即拒绝）。
        const recordedSecondary = report.payload.secondaryFamilies ?? [];
        if (report.seriesId !== REVIEW_EVIDENCE_SERIES) {
          if (recordedSecondary.some((family) => family.entries?.length))
            return fail(checks, "非复盘系列不得输出板块次要检验族");
        } else {
          const expectedFamilies = expectedSecondaryFamilies({
            policy,
            validDates,
            metricsByDate,
            matrix,
          });
          const recordedByName = new Map(
            recordedSecondary.map((family) => [family.name, family]),
          );
          for (const expectedFamily of expectedFamilies) {
            const recordedFamily = recordedByName.get(expectedFamily.name);
            if (!recordedFamily)
              return fail(checks, `缺少次要检验族 ${expectedFamily.name}`);
            if (recordedFamily.familySize !== expectedFamily.familySize)
              return fail(
                checks,
                `${expectedFamily.name} 族大小与冻结输入不一致`,
              );
            if (recordedFamily.role !== "SECONDARY")
              return fail(
                checks,
                `${expectedFamily.name} 角色必须为 SECONDARY`,
              );
            const recordedEntries = recordedFamily.entries ?? [];
            const expectedEntries = expectedFamily.entries;
            if (recordedEntries.length !== expectedEntries.length)
              return fail(checks, `${expectedFamily.name} 成员数与重算不一致`);
            for (const [index, expectedEntry] of expectedEntries.entries()) {
              const recordedEntry = recordedEntries[index];
              const label = `${expectedFamily.name}/${expectedEntry.sector ?? expectedEntry.metric}`;
              if (expectedEntry.sector !== recordedEntry.sector)
                return fail(checks, `${label} 板块与重算不一致`);
              if (recordedEntry.metric !== expectedEntry.metric)
                return fail(checks, `${label} 指标与重算不一致`);
              if (recordedEntry.unit !== expectedEntry.unit)
                return fail(checks, `${label} 单位与指标不一致`);
              if (recordedEntry.status !== expectedEntry.status)
                return fail(checks, `${label} 状态与重算不一致`);
              if (recordedEntry.validDays !== expectedEntry.validDays)
                return fail(checks, `${label} 有效天数与重算不一致`);
              if (recordedEntry.direction !== expectedEntry.direction)
                return fail(checks, `${label} 方向与区间不一致`);
              if (expectedEntry.ci) {
                if (!recordedEntry.ci)
                  return fail(checks, `${label} 缺少应输出的区间`);
                if (recordedEntry.ci.level !== policy.confidenceLevel)
                  return fail(checks, `${label} 区间参数与政策不一致`);
                if (recordedEntry.ci.scope !== "POINTWISE")
                  return fail(checks, `${label} 区间范围标记不一致`);
                assert.ok(
                  Math.abs(
                    (recordedEntry.estimate ?? NaN) - expectedEntry.estimate,
                  ) < 1e-12,
                  `${label} 点估计不一致`,
                );
                assert.ok(
                  Math.abs(
                    (recordedEntry.ci.lower ?? NaN) - expectedEntry.ci.lower,
                  ) < 1e-12 &&
                    Math.abs(
                      (recordedEntry.ci.upper ?? NaN) - expectedEntry.ci.upper,
                    ) < 1e-12,
                  `${label} 区间不一致`,
                );
                assert.ok(
                  Math.abs((recordedEntry.pRaw ?? NaN) - expectedEntry.pRaw) <
                    1e-12,
                  `${label} p 值不一致`,
                );
                assert.ok(
                  Math.abs(
                    (recordedEntry.pAdjustedWithinFamily ?? NaN) -
                      expectedEntry.pAdjustedWithinFamily,
                  ) < 1e-12,
                  `${label} Holm 校正值不一致`,
                );
                assert.ok(
                  Math.abs(
                    (recordedEntry.standardError ?? NaN) -
                      expectedEntry.standardError,
                  ) < 1e-12,
                  `${label} 标准误不一致`,
                );
              } else {
                if (recordedEntry.ci)
                  return fail(checks, `${label} 不应携带区间`);
                if (recordedEntry.pRaw != null)
                  return fail(checks, `${label} 不可估计时不应携带 p 值`);
                if (recordedEntry.pAdjustedWithinFamily != null)
                  return fail(checks, `${label} 不可估计时不应有校正 p 值`);
              }
            }
          }
          if (
            recordedSecondary.some(
              (family) =>
                !["SECTOR_SECONDARY_EXCESS", "SECTOR_AGGREGATE_IC"].includes(
                  family.name,
                ),
            )
          )
            return fail(checks, "次要检验族包含未预登记的族名");
        }
      }
    }
    // 标签由窗口/政策/系列结构完全派生（§4/§7.1/§10）：篡改受限标注
    // （如 METHOD_SIMULATION_LIMITED）以美化展示在此被拒。
    const expectedTags = ["EXPLORATORY_REPEATED_LOOKS"];
    if (
      (report.payload.window.missingDates ?? []).length ||
      (report.payload.window.excludedDates ?? []).length
    )
      expectedTags.push("CONDITIONAL_ON_OBSERVED_DAYS");
    if (report.seriesId === REVIEW_EVIDENCE_SERIES)
      expectedTags.push("OBSERVATION_NOT_EXECUTABLE");
    if (report.seriesId === ACCOUNT_EVIDENCE_SERIES) {
      expectedTags.push("NO_COMPARABLE_BASELINE");
      // 成本标签由执行成本政策校准状态派生（批次 C）：报告必须携带 cost
      // 指纹；旧报告（无 cost 字段）按先验未校准兜底。
      const calibration = report.payload.cost?.calibrationStatus;
      if (calibration ? calibration !== "EXECUTION_CALIBRATED" : true)
        expectedTags.push(`COST_${calibration ?? "PRIOR_UNCALIBRATED"}`);
    }
    if (
      report.horizon !== policy.primaryWindow &&
      report.horizon === policy.windows[0]
    )
      expectedTags.push("SHORT_WINDOW");
    if (!METHOD_QUALIFIED_HORIZONS.includes(report.horizon))
      expectedTags.push("METHOD_SIMULATION_LIMITED");
    if (
      JSON.stringify([...(report.payload.tags ?? [])].sort()) !==
      JSON.stringify(expectedTags.sort())
    )
      return fail(checks, "标签与窗口/政策/系列结构不一致");
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
