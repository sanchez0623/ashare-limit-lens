// 运维告警规则域（§3/§5.1）：结构化原因、时段、持续时间、严重程度与恢复判定。
// 中文 reason 只用于展示；告警器只解析结构化枚举，不用中文字符串判断严重程度。
// 纯函数，不调用 HTTP、不写日志、不发通知。

// 原因枚举（§3.1）：交易约束与运行阻塞严格分开。
export const REASON_CODES = {
  // 正常执行结果：保存记录，不告警。
  T1_UNAVAILABLE: "T1_UNAVAILABLE", // 当日新买不可卖（T+1 约束）
  LIMIT_UP: "LIMIT_UP", // 涨停无法买入（预期约束）
  LIMIT_DOWN: "LIMIT_DOWN", // 跌停无法卖出
  NO_LIQUIDITY: "NO_LIQUIDITY", // 成交量不足等待
  NOT_TRIGGERED: "NOT_TRIGGERED", // 保护条件未触发
  // 交易约束但构成风险暴露：需要通知（不虚构成交）。
  PROTECTIVE_EXIT_BLOCKED: "PROTECTIVE_EXIT_BLOCKED",
  T_RECOVERY_INCOMPLETE: "T_RECOVERY_INCOMPLETE",
  // 运行阻塞：立即告警。
  MISSING_PLAN: "MISSING_PLAN",
  MISSING_SETTLEMENT: "MISSING_SETTLEMENT",
  CORPORATE_ACTION_UNVERIFIED: "CORPORATE_ACTION_UNVERIFIED",
  LEDGER_INVARIANT_FAILED: "LEDGER_INVARIANT_FAILED",
  // 程序故障。
  EXECUTION_ERROR: "EXECUTION_ERROR",
  STALE_QUOTE: "STALE_QUOTE",
  RUNNER_FAILED: "RUNNER_FAILED",
  SETTLEMENT_FAILED: "SETTLEMENT_FAILED",
  RESEARCH_FAILED: "RESEARCH_FAILED",
};

export const SEVERITIES = { WARNING: "WARNING", CRITICAL: "CRITICAL" };

// 规则定义（§3）：trigger 判定事件是否命中，duration 与恢复条件用默认策略。
export const RULE_TYPES = {
  RUNNER_STALLED: "RUNNER_STALLED",
  LOOP_FAILED: "LOOP_FAILED",
  SESSION_BLOCKED: "SESSION_BLOCKED",
  REQUIRED_QUOTE_STALE: "REQUIRED_QUOTE_STALE",
  DRAWDOWN_TRIPPED: "DRAWDOWN_TRIPPED",
  PROTECTIVE_EXIT_BLOCKED: "PROTECTIVE_EXIT_BLOCKED",
  T_RECOVERY_INCOMPLETE: "T_RECOVERY_INCOMPLETE",
  SETTLEMENT_LATE: "SETTLEMENT_LATE",
  LEDGER_INVARIANT_FAILED: "LEDGER_INVARIANT_FAILED",
  ALERT_PIPELINE_STALLED: "ALERT_PIPELINE_STALLED",
  AI_OR_RESEARCH_FAILED: "AI_OR_RESEARCH_FAILED",
};

export const EVENT_TYPES = {
  LOOP_ERROR: "LOOP_ERROR",
  LOOP_RESULT: "LOOP_RESULT",
  DAILY_RESULT: "DAILY_RESULT",
  LEDGER_INVARIANT: "LEDGER_INVARIANT",
  RESEARCH_RESULT: "RESEARCH_RESULT",
  TEST: "TEST",
  MAINTENANCE: "MAINTENANCE",
};

// 默认策略（§3 表）：所有者可配置并版本化，AI 不得降低或关闭。
export const DEFAULT_ALERT_POLICY = {
  runnerStalledSeconds: 90, // max(90, 6×轮询间隔) 在评估时取较大值
  loopFailedRounds: 3,
  loopFailedSeconds: 30,
  loopFailedEscalateSeconds: 90,
  requiredQuoteStaleSeconds: 30,
  requiredQuoteStaleCriticalSeconds: 60,
  settlementLateWarningAt: "15:20:00",
  settlementLateCriticalAt: "15:30:00",
  tRecoveryCheckAt: "14:50:00",
  tRecoveryCriticalAt: "14:55:00",
  escalateAfterSeconds: 300, // 持续 5 分钟升级一次
  remindEverySeconds: 900, // 之后每 15 分钟提醒
  resumeGraceSeconds: 120,
  maxAttempts: 5,
  backoffSeconds: [5, 30, 120, 600],
};

export function validateAlertPolicy(policy) {
  if (!policy || typeof policy !== "object") throw new Error("策略必须为对象");
  const int = (key, min, max) => {
    const value = policy[key];
    if (
      !Number.isInteger(value) ||
      value < min ||
      value > max ||
      (key === "escalateAfterSeconds" || key === "remindEverySeconds"
        ? value < 30
        : false)
    )
      throw new Error(`策略项 ${key} 必须为 ${min}–${max} 的整数`);
  };
  int("runnerStalledSeconds", 30, 3600);
  int("loopFailedRounds", 1, 60);
  int("loopFailedSeconds", 10, 3600);
  int("loopFailedEscalateSeconds", 30, 3600);
  int("requiredQuoteStaleSeconds", 10, 3600);
  int("requiredQuoteStaleCriticalSeconds", 20, 3600);
  int("escalateAfterSeconds", 30, 86400);
  int("remindEverySeconds", 30, 86400);
  int("resumeGraceSeconds", 0, 3600);
  int("maxAttempts", 1, 20);
  for (const key of [
    "settlementLateWarningAt",
    "settlementLateCriticalAt",
    "tRecoveryCheckAt",
    "tRecoveryCriticalAt",
  ])
    if (!/^\d{2}:\d{2}:\d{2}$/.test(policy[key] ?? ""))
      throw new Error(`策略项 ${key} 必须为 HH:MM:SS`);
  if (
    policy.settlementLateWarningAt >= policy.settlementLateCriticalAt ||
    policy.tRecoveryCheckAt >= policy.tRecoveryCriticalAt
  )
    throw new Error("策略项的警告时点必须早于升级时点");
  if (!Array.isArray(policy.backoffSeconds) || !policy.backoffSeconds.length)
    throw new Error("策略项 backoffSeconds 必须为非空数组");
  if (
    policy.backoffSeconds.some((v) => !Number.isInteger(v) || v < 1 || v > 3600)
  )
    throw new Error("退避秒数必须为 1–3600 的整数");
  return policy;
}

// 时段（§3.2）：Asia/Shanghai。marketContext 由调用方按市场时钟传入，
// 域层只做判定，不自取时间。
export function marketPhase(marketContext) {
  const { date, time, weekday, calendarConfirmed } = marketContext ?? {};
  if (typeof time !== "string") return { phase: "UNKNOWN", time: null };
  const context = {
    time,
    date: date ?? null,
    weekday: weekday ?? null,
    calendarConfirmed: Boolean(calendarConfirmed),
  };
  if (time >= "09:30:00" && time < "11:30:00")
    return { ...context, phase: "MORNING" };
  if (time >= "13:00:00" && time < "14:57:00")
    return { ...context, phase: "AFTERNOON" };
  if (time >= "11:30:00" && time < "13:00:00")
    return { ...context, phase: "LUNCH" };
  if (time >= "15:05:00" && time < "16:00:00")
    return { ...context, phase: "AFTER_CLOSE" };
  return { ...context, phase: "OFF_HOURS" };
}

// 事实分类（§3.1）：把 pollTrading / runDaily / 账本异常等已提交事实映射为
// 结构化运维事件。正常执行结果（未触发、涨停买不进、T+1 当日不可卖、
// 普通买单窗口结束）不产生告警事件。
export function classifyOperationalFacts(input) {
  const events = [];
  const { source = "loop", result = null, now, tradeDate = null } = input ?? {};
  const base = { occurredAt: now, tradeDate, source };
  if (source === "loop") {
    const status = result?.status;
    if (status === "ERROR" || result?.error)
      events.push({
        ...base,
        type: EVENT_TYPES.LOOP_ERROR,
        ruleType: RULE_TYPES.LOOP_FAILED,
        reasonCode: REASON_CODES.EXECUTION_ERROR,
        entityRef: "primary",
        safeFacts: { status: status ?? "ERROR" },
      });
    else if (status === "STALE_QUOTES")
      events.push({
        ...base,
        type: EVENT_TYPES.LOOP_RESULT,
        ruleType: RULE_TYPES.REQUIRED_QUOTE_STALE,
        reasonCode: REASON_CODES.STALE_QUOTE,
        entityRef: "primary",
        safeFacts: {
          freshQuotes: result.freshQuotes ?? 0,
          watchedCodes: result.watchedCodes ?? 0,
        },
      });
    else if (status === "BLOCKED")
      // 缺前日结算/缺事前计划是不可执行条件（SESSION_BLOCKED）；
      // 其余 BLOCKED 子原因在 safeFacts 中保留展示文本，但不虚告警。
      events.push({
        ...base,
        type: EVENT_TYPES.LOOP_RESULT,
        ruleType: RULE_TYPES.SESSION_BLOCKED,
        reasonCode: /计划/.test(result.reason ?? "")
          ? REASON_CODES.MISSING_PLAN
          : REASON_CODES.MISSING_SETTLEMENT,
        entityRef: "primary",
        safeFacts: {},
      });
  } else if (source === "daily") {
    const paper = result?.paper ?? {};
    const settled =
      paper.status === "SETTLED" || paper.status === "NON_TRADING_DAY";
    const snapshotSaved = result?.snapshot?.saved !== false;
    const nextPlan = Boolean(paper.nextPlan);
    if (!settled || !snapshotSaved || (!nextPlan && paper.status === "SETTLED"))
      events.push({
        ...base,
        type: EVENT_TYPES.DAILY_RESULT,
        ruleType: RULE_TYPES.SETTLEMENT_LATE,
        reasonCode: REASON_CODES.SETTLEMENT_FAILED,
        entityRef: "primary",
        safeFacts: { settled, snapshotSaved, nextPlan },
      });
    const tournament = result?.tournament;
    if (tournament && tournament.error)
      events.push({
        ...base,
        type: EVENT_TYPES.RESEARCH_RESULT,
        ruleType: RULE_TYPES.AI_OR_RESEARCH_FAILED,
        reasonCode: REASON_CODES.RESEARCH_FAILED,
        entityRef: "tournament",
        safeFacts: {},
      });
  } else if (source === "ledger") {
    events.push({
      ...base,
      type: EVENT_TYPES.LEDGER_INVARIANT,
      ruleType: RULE_TYPES.LEDGER_INVARIANT_FAILED,
      reasonCode: REASON_CODES.LEDGER_INVARIANT_FAILED,
      entityRef: input.accountId ?? "primary",
      safeFacts: {},
    });
  } else if (source === "research") {
    events.push({
      ...base,
      type: EVENT_TYPES.RESEARCH_RESULT,
      ruleType: RULE_TYPES.AI_OR_RESEARCH_FAILED,
      reasonCode: REASON_CODES.RESEARCH_FAILED,
      entityRef: input.entityRef ?? "research",
      safeFacts: {},
    });
  }
  return events;
}

// fingerprint（§5.3）：结构化枚举 + 实体；不含可能带敏感信息的原始异常文本。
export function fingerprintOf(event) {
  return `${event.ruleType}:${event.entityRef ?? "primary"}`;
}

// 规则评估：输入当前事实、既有活动实例、策略与市场上下文，
// 输出状态机动作。不读写数据库。
export function evaluateAlertRules({
  events,
  previousIncident,
  policy = DEFAULT_ALERT_POLICY,
  marketContext,
}) {
  const evaluations = [];
  const byFingerprint = new Map();
  for (const event of events) {
    const fingerprint = fingerprintOf(event);
    byFingerprint.set(fingerprint, event);
    const phase = marketPhase(marketContext);
    const severity = severityOf(event, policy, phase);
    evaluations.push({
      event,
      fingerprint,
      severity,
      // 午休与非交易时段不把不成交视为故障（§3.2）：LOOP_FAILED 与
      // REQUIRED_QUOTE_STALE 只在连续竞价期间推进；其余规则全天有效。
      suppressed:
        (event.ruleType === RULE_TYPES.LOOP_FAILED ||
          event.ruleType === RULE_TYPES.REQUIRED_QUOTE_STALE ||
          event.ruleType === RULE_TYPES.RUNNER_STALLED) &&
        !["MORNING", "AFTERNOON"].includes(phase.phase),
    });
  }
  // 已不再上报的既有实例：条件可能已消失，由调用方结合 resumeGraceSeconds
  // 判定恢复；此处只标注"本批未见"。
  for (const incident of previousIncident ? [previousIncident] : []) {
    if (!byFingerprint.has(incident.fingerprint))
      evaluations.push({
        event: null,
        fingerprint: incident.fingerprint,
        severity: incident.severity,
        absent: true,
        suppressed: false,
      });
  }
  return evaluations;
}

function severityOf(event, policy, phase) {
  switch (event.ruleType) {
    case RULE_TYPES.DRAWDOWN_TRIPPED:
    case RULE_TYPES.LEDGER_INVARIANT_FAILED:
    case RULE_TYPES.SESSION_BLOCKED:
    case RULE_TYPES.RUNNER_STALLED:
      return SEVERITIES.CRITICAL;
    case RULE_TYPES.SETTLEMENT_LATE:
      return phase.phase === "AFTER_CLOSE" &&
        phase.time >= policy.settlementLateCriticalAt
        ? SEVERITIES.CRITICAL
        : SEVERITIES.WARNING;
    case RULE_TYPES.REQUIRED_QUOTE_STALE:
      return (event.safeFacts?.staleSeconds ?? 0) >=
        policy.requiredQuoteStaleCriticalSeconds ||
        event.safeFacts?.affectsProtectiveExit
        ? SEVERITIES.CRITICAL
        : SEVERITIES.WARNING;
    case RULE_TYPES.T_RECOVERY_INCOMPLETE:
      return phase.phase === "AFTERNOON" &&
        phase.time >= policy.tRecoveryCriticalAt
        ? SEVERITIES.CRITICAL
        : SEVERITIES.WARNING;
    case RULE_TYPES.LOOP_FAILED:
      return (event.safeFacts?.failedSeconds ?? 0) >=
        policy.loopFailedEscalateSeconds
        ? SEVERITIES.CRITICAL
        : SEVERITIES.WARNING;
    default:
      return SEVERITIES.WARNING;
  }
}

// 状态机转换（§5.3）：OPEN → 升级/提醒 → RESOLVED；ACK 只静默提醒不阻止升级。
export function transitionIncident({ incident, evaluation, now }) {
  const policy = DEFAULT_ALERT_POLICY;
  // 新实例。
  if (!incident)
    return evaluation.absent || evaluation.suppressed
      ? null
      : {
          action: "OPEN",
          patch: {
            status: "OPEN",
            severity: evaluation.severity,
            firstSeen: now,
            lastSeen: now,
            ackUntil: null,
            resolvedAt: null,
          },
          notify: { type: "OPEN", severity: evaluation.severity },
        };
  // 本批未见：宽限后恢复（恢复不能只因价格短暂反弹——由事件源停止上报驱动）。
  if (evaluation.absent) {
    if (incident.status === "RESOLVED") return null;
    const silent = incident.ackUntil && incident.ackUntil > now ? true : false;
    const absentSeconds =
      (new Date(now).getTime() - new Date(incident.lastSeen).getTime()) / 1000;
    if (absentSeconds < policy.resumeGraceSeconds)
      return { action: "KEEP", patch: {}, notify: null, silent };
    return {
      action: "RESOLVE",
      patch: { status: "RESOLVED", resolvedAt: now },
      notify: incident.notifiedOnce
        ? { type: "RESOLVED" }
        : { type: "RESOLVED_SUMMARY" },
      silent,
    };
  }
  if (evaluation.suppressed) return { action: "KEEP", patch: {}, notify: null };
  const escalated =
    evaluation.severity === SEVERITIES.CRITICAL &&
    incident.severity !== SEVERITIES.CRITICAL;
  const lastSeenAge =
    (new Date(now).getTime() - new Date(incident.lastSeen).getTime()) / 1000;
  const ackActive = Boolean(incident.ackUntil && incident.ackUntil > now);
  let notify = null;
  if (escalated) notify = { type: "ESCALATED", severity: SEVERITIES.CRITICAL };
  else if (!incident.notifiedOnce)
    notify = { type: "OPEN", severity: evaluation.severity };
  else if (!ackActive && lastSeenAge >= policy.remindEverySeconds)
    notify = { type: "REMIND", severity: evaluation.severity };
  return {
    action: escalated ? "ESCALATE" : "KEEP",
    patch: {
      status: "OPEN",
      severity: evaluation.severity,
      lastSeen: now,
      ...(escalated ? { ackUntil: null } : {}),
    },
    notify,
    silent: ackActive && !escalated,
  };
}
