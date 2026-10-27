import { escapeHtml as escape } from "./observatory-model.js";
import { BUY_POINT_LABELS } from "../shared/buy-point-type.js";
import { OBSERVATION_SCORE_POLICY } from "../shared/observation-scoring.js";

export const scoreStatuses = {
  INELIGIBLE: "分类不适用",
  OUTSIDE_WINDOW: "不在交易窗口",
  DISABLED: "买点未启用",
  PREMARKET: "历史形态 · 待盘中确认",
  WAITING_DATA: "数据不足",
  FILLED: "实际建仓成交",
  BLOCKED: "执行受限",
  TRIGGERED: "实际观测触发",
  WAITING_TRIGGER: "等待买点触发",
  NOT_OBSERVED: "未进入实际观察池",
};
const number = (v) => (Number.isFinite(v) ? Math.round(v) : "—");
const dateTime = (v) =>
  Number.isFinite(Date.parse(v))
    ? new Date(v).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "尚无观测";
const classNames = {
  "relay-leader": "连板龙头",
  "strong-reversal": "强势反包",
  "swing-range": "波段震荡",
  mediocre: "准入不符",
};

export function scoringCells(profile, buyPoint, stockClass) {
  const card = profile?.cards.find((c) => c.type === buyPoint);
  const cls = profile ? profile.stockClass : stockClass;
  const identity = profile
    ? profile.identity
    : Object.hasOwn(OBSERVATION_SCORE_POLICY.identity, cls)
      ? OBSERVATION_SCORE_POLICY.identity[cls]
      : null;
  return `<td><strong>${escape(classNames[cls] ?? "未分类")}</strong><small class="stock-code">身份 ${number(identity)}</small></td><td>${buyPoint ? `${number(card?.value)}<small class="stock-code">${escape(BUY_POINT_LABELS[buyPoint])}</small>` : '<span class="small-muted">先选择买点</span>'}</td><td>${number(profile?.risk?.value)}<small class="stock-code">${escape(profile?.risk?.level ?? "待观测")}</small></td><td><span class="outline-tag">${escape(card ? scoreStatuses[card.status] : profile ? "查看六类卡" : "未观测")}</span><small class="stock-code">${escape(profile ? dateTime(profile.asOf) : "等待持久化观测")}</small></td>`;
}

export function scoringCards(profile) {
  if (!profile)
    return '<div class="score-empty"><strong>尚无此日的实际评分观测</strong><p>历史分类和形态仅供观察；盘中质量、风险与触发状态等待独立评分进程，不使用旧综合分替代。</p></div>';
  const risk = profile.risk;
  return `<p class="small-muted">${escape(profile.version)} · ${escape(dateTime(profile.asOf))}（北京时间） · 固定规则匹配程度，不是胜率</p><div class="score-risk-summary"><strong>风险压力 ${number(risk.value)} · ${escape(risk.level)}</strong><span>${escape(risk.reason)}</span></div>${
    risk.layers
      ? `<details><summary>市场、板块、个股风险依据</summary>${Object.entries(
          risk.layers,
        )
          .map(
            ([key, layer]) =>
              `<p>${escape({ market: "市场", sector: "板块", stock: "个股" }[key])}：${escape(layer?.reasons?.join("；") ?? "缺少证据")}</p>`,
          )
          .join(
            "",
          )}<p>实际单笔风险上限 ${Number.isFinite(risk.effective?.entryRisk) ? (risk.effective.entryRisk * 100).toFixed(3) + "%" : "未知"}；权限以交易执行器为准。</p></details>`
      : ""
  }<div class="score-card-grid">${profile.cards
    .map(
      (c) =>
        `<section class="score-card"><div class="panel-heading"><h3>${escape(c.label)}</h3><strong>${number(c.value)}<small> / 100</small></strong></div><p class="score-card-state">${escape(scoreStatuses[c.status])}</p><p class="small-muted">${escape(c.reason)}</p><dl class="score-components">${Object.entries(
          c.components,
        )
          .map(
            ([key, value]) =>
              `<div><dt>${escape({ L: "身份", E: "板块", F: "形态", C: "确认" }[key])} · ${c.weights[key]}%</dt><dd>${number(value)}</dd></div>`,
          )
          .join(
            "",
          )}</dl><p class="small-muted">覆盖 ${Math.round(c.coverage * 100)}%${c.missing.length ? ` · 待补 ${escape(c.missing.join("、"))}` : ""}</p><details><summary>逐项形态证据</summary><ul>${c.checks.map((check) => `<li>${check.passed === null ? "未知" : check.passed ? "满足" : "未满足"} · ${escape(check.label)}</li>`).join("")}</ul></details></section>`,
    )
    .join("")}</div>`;
}

export function calibrationView(report) {
  if (!report.groups?.length)
    return `<div class="empty compact"><strong>校准样本积累中</strong><p>${escape(report.note)}</p><p>完整建仓至清仓才计一个周期；需要30个周期、20个入场日，各比较分箱至少5个可核验R样本。</p></div>`;
  const directions = {
    INSUFFICIENT: "样本不足",
    POSITIVE: "正向区分",
    REVERSE: "反向区分",
    FLAT: "平坦或不单调",
  };
  const value = (v, digits = 3) =>
    Number.isFinite(v) ? v.toFixed(digits) : "—";
  return `<p>${escape(report.note)}</p><p class="small-muted">截至 ${escape(report.asOf)} · ${report.sampleCount} 个完整周期 · 描述诊断，无交易或晋级资格</p>${report.groups.map((g) => `<section class="score-calibration-group"><h3>${escape(BUY_POINT_LABELS[g.buyPoint] ?? g.buyPoint)} · ${escape(g.phase)} · ${escape(classNames[g.stockClass] ?? "未分类")}</h3><p>${escape(g.mode === "REPLAY_DIAGNOSTIC" ? "回放诊断" : "规则发布后前瞻观察")} · ${escape(directions[g.direction])} · ${g.cycles} 周期 / ${g.entryDates} 入场日</p><p class="small-muted">配置 ${escape(g.configDigest?.slice(0, 12))} · 执行 ${escape(g.engineBuild?.slice(0, 12))} · ${escape(g.reason)}</p><div class="table-scroll"><table><thead><tr><th>质量分箱</th><th>周期 / R样本</th><th>含费净损益（元）</th><th>观察胜率</th><th>平均净R</th><th>平均持有日</th></tr></thead><tbody>${g.quality.map((b) => `<tr><td>${escape(b.bin)}</td><td>${b.cycles} / ${b.rCycles}</td><td>${value(b.netPnlCents / 100, 2)}</td><td>${value(b.winRate == null ? null : b.winRate * 100, 1)}%</td><td>${value(b.meanNetR)}</td><td>${value(b.averageHoldingDays, 1)}</td></tr>`).join("")}</tbody></table></div><p class="small-muted">风险分组：${g.risk.map((b) => `${escape(b.bin)} ${b.cycles}周期，净R ${value(b.meanNetR)}`).join("；")}</p></section>`).join("")}`;
}
