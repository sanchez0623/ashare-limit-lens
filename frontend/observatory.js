import {
  escapeHtml as escape,
  marketPrintSvg,
  marketSculptureSvg,
  navigationGroup,
} from "./observatory-model.js";

const $ = (id) => document.getElementById(id);
const tabs = {
  research: [
    ["industry", "行业板块"],
    ["theme", "题材协同"],
    ["stocks", "个股分析"],
  ],
  paper: [
    ["live", "运行与持仓"],
    ["plan", "冻结计划"],
    ["ledger", "成交账本"],
    ["config", "账户与策略"],
  ],
  review: [
    ["review", "每日复盘"],
    ["replay", "严格历史回放"],
  ],
  system: [
    ["data", "数据管理"],
    ["alerts", "运维告警"],
    ["settings", "研究设置"],
    ["strategies", "策略赛马"],
  ],
};

// Move the existing nodes, retaining form values, IDs and all domain event handlers.
function partitionPanels() {
  const root = $("paper-view");
  for (const [tab, ids] of Object.entries({
    live: [
      "paper-metrics",
      "paper-live-summary",
      "paper-chart",
      "paper-position-rows",
    ],
    plan: ["paper-plan-rows"],
    ledger: ["paper-ledger-rows", "paper-stock-pnl-rows", "paper-archives"],
    config: ["dragon-config-panel", "paper-config-form", "paper-ai-content"],
  })) {
    const group = document.createElement("div");
    group.dataset.executionPanel = tab;
    group.className = "execution-tab-content";
    group.hidden = tab !== "live";
    for (const id of ids) {
      const node = $(id);
      const panel = [
        "paper-metrics",
        "paper-archives",
        "dragon-config-panel",
      ].includes(id)
        ? node
        : node.closest("section");
      if (panel) group.append(panel);
    }
    root.append(group);
  }
  root.querySelector(".paper-grid")?.remove();
  const context = document.createElement("p");
  context.id = "execution-context";
  context.className = "execution-context";
  context.textContent = "当前模拟账户 · 正在读取账户日期与执行状态";
  root.prepend(context);
  const reviewRoot = $("review-view");
  const replayPanel = $("strict-history-title").closest("section");
  const reviewGroup = document.createElement("div");
  reviewGroup.dataset.reviewPanel = "review";
  reviewGroup.append(
    ...[...reviewRoot.children].filter((node) => node !== replayPanel),
  );
  replayPanel.dataset.reviewPanel = "replay";
  reviewRoot.prepend(reviewGroup);
}

function mosaic(groups) {
  const sorted = groups
    .filter((g) => Number.isFinite(g.count) && g.count > 0)
    .slice()
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  const items = sorted.slice(0, 8);
  if (sorted.length > 8)
    items.push({
      name: `其他 ${sorted.length - 8} 个行业`,
      count: sorted.slice(8).reduce((n, g) => n + g.count, 0),
      other: true,
    });
  const result = [];
  function divide(list, x, y, width, height) {
    if (!list.length) return;
    if (list.length === 1) {
      result.push({ ...list[0], x, y, width, height });
      return;
    }
    const total = list.reduce((n, item) => n + item.count, 0);
    let split = 1,
      part = list[0].count;
    while (split < list.length - 1 && part < total / 2)
      part += list[split++].count;
    const ratio = part / total;
    if (width >= height) {
      divide(list.slice(0, split), x, y, width * ratio, height);
      divide(
        list.slice(split),
        x + width * ratio,
        y,
        width * (1 - ratio),
        height,
      );
    } else {
      divide(list.slice(0, split), x, y, width, height * ratio);
      divide(
        list.slice(split),
        x,
        y + height * ratio,
        width,
        height * (1 - ratio),
      );
    }
  }
  divide(items, 0, 0, 100, 100);
  return result;
}

export function initializeObservatory({
  navigate,
  onHeight,
  onSector,
  onArchive,
  getPayload,
  getPlan,
}) {
  partitionPanels();
  let lastSculpture = "",
    printSvg = null,
    paperState = null;
  document.addEventListener("click", (event) => {
    const height = event.target.closest("[data-ladder-height]");
    if (
      height &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      onHeight(height.dataset.ladderHeight);
    }
    const sector = event.target.closest("[data-research-sector]");
    if (sector)
      onSector(sector.dataset.researchSector, sector.dataset.taxonomy || "EM");
    const archive = event.target.closest("[data-archive-date]");
    if (archive) onArchive(archive.dataset.archiveDate);
    if (event.target.closest("[data-mosaic-all]")) {
      const table = $("sector-rows").closest(".table-scroll");
      table.tabIndex = -1;
      table.focus({ preventScroll: true });
      table.scrollIntoView({ block: "start" });
    }
    const tab = event.target.closest("[data-workspace-tab]");
    if (tab) {
      const { group, workspaceTab } = tab.dataset;
      navigate(
        group === "research"
          ? workspaceTab === "stocks"
            ? "stocks"
            : "sectors"
          : group === "system"
            ? workspaceTab
            : group,
        workspaceTab,
      );
    }
  });

  function setWorkspace(state) {
    const group = navigationGroup(state.view);
    const tabGroup = tabs[group]
      ? group
      : ["settings", "data", "alerts", "strategies"].includes(group)
        ? "system"
        : null;
    const active =
      group === "research"
        ? state.view === "stocks"
          ? "stocks"
          : state.synergyTab
        : group === "paper"
          ? state.paperTab
          : group === "review"
            ? state.reviewTab
            : state.view;
    $("workspace-tabs").hidden = !tabGroup;
    $("workspace-tabs").innerHTML = tabGroup
      ? tabs[tabGroup]
          .map(
            ([value, label]) =>
              `<button type="button" data-group="${tabGroup}" data-workspace-tab="${value}" class="${active === value ? "active" : ""}" ${active === value ? 'aria-current="page"' : ""}>${label}</button>`,
          )
          .join("")
      : "";
    document.querySelectorAll("[data-primary-nav]").forEach((button) => {
      const selected = button.dataset.primaryNav === group;
      button.classList.toggle("active", selected);
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-execution-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.executionPanel !== state.paperTab;
    });
    document.querySelectorAll("[data-review-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.reviewPanel !== state.reviewTab;
    });
    document.querySelectorAll(".system-menu").forEach((menu) => {
      menu.open = false;
    });
    $("observatory-view").hidden = state.view !== "overview";
    $("observation-directions").hidden = state.view !== "overview";
    $("overview-content").hidden = state.view !== "stocks";
    $("page-eyebrow").textContent =
      {
        overview: "A FIELD GUIDE TO THE MARKET",
        research: "FOLLOW THE SIGNALS",
        paper: "LET THE PLAN MEET THE MARKET",
        review: "THE DAYS WE OBSERVED",
      }[group] ?? "CARE FOR THE OBSERVATORY";
  }

  function render(state, researchGroups = []) {
    const a = state.analysis,
      p = state.payload;
    $("observation-edition").textContent =
      `/ ${p?.date ?? $("trade-date").value}`;
    $("observation-title").textContent = state.loading
      ? "正在展开市场。"
      : a
        ? a.count
          ? `${a.count} 家涨停，一日的切面。`
          : "今天，先留一页空白。"
        : "等数据，也是一种观察。";
    $("observation-description").textContent = a
      ? `首板 ${a.first ?? "—"} 家，连板 ${a.relay ?? "—"} 家，最高 ${a.height ?? "—"} 板。从结构出发，沿着线索往下看。`
      : state.error
        ? "行情暂未到达。可以重试、选择其他交易日，或进入明确标注的演示。"
        : "涨停的分布、连板的高度，构成今天值得细看的线索。";
    $("index-structure").textContent = a
      ? `${a.count ?? "—"} 家涨停 · ${a.height ?? "—"} 板高度`
      : "等待有效行情";
    $("index-sector").textContent = a?.sectors?.[0]?.name ?? "等待板块样本";
    const svg = marketSculptureSvg(a?.stocks, {
      date: p?.date,
      interactive: !!a,
    });
    if (svg !== lastSculpture) {
      $("market-sculpture").innerHTML = svg;
      lastSculpture = svg;
    }
    $("observation-sectors").innerHTML = a?.sectors?.length
      ? a.sectors
          .slice(0, 3)
          .map(
            (s, i) =>
              `<button class="direction-card" data-research-sector="${escape(s.name)}" data-taxonomy="EM"><span class="direction-number">0${i + 1} / INDUSTRY</span><span class="direction-glyph glyph-${i}" aria-hidden="true"><i></i><i></i><i></i></span><strong>${escape(s.name)}</strong><span>${s.count} 家涨停 · 最高 ${s.height ?? "—"} 板</span><span class="direction-score">板块评分 <b>${s.score ?? "—"}</b><i aria-hidden="true">↗</i></span></button>`,
          )
          .join("")
      : `<div class="observation-empty"><span aria-hidden="true">⌁</span><p>${state.loading ? "正在寻找今天的主线" : "有效行情到达后，主线板块会在这里展开。"}</p></div>`;
    const tiles = mosaic(researchGroups);
    $("industry-mosaic").innerHTML = tiles.length
      ? `<div class="mosaic-canvas">${tiles.map((s) => `<button class="mosaic-tile" ${s.other ? "data-mosaic-all" : `data-research-sector="${escape(s.name)}" data-taxonomy="${state.industryTaxonomy}"`} style="left:${s.x}%;top:${s.y}%;width:${s.width}%;height:${s.height}%;--strength:${Number.isFinite(s.score) ? Math.max(0.08, Math.min(0.65, s.score / 140)) : 0.08}" aria-label="${escape(s.name)}，${s.count}家涨停${s.other ? "，查看下方全部行业列表" : `，评分${s.score ?? "暂缺"}，查看个股`}"><strong>${escape(s.name)}</strong><span>${s.count} 家${!s.other ? ` · ${s.score ?? "—"} 分` : ""}</span></button>`).join("")}</div><p class="mosaic-caption">面积 = 涨停家数 · 色深 = 板块评分 · 精确数据见下方列表${state.industryTaxonomy !== "EM" ? " · 当前申万分类仅用于研究分组" : ""}</p>`
      : "";
    const printReady =
      !!p?.archived && !state.demo && !state.loading && !!p.analysis;
    $("market-print-open").disabled = !printReady;
    $("market-print-note").textContent = printReady
      ? `${p.date} · 已读取当日冻结数据，可生成市场切片。`
      : "选取一个已有盘后归档的交易日，回看当时的市场。";
  }

  function renderArchives(history, selectedDate) {
    const snapshots = history?.snapshots ?? [];
    $("archive-days").innerHTML = snapshots.length
      ? snapshots
          .map((s, i) => {
            const date = s.trade_date;
            return `<button class="archive-day ${date === selectedDate ? "selected" : ""}" data-archive-date="${escape(date)}" ${date === selectedDate ? 'aria-current="date"' : ""}><span class="folio-label">FIELD NOTE / ${String(i + 1).padStart(2, "0")}</span><strong>${escape(date.slice(5).replace("-", " / "))}</strong><span>${escape(date.slice(0, 4))} · 盘后归档</span><span class="archive-day-link">查看当日观察 <i aria-hidden="true">↗</i></span></button>`;
          })
          .join("")
      : '<div class="empty compact">还没有盘后归档。真实快照保存后，会在这里留下日期索引。</div>';
  }

  function updateExecution(data) {
    paperState = data;
    const live = data.realtime,
      health = live?.health;
    const unhealthy = ["ERROR", "STALE_QUOTES", "CONFLICT", "BLOCKED"].includes(
      health?.status,
    );
    const connected = live?.running === true;
    $("global-health").textContent = unhealthy
      ? "执行需要关注"
      : connected
        ? "执行器已连接"
        : "执行器未连接";
    $("global-health-dot").className =
      `status-dot ${unhealthy ? "critical" : connected ? "connected" : "waiting"}`;
    $("global-health").parentElement.title = health?.checkedAt
      ? `最近心跳 ${new Date(health.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} · 点击查看运维告警`
      : "尚无心跳 · 点击查看运维告警";
    $("global-health").parentElement.setAttribute(
      "aria-label",
      `${$("global-health").textContent}，查看运维告警`,
    );
    $("index-execution").textContent = unhealthy
      ? "检查执行与行情"
      : connected
        ? `${live?.session?.fillCount ?? 0} 笔当日模拟成交`
        : "常驻执行器未连接";
    $("execution-context").textContent =
      `当前模拟账户 · 行情日 ${data.equity?.date ?? live?.session?.date ?? "尚无行情"} · 最近结算 ${data.book?.lastDate ?? "尚未结算"} · 研究日期单独选择`;
  }

  function showStockPlan(code, date, demo) {
    const plan = getPlan?.() ?? paperState?.plan;
    const match =
      !demo &&
      plan?.signalDate === date &&
      (plan.orders?.some((row) => row.code === code) ||
        plan.entryExecutionPolicy?.candidates?.includes(code));
    $("stock-plan-link").innerHTML = match
      ? `<button class="secondary" id="stock-open-plan">查看对应冻结计划 ↗</button><p>信号日 ${escape(plan.signalDate)} · 以冻结依据为准</p>`
      : `<p>${demo ? "演示样本仅供体验。" : "该研究日与个股暂无匹配的当前冻结计划。"}</p>`;
    if (match)
      $("stock-open-plan").onclick = () => {
        $("stock-dialog").close();
        navigate("paper", "plan");
      };
  }

  $("market-print-open").onclick = () => {
    printSvg = marketPrintSvg(getPayload());
    if (!printSvg) return;
    $("market-print-preview").innerHTML = printSvg;
    $("market-print-title").textContent = `${getPayload().date} · 市场切片`;
    $("market-print-status").textContent =
      "来自已保存的盘后归档 · 只包含公开市场摘要";
    if (!$("market-print-dialog").open) $("market-print-dialog").showModal();
  };
  $("market-print-download").onclick = async () => {
    if (!printSvg) return;
    const button = $("market-print-download");
    button.disabled = true;
    // data: is already allowed by the application's image CSP; blob: is not.
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(printSvg)}`;
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("图片生成失败，请重试。"));
        image.src = svgUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 1500;
      canvas.getContext("2d").drawImage(image, 0, 0);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("浏览器未能导出图片，请重试。");
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = `limit-lens-${$("market-print-title").textContent.slice(0, 10)}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      $("market-print-status").textContent = "市场切片已导出 · 1200 × 1500 PNG";
    } catch (error) {
      $("market-print-status").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  return {
    setWorkspace,
    render,
    renderArchives,
    updateExecution,
    showStockPlan,
  };
}
