import { DEFAULT_FEES, FEE_FIELDS } from "../shared/fees.js";
import { DEFAULT_RISK_LIMITS, RISK_FIELDS } from "../shared/risk-limits.js";
import {
  EXPOSURE_TIERS_DEFAULTS,
  STRATEGY_DEFAULTS,
  STRATEGY_FIELDS,
  TIER_FIELDS,
  WEIGHT_FIELDS,
} from "../shared/strategy-params.js";
import {
  BENCHMARK_INDEXES,
  benchmarkName,
  DEFAULT_BENCHMARK,
} from "../shared/benchmarks.js";
const $ = (id) => document.getElementById(id);
import {
  programDescription,
  FAMILY_DEFINITIONS,
} from "../shared/strategy-program.js";
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const money = (cents) =>
  (Number(cents || 0) / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const metricMoney = (cents) =>
  Math.abs(cents || 0) >= 1e10
    ? `${(cents / 1e10).toFixed(2)} 亿`
    : Math.abs(cents || 0) >= 1e6
      ? `${(cents / 1e6).toFixed(2)} 万`
      : money(cents);
const percent = (value) =>
  value === null || value === undefined
    ? "—"
    : `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
const tone = (value) => (value > 0 ? "up" : value < 0 ? "down" : "");
const actionNames = {
  OPEN: "建仓",
  ADD: "加仓",
  REDUCE: "减仓",
  EXIT: "清仓",
  T_FORWARD: "正向 T",
  T_REVERSE: "反向 T",
  HOLD: "持有",
};
const statusNames = {
  ACTIVE: "使用中",
  VALIDATED: "验证通过",
  LEGACY_VALIDATED: "历史通过（无启用资格）",
  SHADOW_PENDING: "等待影子验证",
  AWAITING_SHADOW: "等待影子验证",
  REJECTED: "未通过",
  ERROR: "调用失败",
  PROPOSING: "正在验证",
  RETIRED: "已归档",
  COLLECTING: "数据积累中",
  NOT_CONFIGURED: "未配置大模型",
  BUSY: "已有进行中的实验",
  BUDGET_EXHAUSTED: "本月提案次数已用完",
  INCONCLUSIVE: "证据不足",
  INVALIDATED: "环境变化已失效",
  APPROVED: "已批准待排期",
  SCHEDULED: "已排期",
  PROMOTED: "已启用",
};
const executionNames = {
  PENDING: "等待触发",
  BLOCKED: "受约束，重试中",
  PARTIAL: "部分成交",
  FIRST_LEG: "做 T 第一腿",
  SECOND_LEG: "恢复第二腿",
  FILLED: "完成",
  CANCELLED: "已取消",
  EXPIRED: "当日到期",
  EXPIRED_PARTIAL: "部分完成后到期",
  INCOMPLETE_T: "第二腿转下日",
  RUNNING: "轮询运行中",
  STALE_QUOTES: "报价陈旧，暂停成交",
  MARKET_CLOSED: "等待交易时段",
  ERROR: "异常，自动重试",
  NON_TRADING_DAY: "非交易日",
  CONFLICT: "并发结果已丢弃",
  SETTLED: "已结算",
};
let data = null,
  busy = false,
  settingsDirty = false,
  ledgerPage = 1,
  ledgerDate = "",
  stockPnlPage = 1;
const LEDGER_PAGE_SIZE = 10;
const STOCK_PNL_PAGE_SIZE = 15;
let ledgerData = null,
  ledgerLoading = false,
  ledgerRequestId = 0,
  overviewRequestId = 0;
async function request(path, body) {
  const response = await fetch(path, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(130000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "服务暂不可用");
  return result;
}
function message(value) {
  $("paper-message").textContent = value;
}
const feeDisplay = (key, value) =>
  key === "commission_min" ? value : Number((value * 10000).toFixed(5));
function fillFeeInputs(config) {
  for (const { key } of FEE_FIELDS)
    $(`fee-${key}`).value = feeDisplay(key, config[key]);
}
function feeSummary(config) {
  return FEE_FIELDS.map(
    ({ key, label, unit }) =>
      `${label} ${feeDisplay(key, config[key])}${unit === "元" ? " 元" : " / 万"}`,
  ).join(" · ");
}
const riskDisplay = (key, value) =>
  RISK_FIELDS.find((field) => field.key === key)?.percent
    ? Number((value * 100).toFixed(4))
    : value;
function fillRiskInputs(config) {
  for (const { key } of RISK_FIELDS)
    $(`risk-${key}`).value = riskDisplay(key, config[key]);
}
function riskSummary(config) {
  return RISK_FIELDS.map(
    ({ key, label, unit }) =>
      `${label} ${riskDisplay(key, config[key])}${unit}`,
  ).join(" · ");
}
const strategyDisplay = (field, value) =>
  field.percent ? Number((value * 100).toFixed(2)) : value;
let inheritedStrategyProgram;
let inheritedPyramidReduce;
function fillStrategyInputs(config, { preserveProgram = false } = {}) {
  // 重置数值参数仍沿用已验证程序，不能经设置表单绕过家族研究。
  if (!preserveProgram)
    inheritedStrategyProgram = config.program
      ? structuredClone(config.program)
      : undefined;
  // 方案 4：金字塔减仓比例向量不经设置表单编辑，原样回传避免
  // 手动保存时被静默重置为默认档位（该向量由策略赛马优化）。
  inheritedPyramidReduce = Array.isArray(config.pyramidReduce)
    ? [...config.pyramidReduce]
    : undefined;
  const tiers = { ...EXPOSURE_TIERS_DEFAULTS, ...config.exposureTiers };
  WEIGHT_FIELDS.forEach(
    ({ key }, index) =>
      ($(`strat-weight-${key}`).value = config.weights[index]),
  );
  for (const field of STRATEGY_FIELDS)
    $(`strat-${field.key}`).value = strategyDisplay(field, config[field.key]);
  for (const field of TIER_FIELDS)
    $(`strat-tier-${field.key}`).value = strategyDisplay(
      field,
      tiers[field.key],
    );
}
function collectStrategyParams() {
  return {
    weights: WEIGHT_FIELDS.map(({ key }) =>
      Number($(`strat-weight-${key}`).value),
    ),
    ...Object.fromEntries(
      STRATEGY_FIELDS.map(({ key, percent }) => [
        key,
        percent
          ? Number($(`strat-${key}`).value) / 100
          : Number($(`strat-${key}`).value),
      ]),
    ),
    exposureTiers: Object.fromEntries(
      TIER_FIELDS.map(({ key, percent }) => [
        key,
        percent
          ? Number($(`strat-tier-${key}`).value) / 100
          : Number($(`strat-tier-${key}`).value),
      ]),
    ),
    ...(Array.isArray(inheritedPyramidReduce)
      ? { pyramidReduce: [...inheritedPyramidReduce] }
      : {}),
    ...(inheritedStrategyProgram
      ? { program: structuredClone(inheritedStrategyProgram) }
      : {}),
  };
}
function breakdown(fill) {
  const labels = {
    commission: "佣金",
    stamp: "印花税",
    handling: "经手费",
    regulatory: "证管费",
    transfer: "过户费",
  };
  const fees = Object.entries(labels)
    .map(([key, label]) => `${label} ¥ ${money(fill.feeBreakdown[key] || 0)}`)
    .join("；");
  return (
    fees +
    (fill.strategyAllocations
      ? `；成员费用 ${fill.strategyAllocations.map((row) => `${FAMILY_DEFINITIONS[row.familyId]?.name ?? "继承仓位"} ${row.quantity} 股 / ¥ ${money(row.feeCents)}`).join("，")}`
      : "")
  );
}
function priceConditions(order) {
  const reference = `<span class="stock-code">参考价 ¥ ${money(order.referenceCents)}</span>`;
  const protection = `<span class="stock-code">止损 ≤ ¥ ${money(order.stopCents)}<br>分批止盈 ≥ ¥ ${money(order.takeProfitCents)}</span>`;
  const execution =
    order.side === "PAIR"
      ? `低吸 ≤ ¥ ${money(order.buyTriggerCents)}<br>兑现 ≥ ¥ ${money(order.sellTriggerCents)}<span class="stock-code">09:35 起触发 · 14:50 起恢复第二腿</span>`
      : order.side === "BUY" && order.recovery
        ? `恢复买回 · 参考 ¥ ${money(order.referenceCents)}<span class="stock-code">连续竞价时段按实时价 + 0.1% 滑点<br>受现金、仓位与涨停边界限制</span>`
        : order.side === "BUY"
          ? `买入上限 ¥ ${money(order.maxPriceCents)}<span class="stock-code">含滑点 · 09:30–09:35 内满足时成交</span>`
          : order.side === "SELL"
            ? `参考卖价 ¥ ${money(Math.round(order.referenceCents * 0.999))}<span class="stock-code">实际卖价 = 实时报价 − 0.1% 滑点<br>连续竞价时段重试，跌停不假设成交</span>`
            : "持有并监控保护阈值";
  return reference + execution + protection;
}
function chart(rows, benchmarkLabel = "上证指数", status = "OK") {
  if (!rows.length)
    return '<div class="empty"><strong>收益曲线从首个结算日开始</strong>保存真实计划并执行后，逐日积累净值。</div>';
  // 基准曲线的两种异常状态都要写明：既不画跨指数的曲线，也不静默缺线。
  const repairAt =
    status === "REPAIRED" ? status.slice("REPAIRED@".length) : "";
  const benchmarkNote =
    status === "OK"
      ? ""
      : status === "UNAVAILABLE"
        ? '<p class="panel-footnote">基准曲线暂不可用：行情源本轮未返回所选指数收盘，宁缺毋滥，不展示可能混入其他指数的数值。</p>'
        : `<p class="panel-footnote">基准曲线已校正：${repairAt} 起以 ${escape(benchmarkLabel)} 真实收盘重新起算；此前基准价锚定在错误指数上，整条曲线被跨指数放大。</p>`;
  const width = 760,
    height = 200,
    padding = 30;
  const values = [
    0,
    ...rows.map((row) => row.totalReturn),
    ...rows
      .map((row) => row.benchmarkReturn)
      .filter((value) => value !== null && value !== undefined),
  ];
  const low = Math.min(...values) - 0.005,
    high = Math.max(...values) + 0.005;
  const x = (index) =>
    padding + (index / Math.max(1, rows.length - 1)) * (width - 2 * padding);
  const y = (value) =>
    height - padding - ((value - low) / (high - low)) * (height - padding * 2);
  const points = (key) =>
    rows
      .map((row, index) =>
        row[key] === null || row[key] === undefined
          ? null
          : `${x(index)},${y(row[key])}`,
      )
      .filter(Boolean)
      .join(" ");
  return `<svg class="equity-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="账户累计收益率与${escape(benchmarkLabel)}收益率"><line x1="${padding}" x2="${width - padding}" y1="${y(0)}" y2="${y(0)}" stroke="#d9e1e8" stroke-dasharray="4 4"/><text x="${padding}" y="18" class="chart-axis">${percent(high)}</text><text x="${padding}" y="${height - 7}" class="chart-axis">${percent(low)}</text><polyline points="${points("benchmarkReturn")}" fill="none" stroke="#acb6c4" stroke-width="2"/><polyline points="${points("totalReturn")}" fill="none" stroke="#13977e" stroke-width="3"/>${rows.map((row, index) => `<circle cx="${x(index)}" cy="${y(row.totalReturn)}" r="3" fill="#13977e"><title>${escape(row.date)}：账户 ${percent(row.totalReturn)}；基准 ${percent(row.benchmarkReturn)}</title></circle>`).join("")}</svg><div class="chart-legend"><span><i></i>模拟账户</span><span><i class="benchmark"></i>${escape(benchmarkLabel)}</span><span>${escape(rows[0].date)} — ${escape(rows.at(-1).date)} · ${rows.length} 个结算日</span></div>${rows.length === 1 ? '<p class="panel-footnote">首次结算只建立收益基准；下一交易日起执行事前计划。</p>' : ""}${benchmarkNote}`;
}
function renderLedgerPage(ledger, meta) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const total = meta?.total ?? rows.length;
  const totalPages =
    meta?.totalPages ?? Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE));
  const page = meta?.page ?? 1;

  const rowsHtml = rows.length
    ? rows
        .map(
          (fill) =>
            `<tr><td>${escape(fill.date)}<span class="stock-code">${escape(fill.time)}</span></td><td><strong>${escape(fill.name)}</strong><span class="stock-code">${escape(fill.code)}</span></td><td>${actionNames[fill.action]} · ${fill.side === "BUY" ? "买" : "卖"}</td><td>${fill.quantity}</td><td>${money(fill.priceCents)}</td><td title="${escape(breakdown(fill))}"><details class="fee-breakdown"><summary>¥ ${money(fill.feeCents)}</summary><span>${escape(breakdown(fill))}</span></details><span class="stock-code">费用 v${fill.feeConfigVersion || 0}</span></td><td class="${tone(fill.cashDeltaCents)}">${money(fill.cashDeltaCents)}</td><td>${fill.dataQuality === "realtime_poll" ? "实时 HTTP 轮询" : fill.dataQuality === "minute" ? "历史分钟采样" : "开盘假设"}${fill.executionCost ? `<span class="stock-code">滑点 ${fill.executionCost.totalBps}bps · ${fill.executionCost.spreadSource === "BOOK" ? "盘口价差" : "回退价差"}</span>` : ""}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="8"><div class="empty compact">该日期无成交记录。</div></td></tr>';

  let pageButtons = "";
  for (let i = 1; i <= totalPages; i++) {
    if (
      totalPages > 12 &&
      i !== 1 &&
      i !== totalPages &&
      Math.abs(i - page) > 2
    ) {
      if (i === 2 || i === totalPages - 1)
        pageButtons += '<span class="page-ellipsis">…</span>';
      continue;
    }
    pageButtons += `<button class="page-btn ${i === page ? "active" : ""}" data-page="${i}">${i}</button>`;
  }

  const pagerHtml =
    `<div class="ledger-pager">` +
    `<button class="page-btn" data-page="${Math.max(1, page - 1)}" ${page <= 1 ? "disabled" : ""}>‹ 上一页</button>` +
    `<span class="page-info">第 ${page} / ${totalPages} 页 · 共 ${total} 笔</span>` +
    `<button class="page-btn" data-page="${Math.min(totalPages, page + 1)}" ${page >= totalPages ? "disabled" : ""}>下一页 ›</button>` +
    `<div class="page-numbers">${pageButtons}</div>` +
    `</div>`;

  return { rowsHtml, pagerHtml, total, totalPages, page };
}
function renderStockPnlPage(stockPnl, meta, heldQuantityByCode) {
  const rows = Array.isArray(stockPnl) ? stockPnl : [];
  const total = meta?.total ?? rows.length;
  const totalPages =
    meta?.totalPages ?? Math.max(1, Math.ceil(total / STOCK_PNL_PAGE_SIZE));
  const page = meta?.page ?? 1;

  const rowsHtml = rows.length
    ? rows
        .map(
          (row) =>
            `<tr><td><strong>${escape(row.name)}</strong><span class="stock-code">${escape(row.code)}</span></td><td>${escape(row.lastDate)}</td><td>${row.sellCount}</td><td>${row.winCount} 盈 / ${row.lossCount} 亏</td><td class="${tone(row.realizedPnlCents)}">¥ ${money(row.realizedPnlCents)}</td><td>${heldQuantityByCode.get(row.code) ? `仍持有 ${heldQuantityByCode.get(row.code)} 股` : "已清仓"}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="6"><div class="empty compact">尚无已实现盈亏。卖出成交后按 FIFO 核算逐笔盈亏。</div></td></tr>';

  let pageButtons = "";
  for (let i = 1; i <= totalPages; i++) {
    if (
      totalPages > 12 &&
      i !== 1 &&
      i !== totalPages &&
      Math.abs(i - page) > 2
    ) {
      if (i === 2 || i === totalPages - 1)
        pageButtons += '<span class="page-ellipsis">…</span>';
      continue;
    }
    pageButtons += `<button class="page-btn" data-pnl-page="${i}">${i}</button>`;
  }

  const pagerHtml =
    `<div class="ledger-pager">` +
    `<button class="page-btn" data-pnl-page="${Math.max(1, page - 1)}" ${page <= 1 ? "disabled" : ""}>‹ 上一页</button>` +
    `<span class="page-info">第 ${page} / ${totalPages} 页 · 共 ${total} 只</span>` +
    `<button class="page-btn" data-pnl-page="${Math.min(totalPages, page + 1)}" ${page >= totalPages ? "disabled" : ""}>下一页 ›</button>` +
    `<div class="page-numbers">${pageButtons}</div>` +
    `</div>`;

  return { rowsHtml, pagerHtml, total, totalPages, page };
}
function renderLedger() {
  const meta = ledgerData;
  const ledgerRender = renderLedgerPage(meta?.rows, meta);
  const total = meta?.total ?? 0;
  $("paper-ledger-rows").innerHTML = total
    ? ledgerRender.rowsHtml
    : `<tr><td colspan="8"><div class="empty compact">${meta?.date ? "该日期无成交记录。" : "尚无成交记录。未满足成交条件的计划不会记为收益。"}</div></td></tr>`;
  $("paper-ledger-rows").setAttribute("aria-busy", String(ledgerLoading));
  $("paper-ledger-pager").innerHTML = total ? ledgerRender.pagerHtml : "";
  const filter = $("paper-ledger-date-filter");
  const dates = [
    ...new Set([...(meta?.dates ?? []), ...(ledgerDate ? [ledgerDate] : [])]),
  ];
  filter.innerHTML =
    "<option value=''>全部日期</option>" +
    dates
      .map((date) => `<option value="${escape(date)}">${escape(date)}</option>`)
      .join("");
  filter.value = ledgerDate;
  filter.disabled = ledgerLoading;
  if (ledgerLoading)
    $("paper-ledger-pager")
      .querySelectorAll("button")
      .forEach((button) => (button.disabled = true));
  $("paper-ledger-count").textContent = ledgerLoading
    ? "加载中…"
    : total
      ? `${total} 笔 · ${ledgerRender.totalPages} 页`
      : "无记录";
}
function render() {
  if (!data) return;
  const {
    book,
    equity,
    lastSettled,
    plan,
    run,
    versions,
    riskLimits,
    ledgerMeta,
    stockPnlMeta,
  } = data;
  const live = data.realtime;
  const health = live?.health;
  $("paper-live-tag").textContent = live?.running
    ? "常驻执行器已连接"
    : "常驻执行器未连接";
  $("paper-live-summary").textContent = live?.session
    ? `${live.session.date} · ${live.session.sequence} 次观测 · ${live.session.fillCount} 笔成交`
    : "尚无今日实时交易记录";
  $("paper-live-health").textContent =
    `${health ? `${executionNames[health.status] || health.status} · 最近心跳 ${new Date(health.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} · ${health.pollIntervalSeconds} 秒轮询。` : "尚未收到常驻执行器心跳。"} ${!live?.running ? live?.requirement || "" : "关闭网页后服务继续执行；盘后按已记录成交结算。"}`;
  $("paper-live-orders").innerHTML = live?.session?.orders.length
    ? live.session.orders
        .map(
          (o) =>
            `<tr><td><strong>${escape(o.name)} · ${actionNames[o.action]}</strong><span class="stock-code">${escape(o.code)}</span></td><td>${executionNames[o.status] || escape(o.status)}</td><td>${o.side === "PAIR" ? `第一腿 ${o.firstFilled} / 第二腿 ${o.secondFilled}` : `${o.filledQuantity} / ${o.quantity}`} 股</td><td>${escape(o.reason)}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="4"><div class="empty compact">等待常驻服务在交易时段执行冻结计划。</div></td></tr>';
  const marketValue = book.positions.reduce(
    (sum, position) =>
      sum +
      position.lots.reduce((n, lot) => n + lot.quantity, 0) *
        position.markCents,
    0,
  );
  // 盘中实时盯市时 equity 是当日实时快照，上一结算日数字单独保留展示。
  const settledDay =
    lastSettled && equity && equity.date !== lastSettled.date
      ? lastSettled
      : null;
  const metrics = [
    [
      "账户总权益",
      `¥ ${metricMoney(book.equityCents)}`,
      `初始资金 ¥ ${money(book.initialCashCents)}`,
      "",
    ],
    [
      "当日盈亏",
      `¥ ${metricMoney(equity?.dailyPnlCents)}`,
      settledDay
        ? `当日收益 ${percent(equity?.dailyReturn ?? 0)} · 前结算 ${settledDay.date.slice(5)} ${percent(settledDay.dailyReturn)}`
        : `当日收益 ${percent(equity?.dailyReturn ?? 0)}`,
      tone(equity?.dailyPnlCents),
    ],
    [
      "累计收益率",
      percent(book.equityCents / book.initialCashCents - 1),
      `已扣费用 ¥ ${money(book.feesCents)}`,
      tone(book.equityCents - book.initialCashCents),
    ],
    [
      "当前持仓比例",
      percent(marketValue / book.equityCents),
      `可用现金 ¥ ${money(book.cashCents)}`,
      "",
    ],
  ];
  $("paper-metrics").innerHTML = metrics
    .map(
      ([label, value, caption, color]) =>
        `<article class="metric"><div class="metric-head">${label}</div><div class="metric-value ${color}">${value}</div><div class="metric-caption">${caption}</div></article>`,
    )
    .join("");
  $("paper-date").textContent = book.lastDate
    ? `已结算至 ${book.lastDate}`
    : "等待首次盘后结算";
  $("paper-audit").textContent = data.audit.passed
    ? "资金账本一致"
    : "账本核对异常";
  $("paper-audit").className =
    `outline-tag ${data.audit.passed ? "verified" : "down"}`;
  $("paper-chart").innerHTML = chart(
    data.equities,
    benchmarkName(data.benchmarkCode || book.benchmarkCode),
    data.benchmarkStatus,
  );
  $("paper-risk").textContent =
    `单股上限 ${percent(riskLimits.maxPositionWeight)} · 总仓位上限 ${percent(riskLimits.maxGrossExposure)} · 回撤 ${percent(equity?.drawdown ?? 0)} / ${percent(riskLimits.maxDrawdown)} · 不透支`;
  $("paper-position-rows").innerHTML = book.positions.length
    ? book.positions
        .map((position) => {
          const quantity = position.lots.reduce(
              (sum, lot) => sum + lot.quantity,
              0,
            ),
            basis = position.lots.reduce((sum, lot) => sum + lot.costCents, 0);
          const available = position.lots
            .filter(
              (lot) =>
                lot.acquiredDate <
                (live?.session?.date ||
                  new Date().toLocaleDateString("en-CA", {
                    timeZone: "Asia/Shanghai",
                  })),
            )
            .reduce((sum, lot) => sum + lot.quantity, 0);
          return `<tr><td><strong>${escape(position.name)}</strong><span class="stock-code">${escape(position.code)}</span></td><td>${quantity}<span class="stock-code">当日可卖 ${available}</span></td><td>${money(basis / quantity)}</td><td>${money(position.markCents)}</td><td>¥ ${money(quantity * position.markCents)}</td><td class="${tone(quantity * position.markCents - basis)}">¥ ${money(quantity * position.markCents - basis)}</td><td>${position.heldDays} 日</td></tr>`;
        })
        .join("")
    : '<tr><td colspan="7"><div class="empty compact">当前空仓。下一交易日按照冻结计划与实际成交条件模拟执行。</div></td></tr>';
  const heldQuantityByCode = new Map(
    book.positions.map((position) => [
      position.code,
      position.lots.reduce((sum, lot) => sum + lot.quantity, 0),
    ]),
  );
  const pnlRender = renderStockPnlPage(
    data.stockPnl,
    data.stockPnlMeta,
    heldQuantityByCode,
  );
  const pnlTotal = data.stockPnlMeta?.total ?? 0;
  $("paper-stock-pnl-rows").innerHTML = pnlRender.rowsHtml;
  $("paper-stock-pnl-pager").innerHTML = pnlTotal ? pnlRender.pagerHtml : "";
  $("paper-plan-date").textContent = plan
    ? `${plan.signalDate} 盘后制定 → 下一交易日`
    : "尚未生成计划";
  $("paper-plan-meta").textContent = plan
    ? `策略 ${plan.strategyVersion} · 选股 ${(() => {
        const v = plan.selectionPolicy?.version;
        return v === "signal-ranking-v2"
          ? "精确分 → 成交额 → 代码"
          : v === "signal-ranking-v3"
            ? "精确分 → 分类路由"
            : v === "signal-ranking-v4"
              ? "精确分 → 分类路由 → 买点闸门 → 炸板候选"
              : v === "signal-ranking-v5"
                ? "精确分 → 分类路由 → 买点闸门 → 炸板及首阴/假阴候选"
                : "整数分 → 代码";
      })()} · 费用 v${plan.feeConfigVersion || 0} · 成本 ${plan.executionCostPolicy ? `${plan.executionCostPolicy.modelVersion} v${plan.executionCostPolicy.version || 0}` : "旧版固定 10bps"}${plan.sourceSnapshotMissing ? " · 评分缺失，仅执行风险保护" : ""} · 目标仓位 ${percent(plan.targetExposure)} · ${new Date(plan.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} 冻结`
    : "当日评分保存后，生成下一交易日计划。";
  $("paper-plan-rows").innerHTML = plan?.orders.length
    ? plan.orders
        .map(
          (order) =>
            `<tr><td><strong>${escape(order.name)}</strong><span class="stock-code">${escape(order.code)} · ${escape(order.sector)}</span></td><td><span class="action-tag">${actionNames[order.action]}</span></td><td>${order.score ?? "—"}${Number.isFinite(order.scoreValue) ? `<span class="stock-code">精确 ${Number(order.scoreValue.toFixed(6))}</span>` : ""}<span class="stock-code">原始 ${order.originalScore ?? "—"}</span></td><td>${order.quantity || "—"} 股</td><td class="plan-price-conditions">${priceConditions(order)}</td><td class="plan-reason">${escape(order.reason)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="6"><div class="empty compact">${plan ? "当前没有满足建仓条件的个股，保持空仓。" : "等待有效盘后评分。"}</div></td></tr>`;
  const candidates = plan?.selectionAudit?.candidates ?? [];
  const graded = candidates.filter((c) => c.grade !== undefined);
  const gradeSummary = graded.length
    ? ` · A ${candidates.filter((c) => c.grade === "A").length} / B ${candidates.filter((c) => c.grade === "B").length} / C ${candidates.filter((c) => c.grade === "C").length}`
    : "";
  const gradeCell = (candidate) => {
    if (candidate.grade === undefined) return "未分级";
    if (candidate.grade === null)
      return `剔除<span class="stock-code">${escape(candidate.gradeReason)}</span>`;
    const label =
      candidate.grade === "A"
        ? "重点关注"
        : candidate.grade === "B"
          ? "一般关注"
          : "备选观察";
    return `${candidate.grade} 级<span class="stock-code">${label} · ${escape(candidate.gradeReason)}</span>`;
  };
  const selectionExpanded =
    $("paper-selection-audit").querySelector("details")?.open ?? false;
  $("paper-selection-audit").innerHTML = candidates.length
    ? `<details><summary>选股依据 · ${candidates.filter((c) => c.status === "SELECTED").length} 只入选 / ${candidates.length} 只候选${gradeSummary}</summary><div class="table-scroll"><table><thead><tr><th>顺序</th><th>个股</th><th>分级</th><th>精确评分</th><th>信号日成交额</th><th>选择结果</th></tr></thead><tbody>${candidates.map((c) => `<tr><td>${c.rank}</td><td>${escape(c.name)}<span class="stock-code">${escape(c.code)}</span></td><td>${gradeCell(c)}</td><td>${Number.isFinite(c.scoreValue) ? Number(c.scoreValue.toFixed(6)) : "—"}</td><td>${Number.isFinite(c.liquidityAmountCents) ? `¥ ${metricMoney(c.liquidityAmountCents)}` : "未知"}</td><td>${c.status === "SELECTED" ? "已入选" : "未入选"}<span class="stock-code">${escape(c.reason)}</span></td></tr>`).join("")}</tbody></table></div><p class="small-muted">成交额取自信号日冻结数据，仅作同分决胜；实际成交仍受下一交易日行情、资金及容量限制。</p></details>`
    : "";
  const selectionDetails = $("paper-selection-audit").querySelector("details");
  if (selectionDetails) selectionDetails.open = selectionExpanded;
  $("paper-outcomes").innerHTML = run?.outcomes?.length
    ? `<details><summary>最近执行反馈 · ${escape(run.date)}</summary><div class="execution-feedback">${run.outcomes.map((order) => `<p><strong>${escape(order.name)} · ${actionNames[order.action]}</strong><span>${order.status === "FILLED" ? "已成交" : order.status === "PARTIAL" ? "部分完成" : "未执行"} ${order.filledQuantity ? `${order.filledQuantity} 股` : ""} · ${escape(order.reason || "")}</span></p>`).join("")}</div></details>`
    : "";
  renderLedger();
  const progress = run?.improvement;
  const days = progress?.days ?? Math.max(0, book.settlementCount - 1);
  $("paper-ai-tag").textContent = data.ai.configured
    ? "已配置模型"
    : "模型待配置";
  $("paper-ai-content").innerHTML =
    `<div class="strategy-active"><span>当前策略</span><strong>${escape(book.activeStrategy)}</strong></div><p>${data.ai.configured ? `已积累 ${days} 个可验证交易日。至少 20 日训练 + 10 日封存验证后提出新候选。` : "尚未配置服务端大模型密钥。规则策略正常运行；配置后接入真实 AI 提案与验证。"}</p><div class="ai-process">真实成交与费用<span>↓</span>AI 训练窗口建议<span>↓</span>独立验证 · 收益与回撤<span>↓</span>通过后启用新版本</div><p class="ai-note">每个封存窗口只验证一个候选；已冻结计划和历史交易保留原版本。</p>`;
  $("paper-version-list").innerHTML =
    versions
      .filter((version) => version.id !== "baseline-v1")
      .slice(0, 6)
      .map(
        (version) =>
          `<div class="version-row"><div><strong>${escape(version.id)}</strong><span>${statusNames[version.status] || escape(version.status)}</span></div><p>${escape(version.evidence.rationale || version.evidence.error || "等待验证结果")}</p>${version.evidence.baseline ? `<small>封存验证 ${escape(version.evidence.validationStart)} — ${escape(version.evidence.validationEnd)}<br>基线 ${percent(version.evidence.baseline.totalReturn)} → 候选 ${percent(version.evidence.candidate.totalReturn)} · 回撤 ${percent(version.evidence.candidate.maxDrawdown)}</small>` : ""}${version.status === "VALIDATED" ? `<button class="secondary" data-activate="${escape(version.id)}">启用此版本</button>` : ""}</div>`,
      )
      .join("") ||
    '<div class="small-muted">尚无 AI 候选版本，持续积累真实数据。</div>';
  if (!settingsDirty)
    $("paper-initial-capital").value = book.initialCashCents / 100;
  $("paper-initial-capital").disabled = !data.canEditCapital;
  if (!settingsDirty) fillFeeInputs(data.feeConfig);
  $("paper-fee-version").textContent =
    `费用配置 v${book.feeConfigVersion || 0}`;
  $("paper-fee-summary").textContent =
    `下一计划：${plan?.feeConfig ? feeSummary(plan.feeConfig) : "旧版固定费用"}。新设置随计划冻结，历史成交按当时配置核验。`;
  if (!settingsDirty) fillRiskInputs(data.riskLimits);
  $("paper-risk-version").textContent =
    `风控配置 v${book.riskLimitsVersion || 0}`;
  $("paper-risk-summary").textContent =
    `下一计划：${plan?.riskLimits ? riskSummary(plan.riskLimits) : "默认风控"}。新设置随计划冻结，历史成交按当时配置核验。`;
  if (!settingsDirty) fillStrategyInputs(data.strategyParams);
  $("paper-strategy-version").textContent = `策略 ${book.activeStrategy}`;
  $("paper-strategy-summary").textContent =
    `当前版本 ${book.activeStrategy} · ${programDescription(data.strategyParams)}${plan ? ` · 下一计划 ${plan.strategyVersion}` : ""}。保存数值参数登记为新版本，已冻结计划保持原参数；家族与组合变化通过策略赛马验证。`;
  if (!settingsDirty)
    $("paper-improvement-mode").value = book.improvementMode || "auto";
  if (!settingsDirty)
    $("paper-benchmark").value = book.benchmarkCode || DEFAULT_BENCHMARK;
  if (!settingsDirty)
    $("paper-selection-version").value =
      book.selectionPolicyVersion ?? "signal-ranking-v1";
  $("paper-config-note").textContent = data.canEditCapital
    ? "交易计划开始执行前可自定义初始资金；费用与风控随时可调整。"
    : "初始资金作为收益基准已冻结；费用与风控仍可自定义，适用于后续新计划。";
  document.querySelectorAll("[data-activate]").forEach(
    (button) =>
      (button.onclick = () =>
        perform(async () => {
          const result = await request("/api/paper/activate", {
            id: button.dataset.activate,
          });
          return result.activated
            ? "新版本已启用，将用于后续新计划"
            : "账户同时更新，请重试";
        })),
  );
}
async function refresh() {
  const requestId = ++overviewRequestId;
  const ledgerId = ledgerRequestId;
  try {
    const query = new URLSearchParams();
    query.set("ledgerPage", String(ledgerPage));
    query.set("ledgerPageSize", String(LEDGER_PAGE_SIZE));
    query.set("ledgerDate", ledgerDate || "");
    query.set("stockPnlPage", String(stockPnlPage));
    query.set("stockPnlPageSize", String(STOCK_PNL_PAGE_SIZE));
    const result = await request(`/api/paper?${query.toString()}`);
    if (requestId !== overviewRequestId) return;
    data = result;
    // 服务端会对页码做越界裁剪，用返回值同步本地状态，避免状态漂移。
    // 翻页期间返回的旧概览不能覆盖新账本页。
    if (ledgerId === ledgerRequestId && !ledgerLoading) {
      ledgerData = data.ledgerMeta;
      ledgerPage = ledgerData.page;
      ledgerDate = ledgerData.date;
    }
    if (data?.stockPnlMeta?.page) stockPnlPage = data.stockPnlMeta.page;
    render();
  } catch (error) {
    if (requestId === overviewRequestId) message(error.message);
  }
}
async function refreshLedger() {
  const requestId = ++ledgerRequestId;
  ledgerLoading = true;
  renderLedger();
  try {
    const query = new URLSearchParams({
      page: String(ledgerPage),
      pageSize: String(LEDGER_PAGE_SIZE),
      date: ledgerDate,
    });
    const result = await request(`/api/paper/ledger?${query.toString()}`);
    if (requestId !== ledgerRequestId) return;
    ledgerData = result;
    ledgerPage = result.page;
    ledgerDate = result.date;
  } catch (error) {
    if (requestId !== ledgerRequestId) return;
    ledgerPage = ledgerData?.page ?? 1;
    ledgerDate = ledgerData?.date ?? "";
    message(`成交账本加载失败：${error.message}`);
  } finally {
    if (requestId === ledgerRequestId) {
      ledgerLoading = false;
      renderLedger();
    }
  }
}
async function perform(task) {
  if (busy) return;
  busy = true;
  document
    .querySelectorAll("[data-paper-operation]")
    .forEach((button) => (button.disabled = true));
  message("正在处理，结果将保存到账本…");
  try {
    const result = await task();
    await refresh();
    message(result);
  } catch (error) {
    message(error.message);
  } finally {
    busy = false;
    document
      .querySelectorAll("[data-paper-operation]")
      .forEach((button) => (button.disabled = false));
  }
}
export function initializePaper() {
  $("paper-config-form").addEventListener("input", () => {
    settingsDirty = true;
  });
  $("paper-fee-controls").innerHTML = FEE_FIELDS.map(
    ({ key, label, unit, direction }) =>
      `<label for="fee-${key}">${label}（${unit}）<input id="fee-${key}" type="number" min="0" max="${key === "commission_min" ? 10000 : 100}" step="${key === "commission_min" ? "0.01" : "0.001"}" value="${feeDisplay(key, DEFAULT_FEES[key])}" required><span>${direction}</span></label>`,
  ).join("");
  $("paper-risk-controls").innerHTML = RISK_FIELDS.map(
    ({ key, label, unit, percent, hint }) =>
      `<label for="risk-${key}" title="${escape(hint)}">${label}（${unit}）<input id="risk-${key}" type="number" min="${percent ? 0.01 : 0}" max="${percent ? 100 : 200}" step="${percent ? "0.01" : "1"}" value="${riskDisplay(key, DEFAULT_RISK_LIMITS[key])}" required></label>`,
  ).join("");
  $("paper-strategy-controls").innerHTML = [
    ...WEIGHT_FIELDS.map(
      ({ key, label }) =>
        `<label for="strat-weight-${key}" title="策略评分中「${label}」因子的权重，与研究页观察权重相互独立">${label}权重（%）<input id="strat-weight-${key}" type="number" min="0" max="50" step="1" required></label>`,
    ),
    ...STRATEGY_FIELDS.map(
      ({ key, label, unit, min, max, step, hint }) =>
        `<label for="strat-${key}" title="${escape(hint)}">${label}（${unit}）<input id="strat-${key}" type="number" min="${min}" max="${max}" step="${step}" required></label>`,
    ),
    ...TIER_FIELDS.map(
      ({ key, label, unit, min, max, step, hint }) =>
        `<label for="strat-tier-${key}" title="${escape(hint)}">${label}（${unit}）<input id="strat-tier-${key}" type="number" min="${min}" max="${max}" step="${step}" required></label>`,
    ),
  ].join("");
  $("paper-benchmark").innerHTML = BENCHMARK_INDEXES.map(
    ({ code, name }) => `<option value="${code}">${name}</option>`,
  ).join("");
  $("paper-fee-defaults").onclick = () => {
    fillFeeInputs(DEFAULT_FEES);
    settingsDirty = true;
    message("已填入图中默认费用，保存设置后生效。");
  };
  $("paper-risk-defaults").onclick = () => {
    fillRiskInputs(DEFAULT_RISK_LIMITS);
    settingsDirty = true;
    message("已填入默认风控约束，保存设置后生效。");
  };
  $("paper-strategy-defaults").onclick = () => {
    fillStrategyInputs(STRATEGY_DEFAULTS, { preserveProgram: true });
    settingsDirty = true;
    message("已填入默认策略参数，保存设置后登记为新版本并用于下一份计划。");
  };
  $("paper-run").onclick = () =>
    perform(async () => {
      const result = await request("/api/run-daily", {});
      window.dispatchEvent(new Event("paper-updated"));
      return (
        result.paper?.reason || result.snapshot?.reason || "已完成盘后更新"
      );
    });
  $("paper-verify").onclick = () =>
    perform(async () => {
      const result = await request("/api/paper/verify");
      return result.passed
        ? `完整重放通过：${result.days} 个结算日、${result.fills} 笔成交，资金、费用与收益均一致。`
        : "验证未通过，请检查导出记录与行情完整度。";
    });
  $("paper-improve").onclick = () =>
    perform(async () => {
      const result = await request("/api/paper/improve", {});
      return (
        result.reason ||
        `AI 改进状态：${statusNames[result.status] || result.status}`
      );
    });
  $("paper-config-form").onsubmit = (event) => {
    event.preventDefault();
    void perform(async () => {
      const result = await request("/api/paper/settings", {
        ...(data?.canEditCapital
          ? { initialCapital: Number($("paper-initial-capital").value) }
          : {}),
        improvementMode: $("paper-improvement-mode").value,
        benchmarkCode: $("paper-benchmark").value || DEFAULT_BENCHMARK,
        ...([
          "signal-ranking-v3",
          "signal-ranking-v4",
          "signal-ranking-v5",
        ].includes($("paper-selection-version").value)
          ? { selectionPolicyVersion: $("paper-selection-version").value }
          : {}),
        fees: Object.fromEntries(
          FEE_FIELDS.map(({ key }) => [
            key,
            key === "commission_min"
              ? Number($(`fee-${key}`).value)
              : Number($(`fee-${key}`).value) / 10000,
          ]),
        ),
        riskLimits: Object.fromEntries(
          RISK_FIELDS.map(({ key, percent }) => [
            key,
            percent
              ? Number($(`risk-${key}`).value) / 100
              : Number($(`risk-${key}`).value),
          ]),
        ),
        strategyParams: collectStrategyParams(),
      });
      settingsDirty = false;
      return `设置已保存；策略参数登记为 ${result.book.activeStrategy}，将用于下一份计划，已冻结计划保持原参数。`;
    });
  };
  $("paper-ledger-date-filter").onchange = () => {
    ledgerDate = $("paper-ledger-date-filter").value;
    ledgerPage = 1;
    void refreshLedger();
  };
  document.addEventListener("click", (event) => {
    const btn = event.target.closest(".page-btn[data-page]");
    if (btn && !btn.disabled) {
      ledgerPage = Number(btn.dataset.page);
      void refreshLedger();
      return;
    }
    const pnlBtn = event.target.closest(".page-btn[data-pnl-page]");
    if (pnlBtn && !pnlBtn.disabled) {
      stockPnlPage = Number(pnlBtn.dataset.pnlPage);
      void refresh();
    }
  });
  window.addEventListener("paper-updated", refresh);
  setInterval(() => {
    if (!document.hidden && !busy) void refresh();
  }, 15000);
  void refresh();
  return { refresh };
}
