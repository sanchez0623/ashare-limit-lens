import { initializeEntryObservationLedger } from "./entry-observation-ledger.js";
import { initializeEntryObservationCandidates } from "./entry-observation-candidates.js";

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const timestamp = (value) => {
  const date = new Date(value ?? "");
  return Number.isNaN(date.getTime())
    ? "暂无记录"
    : date.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });
};
const statusNames = {
  NOT_STARTED: "尚未启动",
  WAITING_CLOSE: "等待盘后准备",
  WAITING_HISTORY: "等待候选日线",
  OBSERVING: "影子观察中",
  READY: "核验通过",
  OPEN: "观察中，尚未结算",
  CLOSED: "已收盘结算",
  SETTLED: "已结算",
  RUNNING: "轮询运行中",
  MARKET_CLOSED: "等待交易时段",
  STALE_QUOTES: "行情陈旧",
  ERROR: "执行异常",
  NON_TRADING_DAY: "非交易日",
};

export function renderEntryObservationProgress(result) {
  const { session, executor, readiness } = result;
  const row = (label, value) =>
    `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;
  const checks = [
    ["coverage", "全天有效行情覆盖"],
    ["replayPassed", "订单、成交与账本重放"],
    ["inputsPresent", "竞价与市场输入"],
    ["contextPresent", "冻结候选历史"],
    ["previousDateConfirmed", "信号日对应关系"],
  ];
  return `<p>${escape(result.message)}</p>
    <dl class="entry-observation-facts">
      ${row("当前状态", statusNames[result.status] ?? result.status)}
      ${row("最新计划信号日", result.signalDate ?? "尚未冻结")}
      ${result.signalDate ? `<div><dt>计划观察候选</dt><dd><button type="button" class="text-button entry-observation-ledger-link" data-entry-candidates-date="${escape(result.signalDate)}" aria-haspopup="dialog" aria-controls="paper-entry-candidates-dialog">${escape(result.candidates ?? 0)} 只 · 查看候选明细</button></dd></div>` : row("计划观察候选", `${result.candidates ?? 0} 只（不等于成交数）`)}
      ${row("常驻交易服务", executor?.running ? "已连接" : executor?.stale ? "心跳已过期" : "未连接")}
      ${row("服务最近心跳", timestamp(executor?.health?.checkedAt))}
      ${row("服务状态", executor?.health ? (statusNames[executor.health.status] ?? executor.health.status) : "尚未收到心跳")}
    </dl>
    ${!executor?.running ? '<p class="notice">请启动常驻交易服务并保持运行。关闭网页不会影响后台；电脑睡眠或服务停止期间无法持续采集。</p>' : ""}
    <h3>历史影子成交</h3>
    <p><button type="button" class="text-button entry-observation-ledger-link" data-entry-ledger-date="" aria-haspopup="dialog" aria-controls="paper-entry-ledger-dialog">全部历史成交${result.ledger ? ` · ${escape(result.ledger.total)} 笔` : ""}</button>${result.ledger?.latestTradeDate ? ` · 最近成交日 ${escape(result.ledger.latestTradeDate)}` : ""}</p>
    <h3>最近一次影子执行</h3>
    ${
      session
        ? `<dl class="entry-observation-facts">
      ${row("观察交易日 / 信号日", `${session.date} / ${session.signalDate}`)}
      ${row("执行状态", statusNames[session.status] ?? session.status)}
      ${row("已消费行情", `${session.sequence ?? 0} 次观测`)}
      <div><dt>影子模拟成交</dt><dd><button type="button" class="text-button entry-observation-ledger-link" data-entry-ledger-date="${escape(session.date)}" aria-haspopup="dialog" aria-controls="paper-entry-ledger-dialog">${escape(session.fillCount ?? 0)} 笔 · 查看明细</button></dd></div>
      ${row("最近行情时间", timestamp(session.lastObservedAt))}
    </dl>`
        : '<p class="small-muted">尚无影子执行记录。计划需在开盘前冻结，并由常驻服务在下一实际交易日采集。</p>'
    }
    <h3>最近盘后核验</h3>
    ${
      readiness
        ? `<p>${escape(readiness.date)} · ${result.ready ? "核验通过" : readiness.passed ? "报告对应旧执行版本，需重新核验" : "核验未通过"} · ${escape(timestamp(readiness.verifiedAt))}</p>
      <dl class="entry-observation-facts">${checks.map(([key, label]) => row(label, readiness[key] === true ? "通过" : readiness[key] === false ? "未通过" : "无记录")).join("")}
      ${row("核验行情 / 成交", `${readiness.frameCount ?? 0} 帧 / ${readiness.fills ?? 0} 笔`)}
      </dl>`
        : '<p class="small-muted">尚无核验报告。完整交易日结束后，北京时间 17:00 起由后台核验；刷新进度不会提前生成报告。</p>'
    }
    <p class="small-muted">观测次数与成交数不代表全天覆盖通过。影子账户单独模拟，验证结果不影响选择 V5 盘中条件执行。时间均为北京时间。</p>
    <p class="small-muted">本次进度读取：${escape(timestamp(result.checkedAt))}。可点击“刷新进度”读取最新记录。</p>`;
}

export function initializeEntryObservation({
  request,
  getObservation,
  onStarted,
}) {
  const $ = (id) => document.getElementById(id);
  const dialog = $("paper-entry-observation-dialog");
  const content = $("paper-entry-observation-detail");
  const refreshButton = $("paper-entry-observation-refresh");
  const ledger = initializeEntryObservationLedger({ request });
  const candidates = initializeEntryObservationCandidates({ request });
  content.onclick = (event) => {
    const button = event.target.closest(
      "[data-entry-ledger-date], [data-entry-candidates-date]",
    );
    if (button?.dataset.entryLedgerDate !== undefined)
      ledger.open(button.dataset.entryLedgerDate);
    else if (button?.dataset.entryCandidatesDate)
      candidates.open(button.dataset.entryCandidatesDate);
  };
  let loading = false;
  async function load(start = false) {
    if (loading) return;
    loading = true;
    refreshButton.disabled = true;
    content.setAttribute("aria-busy", "true");
    content.textContent = start ? "正在登记影子观察…" : "正在读取影子观察进度…";
    try {
      if (start) {
        await request("/api/paper/entry-observation", {});
        await onStarted();
      }
      const result = await request("/api/paper/entry-observation");
      content.innerHTML = renderEntryObservationProgress(result);
    } catch (error) {
      content.textContent = `影子观察进度读取失败：${error.message}。可点击“刷新进度”重试。`;
    } finally {
      loading = false;
      refreshButton.disabled = false;
      content.setAttribute("aria-busy", "false");
    }
  }
  $("paper-entry-observe").onclick = () => {
    if (!dialog.open) dialog.showModal();
    void load(!getObservation()?.requested);
  };
  refreshButton.onclick = () => void load();
  $("paper-entry-observation-close").onclick = () => dialog.close();
}
