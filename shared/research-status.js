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
export const COHORT_STAGES = {
  RESERVED: "已预留",
  PROPOSING: "候选生成中",
  FROZEN: "候选已冻结",
  HISTORICAL_CHECK: "历史筛查中",
  SCHEDULED: "前瞻窗口已排期",
  RUNNING: "前瞻窗口运行中",
  EVALUATING: "批次评估中",
  CLOSED: "批次已结束",
};
export const COHORT_ACTIVE_STAGES = new Set([
  "RESERVED",
  "PROPOSING",
  "FROZEN",
  "HISTORICAL_CHECK",
  "SCHEDULED",
  "RUNNING",
  "EVALUATING",
]);
export const COHORT_MEMBER_STAGES = {
  PROPOSING: "候选生成中",
  HISTORICAL_CHECK: "历史筛查中",
  SCHEDULED: "已进入前瞻窗口",
  RUNNING: "前瞻运行中",
  ELIGIBLE: "符合晋级条件",
  PROMOTED: "已启用",
  REJECTED: "历史筛查未通过",
  ERROR: "候选生成或验证出错",
  INCONCLUSIVE: "证据不足",
  INVALIDATED: "环境变化已失效",
};
