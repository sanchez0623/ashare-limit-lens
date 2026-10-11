// 最小消息模板与脱敏（§7）：默认不含资产金额、持仓数量、真实账户标识、
// 原始 URL、Key 或堆栈。中文只用于展示。
import { fingerprintOf } from "./alert-rules.js";
import { marketClock } from "./realtime.js";

export function instanceAlias(env) {
  const alias = env?.ALERT_INSTANCE_ALIAS;
  return typeof alias === "string" && alias.trim()
    ? alias.trim().slice(0, 40)
    : "paper-instance";
}

// 库里的时刻一律是 UTC ISO；直接截断字符串会把 UTC 当成北京时间显示，
// 与操作者墙上的时钟差 8 小时。展示统一换算到北京时间。
function beijingStamp(iso) {
  if (!iso) return "";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  const clock = marketClock(at);
  return `${clock.date} ${clock.time}`;
}

const RULE_LABELS = {
  RUNNER_STALLED: "执行循环停滞",
  LOOP_FAILED: "执行循环连续失败",
  SESSION_BLOCKED: "交易会话被阻塞",
  REQUIRED_QUOTE_STALE: "关键报价陈旧",
  DRAWDOWN_TRIPPED: "账户回撤触及硬约束",
  PROTECTIVE_EXIT_BLOCKED: "保护退出无法成交",
  T_RECOVERY_INCOMPLETE: "做 T 第二腿未恢复",
  SETTLEMENT_LATE: "盘后结算迟延",
  LEDGER_INVARIANT_FAILED: "账本不变式异常",
  ALERT_PIPELINE_STALLED: "告警分发停滞",
  AI_OR_RESEARCH_FAILED: "AI/研究任务失败",
};

const SEVERITY_LABELS = { WARNING: "警告", CRITICAL: "严重" };

export function formatSafeNotification({
  event,
  incident,
  instanceAlias: alias,
  now,
  privacyMode = true,
}) {
  const ruleLabel = RULE_LABELS[incident.ruleType] ?? incident.ruleType;
  const header = `[${SEVERITY_LABELS[incident.severity] ?? incident.severity}] ${ruleLabel}`;
  const lines = [
    header,
    `实例: ${alias}`,
    `规则: ${incident.ruleType} / ${incident.fingerprint === fingerprintOf({ ruleType: incident.ruleType, entityRef: incident.entityRef }) ? (incident.entityRef ?? "primary") : incident.fingerprint}`,
    `北京时间: ${beijingStamp(now)}`,
  ];
  // 刚触发的告警不显示"持续时间: 1 分钟"这类凑数结论；满一分钟才给出。
  const durationMinutes =
    incident.firstSeen && now
      ? Math.round(
          (new Date(now).getTime() - new Date(incident.firstSeen).getTime()) /
            60000,
        )
      : 0;
  if (durationMinutes >= 1) lines.push(`持续时间: ${durationMinutes} 分钟`);
  if (event?.reasonCode) lines.push(`原因: ${event.reasonCode}`);
  if (!privacyMode && event?.safeFacts)
    lines.push(
      `事实: ${Object.entries(event.safeFacts)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(" ")}`,
    );
  lines.push("处理入口: 本机网页「运维告警」页面");
  return { title: header, text: lines.join("\n") };
}

// 恢复摘要：未曾成功通知就恢复的问题，发送"发生并恢复"，不能只发莫名恢复。
export function formatResolvedNotification({
  incident,
  instanceAlias: alias,
  now,
}) {
  const ruleLabel = RULE_LABELS[incident.ruleType] ?? incident.ruleType;
  return {
    title: `[已恢复] ${ruleLabel}`,
    text: [
      `[已恢复] ${ruleLabel}`,
      `实例: ${alias}`,
      `规则: ${incident.ruleType}`,
      `发生: ${beijingStamp(incident.firstSeen)}`,
      `恢复: ${beijingStamp(now)}`,
    ].join("\n"),
  };
}
