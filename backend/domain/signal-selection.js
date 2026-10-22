import { digestOf } from "./research-lineage.js";
import { BUY_POINT_TYPES } from "../../shared/buy-point-type.js";
import { STOCK_CLASSES } from "../../shared/stock-class.js";
// 选股政策与纯排序内核。每个版本的完整内容固定，禁止同编号改规则。
// 缺少版本的历史账户/清单按 v1 解释；新账户显式采用最新版本。
export const LEGACY_SELECTION_VERSION = "signal-ranking-v1";
export const SELECTION_VERSION_V2 = "signal-ranking-v2";
export const SELECTION_VERSION_V3 = "signal-ranking-v3";
export const SELECTION_VERSION_V4 = "signal-ranking-v4";
export const SELECTION_VERSION_V5 = "signal-ranking-v5";
// v5 是当前默认：龙头低吸（dragon-head-dip-buy）策略的完整能力——
// 分类路由 + 炸板候选 + 买点闸门 + EOD 候选（首阴低吸/假阴跌停低吸）——
// 直接成为新账户的默认行为，无需手动切换。v3/v4 保留为回退选项；
// 缺少版本的历史账户按 v1 解释。
export const DEFAULT_SELECTION_VERSION = SELECTION_VERSION_V5;
const policies = Object.freeze({
  [LEGACY_SELECTION_VERSION]: Object.freeze({
    version: LEGACY_SELECTION_VERSION,
    scorePrecision: 0,
    liquiditySource: null,
    tieBreak: "code-asc",
  }),
  [SELECTION_VERSION_V2]: Object.freeze({
    version: SELECTION_VERSION_V2,
    scorePrecision: 6,
    liquiditySource: "signal-day-turnover-cny",
    tieBreak: "code-asc",
  }),
  // v3：股票分类路由。scoreSignals 按股票类别（连板龙头/强势反包/波段震荡）
  // 路由评分权重，并把明确判定为平庸型的股票排除出候选池（方案 3）。
  [SELECTION_VERSION_V3]: Object.freeze({
    version: SELECTION_VERSION_V3,
    scorePrecision: 6,
    liquiditySource: "signal-day-turnover-cny",
    tieBreak: "code-asc",
    stockClassRouting: true,
  }),
  // v4：买点驱动建仓（方案 9）。炸板池候选并入信号，新增建仓位按买点硬闸门
  // 过滤——只有命中已验证龙头低吸买点的候选才进入建仓候选池。
  [SELECTION_VERSION_V4]: Object.freeze({
    version: SELECTION_VERSION_V4,
    scorePrecision: 6,
    liquiditySource: "signal-day-turnover-cny",
    tieBreak: "code-asc",
    stockClassRouting: true,
    brokenCandidateSource: true,
  }),
  // v5：EOD 候选源扩展。首阴低吸 / 假阴跌停低吸 的候选行从日线 parquet
  // 构造，评分因子结构性缺失（无封单、无首封时间），门控按买点资格豁免
  // 覆盖/评分检查。其余字段与 v4 一致。
  [SELECTION_VERSION_V5]: Object.freeze({
    version: SELECTION_VERSION_V5,
    scorePrecision: 6,
    liquiditySource: "signal-day-turnover-cny",
    tieBreak: "code-asc",
    stockClassRouting: true,
    brokenCandidateSource: true,
    extraCandidateSource: true,
  }),
});
// SHA-256(canonicalJson(policy))。常量使同步纯内核也能冻结完整摘要；
// 回归测试独立重算，政策字段变化必须新增版本及摘要。
const digests = Object.freeze({
  [LEGACY_SELECTION_VERSION]:
    "7b340abd928a57f1d401351952ad40219e29a81ee74a33f44747b128209f883a",
  [SELECTION_VERSION_V2]:
    "250aed8e31828b808180950a096ecf489c9fef150896d2495ba0708c3ef1cd32",
  [SELECTION_VERSION_V3]:
    "508cd643a3e2ef3842b55a89ec761a0a39851e7fd327c14fae96f39c5a828aa7",
  [SELECTION_VERSION_V4]:
    "2fbf957ad0be7c4bb1cbb9b09cf066f3187c8bc984df3db2d799e387908f0b02",
  [SELECTION_VERSION_V5]:
    "777dc3af6c39c79d09380122de3338fae44cf40b54eab592e55621f74ce06352",
});
export function selectionPolicy(version = DEFAULT_SELECTION_VERSION) {
  if (!Object.hasOwn(policies, version))
    throw new Error("选股政策版本不受支持");
  return structuredClone(policies[version]);
}
export function selectionPolicyDigest(policy) {
  const expected =
    policy && Object.hasOwn(policies, policy.version)
      ? policies[policy.version]
      : null;
  if (
    !expected ||
    Object.keys(policy).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => policy[key] !== value)
  )
    throw new Error("选股政策内容与声明版本不一致");
  return digests[policy.version];
}
export function selectionPolicyForBook(book) {
  return selectionPolicy(
    book?.selectionPolicyVersion ?? LEGACY_SELECTION_VERSION,
  );
}
export function frozenSelectionPolicy(record) {
  if (
    record?.selectionPolicy === undefined &&
    record?.selectionPolicyDigest === undefined
  )
    return selectionPolicy(LEGACY_SELECTION_VERSION);
  const policy = record?.selectionPolicy;
  if (selectionPolicyDigest(policy) !== record?.selectionPolicyDigest)
    throw new Error("冻结选股政策与摘要不一致");
  return structuredClone(policy);
}
export function selectionPolicyFields(policy) {
  return {
    selectionPolicy: structuredClone(policy),
    selectionPolicyDigest: selectionPolicyDigest(policy),
  };
}
export function selectionPolicyMatches(record, book) {
  try {
    return (
      selectionPolicyDigest(frozenSelectionPolicy(record)) ===
      selectionPolicyDigest(selectionPolicyForBook(book))
    );
  } catch {
    return false;
  }
}
// v4 建仓闸门：返回允许建仓的买点集合，旧版本返回 null 表示不设闸门。
// 闸门集合不进 policy 对象——selectionPolicyDigest 逐字段用 !== 比较，
// Set 会被判为"内容与声明版本不一致"；版本即闸门开关，集合在模块内定义。
export function buyPointGateForPolicy(policy) {
  return policy.version === SELECTION_VERSION_V4 ||
    policy.version === SELECTION_VERSION_V5
    ? A_GRADE_BUY_POINTS
    : null;
}
export function liquidityAmountCents(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
const codeOrder = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
// 股票/板块列表在选股输入中是集合；因子数组仍有权重位置含义，不能重排。
export function selectionSnapshotDigest(snapshot) {
  const digestSource = {
    ...snapshot,
    stocks: [...snapshot.stocks].sort(codeOrder),
    sectors: [...snapshot.sectors].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
  };
  // 旧快照无炸板候选字段：不补空数组，否则摘要输入多出键，旧计划重算 /
  // 核验会因摘要失配而拒绝（不追溯改规则）。仅在新快照上按 code 排序
  // 纳入，保证选择摘要确定性与新字段冻结。
  if (snapshot.brokenStocks !== undefined)
    digestSource.brokenStocks = [...snapshot.brokenStocks].sort(codeOrder);
  if (snapshot.extraStocks !== undefined)
    digestSource.extraStocks = [...snapshot.extraStocks].sort(codeOrder);
  return digestOf(digestSource);
}
// 观察池分级（方案 8）：独立规则版本，不进入选股政策与摘要。
// 评分决定下限、股票分类决定上限；grade 仅展示，不参与排序与交易决策。
export const OBSERVATION_GRADE_RULES_VERSION = 1;
export const OBSERVATION_GRADES = Object.freeze({ A: "A", B: "B", C: "C" });

const GRADE_ORDER = Object.freeze({ A: 0, B: 1, C: 2 });
const CLASS_LABELS = Object.freeze({
  [STOCK_CLASSES.RELAY_LEADER]: "连板龙头型",
  [STOCK_CLASSES.STRONG_REVERSAL]: "强势反包型",
  [STOCK_CLASSES.SWING_RANGE]: "波段震荡型",
});
// 类别封顶：连板龙头最高 A、强势反包最高 B、波段震荡最高 C、
// 未分类（null/未知）最高 B。
const CLASS_CEILING = Object.freeze({
  [STOCK_CLASSES.RELAY_LEADER]: "A",
  [STOCK_CLASSES.STRONG_REVERSAL]: "B",
  [STOCK_CLASSES.SWING_RANGE]: "C",
});
// A 级买点：语义上是"已验证可交易的龙头低吸买点"。这一集合同时定义两件
// 事情：① 观察池分级的 A 级校验（observationGrade，仅展示）；② v4 建仓
// 硬闸门（buyPointGateForPolicy，影响交易）。刻意共用一个定义而不是维护
// 两份集合——两者漂移会让展示等级与建仓资格自相矛盾。新增买点必须先在其
// 所属策略上积累样本验证，再进这个集合，两处同时生效。
const A_GRADE_BUY_POINTS = new Set([
  BUY_POINT_TYPES.LIMIT_UP_MOMENTUM,
  BUY_POINT_TYPES.BROKEN_BOARD_DIP,
]);
const buyPointTypes = (buyPoint) =>
  buyPoint?.labels ?? (buyPoint?.primary?.type ? [buyPoint.primary.type] : []);

// 判定顺序：硬排除 → 评分下限 → 类别上限 → A 级买点校验。
// grade 为 null 只表示"剔除观察池"，不删除信号、不改变交易动作。
export function observationGrade(signal = {}) {
  const score = signal.score;
  if (!Number.isFinite(score))
    return { grade: null, gradeReason: "缺少有效评分" };
  if (score < 40) return { grade: null, gradeReason: "评分低于 40" };
  if (signal.stockClass === STOCK_CLASSES.MEDIOCRE)
    return { grade: null, gradeReason: "平庸型" };

  const floor = score >= 80 ? "A" : score >= 60 ? "B" : "C";
  const ceiling = CLASS_CEILING[signal.stockClass] ?? "B";
  let grade = GRADE_ORDER[floor] >= GRADE_ORDER[ceiling] ? floor : ceiling;

  const qualifiedBuyPoint = buyPointTypes(signal.buyPoint).some((type) =>
    A_GRADE_BUY_POINTS.has(type),
  );
  const buyPointDowngraded = grade === "A" && !qualifiedBuyPoint;
  if (buyPointDowngraded) grade = "B";

  const classLabel = CLASS_LABELS[signal.stockClass] ?? "未分类（最高 B）";
  const reasonParts = [`评分 ${score}`, classLabel];
  if (buyPointDowngraded) reasonParts.push("买点未命中打板/炸板低吸，降为 B");
  else if (GRADE_ORDER[ceiling] > GRADE_ORDER[floor])
    reasonParts.push(`按类别封顶为 ${ceiling}`);
  return { grade, gradeReason: reasonParts.join(" · ") };
}

export function annotateObservationGrades(signals) {
  return signals.map((signal) => ({ ...signal, ...observationGrade(signal) }));
}

export function rankSignals(signals, policy) {
  selectionPolicyDigest(policy);
  return [...signals].sort((a, b) => {
    if (policy.version === LEGACY_SELECTION_VERSION)
      return (b.score ?? -1) - (a.score ?? -1) || codeOrder(a, b);
    const scoreOrder = (b.scoreRankKey ?? -1) - (a.scoreRankKey ?? -1);
    if (scoreOrder) return scoreOrder;
    // 未知成交额只在实际同分时靠后，不能盖过信号强弱。
    const amountOrder =
      (b.liquidityAmountCents ?? -1) - (a.liquidityAmountCents ?? -1);
    return amountOrder || codeOrder(a, b);
  });
}
