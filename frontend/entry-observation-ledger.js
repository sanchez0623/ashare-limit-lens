import { BUY_POINT_LABELS } from "../shared/buy-point-type.js";

const PAGE_SIZE = 10;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const money = (cents) =>
  Number.isFinite(cents)
    ? (cents / 100).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "—";
const tone = (value) => (value > 0 ? "up" : value < 0 ? "down" : "");
const signedMoney = (cents) => `${cents > 0 ? "+" : ""}${money(cents)}`;
const percent = (value) =>
  Number.isFinite(value)
    ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`
    : "—";
const timestamp = (value) => {
  const date = new Date(value ?? "");
  return Number.isNaN(date.getTime())
    ? "暂无记录"
    : date.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });
};
function renderPnl(pnl) {
  return `<div class="entry-ledger-pnl-metrics">
    <div><span>观察期总体盈亏</span><strong class="${tone(pnl.totalPnlCents)}">¥ ${signedMoney(pnl.totalPnlCents)}</strong><small class="${tone(pnl.totalPnlCents)}">观察期收益率 ${percent(pnl.totalReturn)}</small></div>
    <div><span>当前持仓浮动盈亏</span><strong class="${tone(pnl.unrealizedPnlCents)}">¥ ${signedMoney(pnl.unrealizedPnlCents)}</strong><small>按剩余持仓成本计算，含买入费用</small></div>
    <div><span>影子账户当前权益</span><strong>¥ ${money(pnl.equityCents)}</strong><small>观察起始权益 ¥ ${money(pnl.baselineEquityCents)}</small></div>
  </div><p class="small-muted">观察起始：${escape(pnl.baselineDate)} 交易前。账户更新：${escape(timestamp(pnl.updatedAt))}（北京时间）。</p>`;
}
function renderStockSummary(stocks) {
  if (!stocks?.length) return "";
  return `<details class="entry-ledger-stock-summary" open>
    <summary>个股盈亏汇总 · ${stocks.length} 只（完整观察期）</summary>
    <div class="table-scroll"><table>
      <thead><tr><th scope="col">股票</th><th scope="col">当前持仓（股）</th><th scope="col">累计盈亏（元）</th><th scope="col">持仓浮动盈亏（元）</th></tr></thead>
      <tbody>${stocks
        .map(
          (stock) => `<tr>
        <td><strong>${escape(stock.name)}</strong><span class="stock-code">${escape(stock.code)}</span></td>
        <td>${escape(stock.quantity)}</td>
        <td class="${tone(stock.totalPnlCents)}">${signedMoney(stock.totalPnlCents)}</td>
        <td class="${tone(stock.unrealizedPnlCents)}">${signedMoney(stock.unrealizedPnlCents)}</td>
      </tr>`,
        )
        .join("")}</tbody>
    </table></div>
  </details>`;
}
function renderFillPnl(pnl) {
  if (!Number.isFinite(pnl?.pnlCents))
    return '—<span class="stock-code">暂无本笔盈亏记录</span>';
  const detail =
    pnl.kind === "REALIZED"
      ? `本笔卖出已实现 · ${percent(pnl.return)}`
      : pnl.remainingQuantity > 0
        ? `本批剩余 ${escape(pnl.remainingQuantity)} 股 · 浮盈率 ${percent(pnl.return)}`
        : "本批已卖出，收益见卖出记录";
  return `<strong class="${tone(pnl.pnlCents)}">${signedMoney(pnl.pnlCents)}</strong><span class="stock-code">${detail}</span>`;
}
const actionNames = {
  OPEN: "建仓",
  ADD: "加仓",
  ADD_PROFIT: "盈利加仓",
  ADD_LOSS: "亏损补仓",
  T_RECOVERY: "做 T 第二腿",
  REDUCE: "减仓",
  EXIT: "清仓",
  T_FORWARD: "正向 T",
  T_REVERSE: "反向 T",
};

function renderRows(rows) {
  return rows
    .map((fill) => {
      const side =
        fill.side === "BUY" ? "买入" : fill.side === "SELL" ? "卖出" : "—";
      const action = actionNames[fill.action] ?? fill.action ?? "—";
      const buyPoint = BUY_POINT_LABELS[fill.buyPoint] ?? fill.buyPoint;
      const notional =
        fill.notionalCents ??
        (Number.isFinite(fill.priceCents) && Number.isFinite(fill.quantity)
          ? fill.priceCents * fill.quantity
          : null);
      const cashTone =
        fill.cashDeltaCents > 0 ? "up" : fill.cashDeltaCents < 0 ? "down" : "";
      const stock = fill.stockPnl;
      return `<tr>
        <td>${escape(fill.date)}<span class="stock-code">${escape(fill.time ?? "—")}</span></td>
        <td><strong>${escape(fill.name)}</strong><span class="stock-code">${escape(fill.code)}</span></td>
        <td>${money(stock?.markCents)}${stock?.quantity > 0 ? `<span class="stock-code">估值日 ${escape(stock.markDate ?? "未知")}</span>` : ""}</td>
        <td class="entry-ledger-stock-pnl">${renderFillPnl(fill.fillPnl)}</td>
        <td>${escape(action)} · ${side}${buyPoint ? `<span class="stock-code">${escape(buyPoint)}</span>` : ""}</td>
        <td>${escape(fill.quantity ?? "—")}</td>
        <td>${money(fill.priceCents)}</td>
        <td>${money(notional)}</td>
        <td>${money(fill.feeCents)}</td>
        <td class="${cashTone}">${money(fill.cashDeltaCents)}</td>
      </tr>`;
    })
    .join("");
}

function renderPager(data, loading) {
  if (!data) return "";
  const { page, totalPages, total } = data;
  const button = (label, target, disabled = false, active = false) =>
    `<button type="button" class="page-btn${active ? " active" : ""}" data-entry-ledger-page="${target}" ${loading || disabled ? "disabled" : ""}${active ? ' aria-current="page"' : ""}>${label}</button>`;
  // 只生成边界与当前页邻近的按钮，页数很大时也保持固定大小。
  const pages = [...new Set([1, page - 1, page, page + 1, totalPages])]
    .filter((number) => number >= 1 && number <= totalPages)
    .sort((a, b) => a - b);
  const numbers = pages
    .map(
      (number, index) =>
        `${index && number - pages[index - 1] > 1 ? '<span class="page-ellipsis">…</span>' : ""}${button(number, number, number === page, number === page)}`,
    )
    .join("");
  return `<div class="ledger-pager">
    ${button("‹ 上一页", page - 1, page <= 1)}
    <span class="page-info">第 ${page} / ${totalPages} 页 · 共 ${total} 笔 · 每页 ${data.pageSize} 笔</span>
    ${button("下一页 ›", page + 1, page >= totalPages)}
    <div class="page-numbers">${numbers}</div>
  </div>`;
}

export function initializeEntryObservationLedger({ request }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $("paper-entry-ledger-dialog");
  const rows = $("paper-entry-ledger-rows");
  const pager = $("paper-entry-ledger-pager");
  const message = $("paper-entry-ledger-message");
  const refresh = $("paper-entry-ledger-refresh");
  const dateInput = $("paper-entry-ledger-date");
  let date = "",
    data = null,
    loading = false,
    error = "",
    requestId = 0;

  function render() {
    const shownDate = data?.date ?? date;
    $("paper-entry-ledger-summary").textContent =
      `${shownDate || "全部交易日"} · 影子观察账户 · 按成交顺序倒序展示（含分批成交），时间为北京时间。`;
    $("paper-entry-ledger-pnl").innerHTML = data?.pnl
      ? renderPnl(data.pnl)
      : `<p class="small-muted">${loading ? "正在加载账户盈亏…" : "尚无观察期初账本，暂无法计算盈亏。"}</p>`;
    $("paper-entry-ledger-pnl-note").hidden = !data?.pnl;
    $("paper-entry-ledger-stocks").innerHTML = renderStockSummary(data?.stocks);
    rows.innerHTML = data?.rows.length
      ? renderRows(data.rows)
      : `<tr><td colspan="10"><div class="empty compact">${loading ? "正在加载影子模拟成交…" : error ? "成交记录尚未加载，请重试。" : shownDate ? "该交易日暂无影子模拟成交，可点击“全部日期”查看历史记录。" : "暂无影子模拟成交记录。"}</div></td></tr>`;
    $("paper-entry-ledger-table").setAttribute("aria-busy", String(loading));
    pager.innerHTML = renderPager(data, loading);
    message.textContent = loading ? "正在加载影子模拟成交…" : error;
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
        date,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      const result = await request(
        `/api/paper/entry-observation/ledger?${query}`,
      );
      if (id !== requestId) return;
      data = result;
      $("paper-entry-ledger-scroll").scrollTop = 0;
    } catch (cause) {
      if (id !== requestId) return;
      error = `影子模拟成交加载失败：${cause.message}。请点击“刷新明细”重试。`;
    } finally {
      if (id === requestId) {
        loading = false;
        render();
      }
    }
  }
  pager.onclick = (event) => {
    const button = event.target.closest("[data-entry-ledger-page]");
    if (!button || button.disabled || loading) return;
    const page = Number(button.dataset.entryLedgerPage);
    if (page >= 1 && page <= data.totalPages) void load(page);
  };
  refresh.onclick = () => {
    if (!loading) void load(data?.page ?? 1);
  };
  $("paper-entry-ledger-filter").onsubmit = (event) => {
    event.preventDefault();
    date = dateInput.value;
    void load(1, true);
  };
  $("paper-entry-ledger-all-dates").onclick = () => {
    date = dateInput.value = "";
    void load(1, true);
  };
  $("paper-entry-ledger-close").onclick = () => dialog.close();
  dialog.onclose = () => {
    requestId++;
    loading = false;
  };
  return {
    open(tradeDate = "") {
      date = dateInput.value = tradeDate;
      if (!dialog.open) dialog.showModal();
      void load(1, true);
    },
  };
}
