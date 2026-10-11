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
  DRAWDOWN_LIMIT: "DRAWDOWN_LIMIT", // 账户回撤触及硬约束，买入被暂停
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
// 运行阻塞与故障之外，执行层还会给出独立于 status 的风险事实：回撤触及
// 硬约束、保护退出被阻塞、做 T 第二腿未恢复、持仓关键报价缺失。这些事实
// 与"本轮是 RUNNING 还是 STALE_QUOTES"无关，必须各自入账，否则会漏报。
export function classifyOperationalFacts(input) {
  const events = [];
  const { source = "loop", result = null, now, tradeDate = null } = input ?? {};
  const base = { occurredAt: now, tradeDate, source };
  if (source === "loop") {
    const status = result?.status;
    const problems = [];
    if (status === "ERROR" || result?.error)
      // ERROR 轮次只可能来自未捕获异常（pollTrading 的 catch 或 runner 循环的
      // catch），二者都是程序故障而非业务结果。不能依赖 error instanceof Error
      // 判断——异常跨过序列化边界后类型信息丢失（runner 实际只传
      // status: "ERROR"），靠它区分会把盘后异常错误归为普通执行错误并遭到
      // 时段抑制（P1-5 复现路径）。
      problems.push({
        ...base,
        type: EVENT_TYPES.LOOP_ERROR,
        ruleType: RULE_TYPES.LOOP_FAILED,
        reasonCode: REASON_CODES.RUNNER_FAILED,
        entityRef: "primary",
        safeFacts: { status: status ?? "ERROR", isException: true },
      });
    else if (status === "BLOCKED")
      // 缺前日结算/缺事前计划是不可执行条件（SESSION_BLOCKED）；
      // 其余 BLOCKED 子原因在 safeFacts 中保留展示文本，但不虚告警。
      problems.push({
        ...base,
        type: EVENT_TYPES.LOOP_RESULT,
        ruleType: RULE_TYPES.SESSION_BLOCKED,
        reasonCode: /计划/.test(result.reason ?? "")
          ? REASON_CODES.MISSING_PLAN
          : REASON_CODES.MISSING_SETTLEMENT,
        entityRef: "primary",
        safeFacts: {},
      });
    // 关键报价缺失（持仓或挂单所需的股票没有本帧有效报价）：只要还有股票
    // 新鲜，旧实现会报 RUNNING 掩盖整只股票的停摆。这里按缺失只数如实入账。
    const missingQuoteCodes = Array.isArray(result?.missingQuoteCodes)
      ? result.missingQuoteCodes
      : [];
    if (status === "STALE_QUOTES" || missingQuoteCodes.length)
      problems.push({
        ...base,
        type: EVENT_TYPES.LOOP_RESULT,
        ruleType: RULE_TYPES.REQUIRED_QUOTE_STALE,
        reasonCode: REASON_CODES.STALE_QUOTE,
        entityRef: "primary",
        safeFacts: {
          freshQuotes: result.freshQuotes ?? 0,
          watchedCodes: result.watchedCodes ?? 0,
          missingQuotes: missingQuoteCodes.length || null,
          affectsProtectiveExit: Boolean(result.affectsProtectiveExit),
        },
      });
    if (result?.drawdownBreached)
      problems.push({
        ...base,
        type: EVENT_TYPES.LOOP_RESULT,
        ruleType: RULE_TYPES.DRAWDOWN_TRIPPED,
        reasonCode: REASON_CODES.DRAWDOWN_LIMIT,
        entityRef: "primary",
        safeFacts: { drawdown: result.drawdown ?? null },
      });
    // 保护退出被阻塞：止损/保护订单已触发却无法成交（跌停、无流动性、T+1），
    // 持仓暴露在无保护状态，属风险暴露而非正常约束。
    const blockedProtectiveExits = Array.isArray(result?.blockedProtectiveExits)
      ? result.blockedProtectiveExits
      : [];
    if (blockedProtectiveExits.length)
      problems.push({
        ...base,
        type: EVENT_TYPES.LOOP_RESULT,
        ruleType: RULE_TYPES.PROTECTIVE_EXIT_BLOCKED,
        reasonCode: REASON_CODES.PROTECTIVE_EXIT_BLOCKED,
        entityRef: "primary",
        safeFacts: { codes: blockedProtectiveExits },
      });
    // 做 T 第二腿在检查时点之后仍未完成：第一腿已成交，敞口留在账上。
    const incompleteRecoveries = Array.isArray(result?.incompleteRecoveries)
      ? result.incompleteRecoveries
      : [];
    if (incompleteRecoveries.length)
      problems.push({
        ...base,
        type: EVENT_TYPES.LOOP_RESULT,
        ruleType: RULE_TYPES.T_RECOVERY_INCOMPLETE,
        reasonCode: REASON_CODES.T_RECOVERY_INCOMPLETE,
        entityRef: "primary",
        safeFacts: { codes: incompleteRecoveries },
      });
    // 除权不匹配（昨收与冻结参考价不一致）导致该股暂停交易：§3.1 列为
    // "需要处理的运行阻塞，立即告警"，不能因为其他股票正常就报 RUNNING 掩盖。
    const corporateActionHolds = Array.isArray(result?.corporateActionHolds)
      ? result.corporateActionHolds
      : [];
    if (corporateActionHolds.length)
      problems.push({
        ...base,
        type: EVENT_TYPES.LOOP_RESULT,
        ruleType: RULE_TYPES.SESSION_BLOCKED,
        reasonCode: REASON_CODES.CORPORATE_ACTION_UNVERIFIED,
        entityRef: "primary",
        safeFacts: { codes: corporateActionHolds },
      });
    events.push(...problems);
    // 恢复必须由正向证据驱动（§3 恢复条件）：只有真正执行过一轮、且本轮
    // 已验证相关条件不成立的规则才发"已清除"。休市/结算/跳过/失败轮次
    // 什么都没有验证，绝不能被当成"问题已消失"。
    const verified = status === "RUNNING" || status === "STALE_QUOTES";
    if (verified) {
      const reported = new Set(problems.map((event) => event.ruleType));
      const clearable = [
        RULE_TYPES.LOOP_FAILED,
        RULE_TYPES.SESSION_BLOCKED,
        RULE_TYPES.PROTECTIVE_EXIT_BLOCKED,
        RULE_TYPES.T_RECOVERY_INCOMPLETE,
        RULE_TYPES.REQUIRED_QUOTE_STALE,
      ];
      for (const ruleType of clearable) {
        if (reported.has(ruleType)) continue;
        // 报价缺失的恢复要求"该股票重新获得合格报价"；只要本轮还有缺失，
        // 就不能通过 STALE_QUOTES 轮次宣告恢复。
        if (
          ruleType === RULE_TYPES.REQUIRED_QUOTE_STALE &&
          missingQuoteCodes.length
        )
          continue;
        // 会话恢复要求交易真正恢复，而不是仅"本轮没报错"。
        if (ruleType === RULE_TYPES.SESSION_BLOCKED && status !== "RUNNING")
          continue;
        events.push({
          ...base,
          type: EVENT_TYPES.LOOP_RESULT,
          ruleType,
          reasonCode: null,
          entityRef: "primary",
          cleared: true,
          safeFacts: {},
        });
      }
    }
  } else if (source === "daily") {
    const paper = result?.paper ?? {};
    const settled =
      paper.status === "SETTLED" || paper.status === "NON_TRADING_DAY";
    const snapshotSaved = result?.snapshot?.saved !== false;
    const nextPlan = Boolean(paper.nextPlan);
    const late =
      !settled || !snapshotSaved || (!nextPlan && paper.status === "SETTLED");
    if (late)
      events.push({
        ...base,
        type: EVENT_TYPES.DAILY_RESULT,
        ruleType: RULE_TYPES.SETTLEMENT_LATE,
        reasonCode: REASON_CODES.SETTLEMENT_FAILED,
        entityRef: "primary",
        safeFacts: { settled, snapshotSaved, nextPlan },
      });
    else
      // 三项均完成（结算、归档、冻结下一日计划）是结算迟延唯一的恢复证据。
      events.push({
        ...base,
        type: EVENT_TYPES.DAILY_RESULT,
        ruleType: RULE_TYPES.SETTLEMENT_LATE,
        reasonCode: null,
        entityRef: "primary",
        cleared: true,
        safeFacts: {},
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
    else if (tournament)
      // 研究任务本轮真的跑过且没报错，才是"研究恢复"的正向证据；
      // 本轮压根没有研究任务（tournament 缺省）什么都没验证。
      events.push({
        ...base,
        type: EVENT_TYPES.RESEARCH_RESULT,
        ruleType: RULE_TYPES.AI_OR_RESEARCH_FAILED,
        reasonCode: null,
        entityRef: "tournament",
        cleared: true,
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
  now = new Date().toISOString(),
}) {
  const evaluations = [];
  const byFingerprint = new Map();
  for (const event of events) {
    const fingerprint = fingerprintOf(event);
    byFingerprint.set(fingerprint, event);
    const phase = marketPhase(marketContext);
    // 持续时间取自实例首次发生时刻，而不是本批事件的到达时间：升级要看
    // "已经持续多久"，只看本轮事件永远得不到持续时间，升级规则永不触发。
    // 已恢复实例不作为持续时间基准：补读旧事件触发"重新打开"时是新一段
    // 故障，拿旧 firstSeen 算时长会凭空报出荒谬的持续时间并直接跳到 CRITICAL。
    const related =
      previousIncident &&
      previousIncident.fingerprint === fingerprint &&
      previousIncident.status !== "RESOLVED"
        ? previousIncident
        : null;
    const activeSeconds = related
      ? Math.max(
          0,
          (new Date(now).getTime() - new Date(related.firstSeen).getTime()) /
            1000,
        )
      : 0;
    const durationFacts =
      event.ruleType === RULE_TYPES.LOOP_FAILED
        ? { failedSeconds: Math.round(activeSeconds) }
        : event.ruleType === RULE_TYPES.REQUIRED_QUOTE_STALE
          ? { staleSeconds: Math.round(activeSeconds) }
          : null;
    const enriched = durationFacts
      ? { ...event, safeFacts: { ...event.safeFacts, ...durationFacts } }
      : event;
    // 同批内"问题事实"优先于"已清除事实"：一轮既能报问题也能报清除时，
    // 只有问题才是当前状态。
    if (event.cleared) {
      const hasProblem = events.some(
        (row) => !row.cleared && fingerprintOf(row) === fingerprint,
      );
      if (hasProblem) continue;
      evaluations.push({
        event: enriched,
        fingerprint,
        severity: related?.severity ?? SEVERITIES.WARNING,
        activeSeconds,
        cleared: true,
        suppressed: false,
      });
      continue;
    }
    const severity = severityOf(enriched, policy, phase);
    // 午休与非交易时段不把"运行健康"类告警视为故障（§3.2）：
    // LOOP_FAILED(普通错误 EXECUTION_ERROR)、REQUIRED_QUOTE_STALE、RUNNER_STALLED 只在
    // 连续竞价期间推进；但 LOOP_FAILED 对应的 RUNNER_FAILED（进程抛异常）、
    // 以及 LEDGER_INVARIANT_FAILED、SESSION_BLOCKED、DRAWDOWN_TRIPPED、
    // PROTECTIVE_EXIT_BLOCKED、T_RECOVERY_INCOMPLETE、AI_OR_RESEARCH_FAILED
    // 属于风险暴露或阻塞类，全天有效，不受时段抑制。
    const isExceptionLoopFailed =
      event.ruleType === RULE_TYPES.LOOP_FAILED &&
      (event.reasonCode === REASON_CODES.RUNNER_FAILED ||
        event.safeFacts?.isException === true);
    const suppressed =
      !isExceptionLoopFailed &&
      (event.ruleType === RULE_TYPES.LOOP_FAILED ||
        event.ruleType === RULE_TYPES.REQUIRED_QUOTE_STALE ||
        event.ruleType === RULE_TYPES.RUNNER_STALLED) &&
      !["MORNING", "AFTERNOON"].includes(phase.phase);
    evaluations.push({
      event: enriched,
      fingerprint,
      severity,
      activeSeconds,
      suppressed,
    });
  }
  // 本批完全没有事实的既有实例：只是"本轮没有新证据"，既不是恢复也不是问题，
  // 状态机必须原样保持（§3 的恢复条件都需要正向证据）。
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

// 维护窗口抑制的运行类规则（§4.2）：维护期内只静默"运行健康"类告警；
// 账本不变式、回撤触及硬约束、保护退出阻塞属于风险暴露，不受维护静默。
export const MAINTENANCE_SUPPRESSED_RULES = new Set([
  RULE_TYPES.LOOP_FAILED,
  RULE_TYPES.RUNNER_STALLED,
  RULE_TYPES.REQUIRED_QUOTE_STALE,
  RULE_TYPES.SETTLEMENT_LATE,
  RULE_TYPES.AI_OR_RESEARCH_FAILED,
]);

export function suppressedByMaintenance(ruleType, until, now) {
  return (
    Boolean(until) && until > now && MAINTENANCE_SUPPRESSED_RULES.has(ruleType)
  );
}

// 状态机转换（§5.3）：OPEN → 升级/提醒 → RESOLVED；ACK 只静默提醒不阻止升级。
// 恢复只能由正向证据（cleared）驱动：没有新证据既不恢复也不升级。
// 幂等性（P1-4）：补读旧事件（occurredAt <= resolvedAt）不得重新打开已恢复实例。
export function transitionIncident({
  incident,
  evaluation,
  now,
  policy = DEFAULT_ALERT_POLICY,
}) {
  // 新实例：只有问题事实能开实例。
  if (!incident)
    return evaluation.absent || evaluation.suppressed || evaluation.cleared
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

  // 观测顺序守卫（P1-1）：迟到的执行器 now 早于实例已记录的最后观测时，它读到
  // 的是旧世界。严重度随时长/时段单调不减，旧观测恒被更新的观测支配，写回只会
  // 把已升级的 CRITICAL 降级、把 lastSeen 回退。更新的观测已覆盖本批事实，静默保持。
  if (incident.lastSeen && now < incident.lastSeen)
    return { action: "KEEP", patch: {}, notify: null };

  // 幂等性：实例已恢复且本批事件为旧事件重放（发生时刻不晚于恢复时刻），忽略。
  if (
    incident.status === "RESOLVED" &&
    incident.resolvedAt &&
    evaluation.event?.occurredAt &&
    evaluation.event.occurredAt <= incident.resolvedAt
  ) {
    return { action: "KEEP", patch: {}, notify: null };
  }
  // 本批没有任何事实：保持现状，不写库、不通知。
  if (evaluation.absent) return { action: "KEEP", patch: {}, notify: null };
  if (evaluation.suppressed) return { action: "KEEP", patch: {}, notify: null };
  // 正向证据表明条件消失：宽限期后恢复（§3 各规则的恢复条件）。
  if (evaluation.cleared) {
    if (incident.status === "RESOLVED") return null;
    const silent = Boolean(incident.ackUntil && incident.ackUntil > now);
    const clearedSeconds =
      (new Date(now).getTime() - new Date(incident.lastSeen).getTime()) / 1000;
    if (clearedSeconds < policy.resumeGraceSeconds)
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
  const reopened = incident.status === "RESOLVED";
  const escalated =
    evaluation.severity === SEVERITIES.CRITICAL &&
    incident.severity !== SEVERITIES.CRITICAL;
  // 去重基准是"上次安排通知的时刻"，提醒节奏基准是"上次成功送达的时刻"：
  // 入队不等于送达，两者不能混为一个标志。
  const scheduledAt =
    incident.notifyScheduledAt ??
    incident.lastNotifiedAt ??
    incident.firstSeen ??
    incident.lastSeen;
  const sinceScheduled =
    (new Date(now).getTime() - new Date(scheduledAt).getTime()) / 1000;
  const ackActive =
    Boolean(incident.ackUntil && incident.ackUntil > now) && !reopened;
  let notify = null;
  if (escalated) notify = { type: "ESCALATED", severity: SEVERITIES.CRITICAL };
  else if (reopened || !incident.notifyScheduledAt)
    // 重新打开是新一段故障的开始：重发 OPEN 通知，旧实例的通知状态不继承。
    notify = { type: "OPEN", severity: evaluation.severity };
  else if (!ackActive && sinceScheduled >= policy.remindEverySeconds)
    notify = { type: "REMIND", severity: evaluation.severity };
  return {
    action: escalated || reopened ? "ESCALATE" : "KEEP",
    patch: {
      status: "OPEN",
      severity: evaluation.severity,
      lastSeen: now,
      ...(escalated || reopened
        ? {
            ackUntil: null,
            // 重开必须清除恢复标记并重置起始时刻：resolved_at 残留会让
            // 活动实例查询永远漏掉它，旧 firstSeen 会伪造超长持续时间。
            ...(reopened ? { resolvedAt: null, firstSeen: now } : {}),
          }
        : {}),
    },
    notify,
    silent: ackActive && !escalated && !reopened,
  };
}
