export const RESEARCH_STAGES = {
  PROPOSING: "提案中",
  HISTORICAL_CHECK: "历史筛查中",
  AWAITING_SHADOW: "等待影子验证",
  SHADOWING: "影子验证中",
  EVALUATING: "评估中",
  APPROVED: "已批准待排期",
  SCHEDULED: "已排期",
  PROMOTED: "已启用",
  REJECTED: "历史筛查未通过",
  ERROR: "提案或验证出错",
  INCONCLUSIVE: "证据不足",
  INVALIDATED: "环境变化已失效",
  LEGACY_VALIDATED: "历史通过（无启用资格）",
  SHADOW_PENDING: "等待影子验证",
};
export const RESEARCH_ROLES = {
  TRAIN: "训练",
  HISTORICAL_TEST: "历史测试",
  FORWARD_TEST: "前瞻测试",
  SELECTION: "参数选择",
};
export const RESEARCH_PROPOSE_STATUS = {
  COLLECTING: "数据积累中",
  NOT_CONFIGURED: "未配置大模型",
  BUSY: "已有进行中的实验",
  BUDGET_EXHAUSTED: "本月提案次数已用完",
  AWAITING_SHADOW: "历史通过，等待影子验证",
  REJECTED: "历史筛查未通过",
  ERROR: "提案或验证出错",
};
export const RESEARCH_TERMINAL_STAGES = new Set([
  "REJECTED",
  "ERROR",
  "INCONCLUSIVE",
  "INVALIDATED",
]);
