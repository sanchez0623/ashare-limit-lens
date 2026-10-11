// 外部失联监测信号（§4）：本机向外上报最小健康信号，超时由外部服务通知。
// 信号只含实例别名、角色、递增序号与最小状态；不含持仓、现金、URL、堆栈。
// Ping URL 是秘密：不写 Git、前端、普通日志或页面链接。失败静默——
// 本机无法上报时由外部服务按缺失信号告警。
const TIMEOUT_MS = 5000;
const PROGRESS_INTERVAL_MS = 60_000;
// 队列上限：待发总量与"本该发出却无人领取"的积压都必须有界，否则
// 严重积压或分发器停滞会被当成健康上报。
const MAX_PENDING = 20;
const MAX_OVERDUE = 0;
// 关键通知重试耗尽即为丢失，绝不能当成健康：阈值必须为 0，直到所有者
// 通过确认（ACK）清掉这次失败信号。
const MAX_EXPIRED = 0;
// 关键通知在队列中停留超过 2 分钟（尚未送达、未过期）即为异常积压，
// 必须立即上报不健康，直到送达或所有者 ACK。
const MAX_LONG_PENDING = 0;

export function evaluateWatchdogHealth({
  runnerProgress,
  storageHealth,
  queueHealth,
  pipelineState,
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
  // 只有分发器真的在推进（lastProgressAt 新鲜）才算管道健康：队列恰好为空
  // 可能是"分发器已死、无人入队"，空闲不等于健康。
  const pipelineFresh =
    pipelineState?.lastProgressAt != null &&
    now - new Date(pipelineState.lastProgressAt).getTime() <
      PROGRESS_INTERVAL_MS * 3;
  const queueOk =
    queueHealth == null ||
    ((queueHealth.pending ?? 0) <= MAX_PENDING &&
      (queueHealth.overdue ?? 0) <= MAX_OVERDUE &&
      (queueHealth.expired ?? 0) <= MAX_EXPIRED &&
      (queueHealth.longPending ?? 0) <= MAX_LONG_PENDING);
  return {
    processProgress: progressFresh && storageOk,
    alertPipeline: storageOk && queueOk,
    storageOk,
    queueOk,
    progressFresh,
    pipelineFresh,
  };
}

let lastReport = { progress: 0, pipeline: 0, sequence: 0 };

export function resetWatchdogTimers() {
  lastReport = { progress: 0, pipeline: 0, sequence: 0 };
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

// 主进程循环进度信号：只有在序号真的前进、存储写入成功、且读取到新的实际
// 循环进度时才发送（§4.1）。存储失败时报"健康"会让外部监测永远学不到
// 主库不可写这种停滞，因此 storageOk 必须由调用方如实传入。
export async function reportProcessProgress(
  env,
  { sequence, completedAt, storageOk = true },
) {
  const health = evaluateWatchdogHealth({
    runnerProgress: { sequence, completedAt },
    storageHealth: { ok: storageOk },
    queueHealth: null,
    now: Date.now(),
  });
  if (!health.processProgress) return false;
  if (!(sequence > lastReport.sequence)) return false;
  const now = Date.now();
  if (now - lastReport.progress < PROGRESS_INTERVAL_MS) return false;
  lastReport.progress = now;
  lastReport.sequence = sequence;
  return ping(env?.WATCHDOG_PROGRESS_URL, {
    alias: instanceAliasOf(env),
    role: "process-progress",
    sequence,
  });
}

// 告警管道信号：只有分发器实际推进（进度新鲜）、关键队列不积压、
// 且没有"本该发出却无人领取"的项时才发送（§4.1）。
export async function reportPipelineHealth(env, { cursor, outbox, state }) {
  const health = evaluateWatchdogHealth({
    runnerProgress: null,
    storageHealth: { ok: true },
    queueHealth: outbox,
    pipelineState: state ?? null,
    now: Date.now(),
  });
  // 队列恰好为空可能是"分发器已死、无人入队"，因此必须另有推进证据。
  if (!health.alertPipeline || !health.pipelineFresh) return false;
  const now = Date.now();
  if (now - lastReport.pipeline < PROGRESS_INTERVAL_MS) return false;
  lastReport.pipeline = now;
  return ping(env?.WATCHDOG_PIPELINE_URL, {
    alias: instanceAliasOf(env),
    role: "alert-pipeline",
    cursor: cursor?.ingestSeq != null ? `ingest:${cursor.ingestSeq}` : null,
    progressedAt: state?.lastProgressAt ?? null,
  });
}

function instanceAliasOf(env) {
  const alias = env?.ALERT_INSTANCE_ALIAS;
  return typeof alias === "string" && alias.trim()
    ? alias.trim().slice(0, 40)
    : "paper-instance";
}
