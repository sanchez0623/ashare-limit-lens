// 外部失联监测信号（§4）：本机向外上报最小健康信号，超时由外部服务通知。
// 信号只含实例别名、角色、递增序号与最小状态；不含持仓、现金、URL、堆栈。
// Ping URL 是秘密：不写 Git、前端、普通日志或页面链接。失败静默——
// 本机无法上报时由外部服务按缺失信号告警。
const TIMEOUT_MS = 5000;
const PROGRESS_INTERVAL_MS = 60_000;

export function evaluateWatchdogHealth({
  runnerProgress,
  storageHealth,
  queueHealth,
  now = Date.now(),
}) {
  // 主进程返回了错误但仍在运行时，PROCESS_PROGRESS 可能正常；
  // 业务告警由本地规则触发——两个检查只证明各自监测的条件。
  const progressFresh =
    runnerProgress?.sequence != null &&
    runnerProgress.completedAt != null &&
    now - new Date(runnerProgress.completedAt).getTime() <
      PROGRESS_INTERVAL_MS * 3;
  const storageOk = storageHealth?.ok === true;
  const queueOk =
    queueHealth == null ||
    ((queueHealth.pending ?? 0) <= 20 && (queueHealth.expired ?? 0) < 100);
  return {
    processProgress: progressFresh && storageOk,
    alertPipeline: storageOk && queueOk,
    storageOk,
    queueOk,
    progressFresh,
  };
}

let lastReport = { progress: 0, pipeline: 0 };

export function resetWatchdogTimers() {
  lastReport = { progress: 0, pipeline: 0 };
}

async function ping(url, body) {
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// 主进程循环进度信号：仅在读取到新的实际循环进度且存储检查通过时发送（§4.1）。
export async function reportProcessProgress(env, { sequence, completedAt }) {
  const health = evaluateWatchdogHealth({
    runnerProgress: { sequence, completedAt },
    storageHealth: { ok: true },
    queueHealth: null,
    now: Date.now(),
  });
  if (!health.processProgress) return false;
  const now = Date.now();
  if (now - lastReport.progress < PROGRESS_INTERVAL_MS) return false;
  lastReport.progress = now;
  return ping(env?.WATCHDOG_PROGRESS_URL, {
    alias: instanceAliasOf(env),
    role: "process-progress",
    sequence,
  });
}

// 告警管道信号：只有分发器实际推进且关键队列不积压时发送（§4.1）。
export async function reportPipelineHealth(env, { cursor, outbox }) {
  const health = evaluateWatchdogHealth({
    runnerProgress: null,
    storageHealth: { ok: true },
    queueHealth: outbox,
    now: Date.now(),
  });
  if (!health.alertPipeline) return false;
  const now = Date.now();
  if (now - lastReport.pipeline < PROGRESS_INTERVAL_MS) return false;
  lastReport.pipeline = now;
  return ping(env?.WATCHDOG_PIPELINE_URL, {
    alias: instanceAliasOf(env),
    role: "alert-pipeline",
    cursor: cursor ? `${cursor.occurredAt}:${cursor.id.slice(0, 8)}` : null,
  });
}

function instanceAliasOf(env) {
  const alias = env?.ALERT_INSTANCE_ALIAS;
  return typeof alias === "string" && alias.trim()
    ? alias.trim().slice(0, 40)
    : "paper-instance";
}
