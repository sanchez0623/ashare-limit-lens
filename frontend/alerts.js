// 运维告警面板（§6）：通道状态、事件列表、确认与测试入口。
// 页面只显示通道 configured 状态，不显示、不携带任何密钥。
const state = {
  initialized: false,
  cursor: 0,
  status: null,
};

const el = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

function fmtTime(value) {
  return value ? value.replace("T", " ").slice(0, 19) : "—";
}

const RULE_LABELS = {
  RUNNER_STALLED: "执行循环停滞",
  LOOP_FAILED: "循环连续失败",
  SESSION_BLOCKED: "会话被阻塞",
  REQUIRED_QUOTE_STALE: "关键报价陈旧",
  DRAWDOWN_TRIPPED: "回撤触及硬约束",
  PROTECTIVE_EXIT_BLOCKED: "保护退出无法成交",
  T_RECOVERY_INCOMPLETE: "做 T 第二腿未恢复",
  SETTLEMENT_LATE: "盘后结算迟延",
  LEDGER_INVARIANT_FAILED: "账本不变式异常",
  ALERT_PIPELINE_STALLED: "告警分发停滞",
  AI_OR_RESEARCH_FAILED: "AI/研究任务失败",
};

function renderStatus() {
  const { status } = state;
  if (!status) return;
  el("alerts-enabled-tag").textContent = status.enabled ? "已启用" : "未启用";
  el("alerts-status-note").textContent = status.note ?? "";
  const channelHtml = status.channels
    .map(
      (channel) =>
        `<div><span class="outline-tag">${escape(channel.name)}</span><div class="panel-metric-value">${
          channel.configured ? "已配置" : "未配置（服务端 .env）"
        }</div></div>`,
    )
    .join("");
  const watchdog = status.watchdog ?? {};
  el("alerts-channel-list").innerHTML =
    channelHtml +
    `<div><span class="outline-tag">外部监测</span><div class="panel-metric-value"><span>${
      watchdog.progressConfigured
        ? `进度信号已配置${watchdog.lastProgressAt ? `，最近 ${fmtTime(watchdog.lastProgressAt)}` : ""}`
        : "未配置（WATCHDOG_PROGRESS_URL）"
    }</span><span>${
      watchdog.pipelineConfigured ? "管道信号已配置" : "管道信号未配置"
    }</span></div></div>
    <div><span class="outline-tag">发送队列</span><div class="panel-metric-value">待发送 ${status.outbox?.pending ?? 0}，逾期未领 ${status.outbox?.overdue ?? 0}，已发送 ${status.outbox?.sent ?? 0}，过期 ${status.outbox?.expired ?? 0}</div></div>`;
}

const EVENT_LABELS = {
  OPENED: "首次触发",
  OBSERVED: "持续观测",
  RESOLVED: "恢复",
  ACKED: "确认静音",
  NOTIFIED: "已发送",
  FAILED: "发送失败",
};

function formatFacts(facts) {
  const entries = Object.entries(facts ?? {});
  if (!entries.length) return '<p class="small-muted">无安全事实</p>';
  return `<dl class="alerts-facts">${entries
    .map(
      ([key, value]) =>
        `<dt>${escape(key)}</dt><dd>${
          Array.isArray(value)
            ? escape(value.join(", "))
            : typeof value === "boolean"
              ? value
                ? "是"
                : "否"
              : escape(String(value))
        }</dd>`,
    )
    .join("")}</dl>`;
}

function renderDetail(detail) {
  const { incident, events = [] } = detail ?? {};
  if (!incident) return '<p class="small-muted">告警实例不存在</p>';
  const latestEvent = events[events.length - 1];
  const facts = latestEvent?.payload ?? {};
  const timeline = events.length
    ? `<ol class="alerts-timeline">${events
        .map(
          (event) =>
            `<li><span class="alerts-timeline-time">${fmtTime(event.createdAt)}</span><span class="alerts-timeline-type">${escape(EVENT_LABELS[event.type] ?? event.type)}</span></li>`,
        )
        .join("")}</ol>`
    : "";
  return `<div class="alerts-detail-section">
      <div class="alerts-detail-header">
        <span class="outline-tag">${escape(incident.id)}</span>
        <span class="outline-tag">${escape(RULE_LABELS[incident.ruleType] ?? incident.ruleType)}</span>
        <span class="outline-tag">${incident.severity === "CRITICAL" ? "严重" : "警告"}</span>
        <span class="outline-tag">${incident.status}</span>
      </div>
      <div class="alerts-detail-meta">
        <div><span class="small-muted">指纹</span> ${escape(incident.fingerprint ?? "—")}</div>
        <div><span class="small-muted">首次</span> ${fmtTime(incident.firstSeen)}</div>
        <div><span class="small-muted">最近</span> ${fmtTime(incident.lastSeen)}</div>
        <div><span class="small-muted">恢复</span> ${fmtTime(incident.resolvedAt)}</div>
        ${incident.ackUntil ? `<div><span class="small-muted">静音至</span> ${fmtTime(incident.ackUntil)}</div>` : ""}
      </div>
      <div class="alerts-detail-subsection">
        <h4>安全事实（最新事件）</h4>
        ${formatFacts(facts)}
      </div>
      <div class="alerts-detail-subsection">
        <h4>事件时间线（${events.length}）</h4>
        ${timeline}
      </div>
    </div>`;
}

function renderIncidents(reset) {
  const rows = state.incidents ?? [];
  el("alerts-incident-rows").innerHTML = rows
    .map(
      (incident) => `<tr>
      <td>${escape(RULE_LABELS[incident.ruleType] ?? incident.ruleType)}<small class="small-muted"> ${escape(incident.fingerprint)}</small></td>
      <td>${incident.severity === "CRITICAL" ? "严重" : "警告"}</td>
      <td>${
        incident.status === "RESOLVED"
          ? `已恢复 ${fmtTime(incident.resolvedAt)}`
          : incident.status === "OPEN"
            ? "未恢复"
            : escape(incident.status)
      }${incident.ackUntil && incident.ackUntil > new Date().toISOString() ? `（确认至 ${fmtTime(incident.ackUntil)}）` : ""}</td>
      <td>${fmtTime(incident.firstSeen)}</td>
      <td>${fmtTime(incident.lastSeen)}</td>
      <td>
        <button class="text-button" data-detail="${escape(incident.id)}">详情</button>${
          incident.status !== "RESOLVED"
            ? `<button class="text-button" data-ack="${escape(incident.id)}">确认 2 小时</button>`
            : ""
        }</td>
    </tr>`,
    )
    .join("");
  for (const button of el("alerts-incident-rows").querySelectorAll(
    "[data-ack]",
  ))
    button.onclick = async () => {
      button.disabled = true;
      try {
        await request(`/api/alerts/incidents/${button.dataset.ack}/ack`, {
          method: "POST",
          body: { hours: 2 },
        });
      } catch (error) {
        el("alerts-list-status").textContent = error.message;
      }
      await refresh(true);
    };
  for (const button of el("alerts-incident-rows").querySelectorAll(
    "[data-detail]",
  ))
    button.onclick = async () => {
      const row = button.closest("tr");
      const next = row.nextElementSibling;
      if (next?.dataset.detailRow === "1") {
        next.remove();
        button.textContent = "详情";
        row.removeAttribute("aria-expanded");
        return;
      }
      const tbody = el("alerts-incident-rows");
      for (const other of tbody.querySelectorAll("tr[data-detail-row='1']"))
        other.remove();
      for (const otherBtn of tbody.querySelectorAll("[data-detail]")) {
        otherBtn.textContent = "详情";
        otherBtn.closest("tr").removeAttribute("aria-expanded");
      }
      button.textContent = "收起";
      row.setAttribute("aria-expanded", "true");
      const detailRow = document.createElement("tr");
      detailRow.dataset.detailRow = "1";
      detailRow.innerHTML = `<td colspan="6"><div class="alerts-detail"><div class="alerts-detail-loading">加载中…</div></div></td>`;
      row.after(detailRow);
      try {
        const detail = await request(
          `/api/alerts/incidents/${button.dataset.detail}`,
        );
        detailRow.innerHTML = `<td colspan="6"><div class="alerts-detail">${renderDetail(detail)}</div></td>`;
      } catch (error) {
        detailRow.innerHTML = `<td colspan="6"><div class="alerts-detail alerts-detail-error">${escape(error.message)}</div></td>`;
        button.textContent = "详情";
        row.removeAttribute("aria-expanded");
      }
    };
  el("alerts-more").hidden = !state.nextCursor;
  el("alerts-list-status").textContent = reset
    ? `共 ${rows.length} 条${state.nextCursor ? "（可加载更多）" : ""}`
    : el("alerts-list-status").textContent;
}

async function refresh(reset = false) {
  try {
    state.status = await request("/api/alerts/status");
    renderStatus();
    if (reset) state.cursor = 0;
    const page = await request(
      `/api/alerts/incidents?cursor=${state.cursor}&active=${el("alerts-active-only").checked}`,
    );
    state.incidents = reset
      ? page.incidents
      : [...(state.incidents ?? []), ...page.incidents];
    state.nextCursor = page.nextCursor;
    renderIncidents(reset);
  } catch (error) {
    el("alerts-list-status").textContent = error.message;
  }
}

export function initializeAlerts() {
  if (state.initialized) return;
  state.initialized = true;
  el("alerts-refresh").onclick = () => refresh(true);
  el("alerts-active-only").onchange = () => refresh(true);
  el("alerts-more").onclick = () => {
    state.cursor = state.nextCursor;
    void refresh(false);
  };
  el("alerts-test").onclick = async () => {
    const button = el("alerts-test");
    button.disabled = true;
    el("alerts-status-note").textContent = "正在发送测试通知…";
    try {
      await request("/api/alerts/test", { method: "POST", body: {} });
      el("alerts-status-note").textContent = "测试通知已发送，请在飞书查收";
    } catch (error) {
      el("alerts-status-note").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  el("alerts-maintenance").onclick = async () => {
    const minutes = Number(prompt("维护窗口分钟数（15–1440）：", "60"));
    if (!Number.isInteger(minutes)) return;
    const reason = prompt("维护原因（可选）：", "") ?? "";
    try {
      const result = await request("/api/alerts/maintenance", {
        method: "POST",
        body: { minutes, reason },
      });
      el("alerts-status-note").textContent =
        `维护窗口至 ${fmtTime(result.until)}`;
    } catch (error) {
      el("alerts-status-note").textContent = error.message;
    }
  };
  void refresh(true);
}
