// 证据政策（docs/design/statistical-evidence.md §4）：
// 用途、窗口、质量、方法和指标族的严格校验。参数在数据到来前版本化，
// 独立于评分权重与 AI 参数；拒绝未知字段、非有限数与越界设置。
import { digestOf } from "./research-lineage.js";

export const EVIDENCE_PURPOSES = Object.freeze(["DIAGNOSTIC"]);
export const EVIDENCE_MULTIPLICITY_METHODS = Object.freeze([
  "HOLM_WITHIN_ASOF_FAMILY",
]);
export const EVIDENCE_SAMPLE_STATUSES = Object.freeze([
  "PENDING",
  "INSUFFICIENT_SAMPLE",
  "INCOMPLETE_DATA",
  "MIXED_CONTEXT",
  "DEGENERATE",
  "READY",
]);
export const EVIDENCE_DIRECTIONS = Object.freeze([
  "POSITIVE",
  "INCLUDES_ZERO",
  "NEGATIVE",
]);
export const EVIDENCE_TAGS = Object.freeze([
  "SHORT_WINDOW",
  "EXPLORATORY_REPEATED_LOOKS",
  "CONDITIONAL_ON_OBSERVED_DAYS",
  "COST_PRIOR_UNCALIBRATED",
  "OBSERVATION_NOT_EXECUTABLE",
  "NO_COMPARABLE_BASELINE",
  "METHOD_SIMULATION_LIMITED",
]);
// 方法模拟资格（evidence-simulation v1 记录）：仅以下窗口长度在 IID 基准
// 下同时满足覆盖率 ≥0.90 与零效应拒绝率 ≤0.07；未列入的窗口降为受限探索
// 展示（§10 兜底条款）。未来切换方法版本时以新模拟结果更新。
export const METHOD_QUALIFIED_HORIZONS = Object.freeze([120]);
// 评分主检验族固定为两个指标（§6.4）；账户对照族与板块族另行声明。
export const REVIEW_METRIC_FAMILY = Object.freeze([
  "MEAN_DAILY_IC",
  "MEAN_DAILY_EXCESS",
]);
// 账户系列预登记检验族：单一指标（主账户连续账本无匹配对照，
// 配对族另行声明，不混入本系列）。
export const ACCOUNT_METRIC_FAMILY = Object.freeze(["MEAN_DAILY_RETURN"]);
// 系列预登记检验族（§6.4）：报告不得清空、删减或替换族成员；
// verifier 按系列核对族一致性（P1-2）。
export const REVIEW_EVIDENCE_SERIES = "review-primary";
export const ACCOUNT_EVIDENCE_SERIES = "account-primary";
export const SERIES_METRIC_FAMILIES = Object.freeze({
  [REVIEW_EVIDENCE_SERIES]: REVIEW_METRIC_FAMILY,
  [ACCOUNT_EVIDENCE_SERIES]: ACCOUNT_METRIC_FAMILY,
});

export const EVIDENCE_POLICY_FIELDS = Object.freeze([
  { key: "windows", label: "滚动窗口（交易日）" },
  { key: "primaryWindow", label: "主视图窗口", min: 5, max: 250 },
  { key: "confidenceLevel", label: "置信水平", min: 0.8, max: 0.999 },
  { key: "blockLength", label: "区块长度（交易日）", min: 1, max: 20 },
  {
    key: "blockLengthSensitivity",
    label: "区块长度敏感性预登记",
  },
  { key: "resamples", label: "重采样次数", min: 100, max: 100000 },
  { key: "minValidDays", label: "最少有效天数", min: 1, max: 250 },
  { key: "minWindowCoverage", label: "最小窗口覆盖", min: 0, max: 1 },
  { key: "minStockCoverage", label: "单日最小股票覆盖", min: 0, max: 1 },
  { key: "minValidStocks", label: "单日最少有效股票", min: 1, max: 1000 },
  { key: "minTopStocks", label: "单日最少有效前组股票", min: 1, max: 500 },
  {
    key: "maxDegenerateResampleRatio",
    label: "最大退化重采样比例",
    min: 0,
    max: 0.5,
  },
  { key: "multiplicityMethod", label: "多重检验方法" },
  { key: "purpose", label: "证据用途" },
]);

export const DEFAULT_EVIDENCE_POLICY = Object.freeze({
  windows: Object.freeze([20, 60, 120]),
  primaryWindow: 60,
  confidenceLevel: 0.95,
  blockLength: 5,
  blockLengthSensitivity: Object.freeze([3, 5, 10]),
  resamples: 10000,
  minValidDays: 20,
  minWindowCoverage: 0.9,
  minStockCoverage: 0.9,
  minValidStocks: 10,
  minTopStocks: 3,
  maxDegenerateResampleRatio: 0.05,
  multiplicityMethod: "HOLM_WITHIN_ASOF_FAMILY",
  purpose: "DIAGNOSTIC",
});

const round = (value, decimals) => Number(value.toFixed(decimals));
const isPlainKey = (key) =>
  key !== "__proto__" && key !== "constructor" && key !== "prototype";

const integerField = (value, field) => {
  if (!Number.isInteger(value) || value < field.min || value > field.max)
    throw new Error(
      `证据政策 ${field.label} 超出范围 [${field.min}, ${field.max}]`,
    );
  return value;
};
const decimalField = (value, field, decimals) => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`证据政策 ${field.label} 必须是有限数值`);
  if (value < field.min || value > field.max)
    throw new Error(
      `证据政策 ${field.label} 超出范围 [${field.min}, ${field.max}]`,
    );
  return round(value, decimals);
};

// 严格 schema → 规范化的不可变政策；修改产生新版本。
export function normalizeEvidencePolicy(input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input))
    throw new Error("证据政策必须是对象");
  const known = new Set(EVIDENCE_POLICY_FIELDS.map((field) => field.key));
  for (const key of Object.keys(input)) {
    if (!isPlainKey(key) || !known.has(key))
      throw new Error(`证据政策包含未知字段：${key}`);
  }
  const merged = { ...DEFAULT_EVIDENCE_POLICY, ...input };
  const windows = merged.windows;
  if (
    !Array.isArray(windows) ||
    windows.length < 1 ||
    windows.length > 4 ||
    windows.some(
      (value) => !Number.isInteger(value) || value < 5 || value > 250,
    ) ||
    windows.some((value, index) => index && value <= windows[index - 1])
  )
    throw new Error("证据政策 windows 必须是 1–4 个严格递增的 5–250 整数");
  const primaryWindow = integerField(merged.primaryWindow, {
    label: "主视图窗口",
    min: 5,
    max: 250,
  });
  if (!windows.includes(primaryWindow))
    throw new Error("主视图窗口必须属于 windows");
  const sensitivity = merged.blockLengthSensitivity;
  if (
    !Array.isArray(sensitivity) ||
    sensitivity.length < 1 ||
    sensitivity.length > 5 ||
    sensitivity.some(
      (value) => !Number.isInteger(value) || value < 1 || value > 50,
    )
  )
    throw new Error("区块长度敏感性预登记必须是 1–5 个 1–50 整数");
  if (!sensitivity.includes(merged.blockLength))
    throw new Error("敏感性预登记必须包含当前区块长度");
  if (
    !EVIDENCE_MULTIPLICITY_METHODS.includes(merged.multiplicityMethod) ||
    !EVIDENCE_PURPOSES.includes(merged.purpose)
  )
    throw new Error("证据政策用途或多重检验方法无效");
  return Object.freeze({
    windows: [...windows],
    primaryWindow,
    confidenceLevel: decimalField(
      merged.confidenceLevel,
      {
        label: "置信水平",
        min: 0.8,
        max: 0.999,
      },
      4,
    ),
    blockLength: integerField(merged.blockLength, {
      label: "区块长度（交易日）",
      min: 1,
      max: 20,
    }),
    blockLengthSensitivity: [...sensitivity],
    resamples: integerField(merged.resamples, {
      label: "重采样次数",
      min: 100,
      max: 100000,
    }),
    minValidDays: integerField(merged.minValidDays, {
      label: "最少有效天数",
      min: 1,
      max: 250,
    }),
    minWindowCoverage: decimalField(
      merged.minWindowCoverage,
      {
        label: "最小窗口覆盖",
        min: 0,
        max: 1,
      },
      4,
    ),
    minStockCoverage: decimalField(
      merged.minStockCoverage,
      {
        label: "单日最小股票覆盖",
        min: 0,
        max: 1,
      },
      4,
    ),
    minValidStocks: integerField(merged.minValidStocks, {
      label: "单日最少有效股票",
      min: 1,
      max: 1000,
    }),
    minTopStocks: integerField(merged.minTopStocks, {
      label: "单日最少有效前组股票",
      min: 1,
      max: 500,
    }),
    maxDegenerateResampleRatio: decimalField(
      merged.maxDegenerateResampleRatio,
      { label: "最大退化重采样比例", min: 0, max: 0.5 },
      4,
    ),
    multiplicityMethod: merged.multiplicityMethod,
    purpose: merged.purpose,
  });
}

export async function evidencePolicyDigest(policy) {
  return digestOf(policy);
}
