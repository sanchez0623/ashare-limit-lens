import { BUY_POINT_LABELS } from "./buy-point-type.js";

export const DRAGON_POLICY_VERSION = "dragon-risk-v1";
export const DRAGON_TEMPLATE_VERSION = "dragon-template-v1";
export const DRAGON_RISK_FIELDS = Object.freeze([
  {
    key: "entryRisk",
    label: "单笔新仓计划风险",
    default: 0.005,
    min: 0.0001,
    max: 0.05,
  },
  {
    key: "portfolioRisk",
    label: "全账户计划风险上限",
    default: 0.02,
    min: 0.0001,
    max: 0.2,
  },
  {
    key: "stockWeight",
    label: "单股仓位上限",
    default: 0.15,
    min: 0.01,
    max: 1,
  },
  {
    key: "sectorWeight",
    label: "单板块仓位上限",
    default: 0.3,
    min: 0.01,
    max: 1,
  },
  { key: "grossWeight", label: "总仓位上限", default: 0.5, min: 0.01, max: 1 },
  {
    key: "maxPositions",
    label: "最大持仓数",
    default: 4,
    min: 1,
    max: 10,
    integer: true,
  },
  {
    key: "dailyLoss",
    label: "单日亏损暂停线",
    default: 0.02,
    min: 0.005,
    max: 0.2,
  },
  {
    key: "drawdown",
    label: "账户回撤熔断线",
    default: 0.08,
    min: 0.005,
    max: 0.5,
  },
]);
export const DRAGON_ADVANCED_FIELDS = Object.freeze([
  {
    key: "stopLoss",
    label: "初始保护退出幅度",
    default: 0.04,
    min: 0.02,
    max: 0.08,
  },
  {
    key: "tFraction",
    label: "做 T 占可卖底仓比例",
    default: 0.1,
    min: 0.05,
    max: 0.2,
  },
  {
    key: "tSpread",
    label: "做 T 第二腿目标价差",
    default: 0.02,
    min: 0.005,
    max: 0.04,
  },
]);
export const DRAGON_OPERATION_FIELDS = Object.freeze([
  { key: "profitAdd", label: "盈利加仓" },
  { key: "lossAdd", label: "亏损补仓" },
  { key: "tForward", label: "正向 T" },
  { key: "tReverse", label: "反向 T" },
]);
export const DRAGON_BUY_POINT_FIELDS = Object.freeze(
  Object.entries(BUY_POINT_LABELS).map(([key, label]) => ({ key, label })),
);
export const DRAGON_RESEARCH_KEYS = Object.freeze(
  DRAGON_ADVANCED_FIELDS.map((f) => f.key),
);
export const DRAGON_FIELD_REGISTRY = Object.freeze(
  [
    ["risk", DRAGON_RISK_FIELDS],
    ["operations", DRAGON_OPERATION_FIELDS],
    ["buyPoints", DRAGON_BUY_POINT_FIELDS],
    ["advanced", DRAGON_ADVANCED_FIELDS],
  ].flatMap(([group, fields]) =>
    fields.map((f) =>
      Object.freeze({
        ...f,
        group,
        path: `${group}.${f.key}`,
        type: ["operations", "buyPoints"].includes(group)
          ? "boolean"
          : f.integer
            ? "integer"
            : "number",
        unit: ["operations", "buyPoints"].includes(group)
          ? "switch"
          : f.integer
            ? "count"
            : "ratio",
        editableBy: group === "advanced" ? ["user", "ai-candidate"] : ["user"],
        effectiveScope: "next-unfrozen-plan",
      }),
    ),
  ),
);
export function assertDragonSettingsIsolation(book, settings) {
  if (
    (book?.tradingPolicyVersion === DRAGON_POLICY_VERSION ||
      book?.dragonTransition?.state === "DRAINING") &&
    [
      "strategyParams",
      "riskLimits",
      "selectionPolicyVersion",
      "entryExecutionMode",
    ].some((k) => Object.hasOwn(settings, k))
  )
    throw new Error("新交易政策已隔离旧配置，不能写入旧策略、风控或执行方式");
}
export const DRAGON_REGIMES = Object.freeze({
  rising: {
    label: "上升",
    factor: 1,
    open: true,
    profitAdd: true,
    lossAdd: true,
    t: true,
    target: null,
  },
  climax: {
    label: "高潮",
    factor: 0.7,
    open: true,
    profitAdd: true,
    lossAdd: false,
    t: true,
    target: null,
  },
  ebbing: {
    label: "退潮",
    factor: 0,
    open: false,
    profitAdd: false,
    lossAdd: false,
    t: false,
    target: 0.2,
  },
  freezing: {
    label: "冰点",
    factor: 0,
    open: false,
    profitAdd: false,
    lossAdd: false,
    t: false,
    target: 0,
  },
  unknown: {
    label: "数据不足",
    factor: 0,
    open: false,
    profitAdd: false,
    lossAdd: false,
    t: false,
    target: null,
  },
});
export const DRAGON_HOLD_DAYS = Object.freeze({
  "limit-up-momentum": 4,
  "broken-board-dip": 3,
  "first-neg-dip": 3,
  "fake-neg-limit-dip": 2,
  "auction-dip": 2,
  "late-dip": 2,
});
export function defaultDragonConfig() {
  return {
    version: DRAGON_POLICY_VERSION,
    risk: Object.fromEntries(DRAGON_RISK_FIELDS.map((f) => [f.key, f.default])),
    operations: Object.fromEntries(
      DRAGON_OPERATION_FIELDS.map((f) => [f.key, true]),
    ),
    buyPoints: Object.fromEntries(
      DRAGON_BUY_POINT_FIELDS.map((f) => [f.key, true]),
    ),
    advanced: Object.fromEntries(
      DRAGON_ADVANCED_FIELDS.map((f) => [f.key, f.default]),
    ),
  };
}
function exact(value, keys, name) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new Error(`新交易配置 ${name} 字段不完整或含未知字段`);
}
export function normalizeDragonConfig(input) {
  exact(
    input,
    ["version", "risk", "operations", "buyPoints", "advanced"],
    "根对象",
  );
  if (input.version !== DRAGON_POLICY_VERSION)
    throw new Error("不支持的新交易政策版本");
  const out = { version: input.version };
  for (const [group, fields] of [
    ["risk", DRAGON_RISK_FIELDS],
    ["advanced", DRAGON_ADVANCED_FIELDS],
  ]) {
    exact(
      input[group],
      fields.map((f) => f.key),
      group,
    );
    out[group] = {};
    for (const f of fields) {
      const v = input[group][f.key];
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        v < f.min ||
        v > f.max ||
        (f.integer && !Number.isInteger(v))
      )
        throw new Error(`新交易配置 ${f.label} 超出允许范围`);
      out[group][f.key] = Math.round(v * 1e6) / 1e6;
    }
  }
  for (const [group, fields] of [
    ["operations", DRAGON_OPERATION_FIELDS],
    ["buyPoints", DRAGON_BUY_POINT_FIELDS],
  ]) {
    exact(
      input[group],
      fields.map((f) => f.key),
      group,
    );
    out[group] = {};
    for (const f of fields) {
      if (typeof input[group][f.key] !== "boolean")
        throw new Error(`新交易配置 ${f.label} 必须为开关`);
      out[group][f.key] = input[group][f.key];
    }
  }
  const r = out.risk;
  if (
    r.entryRisk > r.portfolioRisk ||
    r.stockWeight > r.sectorWeight ||
    r.sectorWeight > r.grossWeight ||
    r.dailyLoss > r.drawdown
  )
    throw new Error(
      "新交易配置须满足：单笔风险≤组合风险，单股≤板块≤总仓位，日亏损线≤回撤线",
    );
  return out;
}
export function dragonPreview(config, phase = "unknown") {
  const c = normalizeDragonConfig(config),
    regime = DRAGON_REGIMES[phase] ?? DRAGON_REGIMES.unknown;
  return {
    policyVersion: DRAGON_POLICY_VERSION,
    templateVersion: DRAGON_TEMPLATE_VERSION,
    phase,
    label: regime.label,
    configured: c,
    effective: {
      entryRisk: c.risk.entryRisk * regime.factor,
      portfolioRisk: c.risk.portfolioRisk * regime.factor,
      grossWeight:
        regime.target == null
          ? regime.factor
            ? c.risk.grossWeight * regime.factor
            : null
          : Math.min(c.risk.grossWeight, regime.target),
      open: regime.open,
      profitAdd: regime.profitAdd && c.operations.profitAdd,
      lossAdd: regime.lossAdd && c.operations.lossAdd,
      tForward: regime.t && c.operations.tForward,
      tReverse: regime.t && c.operations.tReverse,
    },
    note: "计划风险为估算；费用、滑点、仓位与成交容量可继续收紧。缺数据停止新增，不回退旧参数。",
  };
}

// Read-only field projection shared by the API preview and the settings page.
export function dragonEffectiveFields(
  config,
  phase = "unknown",
  paused = false,
) {
  const c = normalizeDragonConfig(config),
    preview = dragonPreview(c, phase),
    rows = [];
  for (const [group, fields] of [
    ["risk", DRAGON_RISK_FIELDS],
    ["operations", DRAGON_OPERATION_FIELDS],
    ["buyPoints", DRAGON_BUY_POINT_FIELDS],
    ["advanced", DRAGON_ADVANCED_FIELDS],
  ]) {
    for (const f of fields) {
      const set = c[group][f.key];
      let effective = set,
        reason = "依设定执行";
      if (
        group === "risk" &&
        ["entryRisk", "portfolioRisk", "grossWeight"].includes(f.key)
      ) {
        effective = preview.effective[f.key];
        reason = preview.label + "市场预算";
        if (paused && f.key !== "grossWeight") {
          effective = 0;
          reason = "账户暂停新增风险，保护退出继续";
        }
      } else if (group === "operations" || group === "buyPoints") {
        effective =
          !paused &&
          (group === "buyPoints"
            ? set && preview.effective.open
            : preview.effective[f.key]);
        reason = paused
          ? "账户暂停新增风险"
          : !set
            ? "用户关闭"
            : !effective
              ? preview.label + "限制"
              : "仍须买点、时段及共享风控确认";
      } else if (group === "advanced") {
        reason =
          f.key === "stopLoss"
            ? "仅用于新持仓周期；已有保护位不放宽"
            : "用于新 T；未完成 T 保留首腿冻结值";
      } else if (f.key === "maxPositions") {
        reason = "持仓及待成交名额共同占用";
      } else if (["stockWeight", "sectorWeight"].includes(f.key)) {
        reason = "持仓、待成交及 T 恢复预留共同占用";
      }
      rows.push({
        group,
        key: f.key,
        label: f.label,
        unit:
          typeof set === "boolean" ? "boolean" : f.integer ? "count" : "ratio",
        configured: set,
        effective,
        reason,
      });
    }
  }
  return rows;
}
