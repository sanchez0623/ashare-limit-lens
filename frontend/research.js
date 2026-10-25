import {
  FACTORS,
  PRESETS,
  analyze,
  normalize,
  timeLabel,
} from "../shared/scoring.js";
import { initializePaper } from "./paper.js";
import { initializeStrategies } from "./strategies.js";
import { initializeAlerts } from "./alerts.js";
import { initializeDataManagement, beijingTime } from "./data-management.js";
import { isExecutionReview } from "../shared/review.js";
import { executionReviewView, reviewMoney } from "./execution-review.js";
import { initializeObservatory } from "./observatory.js";
import { parseRoute, routeHash } from "./observatory-model.js";
import {
  researchIndustryName,
  researchIndustryGroups,
} from "../shared/industry-research.js";
const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icons = {
  dashboard:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  chart: '<path d="M4 3v17h17M8 15l4-6 4 3 5-7"/>',
  grid: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 11h18M11 4v16"/>',
  sliders:
    '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="9" cy="18" r="2" fill="currentColor"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/>',
  refresh:
    '<path d="M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5M4 17a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  flame:
    '<path d="M12 3c1 6 7 6 7 12a7 7 0 0 1-14 0c0-3 2-5 4-7 0 3 1 3 2 4 2-3 2-6 1-9Z"/>',
  shield:
    '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.chart}</svg>`;
}
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
const state = {
  view: "overview",
  paperTab: "live",
  reviewTab: "review",
  height: "all",
  // 板块研究页内 行业 ↔ 题材 切换标签状态
  synergyTab: "industry",
  industryTaxonomy: "EM",
  // 个股视图按题材标签筛选（点击题材行写入，清除 chip 或切换数据时复位）
  themeFilter: null,
  weights: [...PRESETS.balanced],
  payload: null,
  analysis: null,
  loading: true,
  error: null,
  demo: false,
  request: 0,
  review: null,
  ai: null,
  aiConfig: { configured: false },
  history: null,
  reviewBusy: false,
  reviewMessage: "",
  storageAvailable: false,
};
try {
  const pref = JSON.parse(localStorage.getItem("limitLensWeights"));
  if (
    Array.isArray(pref) &&
    pref.length === 6 &&
    pref.every((v) => Number.isInteger(v) && v >= 0 && v <= 50) &&
    pref.some((v) => v > 0)
  )
    state.weights = pref;
} catch {}
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const initialRoute = parseRoute(window.location.hash, today);
let routingReady = false,
  applyingRoute = false,
  pendingSector = null,
  dateChosen = !!initialRoute.date,
  lastAppliedHash = "";
const scrollPositions = new Map();
$("trade-date").value = initialRoute.date || today;
$("trade-date").max = today;
const observatory = initializeObservatory({
  navigate(view, tab) {
    if (view === "paper" && tab) state.paperTab = tab;
    if (view === "review" && tab) state.reviewTab = tab;
    if (view === "sectors" && tab) state.synergyTab = tab;
    setView(view);
  },
  onHeight(height) {
    state.height = height;
    state.themeFilter = null;
    $("search").value = "";
    $("sector-filter").value = "";
    setView("stocks");
  },
  onSector: selectSector,
  onArchive(date) {
    dateChosen = true;
    $("trade-date").value = date;
    state.reviewTab = "review";
    setView("review");
    void loadData();
  },
  getPayload: () => (state.demo ? null : state.payload),
  getPlan: () => paper.getSnapshot()?.plan,
});
const paper = initializePaper({ onState: observatory.updateExecution });
const dataManagement = initializeDataManagement();
const titles = {
  data: [
    "数据管理",
    "股票信息与双行业数据",
    "查看覆盖情况，手动更新股票信息与两套行业分类。",
  ],
  paper: [
    "模拟执行",
    "让计划，走进市场。",
    "跟踪当前账户的执行、持仓与结果，逐一核对判断。",
  ],
  overview: [
    "今日观察",
    "市场，自有形状。",
    "从全貌到细节，让每一个判断都有迹可循。",
  ],
  stocks: [
    "深入研究 / 个股",
    "沿着信号，看到依据。",
    "拆解封板表现，在同一口径下比较强度与风险。",
  ],
  sectors: [
    "深入研究 / 市场主线",
    "资金的线索，在这里交汇。",
    "行业分类与涨停原因标签，两个维度观察资金的共同方向。",
  ],
  review: [
    "复盘档案",
    "每个判断，都有回声。",
    "翻开当日的依据，用实际表现检验，再留下一份观察。",
  ],
  settings: ["设置", "设置", "管理复盘评分、大模型连接与高级研究。"],
  strategies: [
    "设置 / 策略赛马",
    "多策略并行赛马与受控晋级",
    "同一份行情、同一冻结起点，固定窗口内比较，只有合格报告支持启用。",
  ],
  alerts: [
    "运维告警",
    "常驻执行不静默失联",
    "执行错误、风险处置与盘后失败主动通知；整机离线由外部监测发现。",
  ],
};
function routeState() {
  return {
    view: state.view,
    tab:
      state.view === "paper"
        ? state.paperTab
        : state.view === "review"
          ? state.reviewTab
          : state.synergyTab,
    date: $("trade-date").value,
    industryTaxonomy: state.industryTaxonomy,
    height: state.height,
    query: $("search").value,
    sector: pendingSector ?? $("sector-filter").value,
    theme: state.themeFilter,
    sort: $("sort").value,
  };
}
function syncRoute({ replace = false } = {}) {
  if (!routingReady || applyingRoute) return;
  const hash = routeHash(routeState());
  if (window.location.hash !== hash)
    window.history[replace ? "replaceState" : "pushState"](null, "", hash);
  lastAppliedHash = hash;
}
function restoreRoute({ initial = false } = {}) {
  if (!initial && window.location.hash === lastAppliedHash) return;
  const anchor = window.location.hash.slice(1);
  if (anchor === "main-content") return;
  lastAppliedHash = window.location.hash;
  const route = parseRoute(window.location.hash, today);
  const changedDate = !!route.date && route.date !== $("trade-date").value;
  applyingRoute = true;
  if (route.date) {
    $("trade-date").value = route.date;
    dateChosen = true;
  }
  state.paperTab = route.view === "paper" ? route.tab : state.paperTab;
  state.reviewTab = route.view === "review" ? route.tab : state.reviewTab;
  state.synergyTab = route.view === "sectors" ? route.tab : state.synergyTab;
  state.industryTaxonomy = route.industryTaxonomy;
  state.height = route.height;
  state.themeFilter = route.theme || null;
  $("search").value = route.query;
  $("sort").value = route.sort;
  $("industry-taxonomy").value = route.industryTaxonomy;
  $("stock-industry-taxonomy").value = route.industryTaxonomy;
  pendingSector = route.sector;
  if (state.analysis && !changedDate) updateFilters();
  setView(route.view);
  applyingRoute = false;
  if (changedDate && !initial) void loadData();
}
function selectSector(name, taxonomy = "EM") {
  changeIndustryTaxonomy(taxonomy);
  $("sector-filter").value = name;
  state.themeFilter = null;
  state.height = "all";
  $("search").value = "";
  setView("stocks");
}
function selectTheme(name) {
  state.themeFilter = name;
  state.height = "all";
  $("search").value = "";
  $("sector-filter").value = "";
  setView("stocks");
}
function setView(view) {
  if (!titles[view]) return;
  if (view !== state.view) scrollPositions.set(state.view, window.scrollY);
  state.view = view;
  $("crumb").textContent = titles[view][0];
  $("page-title").textContent = titles[view][1];
  $("page-subtitle").textContent = titles[view][2];
  $("overview-content").hidden = !["overview", "stocks"].includes(view);
  $("sectors-view").hidden = view !== "sectors";
  $("settings-view").hidden = view !== "settings";
  $("review-view").hidden = view !== "review";
  $("summary").hidden = [
    "settings",
    "review",
    "paper",
    "strategies",
    "alerts",
  ].includes(view);
  $("paper-view").hidden = view !== "paper";
  $("strategies-view").hidden = view !== "strategies";
  $("alerts-view").hidden = view !== "alerts";
  $("data-view").hidden = view !== "data";
  observatory.setWorkspace(state);
  if (view === "data") $("summary").hidden = true;
  dataManagement.setVisible(view === "data");
  updateSource();
  document.querySelector(".heading-actions").hidden =
    view === "paper" ||
    view === "strategies" ||
    view === "alerts" ||
    view === "data" ||
    view === "settings";
  document.querySelector(".data-strip").hidden =
    view === "paper" ||
    view === "strategies" ||
    view === "alerts" ||
    view === "data" ||
    view === "settings";
  if (view === "paper") void paper.refresh();
  if (view === "strategies") initializeStrategies();
  if (view === "alerts") initializeAlerts();
  document.querySelector(".right-column").hidden = view === "stocks";
  $("overview-content").style.gridTemplateColumns =
    view === "stocks" ? "minmax(0,1fr)" : "";
  render();
  renderReview();
  syncRoute();
  window.scrollTo(0, scrollPositions.get(view) ?? 0);
}
window.addEventListener("popstate", () => restoreRoute());
window.addEventListener("hashchange", () => restoreRoute());
document
  .querySelectorAll("[data-view]")
  .forEach((el) => (el.onclick = () => setView(el.dataset.view)));
document.querySelector(".brand").onclick = (e) => {
  e.preventDefault();
  setView("overview");
};
function fmt(v, d = 1) {
  return v === null || v === undefined ? "—" : Number(v).toFixed(d);
}
function money(v) {
  if (v === null || v === undefined) return "—";
  return v >= 1e8 ? `${(v / 1e8).toFixed(2)} 亿` : `${(v / 1e4).toFixed(0)} 万`;
}
function scoreClass(s) {
  return s >= 80 ? "" : s >= 60 ? "mid" : "low";
}
function scoreHtml(s) {
  return `<div class="score-cell"><span class="score-number ${scoreClass(s)}">${s ?? "—"}</span><span class="score-track"><i style="width:${s ?? 0}%"></i></span></div>`;
}
function recalculate() {
  const options = {
    // 服务端随 payload 下发的 MA5（daily parquet 计算），供首阴校验
    ...(state.payload?.ma5ByCode ? { ma5ByCode: state.payload.ma5ByCode } : {}),
    // 股票分类历史特征（涨停基因 / MA20 / 20 日振幅），供分类路由
    ...(state.payload?.historyByCode
      ? { historyByCode: state.payload.historyByCode }
      : {}),
    ...(state.payload?.previousPricesVerified === true
      ? {
          previousPricesVerified: true,
          prevEodByCode: state.payload.prevEodByCode ?? {},
        }
      : {}),
    // 买点参数（首阴门槛，settings 表配置，服务端已按白名单过滤）
    // 与尾盘时点标记；显式取字段，不整体展开
    ...(state.payload?.buyPointParams
      ? {
          firstNegMinPrevHeight:
            state.payload.buyPointParams.firstNegMinPrevHeight,
        }
      : {}),
    ...(state.payload?.lateSession === true ? { lateSession: true } : {}),
    // 双维度协同评分（行业 + 题材）
    enableDualSynergy: true,
    dualSynergyWeights: { industry: 0.8, theme: 0.2 },
    // 炸板池原始行（payload 已下发）：炸板低吸 / 尾盘跳水低吸 候选来源，
    // 与服务端 saveSnapshot 的 analyze 输入保持同口径
    ...(state.payload?.brokenRows?.length
      ? { brokenRows: state.payload.brokenRows.map(normalize) }
      : {}),
  };
  state.analysis = state.payload?.archived
    ? structuredClone(state.payload.analysis)
    : state.payload
      ? analyze(
          state.payload.rows.map(normalize),
          state.payload.broken,
          state.payload.previous?.map(normalize) || null,
          state.weights,
          options,
        )
      : null;
}
function render() {
  const a = state.analysis,
    has = a !== null,
    loading = state.loading;
  const metrics = [
    {
      name: "涨停家数",
      value: has ? a.count : "—",
      unit: "家",
      caption: has
        ? `首板 ${a.first} 家 · 连板 ${a.relay} 家`
        : "首板与连板分布",
      icon: "flame",
      pct: has ? Math.min((a.count / 80) * 100, 100) : 0,
    },
    {
      name: "封板率",
      value: has ? fmt(a.sealRate) : "—",
      unit: "%",
      caption: has
        ? state.payload.broken === null
          ? "炸板池数据暂缺"
          : `炸板 ${state.payload.broken} 家 · 当前未封住`
        : "涨停 /（涨停 + 炸板）",
      icon: "shield",
      pct: has ? (a.sealRate ?? 0) : 0,
    },
    {
      name: "最高连板",
      value: has ? a.height : "—",
      unit: "板",
      caption: has
        ? `连板股占比 ${a.count ? fmt((a.relay / a.count) * 100) : "—"}%`
        : "衡量当日市场高度",
      icon: "chart",
      pct: has ? Math.min((a.height / 7) * 100, 100) : 0,
      amber: true,
    },
    {
      name: "情绪强度",
      value: has ? (a.emotion ?? "—") : "—",
      unit: "/ 100",
      caption: has
        ? a.emotion === null
          ? "当日无有效评分样本"
          : `${a.emotion >= 75 ? "强度较高" : a.emotion >= 45 ? "强度中等" : "强度较低"} · ${a.emotionCoverage == null ? "已归档的收盘判断" : `数据覆盖 ${a.emotionCoverage}%`}`
        : "涨停规模 · 封板率 · 高度",
      icon: "dashboard",
      pct: has ? (a.emotion ?? 0) : 0,
      accent: true,
    },
  ];
  $("summary").innerHTML = metrics
    .map(
      (m) =>
        `<article class="metric ${loading ? "loading" : ""}"><div class="metric-head">${m.name}${icon(m.icon)}</div><div class="metric-value ${m.accent ? "accent" : ""}">${m.value}<small>${m.unit}</small></div><div class="metric-caption">${m.caption}</div><div class="metric-line ${m.amber ? "amber" : ""}"><i style="width:${m.pct}%"></i></div></article>`,
    )
    .join("");
  $("pool-count").textContent = has ? a.count : "—";
  renderStocks();
  renderSectors();
  renderThemes();
  renderLadder();
  observatory.render(
    state,
    researchIndustryGroups(
      state.analysis,
      state.industryTaxonomy,
      state.payload?.industryMetadata,
    ).groups,
  );
}
function filteredStocks() {
  let rows = state.analysis?.stocks || [];
  const query = $("search").value.trim().toLowerCase(),
    sector = $("sector-filter").value;
  rows = rows.filter(
    (r) =>
      (!query ||
        r.name.toLowerCase().includes(query) ||
        r.code.includes(query)) &&
      (!sector ||
        (sector === "__MISSING__"
          ? !researchIndustryName(
              r,
              state.industryTaxonomy,
              state.payload?.industryMetadata,
            )
          : researchIndustryName(
              r,
              state.industryTaxonomy,
              state.payload?.industryMetadata,
            ) === sector)) &&
      (!state.themeFilter || (r.themes || []).includes(state.themeFilter)) &&
      (state.height === "all" ||
        (state.height === "first"
          ? r.height === 1
          : state.height === "relay"
            ? r.height > 1
            : r.height === Number(state.height))),
  );
  const sort = $("sort").value;
  return rows
    .slice()
    .sort(
      sort === "height"
        ? (a, b) => (b.height ?? 0) - (a.height ?? 0)
        : sort === "seal"
          ? (a, b) => (b.seal ?? -1) - (a.seal ?? -1)
          : sort === "first"
            ? (a, b) => (a.first ?? 999999) - (b.first ?? 999999)
            : (a, b) => (b.score ?? -1) - (a.score ?? -1),
    );
}
function industryResearchNote() {
  const oldArchive = state.payload?.archived && !state.payload.industryContext;
  const original = oldArchive ? "原快照行业（旧版冻结口径）" : "东财行业";
  if (state.industryTaxonomy === "EM")
    return `${original} · 样本 ${state.payload?.date ?? "—"} · ${oldArchive ? "保留原行业与评分；新评分与交易使用东财口径" : "个股评分与交易使用东财口径"}`;
  const research = researchIndustryGroups(
    state.analysis,
    state.industryTaxonomy,
    state.payload?.industryMetadata,
  );
  return `样本 ${state.payload?.date ?? "—"} · 分类更新 ${beijingTime(state.payload?.industryMetadata?.fetchedAt)}（北京时间） · 按当前分类观察 · 未覆盖 ${research.uncovered} 只 · 仅供界面探索，${state.payload?.archived ? "原快照行业与评分保持归档值；交易使用东财口径" : "个股评分与交易使用东财口径"}`;
}
function renderStocks() {
  const rows = filteredStocks(),
    ready = state.analysis !== null;
  document.querySelectorAll("[data-height]").forEach((button) => {
    button.classList.toggle("active", button.dataset.height === state.height);
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.height === state.height),
    );
  });
  let exact = $("exact-height-filter");
  if (!exact) {
    exact = document.createElement("span");
    exact.id = "exact-height-filter";
    exact.className = "exact-height-chip";
    $("overview-content")
      .querySelector(".table-subnav .segments")
      .append(exact);
  }
  exact.hidden = !/^\d+$/.test(state.height);
  exact.innerHTML = exact.hidden
    ? ""
    : `${state.height} 板 <button aria-label="清除精确连板筛选">×</button>`;
  if (!exact.hidden)
    exact.querySelector("button").onclick = () => {
      state.height = "all";
      renderStocks();
      syncRoute({ replace: true });
    };
  const currentSw = state.industryTaxonomy !== "EM";
  $("stock-industry-note").hidden = !currentSw && !state.payload?.archived;
  $("stock-industry-note").textContent = industryResearchNote();
  $("stock-industry-header").textContent =
    `${state.payload?.archived ? "原快照行业" : "东财行业"}${currentSw ? " / 当前申万分类" : ""}`;
  // 题材筛选 chip：点击题材行写入 state.themeFilter，清除按钮或切换数据复位
  const chip = $("theme-filter-chip");
  if (chip) {
    chip.hidden = !state.themeFilter;
    if (state.themeFilter)
      $("theme-filter-label").textContent = `题材：${state.themeFilter}`;
  }
  const emptyTitle = state.loading
    ? "正在获取行情"
    : ready
      ? "没有符合条件的个股"
      : "暂无可用行情";
  const emptyText = state.loading
    ? "正在读取公开涨停池、炸板池与昨日涨停池…"
    : ready
      ? "尝试调整搜索、行业或连板筛选。"
      : "切换近期交易日期或稍后刷新，也可以查看明确标注的演示。";
  $("stock-rows").innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td><button class="stock-name" data-stock="${escape(r.code)}">${escape(r.name)}</button><span class="stock-code">${escape(r.code)}</span></td><td>${scoreHtml(r.score)}</td><td><span class="sector-tag">${escape(r.sector)}</span>${currentSw ? `<small class="stock-research-industry">当前申万：${escape(researchIndustryName(r, state.industryTaxonomy, state.payload?.industryMetadata) ?? "未覆盖")}</small>` : ""}</td><td><span class="height-tag ${r.height >= 4 ? "high" : ""}">${r.height === 1 ? "首板" : r.height ? `${r.height} 板` : "—"}</span></td><td class="money">${timeLabel(r.first)}</td><td class="money">${money(r.seal)}</td><td class="money">${fmt(r.turnover)}%</td><td class="money">${r.breaks ?? "—"}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="8"><div class="empty"><strong>${emptyTitle}</strong>${emptyText}</div></td></tr>`;
  document
    .querySelectorAll("[data-stock]")
    .forEach((btn) => (btn.onclick = () => openStock(btn.dataset.stock)));
  $("table-status").textContent = ready
    ? `显示 ${rows.length} / ${state.analysis.count} 家${state.themeFilter ? ` · 题材 ${state.themeFilter}` : ""}${state.analysis.excluded ? ` · 已剔除 ${state.analysis.excluded} 家 ST / 退市标识个股` : ""}`
    : state.loading
      ? "公开行情加载中"
      : "等待有效数据";
}
function renderSectors() {
  applySynergyTab();
  const emSectors = state.analysis?.sectors || [];
  const research = researchIndustryGroups(
    state.analysis,
    state.industryTaxonomy,
    state.payload?.industryMetadata,
  );
  const sectors = research.groups;
  $("industry-research-note").textContent = industryResearchNote();
  $("sector-rank").innerHTML = emSectors.length
    ? emSectors
        .slice(0, 5)
        .map(
          (s, i) =>
            `<button class="sector-row" data-sector="${escape(s.name)}" data-sector-taxonomy="EM"><div class="sector-row-label"><div><span class="rank-index">0${i + 1}</span>${escape(s.name)}</div><span class="sector-score">${s.score}</span></div><div class="sector-bar"><i style="width:${s.score}%"></i></div><div class="sector-row-meta">${s.count} 家涨停 · 最高 ${s.height} 板</div></button>`,
        )
        .join("")
    : '<div class="empty compact">有效行情到达后，显示行业强度排名。</div>';
  $("sector-rows").innerHTML = sectors.length
    ? sectors
        .map(
          (s) =>
            `<tr><td><button class="stock-name" data-sector="${escape(s.name)}" data-sector-taxonomy="${state.industryTaxonomy}">${escape(s.name)}</button></td><td>${scoreHtml(s.score)}</td><td>${s.count}</td><td>${s.height} 板</td><td>${fmt(s.quality)} / 100</td><td>${fmt(s.components[3].value)}%</td><td>${money(s.amount)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="7"><div class="empty"><strong>暂无可用行业分组</strong>${state.industryTaxonomy !== "EM" ? "请先在数据管理更新申万行业；未覆盖股票不合并为一个行业。" : "请先获取有效交易日行情。"}</div></td></tr>`;
  document.querySelectorAll("[data-sector]").forEach(
    (btn) =>
      (btn.onclick = () => {
        selectSector(btn.dataset.sector, btn.dataset.sectorTaxonomy);
      }),
  );
}
// 板块研究页 行业 ↔ 题材 切换：反映 state.synergyTab，控制两个面板显隐
function applySynergyTab() {
  const tab = state.synergyTab;
  document
    .querySelectorAll(".synergy-tab")
    .forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.synergy === tab),
    );
  const industry = $("industry-panel");
  const theme = $("theme-panel");
  if (industry) industry.hidden = tab !== "industry";
  if (theme) theme.hidden = tab !== "theme";
}
// 题材协同展示：与行业维度同结构，按涨停原因标签聚合
function renderThemes() {
  const themes = state.analysis?.themes || [];
  $("theme-rank").innerHTML = themes.length
    ? themes
        .slice(0, 5)
        .map(
          (t, i) =>
            `<button class="sector-row" data-theme="${escape(t.name)}"><div class="sector-row-label"><div><span class="rank-index">0${i + 1}</span>${escape(t.name)}</div><span class="sector-score">${t.score}</span></div><div class="sector-bar"><i style="width:${t.score}%"></i></div><div class="sector-row-meta">${t.count} 家涨停 · 最高 ${t.height} 板</div></button>`,
        )
        .join("")
    : '<div class="empty compact">当日涨停原因未解析出有效题材标签。</div>';
  $("theme-rows").innerHTML = themes.length
    ? themes
        .map(
          (t) =>
            `<tr><td><button class="stock-name" data-theme="${escape(t.name)}">${escape(t.name)}</button></td><td>${scoreHtml(t.score)}</td><td>${t.count}</td><td>${t.height} 板</td><td>${fmt(t.quality)} / 100</td><td>${fmt(t.components[3].value)}%</td><td>${money(t.amount)}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="7"><div class="empty"><strong>暂无题材评分</strong>当日涨停原因缺失或仅含噪声标签时，无法解析题材协同。</div></td></tr>';
  document.querySelectorAll("[data-theme]").forEach(
    (btn) =>
      (btn.onclick = () => {
        selectTheme(btn.dataset.theme);
      }),
  );
}
function renderLadder() {
  const a = state.analysis;
  let list = [
    {
      name: "5板+",
      count: a ? a.stocks.filter((r) => r.height >= 5).length : 0,
    },
    {
      name: "4板",
      count: a ? a.stocks.filter((r) => r.height === 4).length : 0,
    },
    {
      name: "3板",
      count: a ? a.stocks.filter((r) => r.height === 3).length : 0,
    },
    {
      name: "2板",
      count: a ? a.stocks.filter((r) => r.height === 2).length : 0,
    },
    { name: "首板", count: a ? a.first : 0 },
  ];
  const max = Math.max(1, ...list.map((x) => x.count));
  $("ladder-chart").innerHTML = list
    .map(
      (x) =>
        `<div class="ladder-row"><span class="label">${x.name}</span><div class="ladder-track"><i style="width:${(x.count / max) * 100}%"></i></div><span class="ladder-count">${a ? x.count : "—"}</span></div>`,
    )
    .join("");
  $("ladder-insight").textContent = a
    ? `上一交易日涨停股晋级率：${a.promotion == null ? "暂缺" : `${fmt(a.promotion)}%`}${a.previousCount !== null ? `（样本 ${a.previousCount} 家）` : "，昨日数据暂缺"}${state.payload?.promotionBackfilled ? "，按归档样本补算" : ""}。连板梯队仅反映当日结构。`
    : "用首板供给与连板高度共同观察接力结构。";
}
function updateSource() {
  const p = state.payload;
  $("source-tag").className =
    `source-tag ${state.demo ? "demo" : state.error ? "unavailable" : ""}`;
  $("source-tag").textContent = state.loading
    ? "行情加载中"
    : state.demo
      ? "演示数据"
      : p
        ? p.archived
          ? "历史归档"
          : "公开行情"
        : "数据暂不可用";
  $("data-time").textContent = state.loading
    ? "正在获取所选交易日涨停池"
    : p
      ? state.demo
        ? "虚构样本，仅用于体验评分和交互"
        : p.archived
          ? `${p.date} · ${p.source} · 归档于 ${new Date(p.archivedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）`
          : `${p.date} · ${p.source} · 获取于 ${new Date(p.fetchedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）${p.cached ? " · 2 分钟缓存" : ""}`
      : "未使用演示数据替代真实行情";
  $("sidebar-source").textContent = state.demo
    ? "演示模式"
    : p
      ? p.archived
        ? "历史归档 · 已读取"
        : "东方财富 · 已接入"
      : "东方财富 · 等待数据";
  $("demo-btn").textContent = state.demo ? "返回公开行情" : "查看演示";
  $("notice").hidden =
    !["overview", "stocks", "sectors", "review"].includes(state.view) ||
    (!state.error && !state.demo && !p?.warnings?.length);
  $("notice").textContent =
    state.error ||
    (state.demo
      ? "当前为虚构演示样本，所有个股、日期关联与得分均不代表实际行情。"
      : p?.warnings?.join(" ")) ||
    "";
  $("notice").classList.toggle(
    "archive-note",
    !state.error &&
      !state.demo &&
      !!p?.archived &&
      p.warnings?.length === 1 &&
      p.warnings[0] ===
        "当前展示已保存的盘后评分，个股与板块得分保持当天冻结值。",
  );
  $("refresh-btn").disabled = state.loading;
  $("refresh-btn").innerHTML =
    `${icon("refresh")}${state.loading ? "获取中…" : "刷新行情"}`;
}
async function loadData({ skipReview = false } = {}) {
  const req = ++state.request;
  const requestedDate = $("trade-date").value;
  state.demo = false;
  state.loading = true;
  state.error = null;
  state.payload = null;
  state.analysis = null;
  state.review = null;
  state.ai = null;
  state.reviewMessage = "正在检查历史反馈";
  updateSource();
  render();
  renderReview();
  try {
    const response = await fetch(
      `/api/market?date=${encodeURIComponent(requestedDate)}`,
      { signal: AbortSignal.timeout(20000) },
    );
    const payload = await response.json();
    if (req !== state.request) return;
    const hasArchive =
      payload.archived === true &&
      Array.isArray(payload.analysis?.stocks) &&
      Array.isArray(payload.analysis?.sectors);
    if (!response.ok || (!Array.isArray(payload.rows) && !hasArchive))
      throw new Error(payload.error || "公开行情请求失败");
    if (payload.date !== requestedDate)
      throw new Error("返回的数据日期与所选日期不一致，请重新刷新");
    state.payload = payload;
    recalculate();
  } catch (e) {
    if (req !== state.request) return;
    state.error =
      e.name === "TimeoutError"
        ? "行情请求超时，请稍后刷新。"
        : e.message || "公开行情请求失败";
  } finally {
    if (req === state.request) {
      state.loading = false;
      updateFilters();
      updateSource();
      updateWeightSummary();
      render();
      syncRoute({ replace: true });
      if (
        !skipReview &&
        state.payload?.date === today &&
        !state.payload.archived &&
        state.storageAvailable
      )
        void runDaily(req);
      else if (!skipReview) void readReview(req);
    }
  }
}
function updateFilters() {
  const selected = pendingSector ?? $("sector-filter").value;
  pendingSector = null;
  const research = researchIndustryGroups(
    state.analysis,
    state.industryTaxonomy,
    state.payload?.industryMetadata,
  );
  $("sector-filter").innerHTML =
    '<option value="">全部行业</option>' +
    research.groups
      .map(
        (s) => `<option value="${escape(s.name)}">${escape(s.name)}</option>`,
      )
      .join("") +
    (research.uncovered
      ? '<option value="__MISSING__">申万未覆盖</option>'
      : "");
  if (
    research.groups.some((s) => s.name === selected) ||
    (selected === "__MISSING__" && research.uncovered)
  )
    $("sector-filter").value = selected;
}
function changeIndustryTaxonomy(value) {
  if (!["EM", "SW1", "SW2", "SW3"].includes(value)) return;
  state.industryTaxonomy = value;
  $("industry-taxonomy").value = value;
  $("stock-industry-taxonomy").value = value;
  $("sector-filter").value = "";
  updateFilters();
  render();
}
$("industry-taxonomy").onchange = $("stock-industry-taxonomy").onchange = (
  event,
) => {
  changeIndustryTaxonomy(event.target.value);
  syncRoute({ replace: true });
};
window.addEventListener("metadata-updated", () => {
  void loadData({ skipReview: true });
});
function openStock(code) {
  const r = state.analysis?.stocks.find((r) => r.code === code);
  if (!r) return;
  const sec = state.analysis.sectors.find((s) => s.name === r.sector);
  const strongest = r.factors
    .filter((f) => f.value !== null)
    .sort((a, b) => b.value - a.value)[0];
  const weakest = r.factors
    .filter((f) => f.value !== null)
    .sort((a, b) => a.value - b.value)[0];
  const words = `${r.name}为${r.height === 1 ? "首板" : r.height ? `${r.height}连板` : "连板高度暂缺"}，${timeLabel(r.first)}首次封板${r.breaks !== null ? `，盘中炸板 ${r.breaks} 次` : ""}。${strongest ? `${strongest.name}是当前较强指标（${Math.round(strongest.value)} 分）。` : ""}${weakest && weakest !== strongest ? `${weakest.name}相对偏弱（${Math.round(weakest.value)} 分）。` : ""}${r.themes?.length ? `涨停原因标签 ${r.themes.join("、")}。` : ""}所属行业 ${sec?.count || 0} 家涨停，板块得分 ${sec?.score ?? "—"}。`;
  $("stock-detail").innerHTML =
    `<div class="detail-head"><div><h2>${escape(r.name)}</h2><span class="stock-code">${escape(r.code)}${state.demo ? " · 演示样本" : ""}</span><div class="detail-tags"><span class="sector-tag">${escape(r.sector)}</span><span class="height-tag">${r.height === 1 ? "首板" : `${r.height ?? "—"} 板`}</span></div></div><div class="detail-score">${r.score ?? "—"}<small>综合评分 / 100</small></div></div><div class="detail-facts"><div><label>封单金额</label><strong>${money(r.seal)}</strong></div><div><label>封单 / 成交额</label><strong>${r.sealRatio === null ? "—" : fmt(r.sealRatio * 100)}%</strong></div><div><label>换手率</label><strong>${fmt(r.turnover)}%</strong></div><div><label>最后封板</label><strong>${timeLabel(r.last)}</strong></div></div><div class="detail-section"><h3>六维评分拆解</h3>${r.factors.map((f) => `<div class="factor-row"><span>${f.name}</span><span class="factor-track"><i style="width:${f.value ?? 0}%"></i></span><strong>${f.value === null ? "—" : Math.round(f.value)}</strong><span class="weight">权重 ${f.weight}</span></div>`).join("")}<p class="detail-footnote">有效指标均分 ${fmt(r.rawScore)} − 风险扣分 ${r.deduction} = ${r.score ?? "—"} 分 · 覆盖率 ${r.coverage}%</p></div><div class="detail-section"><h3>风险观察</h3>${r.risks.length ? r.risks.map((x) => `<div class="risk-row"><strong>${x.text} −${x.penalty}</strong><span>${x.detail}</span></div>`).join("") : '<p class="detail-footnote">当前字段未触发模型风险扣分项；公告、基本面与题材风险仍需单独核实。</p>'}</div><div class="detail-section"><h3>盘后诊断</h3><p class="detail-text">${escape(words)}</p></div><p class="detail-footnote">次日观察：竞价是否有承接、同板块是否形成合力、开板后能否回封。当前规则分数尚未经过历史收益校准，不代表上涨概率。</p>`;
  observatory.showStockPlan(code, state.payload?.date, state.demo);
  if (!$("stock-dialog").open) $("stock-dialog").showModal();
}
document
  .querySelectorAll(".close-dialog")
  .forEach((btn) => (btn.onclick = () => btn.closest("dialog").close()));
document.querySelectorAll("dialog").forEach(
  (d) =>
    (d.onclick = (e) => {
      if (e.target === d) {
        const r = d.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          d.close();
      }
    }),
);
$("help-btn").onclick = () => $("help-dialog").showModal();
$("all-sectors").onclick = () => {
  state.synergyTab = "industry";
  setView("sectors");
};
$("all-themes").onclick = () => {
  state.synergyTab = "theme";
  setView("sectors");
};
document.querySelectorAll(".synergy-tab").forEach(
  (btn) =>
    (btn.onclick = () => {
      state.synergyTab = btn.dataset.synergy;
      setView("sectors");
    }),
);
$("theme-filter-clear").onclick = () => {
  state.themeFilter = null;
  renderStocks();
  syncRoute({ replace: true });
};
$("refresh-btn").onclick = loadData;
$("trade-date").onchange = () => {
  dateChosen = true;
  syncRoute();
  void loadData();
};
$("search").oninput =
  $("sector-filter").onchange =
  $("sort").onchange =
    () => {
      renderStocks();
      syncRoute({ replace: true });
    };
document.querySelectorAll("[data-height]").forEach(
  (btn) =>
    (btn.onclick = () => {
      state.height = btn.dataset.height;
      document
        .querySelectorAll("[data-height]")
        .forEach((x) => x.classList.toggle("active", x === btn));
      renderStocks();
      syncRoute({ replace: true });
    }),
);
function renderWeights() {
  $("weight-controls").innerHTML = FACTORS.map(
    (f, i) =>
      `<div class="weight-item"><div class="weight-heading"><label for="weight-${i}">${f.name}</label><output id="weight-output-${i}" for="weight-${i}">${state.weights[i]}%</output></div><input id="weight-${i}" data-weight="${i}" type="range" min="0" max="50" step="1" value="${state.weights[i]}" aria-describedby="weight-desc-${i}"><p id="weight-desc-${i}">${f.description}</p></div>`,
  ).join("");
  document.querySelectorAll("[data-weight]").forEach(
    (input) =>
      (input.oninput = () => {
        const next = [...state.weights];
        next[Number(input.dataset.weight)] = Number(input.value);
        if (!next.some((v) => v > 0)) {
          input.value = state.weights[Number(input.dataset.weight)];
          $("model-status").textContent = "至少保留一项有效权重";
          return;
        }
        state.weights = next;
        $(`weight-output-${input.dataset.weight}`).textContent =
          `${input.value}%`;
        saveWeights();
      }),
  );
  updateWeightSummary();
}
function updateWeightSummary() {
  const total = state.weights.reduce((a, b) => a + b, 0);
  $("weight-total").textContent = `合计 ${total}%`;
  $("model-status").textContent = state.payload?.archived
    ? "当前展示当天冻结评分；修改权重不会重算历史归档"
    : total === 100
      ? "已即时重算 · 即时重算"
      : `合计 ${total}%，计算时自动归一化`;
  document.querySelectorAll("[data-preset]").forEach((btn) =>
    btn.classList.toggle(
      "active",
      PRESETS[btn.dataset.preset].every((v, i) => v === state.weights[i]),
    ),
  );
}
let settingsTimer;
function saveWeights() {
  try {
    localStorage.setItem("limitLensWeights", JSON.stringify(state.weights));
  } catch {}
  updateWeightSummary();
  recalculate();
  render();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weights: state.weights }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      $("model-status").textContent = "权重已保存 · 已归档评分保持原样";
    } catch {
      $("model-status").textContent =
        "服务器保存失败，当前调整仍可使用，请稍后重试。";
    }
  }, 500);
}
document.querySelectorAll("[data-preset]").forEach(
  (btn) =>
    (btn.onclick = () => {
      state.weights = [...PRESETS[btn.dataset.preset]];
      saveWeights();
      renderWeights();
    }),
);
$("reset-model").onclick = () => {
  state.weights = [...PRESETS.balanced];
  saveWeights();
  renderWeights();
};
function demoData() {
  const sectors = [
    "示例·软件服务",
    "示例·电子设备",
    "示例·机械制造",
    "示例·电力设备",
    "示例·医药制造",
  ];
  // 涨停原因标签：演示双维度协同的题材聚合（含问询函噪声词，验证过滤）
  const reasons = [
    "人工智能+算力",
    "人工智能+算力",
    "人工智能",
    "算力+半导体",
    "人工智能+问询函",
    "半导体+国产芯片",
    "半导体",
    "国产芯片",
    "半导体+机器人",
    "机器人",
    "机器人+新能源",
    "新能源",
    "新能源+固态电池",
    "固态电池",
    "新能源",
    "数据中心",
    "数据中心+算力",
    "数据中心",
    "固态电池+新能源",
    "人工智能",
    "机器人",
    "半导体",
  ];
  return Array.from({ length: 22 }, (_, i) => ({
    c: `DEMO${String(i + 1).padStart(3, "0")}`,
    n: `示例个股 ${String(i + 1).padStart(2, "0")}`,
    hybk: sectors[Math.min(4, Math.floor(i / 5))],
    // 双维度协同评分的题材来源（normalize 解析为 themes）
    limitUpReason: reasons[i],
    p: (12 + i) * 1000,
    zdp: i % 4 === 0 ? 20 : 10,
    amount: (2 + (i % 6)) * 1e8,
    ltsz: (18 + i) * 1e8,
    fund: (0.3 + (21 - i) / 10) * 1e8,
    hs: 4 + (i % 16),
    lbc: i === 0 ? 6 : i === 1 ? 4 : i < 5 ? 3 : i < 9 ? 2 : 1,
    fbt: i % 6 === 0 ? 92500 : 93000 + i * 700,
    lbt: i === 0 ? 145500 : 100000 + i * 800,
    zbc: i % 5 === 0 ? 3 : i % 3 === 0 ? 1 : 0,
    zttj: { days: 3, ct: 1 },
  }));
}
$("demo-btn").onclick = () => {
  if (state.demo) {
    loadData();
    return;
  }
  ++state.request;
  state.loading = false;
  state.demo = true;
  state.themeFilter = null;
  state.error = null;
  state.review = null;
  state.ai = null;
  state.reviewMessage = "演示样本不会保存评分或生成市场反馈。";
  state.payload = {
    date: "演示",
    source: "虚构样本",
    fetchedAt: new Date().toISOString(),
    rows: demoData(),
    broken: 6,
    previous: null,
    warnings: [],
  };
  recalculate();
  updateFilters();
  updateSource();
  render();
  renderReview();
};
function pct(value) {
  return value === null || value === undefined
    ? "—"
    : `${value > 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
}
function returnCell(value) {
  return `<span class="${value > 0 ? "up" : value < 0 ? "down" : ""}">${pct(value)}</span>`;
}
function renderReview() {
  observatory.renderArchives(state.history, $("trade-date").value);
  const r = state.review,
    ai = state.ai;
  const execution = !r || isExecutionReview(r);
  const executionView = isExecutionReview(r) ? executionReviewView(r) : null;
  $("review-view").classList.toggle("execution-review", execution);
  $("review-stock-title").textContent = execution
    ? "昨日计划与今日成交表现"
    : "原始评分与实际表现";
  $("review-stock-description").textContent = execution
    ? "仅主账户实际成交标的；按冻结买点、执行事实和含费结果反馈"
    : "固定昨日样本，检验今天的表现，避免事后挑选赢家";
  $("review-stock-headers").innerHTML = (
    execution
      ? [
          "实际成交个股",
          "买点与动作",
          "实际成交",
          "今日市场表现",
          "含费损益（元）",
          "执行反馈",
        ]
      : [
          "昨日涨停个股",
          "原始评分",
          "次日开盘",
          "次日收盘",
          "盘中最低",
          "再次涨停",
        ]
  )
    .map((label) => `<th>${label}</th>`)
    .join("");
  $("review-sector-title").textContent = execution
    ? "板块反馈"
    : "板块判断反馈";
  $("review-sector-description").textContent = execution
    ? "按成交标的的冻结行业归属汇总，不代表整个板块表现"
    : "使用昨日固定的涨停成员，比较次日平均表现";
  $("review-sector-headers").innerHTML = (
    execution
      ? [
          "冻结行业板块",
          "成交只数 / 笔数",
          "买入 / 卖出金额（元）",
          "含费损益（元）",
          "资料覆盖 / 费用",
        ]
      : [
          "昨日行业板块",
          "原始板块分",
          "有效 / 原始样本",
          "次日平均收益",
          "再次涨停比例",
        ]
  )
    .map((label) => `<th>${label}</th>`)
    .join("");
  $("review-footnote").textContent = execution
    ? r?.caveat ||
      "当日损益仅合计主账户实际成交标的；市场涨跌与交易盈亏分别展示。"
    : r.caveat;
  $("review-ai-description").textContent = execution
    ? "用已核验的实际成交、成本与风控事实复盘"
    : "用已核验的市场结果，审视评分质量";
  $("review-date-label").textContent = r
    ? executionView?.dateLabel || `${r.snapshotDate} 评分 → ${r.date} 表现`
    : "等待首个反馈日";
  $("review-status").textContent = state.reviewBusy
    ? "正在归档与核验收盘结果…"
    : state.reviewMessage || "核验昨日冻结计划在今日的实际成交与收盘表现。";
  $("run-review").disabled = state.reviewBusy || state.demo;
  $("review-coverage").textContent = r
    ? execution
      ? r.total
        ? `${r.validCount} / ${r.total} 只可核验`
        : r.status === "NO_TRADES"
          ? "当日无成交"
          : "资料待核对"
      : `${r.validCount} / ${r.total} 家有效`
    : "等待样本";
  const metrics = execution
    ? executionView?.metrics || [
        {
          name: "实际成交",
          value: "—",
          unit: "只",
          caption: "等待当日实际成交归档",
        },
        {
          name: "成交标的当日含费损益",
          value: "—",
          unit: "元",
          caption: "仅成交标的合计 · 已含成交成本",
        },
        {
          name: "实际费用",
          value: "—",
          unit: "元",
          caption: "按成交流水核对费用",
        },
        {
          name: "资料覆盖",
          value: "—",
          unit: "",
          caption: "等待冻结计划与收盘结算",
        },
      ]
    : [
        {
          name: "系统客观反馈分",
          value: r?.systemScore ?? "—",
          unit: "/ 100",
          caption: "单日排序与相对表现，规则计算",
        },
        {
          name: "高分组次日收益",
          value: r?.topMean === null || !r ? "—" : fmt(r.topMean, 2),
          unit: "%",
          caption: r
            ? `有效 ${r.topValid} 家 · 评分前 20%`
            : "按昨日评分固定观察组",
        },
        {
          name: "相对样本超额",
          value: r?.excess === null || !r ? "—" : fmt(r.excess, 2),
          unit: "百分点",
          caption: r
            ? `全样本均值 ${pct(r.allMean)}`
            : "高分组均值 − 全样本均值",
        },
        {
          name: "评分与表现相关",
          value: r?.rho === null || !r ? "—" : fmt(r.rho, 2),
          unit: "ρ",
          caption: "Spearman 秩相关，范围 −1 至 1",
        },
      ];
  $("review-metrics").innerHTML = metrics
    .map(
      (m) =>
        `<article class="metric"><div class="metric-head">${m.name}${icon("shield")}</div><div class="metric-value">${m.value}<small>${m.unit}</small></div><div class="metric-caption">${m.caption}</div></article>`,
    )
    .join("");
  $("review-conclusion").hidden = !r;
  // 滚动证据摘要（§9）：均值、95% 区间、覆盖与方法标签；区间跨零表示
  // 证据不足；方法模拟受限的窗口只作探索展示，不作结论性表述。
  // 历史复盘按所选日期截取（P1-8）：不混入所选日期之后发布的报告。
  const evidenceReport = state.evidence?.review?.report;
  let evidenceText = "";
  if (!execution && evidenceReport) {
    const entry = evidenceReport.payload.family?.find(
      (item) => item.metric === "MEAN_DAILY_IC",
    );
    const limited = evidenceReport.payload.tags?.includes(
      "METHOD_SIMULATION_LIMITED",
    );
    const horizon = evidenceReport.horizon;
    const validDays = evidenceReport.payload.window.validDates.length;
    if (entry?.ci)
      evidenceText = `${horizon} 日滚动证据（探索诊断）：平均日 IC ${entry.estimate.toFixed(2)}，95% 区间 [${entry.ci.lower.toFixed(2)}, ${entry.ci.upper.toFixed(2)}]，${validDays}/${evidenceReport.payload.window.expectedDates.length} 个有效交易日${limited ? "；方法模拟受限，仅作探索展示" : ""}。区间跨零表示证据不足，不等于策略无效。`;
    else
      evidenceText = `${horizon} 日滚动证据：${evidenceReport.payload.status}${evidenceReport.payload.reasons?.length ? `（${evidenceReport.payload.reasons[0]}）` : "，样本积累中"}。`;
    // 板块次要检验族摘要（§3.2/§9 批次 C）：跨零即"证据不足"，不等于无效。
    const sectorFamily = evidenceReport.payload.secondaryFamilies?.find(
      (family) => family.name === "SECTOR_SECONDARY_EXCESS",
    );
    const sectorPositive = (sectorFamily?.entries ?? []).filter(
      (item) => item.direction === "POSITIVE",
    );
    if (sectorFamily?.familySize)
      evidenceText += ` 板块次要族 ${sectorFamily.familySize} 个（Holm 跨板块校正）：${sectorPositive.length ? `${sectorPositive.map((item) => item.sector).join("、")} 区间为正（探索）` : "无区间为正的板块"}`;
  }
  $("review-conclusion").textContent =
    executionView?.conclusion ||
    `${r?.conclusion || ""}${evidenceText ? ` ${evidenceText}` : ""}`;
  $("review-rows").innerHTML = execution
    ? executionView?.rows ||
      '<tr><td colspan="6"><div class="empty"><strong>等待实际成交反馈</strong>主账户收盘结算后，核验昨日计划在今日的实际成交与市场表现。</div></td></tr>'
    : r
      ? r.rows
          .map(
            (s, i) =>
              `<tr><td><strong class="review-stock">${escape(s.name)}${i < r.topSize ? '<span class="top-group">高分组</span>' : ""}</strong><span class="stock-code">${escape(s.code)}</span></td><td>${scoreHtml(s.score)}</td><td>${s.available ? returnCell(s.openReturn) : "—"}</td><td>${s.available ? returnCell(s.closeReturn) : "—"}</td><td>${s.available ? returnCell(s.lowReturn) : "—"}</td><td>${s.available ? (s.continued ? '<span class="height-tag high">是</span>' : "否") : `<span class="small-muted" title="${escape(s.reason)}">不可比</span>`}</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="6"><div class="empty"><strong>先保存判断，再检验结果</strong>收盘后访问工作台会自动保存当日评分。下一交易日的真实反馈到达前，此处保持空白。</div></td></tr>';
  $("review-sector-rows").innerHTML = execution
    ? executionView?.sectors ||
      '<tr><td colspan="5"><div class="empty compact">等待当日实际成交与冻结行业归属。</div></td></tr>'
    : r
      ? r.sectors
          .map(
            (s) =>
              `<tr><td>${escape(s.name)}</td><td>${scoreHtml(s.score)}</td><td>${s.available} / ${s.count}</td><td>${returnCell(s.averageReturn)}</td><td>${s.continuationRate === null ? "—" : fmt(s.continuationRate * 100)}%</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="5"><div class="empty compact">下一交易日核验已保存的板块评分。</div></td></tr>';
  $("ai-status-tag").textContent = state.aiConfig.configured
    ? "已连接"
    : "待配置";
  $("model-ai-status").textContent = state.aiConfig.configured
    ? "已配置"
    : "未配置";
  $("model-ai-detail").textContent = state.aiConfig.configured
    ? `已配置 ${state.aiConfig.model}。只向模型发送冻结依据、核验结果与同口径的近期客观指标（不含过往AI意见），评价会与原始数据一并保存。`
    : "服务端配置密钥、接口地址和模型后，AI 会根据已归档依据与核验结果生成评价。密钥不进入浏览器。";
  $("ai-content").innerHTML = ai
    ? `<div class="ai-score"><strong>${ai.score}</strong><span>AI 主观评价 / 100<small>${escape(ai.model)} · AI 主观把握${ai.confidence === "high" ? "较高" : ai.confidence === "medium" ? "中等" : "较低"}（主观评价，不是统计置信区间）</small></span></div><p class="ai-summary">${escape(ai.summary)}</p><h3>评价依据</h3><ul>${ai.evidence.map((v) => `<li>${escape(v)}</li>`).join("")}</ul>${ai.failures.length ? `<h3>判断不足</h3><ul>${ai.failures.map((v) => `<li>${escape(v)}</li>`).join("")}</ul>` : ""}${ai.suggestions.length ? `<h3>改进建议</h3><ul>${ai.suggestions.map((v) => `<li>${escape(v)}</li>`).join("")}</ul>` : ""}<p class="ai-note">${execution ? "AI 主观评价与客观成交指标分别保留；单日反馈不证明策略有效，不改变配置验证状态。" : "AI 评价与规则反馈分分别保留。统计区间见上方滚动证据摘要；建议不会自动改写模型。"}</p>`
    : `<div class="ai-empty"><span class="ai-symbol">${icon("sliders")}</span><h3>${state.aiConfig.configured ? (r?.status === "NO_TRADES" ? "当日无成交" : "等待已核验结果") : "大模型尚未配置"}</h3><p>${state.aiConfig.configured ? (execution ? "至少一个实际成交标的可核验后，AI 才生成描述性复盘；无成交不评价策略优劣。" : "积累事前快照并取得次日收盘结果后，AI 才对系统评价。") : "已预留 DeepSeek、OpenAI、通义兼容接口。配置服务端密钥后启用；不会用模拟 AI 结论替代真实调用。"}</p><div class="ai-process">${execution ? "冻结昨日计划<span>↓</span>核验今日成交与成本<span>↓</span>AI 复盘、证据与改进建议" : "冻结昨日评分<span>↓</span>核验今日市场结果<span>↓</span>AI 评分、证据与改进建议"}</div></div>`;
  $("ai-grade-btn").disabled =
    state.demo ||
    state.reviewBusy ||
    !state.aiConfig.configured ||
    !r ||
    !!ai ||
    (execution ? r.validCount < 1 : r.validCount < 10 || r.coverage < 0.8);
  $("ai-grade-btn").textContent = ai ? "评价已保存" : "生成 AI 评价";
  const history = state.history?.reviews || [];
  $("review-history").innerHTML = history.length
    ? `<div class="history-list">${history.map((h) => `<button data-history="${escape(h.date)}"><span>${escape(h.snapshotDate)} → ${escape(h.date)}</span><span>${isExecutionReview(h) ? (h.status === "NO_TRADES" ? "当日无成交" : `成交 ${h.summary.stockCount} 只 · 当日含费 ${reviewMoney(h.summary.dailyPnlCents)} 元`) : `历史评分反馈 · 客观 ${h.systemScore ?? "—"} 分`} · AI ${h.aiScore ?? "—"} 分</span></button>`).join("")}</div>`
    : '<div class="empty compact">尚无反馈记录。快照与反馈会保存到服务端，跨设备可查看。</div>';
  document.querySelectorAll("[data-history]").forEach(
    (btn) =>
      (btn.onclick = () => {
        dateChosen = true;
        $("trade-date").value = btn.dataset.history;
        syncRoute();
        void loadData();
      }),
  );
}
async function readReview(req = state.request) {
  try {
    const [response, historyResponse, evidenceResponse] = await Promise.all([
      fetch(`/api/review?date=${encodeURIComponent($("trade-date").value)}`),
      fetch("/api/history"),
      // 证据按所选复盘日期截取（P1-8）：历史日期不显示之后的滚动证据。
      fetch(`/api/evidence?asOf=${encodeURIComponent($("trade-date").value)}`),
    ]);
    const p = await response.json(),
      h = await historyResponse.json();
    if (req !== state.request || state.demo) return;
    state.history = historyResponse.ok ? h : state.history;
    if (!response.ok) throw new Error(p.error);
    state.review = p.review;
    state.ai = p.ai;
    state.aiConfig = p.aiStatus || state.aiConfig;
    // 滚动证据为探索诊断（purpose=DIAGNOSTIC），只展示后端冻结结果
    state.evidence = evidenceResponse.ok ? await evidenceResponse.json() : null;
    state.reviewMessage =
      p.reason ||
      (isExecutionReview(p.review)
        ? "已加载冻结计划、实际成交与收盘结果。"
        : "已加载历史冻结评分与实际结果。");
  } catch (e) {
    if (req === state.request)
      state.reviewMessage = e.message || "历史反馈暂时不可用";
  }
  if (req === state.request) renderReview();
}
async function runDaily(req = state.request) {
  if (state.demo || state.reviewBusy) return;
  state.reviewBusy = true;
  state.reviewMessage = "正在归档与核验";
  renderReview();
  try {
    const response = await fetch("/api/run-daily", {
      method: "POST",
      signal: AbortSignal.timeout(130000),
    });
    const p = await response.json();
    if (req !== state.request || state.demo) return;
    if (!response.ok) throw new Error(p.error);
    state.review = p.review;
    state.ai = p.ai || null;
    state.aiConfig = p.aiStatus || state.aiConfig;
    state.history = p.history || state.history;
    state.reviewMessage =
      p.aiError ||
      p.reason ||
      (p.review
        ? isExecutionReview(p.review)
          ? "昨日计划的今日成交与表现已核验并保存。"
          : "已加载历史评分反馈。"
        : "等待主账户收盘结算后生成成交反馈。");
    $("snapshot-status").textContent = p.snapshot?.saved
      ? `${p.snapshot.date} 原始评分已归档`
      : p.snapshot?.reason || "等待收盘后保存";
  } catch (e) {
    if (req === state.request) {
      state.reviewMessage =
        e.name === "TimeoutError"
          ? "反馈请求超时，可刷新读取已保存的进度。"
          : e.message;
      $("snapshot-status").textContent = "归档暂不可用，可稍后重试";
    }
  } finally {
    state.reviewBusy = false;
    renderReview();
    window.dispatchEvent(new Event("paper-updated"));
  }
}
$("run-review").onclick = () => {
  if ($("trade-date").value === today) void runDaily();
  else void readReview();
};
$("ai-grade-btn").onclick = async () => {
  if (!state.review) return;
  const date = state.review.date;
  state.reviewBusy = true;
  renderReview();
  $("ai-action-status").textContent = "模型正在评价…";
  try {
    const response = await fetch("/api/ai-grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date }),
      signal: AbortSignal.timeout(55000),
    });
    const p = await response.json();
    if (!response.ok) throw new Error(p.error);
    if (state.review?.date === date) state.ai = p.ai;
    $("ai-action-status").textContent = "评价已保存";
  } catch (e) {
    $("ai-action-status").textContent = e.message || "AI 调用失败";
  } finally {
    state.reviewBusy = false;
    renderReview();
  }
};
async function applyDefaultTradeDate() {
  if (dateChosen) return;
  try {
    const response = await fetch("/api/market/latest-date", {
      signal: AbortSignal.timeout(6000),
    });
    const p = await response.json();
    if (
      !dateChosen &&
      response.ok &&
      /^\d{4}-\d{2}-\d{2}$/.test(p.date) &&
      p.date <= today
    )
      $("trade-date").value = p.date;
  } catch {}
}
async function initialize() {
  const settings = fetch("/api/settings", {
    signal: AbortSignal.timeout(5000),
  })
    .then(async (response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const [p] = await Promise.all([settings, applyDefaultTradeDate()]);
  if (p) {
    state.storageAvailable = true;
    if (validWeightsForUI(p.weights)) state.weights = p.weights;
    state.aiConfig = p.ai;
    renderWeights();
  }
  await loadData();
}
function validWeightsForUI(w) {
  return (
    Array.isArray(w) &&
    w.length === 6 &&
    w.every((v) => Number.isInteger(v) && v >= 0 && v <= 50) &&
    w.some((v) => v > 0)
  );
}
routingReady = true;
restoreRoute({ initial: true });
renderWeights();
updateSource();
render();
renderReview();
void initialize();
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  try {
    Promise.resolve(
      document.modelContext.registerTool(
        {
          name: "read_limit_up_analysis",
          title: "读取涨停分析",
          description:
            "读取当前交易日的个股与行业评分，并明确返回真实或演示数据状态。",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute(input) {
            if (
              input === null ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              Object.keys(input).length
            )
              throw new Error("输入必须是空对象");
            return {
              date: state.payload?.date ?? null,
              mode: state.demo ? "demo" : "public",
              loading: state.loading,
              error: state.error,
              stocks:
                state.analysis?.stocks.map((r) => ({
                  code: r.code,
                  name: r.name,
                  sector: r.sector,
                  score: r.score,
                  coverage: r.coverage,
                  risks: r.risks.map((x) => x.text),
                })) || [],
              sectors:
                state.analysis?.sectors.map((s) => ({
                  name: s.name,
                  score: s.score,
                  count: s.count,
                })) || [],
              themes:
                state.analysis?.themes.map((t) => ({
                  name: t.name,
                  score: t.score,
                  count: t.count,
                })) || [],
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    window.addEventListener("pagehide", () => lifecycle.abort(), {
      once: true,
    });
  } catch {}
}
