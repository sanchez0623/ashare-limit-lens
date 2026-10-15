import { digestOf } from "./research-lineage.js";
// 选股政策与纯排序内核。每个版本的完整内容固定，禁止同编号改规则。
// 缺少版本的历史账户/清单按 v1 解释；新账户显式采用最新版本。
export const LEGACY_SELECTION_VERSION = "signal-ranking-v1";
export const SELECTION_VERSION_V2 = "signal-ranking-v2";
export const DEFAULT_SELECTION_VERSION = "signal-ranking-v3";
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
  [DEFAULT_SELECTION_VERSION]: Object.freeze({
    version: DEFAULT_SELECTION_VERSION,
    scorePrecision: 6,
    liquiditySource: "signal-day-turnover-cny",
    tieBreak: "code-asc",
    stockClassRouting: true,
  }),
});
// SHA-256(canonicalJson(policy))。常量使同步纯内核也能冻结完整摘要；
// 回归测试独立重算，政策字段变化必须新增版本及摘要。
const digests = Object.freeze({
  [LEGACY_SELECTION_VERSION]:
    "7b340abd928a57f1d401351952ad40219e29a81ee74a33f44747b128209f883a",
  [SELECTION_VERSION_V2]:
    "250aed8e31828b808180950a096ecf489c9fef150896d2495ba0708c3ef1cd32",
  [DEFAULT_SELECTION_VERSION]:
    "508cd643a3e2ef3842b55a89ec761a0a39851e7fd327c14fae96f39c5a828aa7",
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
export function liquidityAmountCents(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
const codeOrder = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
// 股票/板块列表在选股输入中是集合；因子数组仍有权重位置含义，不能重排。
export function selectionSnapshotDigest(snapshot) {
  return digestOf({
    ...snapshot,
    stocks: [...snapshot.stocks].sort(codeOrder),
    sectors: [...snapshot.sectors].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
  });
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
