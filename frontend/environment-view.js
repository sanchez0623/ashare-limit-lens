import { escapeHtml as escape } from "./observatory-model.js";
import { BUY_POINT_LABELS } from "../shared/buy-point-type.js";
import { renderPagination } from "./pagination.js";
const labels = {
  WEAK: "偏弱",
  NORMAL: "中等",
  STRONG: "偏强",
  IMPROVING: "改善",
  FLAT: "平稳",
  DETERIORATING: "恶化",
  LOW: "低",
  MID: "中",
  HIGH: "高",
  UNKNOWN: "未知",
};
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");
const number = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
export function environmentSummary(e) {
  if (!e?.asOf) return null;
  const when = new Date(e.asOf).toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  return {
    value: `${labels[e.strengthBand] ?? "未知"} · ${labels[e.direction?.band] ?? "未知"}`,
    caption: `强度 ${number(Number.isFinite(e.strength) ? e.strength * 100 : null)} · 脆弱性${labels[e.fragility?.band] ?? "未知"} · ${when}`,
    explanation: `执行端三维环境，用户启用、尚未验证。强度和方向沿用连续观测；炸板占比 ${pct(e.fragility?.breaks)}，昨日涨停受损 ${pct(e.fragility?.ordinary?.value)}（有效报价 ${e.fragility?.ordinary?.valid ?? 0}/${e.fragility?.ordinary?.total ?? 0}，覆盖 ${pct(e.fragility?.ordinary?.coverage)}），高位股受损 ${e.fragility?.high?.applicable ? `${pct(e.fragility.high.value)}（覆盖 ${pct(e.fragility.high.coverage)}）` : "样本不足，不适用"}。样本冻结日 ${e.sources?.cohortDate ?? "未知"}。新增风险市场系数 ${pct(e.budget?.baselineFactor)} → ${pct(e.budget?.newRiskFactor)}。${e.status === "DEGRADED_BASELINE" ? "环境数据不足，降级沿用原预算。" : e.status === "RETAINED" ? "暂缺新数据，保留最近有效上限。" : e.status === "PARTIAL_CURRENT" ? "部分比例缺数据，已知风险仍限制预算，不凭缺失值放宽。" : ""}新增脆弱性不触发已有持仓卖出，也不阻断T第二腿。`,
  };
}
export function environmentResearchView(
  report,
  { page = 1, pageSize = 10, buyPoint = "", dimension = "strength" } = {},
) {
  const groups = report.groups ?? [],
    total = groups.length,
    totalPages = Math.max(1, Math.ceil(total / pageSize));
  page = Math.max(1, Math.min(page, totalPages));
  const rows = groups.slice((page - 1) * pageSize, page * pageSize);
  const arms = report.comparison?.arms ?? {};
  const opened = report.openCycles ?? [];
  const filtered = report.comparison?.filteredOpportunities ?? [];
  const counterfactualSummary = ["LEGACY", "NEUTRAL"]
    .map((role) => {
      const refs = filtered.map((item) => item.references[role]);
      const closed = refs.filter((r) => r.status === "COMPLETED");
      return `${role === "LEGACY" ? "原版" : "取消市场择时"}实际成交 ${refs.filter((r) => r.executed).length} 次，完成 ${closed.length} 个周期，扣费净损益 ${number(closed.reduce((n, r) => n + r.netPnlCents, 0) / 100)} 元，尚未清仓 ${refs.filter((r) => r.status === "OPEN").length} 个`;
    })
    .join("；");
  const stress = report.comparison?.costStress ?? [];
  return `<section class="panel" id="environment-research"><div class="panel-heading"><h2>交易环境与六类买点</h2><span class="outline-tag">用户启用 · 尚未验证</span></div><p>${escape(report.note ?? "等待真实观测，统计不自动启停买点")}</p><div class="research-actions"><label>买点 <select data-environment-buy-point><option value="">全部买点</option>${Object.entries(
    BUY_POINT_LABELS,
  )
    .map(
      ([key, label]) =>
        `<option value="${key}" ${key === buyPoint ? "selected" : ""}>${escape(label)}</option>`,
    )
    .join(
      "",
    )}</select></label><label>环境维度 <select data-environment-dimension>${[
    ["strength", "强度"],
    ["direction", "方向"],
    ["fragility", "脆弱性"],
  ]
    .map(
      ([key, label]) =>
        `<option value="${key}" ${key === dimension ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></label><a class="secondary" href="/api/research/environment" download>导出环境报告</a></div><div class="table-scroll"><table><thead><tr><th>买点 / 环境</th><th>机会 / 成交率</th><th>完整周期 / 入场日</th><th>扣费净损益（元）</th><th>平均净R / 区间</th><th>已观察MAE / MFE（R）</th><th>证据状态</th></tr></thead><tbody>${
    rows
      .map(
        (g) =>
          `<tr><td>${escape(BUY_POINT_LABELS[g.buyPoint] ?? g.buyPoint)} / ${escape(labels[g.band] ?? g.band)}</td><td>${g.opportunities} / ${pct(g.fillRate)}</td><td>${g.cycles} / ${g.entryDates}</td><td>${number(g.netPnlCents / 100)}</td><td>${number(g.meanNetR)} / ${g.interval ? `${number(g.interval.lower)}～${number(g.interval.upper)}` : g.status === "INSUFFICIENT" ? "样本不足" : "不可估计"}</td><td>${number(g.meanMaeR)} / ${number(g.meanMfeR)}</td><td>${g.mode === "REPLAY_DIAGNOSTIC" ? "历史回放诊断" : g.status === "INSUFFICIENT" ? "前瞻样本不足" : "描述性统计"}<details><summary>拦截依据</summary>${
            Object.entries(g.blockingReasons ?? {})
              .map(([k, v]) => `${escape(k)}：${v}`)
              .join("；") || "无记录"
          }</details></td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="7">等待新版计划的真实触发与完整建仓至清仓周期；旧历史不补造。</td></tr>'
  }</tbody></table></div><div data-environment-pager>${renderPagination({ page, pageSize, total, totalPages }, { attribute: "data-environment-page", unit: "组" })}</div><p class="small-muted">尚未清仓 ${opened.length} 个周期单列；部分成交及T腿不扩大样本。区间按入场日分组重采样，仅为描述，不是盈利概率。</p>${opened.length ? `<details><summary>查看未清仓周期</summary><ul>${opened.map((c) => `<li>${escape(c.code)} · ${escape(BUY_POINT_LABELS[c.buyPoint] ?? c.buyPoint)} · ${escape(labels[c.environment?.strengthBand] ?? "未知")} / ${escape(labels[c.environment?.direction?.band] ?? "未知")} / ${escape(labels[c.environment?.fragility?.band] ?? "未知")}</li>`).join("")}</ul></details>` : ""}<h3>三组独立对照</h3><p>${report.trial ? `窗口自 ${escape(report.trial.manifest.startDate)} 起固定30个交易日 · ${escape(report.trial.status)} · 已登记 ${report.comparison?.dates?.length ?? 0} 日` : `等待盘前创建原版、新版及无市场择时对照。`}</p><div class="table-scroll"><table><thead><tr><th>对照</th><th>扣费收益</th><th>最大回撤</th><th>平均收盘资金利用率</th><th>成交笔数 / 费用（元）</th></tr></thead><tbody>${Object.entries(
    { LEGACY: "原版", NEW: "新版", NEUTRAL: "取消市场择时" },
  )
    .map(
      ([role, label]) =>
        `<tr><td>${label}</td><td>${pct(arms[role]?.netReturn)}</td><td>${pct(arms[role]?.maxDrawdown)}</td><td>${pct(arms[role]?.meanGrossExposure)}</td><td>${arms[role]?.fills ?? "—"} / ${number(arms[role]?.feesCents / 100)}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table></div><p>主账户与新版影子核对：${report.comparison ? (report.comparison.mirrorConsistent ? "一致" : "有缺口或差异，收益比较不可用") : "等待实际观测"}。</p><p>被过滤的结构机会 ${filtered.length} 次。${filtered.length ? escape(counterfactualSummary) + "。逐笔证据随报告导出；未成交不计算假设利润。" : "等待三组实际执行证据。"}</p><p>1×、1.5×、2×成本压力 ${stress.length === 3 ? "已完成" : "待固定窗口及完整证据齐备后执行"}；缺日占用窗口，不顺延补满，不自动宣布获胜或更换主账户政策。</p>${stress.length ? `<div class="table-scroll"><table><thead><tr><th>成本 / 对照</th><th>扣费收益</th><th>最大回撤</th><th>实际费用（元）</th></tr></thead><tbody>${stress.flatMap((s) => Object.entries(s.arms).map(([role, a]) => `<tr><td>${s.multiplier}× / ${escape({ LEGACY: "原版", NEW: "新版", NEUTRAL: "取消市场择时" }[role] ?? role)}</td><td>${pct(a.netReturn)}</td><td>${pct(a.maxDrawdown)}</td><td>${number(a.feesCents / 100)}</td></tr>`)).join("")}</tbody></table></div><p class="small-muted">使用同一配对交易日区块，六个比较统一进行多重比较校正；仅供诊断。</p>` : ""}</section>`;
}
