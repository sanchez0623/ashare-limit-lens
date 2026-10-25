import { BUY_POINT_LABELS } from "../shared/buy-point-type.js";
import {
  OBSERVATION_CLASS_LABELS,
  formatObservationBuyPointReason,
} from "../shared/entry-observation-display.js";

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const number = (value) => (Number.isFinite(value) ? String(value) : "—");
const amount = (value) =>
  Number.isFinite(value) ? `${(value / 1e8).toFixed(2)} 亿` : "未知";
const timestamp = (value) => {
  const date = new Date(value ?? "");
  return Number.isNaN(date.getTime())
    ? "未知"
    : date.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });
};

function renderRules(rules) {
  const windows = Object.entries(rules.windows ?? {})
    .map(
      ([type, ranges]) =>
        `<li>${escape(BUY_POINT_LABELS[type] ?? type)}：${ranges.map(([start, end]) => `${escape(start.slice(0, 5))}—${escape(end.slice(0, 5))}`).join("、")}${type === "limit-up-momentum" ? "（午后仅回封）" : ""}</li>`,
    )
    .join("");
  return `<p>先从信号日涨停池、炸板池、日线扩展池中，取有冻结历史且未持仓的股票，按快照分数降序、同分代码升序排列；再按代码升序补入满足历史准入条件的股票。盘前最多 ${number(rules.maxPremarketCandidates)} 只，全天准入最多 ${number(rules.maxCandidates)} 只。</p>
    <p>统一准入标准：冻结历史齐全、近期有涨停基因，属于连板龙头型、强势反包型或波段震荡型；行业、信号日收盘价有效，名称不含 ST 或退市标识。冻结历史成交额或当日有效成交额需至少 ${amount(rules.minTurnoverCny)}。行内只标注该股的准入结果和待确认项。</p>
    <p>入池后还需验证当日市场、板块和买点。低吸需要连续 ${number(rules.confirmationQuotes)} 次有效报价确认企稳，并满足增量成交量与成交成本约束。信号日买点是历史标签，下次交易日须重新触发。</p>
    <ul>${windows}</ul><p>所有时间为北京时间；股票类型、分数和依据均读取这份冻结计划及其原始快照。</p>`;
}

function renderScoringRules(groups = []) {
  if (!groups.length) return "<p>这份冻结快照未保存评分因子说明。</p>";
  return `<p>按原始快照保存的因子、权重与风险扣分形成评分，观察池使用冻结排序分。行内保留该股的原始分和扣分；历史补充股未归档评分时显示“—”。</p>${groups.map((group, index) => `<p>${groups.length > 1 ? `规则 ${index + 1} · ` : ""}${group.stockClasses.map(escape).join("、")} · 适用 ${group.candidateCount} 只</p><div class="table-scroll"><table class="entry-candidates-scoring-table"><thead><tr><th scope="col">因子</th><th scope="col">权重</th><th scope="col">计算说明</th></tr></thead><tbody>${group.factors.map((factor) => `<tr><td>${escape(factor.name)}</td><td>${number(factor.weight)}%</td><td>${escape(factor.description)}</td></tr>`).join("")}</tbody></table></div>`).join("")}`;
}

const pendingChecks = (row) =>
  (row.checks ?? [])
    .filter((check) => check.passed !== true && check.key !== "amount")
    .map((check) => `${check.label}：${check.value}`)
    .join("；");

function renderRows(rows) {
  return rows
    .map(
      (row) => `<tr>
    <td>${number(row.rank)}</td>
    <td><strong>${escape(row.name)}</strong><span class="stock-code">${escape(row.code)} · ${escape(row.sector)}</span></td>
    <td class="entry-candidate-reason"><strong>${escape(row.stockClassLabel)}</strong><span class="stock-code">${escape(row.stockClassReason)}</span></td>
    <td class="entry-candidate-reason">${row.buyPoints.length ? row.buyPoints.map((point) => `<strong>${escape(point.label)}</strong><span class="stock-code">${escape(formatObservationBuyPointReason(point.reason))}</span>`).join("") : '<strong>待盘中识别</strong><span class="stock-code">信号日未标注买点，等待当日条件触发。</span>'}</td>
    <td>${number(row.score)}${row.scoring ? `<span class="stock-code">原始 ${number(row.scoring.rawScore)}<br>扣分 ${number(row.scoring.deduction)}</span>` : ""}</td>
    <td>${amount(row.amountCny)}</td>
    <td class="entry-candidate-reason"><strong>${escape(row.sourceLabel)}</strong><br>
      <span class="entry-candidate-state ${row.readiness === "STATIC_READY" ? "entry-candidate-ready" : ""}">${row.readiness === "STATIC_READY" ? "静态准入通过 · 等待盘中触发" : row.readiness === "WAITING_TURNOVER" ? "待盘中成交额确认" : "准入条件待确认"}</span>
      ${pendingChecks(row) ? `<span class="stock-code">${escape(pendingChecks(row))}</span>` : ""}
      ${row.scoring?.risks?.length ? `<span class="stock-code">风险：${row.scoring.risks.map(escape).join("；")}</span>` : ""}
    </td>
  </tr>`,
    )
    .join("");
}

function renderPager(data, loading) {
  if (!data) return "";
  const { page, totalPages } = data;
  const button = (label, target, disabled = false) =>
    `<button type="button" class="page-btn${target === page ? " active" : ""}" data-entry-candidate-page="${target}" ${disabled || loading ? "disabled" : ""}${target === page ? ' aria-current="page"' : ""}>${label}</button>`;
  const pages = [...new Set([1, page - 1, page, page + 1, totalPages])]
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);
  return `<div class="ledger-pager">${button("‹ 上一页", page - 1, page <= 1)}<span class="page-info">第 ${page} / ${totalPages} 页 · 共 ${data.total} 只 · 每页 ${data.pageSize} 只</span>${button("下一页 ›", page + 1, page >= totalPages)}<div class="page-numbers">${pages.map((p, i) => `${i && p - pages[i - 1] > 1 ? '<span class="page-ellipsis">…</span>' : ""}${button(p, p, p === page)}`).join("")}</div></div>`;
}

export function initializeEntryObservationCandidates({ request }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $("paper-entry-candidates-dialog");
  const rows = $("paper-entry-candidates-rows");
  const pager = $("paper-entry-candidates-pager");
  const refresh = $("paper-entry-candidates-refresh");
  const search = $("paper-entry-candidates-search");
  const classFilter = $("paper-entry-candidates-class");
  const buyPointFilter = $("paper-entry-candidates-buy-point");
  classFilter.innerHTML =
    '<option value="">全部股票类型</option>' +
    Object.entries(OBSERVATION_CLASS_LABELS)
      .map(([key, label]) => `<option value="${key}">${label}</option>`)
      .join("");
  buyPointFilter.innerHTML =
    '<option value="">全部信号日买点</option>' +
    Object.entries({ ...BUY_POINT_LABELS, unclassified: "待盘中识别" })
      .map(([key, label]) => `<option value="${key}">${label}</option>`)
      .join("");
  let signalDate = "",
    filters = {},
    data = null,
    loading = false,
    error = "",
    requestId = 0;

  function render() {
    $("paper-entry-candidates-summary").textContent = data
      ? `信号日 ${data.signalDate} · 冻结于 ${timestamp(data.frozenAt)}（北京时间） · 观察池 ${data.candidateTotal} 只，筛选结果 ${data.total} 只`
      : `信号日 ${signalDate} · 正在读取冻结观察池`;
    $("paper-entry-candidates-distribution").innerHTML = data
      ? `<p><strong>股票类型</strong>　${data.summary.stockClasses.map((item) => `${escape(item.label)} ${item.count} 只`).join(" · ")}</p><p><strong>信号日买点</strong>　${data.summary.buyPoints.map((item) => `${escape(item.label)} ${item.count} 只`).join(" · ")}（同股多买点可重复计数）</p>`
      : "";
    $("paper-entry-candidates-rules").innerHTML = data
      ? renderRules(data.rules)
      : "正在读取冻结规则…";
    $("paper-entry-candidates-scoring-rules").innerHTML = data
      ? renderScoringRules(data.scoringRules)
      : "正在读取冻结评分说明…";
    rows.innerHTML = data?.rows.length
      ? renderRows(data.rows)
      : `<tr><td colspan="7"><div class="empty compact">${loading ? "正在加载候选明细…" : error ? "候选记录尚未加载，请重试。" : "没有匹配的观察候选，可调整筛选条件。"}</div></td></tr>`;
    $("paper-entry-candidates-table").setAttribute(
      "aria-busy",
      String(loading),
    );
    pager.innerHTML = renderPager(data, loading);
    $("paper-entry-candidates-message").textContent = loading
      ? "正在加载候选明细…"
      : error;
    refresh.disabled = loading;
  }
  async function load(page, clear = false) {
    const id = ++requestId;
    if (clear) data = null;
    loading = true;
    error = "";
    render();
    try {
      const query = new URLSearchParams({
        signalDate,
        page: String(page),
        pageSize: "10",
        ...filters,
      });
      const result = await request(
        `/api/paper/entry-observation/candidates?${query}`,
      );
      if (id !== requestId) return;
      data = result;
      $("paper-entry-candidates-scroll").scrollTop = 0;
    } catch (cause) {
      if (id !== requestId) return;
      error = `候选明细加载失败：${cause.message}。请点击“刷新候选”重试。`;
    } finally {
      if (id === requestId) {
        loading = false;
        render();
      }
    }
  }
  pager.onclick = (event) => {
    const button = event.target.closest("[data-entry-candidate-page]");
    if (!button || button.disabled || loading) return;
    const page = Number(button.dataset.entryCandidatePage);
    if (page >= 1 && page <= data.totalPages) void load(page);
  };
  $("paper-entry-candidates-filter").onsubmit = (event) => {
    event.preventDefault();
    filters = {
      q: search.value.trim(),
      stockClass: classFilter.value,
      buyPoint: buyPointFilter.value,
    };
    void load(1, true);
  };
  $("paper-entry-candidates-reset").onclick = () => {
    search.value = classFilter.value = buyPointFilter.value = "";
    filters = {};
    void load(1, true);
  };
  refresh.onclick = () => {
    if (!loading) void load(data?.page ?? 1);
  };
  $("paper-entry-candidates-close").onclick = () => dialog.close();
  dialog.onclose = () => {
    requestId++;
    loading = false;
  };
  return {
    open(date) {
      signalDate = date;
      filters = {};
      search.value = classFilter.value = buyPointFilter.value = "";
      $("paper-entry-candidates-explanation").open = false;
      $("paper-entry-candidates-scoring-explanation").open = false;
      if (!dialog.open) dialog.showModal();
      void load(1, true);
    },
  };
}
