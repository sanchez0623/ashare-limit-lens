// 执行成本政策（docs/design/opening-execution-cost.md §3/§5.3）：
// 政策字段、单位、范围和 DTO，供前后端共用。纯数据与纯函数，
// 不读数据库、不请求行情、不做成本计算（成本内核在 backend/domain/execution-cost.js）。

export const EXECUTION_COST_MODEL = "TIME_LIQUIDITY_V1";
export const LEGACY_EXECUTION_COST_MODEL = "LEGACY_FIXED_10BPS_V1";
export const EXECUTION_COST_PERIODS = Object.freeze([
  "openFirstMinute",
  "openNextFourMinutes",
  "earlySession",
  "regular",
]);
// 现有 RISK_LIMITS.maxParticipation 的硬容量上限（trading.js）。
// 软参与率不得超过该值；此处独立声明以避免共享模块反向依赖领域层。
export const HARD_PARTICIPATION_CAP = 0.01;

export const CALIBRATION_STATUSES = Object.freeze([
  "PRIOR_UNCALIBRATED",
  "QUOTE_PROXY_VALIDATED",
  "EXECUTION_CALIBRATED",
]);

export const EXECUTION_COST_FIELDS = Object.freeze([
  ...EXECUTION_COST_PERIODS.map((period) => ({
    key: `periodBaseBps.${period}`,
    label: `时段残余项 ${period}`,
    unit: "bps",
    min: 0,
    max: 500,
    decimals: 2,
  })),
  {
    key: "previousLimitUpPremiumBps",
    label: "昨日涨停风险项",
    unit: "bps",
    min: 0,
    max: 500,
    decimals: 2,
  },
  {
    key: "unknownSpreadFloorBps",
    label: "缺盘口隐含价差回退",
    unit: "bps",
    min: 0,
    max: 500,
    decimals: 2,
  },
  {
    key: "impactBpsAtReferenceParticipation",
    label: "参考参与率下的平均冲击",
    unit: "bps",
    min: 0,
    max: 500,
    decimals: 2,
  },
  {
    key: "referenceParticipation",
    label: "冲击归一化参与率",
    unit: "比例",
    min: 0.0001,
    max: HARD_PARTICIPATION_CAP,
    decimals: 6,
  },
  {
    key: "impactExponent",
    label: "冲击曲线形状 γ",
    unit: "指数",
    min: 0.1,
    max: 1,
    decimals: 3,
  },
  {
    key: "openingParticipationCap",
    label: "开盘软容量上限",
    unit: "比例",
    min: 0,
    max: HARD_PARTICIPATION_CAP,
    decimals: 6,
  },
  {
    key: "minuteQualityMultiplier",
    label: "分钟采样残余成本倍数",
    unit: "倍数",
    min: 1,
    max: 5,
    decimals: 3,
  },
  {
    // 执行时的残余成本情景倍数；常规执行固定为 1，压力重放由情景
    // bundle 冻结为登记的情景值（§6.2）。
    key: "executionStressMultiplier",
    label: "执行情景压力倍数",
    unit: "倍数",
    min: 1,
    max: 10,
    decimals: 3,
  },
  {
    key: "maximumSupportedCostBps",
    label: "模型适用域上限",
    unit: "bps",
    min: 1,
    max: 2000,
    decimals: 0,
  },
]);

export const DEFAULT_EXECUTION_COST_PAYLOAD = Object.freeze({
  periodBaseBps: Object.freeze({
    openFirstMinute: 30,
    openNextFourMinutes: 20,
    earlySession: 10,
    regular: 5,
  }),
  previousLimitUpPremiumBps: 15,
  unknownSpreadFloorBps: 5,
  impactBpsAtReferenceParticipation: 10,
  referenceParticipation: 0.01,
  impactExponent: 0.5,
  openingParticipationCap: 0.005,
  minuteQualityMultiplier: 1.5,
  executionStressMultiplier: 1,
  // 两个事前登记的压力情景；基准执行固定使用 1.0，不在此表内。
  stressResidualMultiplier: Object.freeze([1.5, 2]),
  maximumSupportedCostBps: 300,
});

const fieldByKey = new Map(
  EXECUTION_COST_FIELDS.map((field) => [field.key, field]),
);
const round = (value, decimals) => Number(value.toFixed(decimals));
const isPlainKey = (key) =>
  key !== "__proto__" && key !== "constructor" && key !== "prototype";

// 严格 schema → 规范化的不可变政策 payload。
// 拒绝未知字段、非有限数、负值、原型字段及越界设置；修改产生新版本。
export function normalizeExecutionCostPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("成本政策必须是对象");
  const known = new Set([
    ...EXECUTION_COST_FIELDS.map((field) => field.key),
    "stressResidualMultiplier",
  ]);
  for (const key of Object.keys(input)) {
    if (key === "periodBaseBps") {
      if (!input.periodBaseBps || typeof input.periodBaseBps !== "object")
        throw new Error("成本政策 periodBaseBps 必须是对象");
      for (const period of Object.keys(input.periodBaseBps))
        if (!isPlainKey(period) || !known.has(`periodBaseBps.${period}`))
          throw new Error(`成本政策包含未知字段：periodBaseBps.${period}`);
      continue;
    }
    if (!isPlainKey(key) || !known.has(key))
      throw new Error(`成本政策包含未知字段：${key}`);
  }
  const output = {};
  for (const field of EXECUTION_COST_FIELDS) {
    const value = field.key.startsWith("periodBaseBps.")
      ? input.periodBaseBps?.[field.key.slice("periodBaseBps.".length)]
      : input[field.key];
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`成本参数 ${field.key} 必须是有限数值`);
    if (value < field.min || value > field.max)
      throw new Error(
        `成本参数 ${field.key} 超出范围 [${field.min}, ${field.max}]`,
      );
    if (field.key.startsWith("periodBaseBps.")) {
      const period = field.key.slice("periodBaseBps.".length);
      output.periodBaseBps = output.periodBaseBps || {};
      output.periodBaseBps[period] = round(value, field.decimals);
    } else output[field.key] = round(value, field.decimals);
  }
  const stress = input.stressResidualMultiplier;
  if (
    !Array.isArray(stress) ||
    stress.length < 1 ||
    stress.length > 4 ||
    stress.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 1 ||
        value > 10,
    ) ||
    stress.some((value, index) => index && value <= stress[index - 1])
  )
    throw new Error("压力倍数必须是 1–4 个严格递增的 1–10 数值");
  output.stressResidualMultiplier = stress.map((value) => round(value, 3));
  return Object.freeze(output);
}

// 默认政策的 payload 摘要（canonical JSON + SHA-256），模块加载即可用，
// 使 createPlan 在同步上下文中也能冻结带摘要的默认政策。
export const DEFAULT_EXECUTION_COST_PAYLOAD_DIGEST =
  "b7487263b2ed23a6d873b7196609552d402d52c778dd453a001ff7a1e51fb248";

// 政策 bundle：完整规范化政策 + 内容摘要。订单计划保存完整 bundle，
// 不能只存“当前设置”键。
export function normalizeExecutionCostPolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("成本政策 bundle 必须是对象");
  const allowed = new Set([
    "id",
    "version",
    "modelVersion",
    "payloadDigest",
    "calibrationStatus",
    "calibrationCutoff",
    "effectiveFrom",
    "payload",
  ]);
  for (const key of Object.keys(input))
    if (!allowed.has(key)) throw new Error(`成本政策包含未知字段：${key}`);
  if (input.modelVersion !== EXECUTION_COST_MODEL)
    throw new Error(`不支持的成本模型：${input.modelVersion}`);
  if (!/^[0-9a-f]{64}$/.test(input.payloadDigest ?? ""))
    throw new Error("成本政策缺少有效载荷摘要");
  if (!CALIBRATION_STATUSES.includes(input.calibrationStatus))
    throw new Error("成本政策校准状态无效");
  for (const key of ["calibrationCutoff", "effectiveFrom"])
    if (input[key] != null && !/^\d{4}-\d{2}-\d{2}/.test(input[key]))
      throw new Error(`成本政策 ${key} 必须是 ISO 日期`);
  const payload = normalizeExecutionCostPayload(input.payload);
  return Object.freeze({
    id: typeof input.id === "string" && input.id ? input.id : "default",
    version:
      Number.isInteger(input.version) && input.version > 0 ? input.version : 0,
    modelVersion: EXECUTION_COST_MODEL,
    payloadDigest: input.payloadDigest,
    calibrationStatus: input.calibrationStatus,
    calibrationCutoff: input.calibrationCutoff ?? null,
    effectiveFrom: input.effectiveFrom ?? null,
    payload,
  });
}

export function defaultExecutionCostPolicy() {
  return Object.freeze({
    id: "default",
    version: 0,
    modelVersion: EXECUTION_COST_MODEL,
    payloadDigest: DEFAULT_EXECUTION_COST_PAYLOAD_DIGEST,
    calibrationStatus: "PRIOR_UNCALIBRATED",
    calibrationCutoff: null,
    effectiveFrom: null,
    payload: DEFAULT_EXECUTION_COST_PAYLOAD,
  });
}

// 时段边界为半开区间（§3.1）：09:35:00 属于早盘后段；
// 接受 "HH:MM"（历史分钟）与 "HH:MM:SS"（实时轮询）两种可因果执行的时刻表示。
export function executionPeriod(time) {
  if (typeof time !== "string" || !/^\d{2}:\d{2}(:\d{2})?$/.test(time))
    return null;
  const normalized = time.length === 5 ? `${time}:00` : time;
  if (normalized < "09:30:00") return null;
  if (normalized < "09:31:00") return "openFirstMinute";
  if (normalized < "09:35:00") return "openNextFourMinutes";
  if (normalized < "10:00:00") return "earlySession";
  return "regular";
}

export const OPENING_PERIODS = Object.freeze([
  "openFirstMinute",
  "openNextFourMinutes",
]);
export const isOpeningPeriod = (period) => OPENING_PERIODS.includes(period);
