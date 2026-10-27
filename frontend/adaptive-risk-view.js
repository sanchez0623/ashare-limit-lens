const escape = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
const percent = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—");
const time = (at) =>
  Number.isFinite(Date.parse(at))
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(at))
    : "—";
const status = (s) =>
  s.available
    ? s.pending
      ? "改善确认／逐步恢复"
      : "当前有效"
    : "等待有效数据与连续确认";
const permissions = (e) =>
  [
    ["新仓", e.open],
    ["盈利加仓", e.profitAdd],
    ["亏损补仓", e.lossAdd],
    ["正向 T", e.tForward],
    ["反向 T", e.tReverse],
  ]
    .filter(([, allowed]) => allowed)
    .map(([label]) => label)
    .join("、") || "暂停新增";
function chart(history = []) {
  const values = history.filter((s) => Number.isFinite(s.strength));
  if (values.length < 2) return "";
  const first = Date.parse(values[0].at),
    end = Date.parse(values.at(-1).at);
  const points = values
    .map(
      (s) =>
        `${(4 + ((Date.parse(s.at) - first) / Math.max(1, end - first)) * 352).toFixed(1)},${(58 - Math.max(0, Math.min(1, s.strength)) * 52).toFixed(1)}`,
    )
    .join(" ");
  return `<svg class="dragon-risk-chart" viewBox="0 0 360 64" role="img" aria-label="最近五分钟短线市场强度，范围零到一百"><path d="M4 58H356 M4 32H356 M4 6H356" fill="none" stroke="currentColor" opacity=".12"/><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2"/></svg><small>${time(values[0].at)} — ${time(values.at(-1).at)} · 强度曲线</small>`;
}
function layerTable(title, entries, kind) {
  if (!entries.length) return "";
  return `<details class="dragon-risk-layers"><summary>${title}（${entries.length}）</summary><div class="table-scroll"><table><thead><tr><th>${kind === "stock" ? "代码 / 板块" : "板块"}</th><th>局部系数</th><th>实际上限</th><th>权限上限</th><th>依据</th></tr></thead><tbody>${entries.map(([name, s]) => `<tr><td>${escape(name)}${s.sector ? `<br><small>${escape(s.sector)}</small>` : ""}</td><td>${percent(s.factor)}<br><small>${status(s)}</small></td><td>${percent(kind === "stock" ? s.effective.stockWeight : s.effective.sectorWeight)}</td><td>${permissions(s.effective)}</td><td>${escape(s.reasons.join("；"))}</td></tr>`).join("")}</tbody></table></div></details>`;
}
export function renderAdaptiveRisk(view) {
  if (!view)
    return '<p class="dragon-info-text">等待今日动态会话与有效行情。新计划启用后显示三层感知；已有会话沿用冻结版本。</p>';
  const m = view.market,
    e = view.effective;
  const confirmation =
    m.available && !m.pending
      ? "连续确认已通过"
      : `连续确认 ${Math.min(3, (m.pending ?? m.warming)?.count ?? 0)}/3 份 · 最短 60 秒`;
  const changes = [
    ["1 分钟", m.trend?.oneMinute],
    ["5 分钟", m.trend?.fiveMinutes],
  ]
    .map(
      ([label, value]) =>
        `${label} ${Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}` : "预热中"}`,
    )
    .join(" · ");
  return `<div class="dragon-dynamic-summary"><span class="dragon-caption">${escape(view.scope)} · 工程默认值</span><p><strong>${escape(m.label)}</strong> · ${status(m)}<br><small>市场采集 ${time(m.observedAt)} · 指标覆盖 ${percent(m.coverage)}<br>${confirmation}</small></p><div class="dragon-preview-metrics"><span>市场系数<strong>${percent(m.factor)}</strong></span><span>新增单笔风险上限<strong>${percent(e.entryRisk)}</strong></span><span>总仓位上限<strong>${percent(e.grossWeight)}</strong></span></div><p>当前操作上限：${permissions(e)}</p><p class="dragon-risk-trend">${changes}</p>${chart(view.history)}<p class="dragon-info-text">${escape(m.reasons.join("；"))}。</p><small>板块与个股可进一步收紧；已有持仓按可信风险敞口减仓，预热不触发强制卖出。</small>${layerTable("板块感知", Object.entries(view.sectors), "sector")}${layerTable("个股感知", Object.entries(view.stocks), "stock")}</div>`;
}
export function renderAdaptiveComparison(result) {
  if (result.mode !== "live") return "";
  const actual = result.actual?.effective;
  return `<p class="dragon-info-text">${escape(result.note)}</p><div class="table-scroll"><table><thead><tr><th>当前状态下</th><th>实际执行</th><th>草稿预览</th></tr></thead><tbody>${[
    ["单笔风险上限", "entryRisk"],
    ["组合风险上限", "portfolioRisk"],
    ["总仓位上限", "grossWeight"],
  ]
    .map(
      ([label, key]) =>
        `<tr><td>${label}</td><td>${percent(actual?.[key])}</td><td>${percent(result.effective[key])}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table></div><small>草稿沿用同一份感知依据；实际成交还须逐股满足局部预算、买点和成交条件。</small>`;
}
