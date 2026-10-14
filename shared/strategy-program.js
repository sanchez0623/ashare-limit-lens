// 声明式策略空间；只允许白名单和有限数据，前后端共用，禁止可执行表达式。
export const STRATEGY_SPACE_VERSION = "strategy-space-v2";
export const PROGRAM_VERSION = 1;
export const FAMILY_DEFINITIONS = Object.freeze({
  "limit-momentum-v1": {
    name: "六因子",
    version: 1,
    description: "现有六因子评分与风险筛选",
  },
  "first-board-v1": {
    name: "首板",
    version: 1,
    description: "连续板数为 1 的信号；缺失板数时拒绝",
  },
  "relay-board-v1": {
    name: "连板",
    version: 1,
    description: "连续板数为 2–4 的信号；几天几板不替代连续板数",
  },
  "sector-resonance-v1": {
    name: "板块共振",
    version: 1,
    description: "信号日同板块至少 3 只涨停，板块评分至少 65",
  },
  "low-turnover-v1": {
    name: "低换手",
    version: 1,
    description: "信号日换手率 1%–8%，未知值不当作零",
  },
  "cash-v1": {
    name: "现金防守",
    version: 1,
    description: "停止新增交易，继续持仓风险保护",
  },
});
function exact(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error(`${label}字段无效`);
}
export function familyReference(value) {
  exact(value, ["familyId", "familyVersion"], "策略家族");
  const registered =
    Object.hasOwn(FAMILY_DEFINITIONS, value.familyId) &&
    FAMILY_DEFINITIONS[value.familyId];
  if (!registered || value.familyVersion !== registered.version)
    throw new Error("策略家族未登记或版本不匹配");
  return { familyId: value.familyId, familyVersion: value.familyVersion };
}
export function normalizeStrategyProgram(value) {
  if (!value || value.version !== PROGRAM_VERSION)
    throw new Error("策略程序版本不支持");
  if (value.kind === "FAMILY") {
    exact(value, ["version", "kind", "family"], "单家族策略");
    return {
      version: PROGRAM_VERSION,
      kind: "FAMILY",
      family: familyReference(value.family),
    };
  }
  if (value.kind === "EMOTION_SELECTOR") {
    exact(value, ["version", "kind", "regimes"], "情绪选择器");
    exact(value.regimes, ["high", "mid", "low"], "情绪分档");
    return {
      version: PROGRAM_VERSION,
      kind: value.kind,
      regimes: Object.fromEntries(
        ["high", "mid", "low"].map((key) => [
          key,
          familyReference(value.regimes[key]),
        ]),
      ),
    };
  }
  if (value.kind === "ALLOCATION") {
    exact(value, ["version", "kind", "components"], "共享资金分配器");
    if (
      !Array.isArray(value.components) ||
      value.components.length < 2 ||
      value.components.length > 4
    )
      throw new Error("资金分配器需要 2–4 个成员");
    const ids = new Set(),
      families = new Set();
    const components = value.components
      .map((row) => {
        exact(row, ["id", "weightBps", "family"], "资金分配成员");
        if (
          typeof row.id !== "string" ||
          !/^[a-z][a-z0-9-]{0,23}$/.test(row.id) ||
          ["constructor", "prototype", "carry"].includes(row.id) ||
          ids.has(row.id)
        )
          throw new Error("资金分配成员 id 无效或重复");
        const family = familyReference(row.family);
        if (families.has(family.familyId)) throw new Error("资金分配家族重复");
        if (
          !Number.isInteger(row.weightBps) ||
          row.weightBps < 500 ||
          row.weightBps > 9500 ||
          row.weightBps % 500
        )
          throw new Error("分配权重必须为 5%–95%，步长 5%");
        ids.add(row.id);
        families.add(family.familyId);
        return { id: row.id, weightBps: row.weightBps, family };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (components.reduce((n, row) => n + row.weightBps, 0) !== 10000)
      throw new Error("资金分配权重合计必须为 100%");
    return { version: PROGRAM_VERSION, kind: "ALLOCATION", components };
  }
  throw new Error("策略程序类型不支持");
}
export const familyProgram = (familyId) =>
  normalizeStrategyProgram({
    version: 1,
    kind: "FAMILY",
    family: { familyId, familyVersion: 1 },
  });
export const programIdentity = (strategy) =>
  JSON.stringify(
    strategy?.program
      ? normalizeStrategyProgram(strategy.program)
      : { kind: "LEGACY_SIX_FACTOR" },
  );
export function programFamily(strategy) {
  const program =
    strategy.program && normalizeStrategyProgram(strategy.program);
  return {
    familyId: !program
      ? "limit-momentum-v1"
      : program.kind === "FAMILY"
        ? program.family.familyId
        : program.kind === "ALLOCATION"
          ? "shared-allocation-v1"
          : "emotion-selector-v1",
    familyVersion: 1,
  };
}
export function programDescription(strategy) {
  if (!strategy?.program) return "六因子";
  const p = normalizeStrategyProgram(strategy.program);
  const label = (ref) => FAMILY_DEFINITIONS[ref.familyId].name;
  if (p.kind === "FAMILY") return label(p.family);
  if (p.kind === "EMOTION_SELECTOR")
    return `情绪选择：高 ${label(p.regimes.high)} / 中 ${label(p.regimes.mid)} / 低 ${label(p.regimes.low)}`;
  return `共享分配：${p.components.map((row) => `${label(row.family)} ${row.weightBps / 100}%`).join(" / ")}`;
}
