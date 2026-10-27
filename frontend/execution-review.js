import { BUY_POINT_LABELS } from "../shared/buy-point-type.js";
import { isPracticeReview } from "../shared/practice.js";

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
export const reviewMoney = (cents) =>
  Number.isFinite(cents)
    ? (cents / 100).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "—";
const moneyCell = (cents) =>
  `<span class="${cents > 0 ? "up" : cents < 0 ? "down" : ""}">${reviewMoney(cents)}</span>`;
const marketReturn = (value) =>
  Number.isFinite(value)
    ? `<span class="${value > 0 ? "up" : value < 0 ? "down" : ""}">${value > 0 ? "+" : ""}${value.toFixed(2)}%</span>`
    : "—";
const line = (label, value) =>
  `<span class="review-detail">${label} ${value}</span>`;
const actionNames = {
  OPEN: "建仓",
  ADD: "加仓",
  ADD_PROFIT: "盈利加仓",
  ADD_LOSS: "亏损补仓",
  EXIT: "清仓",
  REDUCE: "减仓",
  T_FORWARD: "正向 T",
  T_REVERSE: "反向 T",
  T_RECOVERY: "做 T 恢复腿",
};
const statusNames = {
  FILLED: "已完成",
  PARTIAL: "部分成交",
  EXPIRED_PARTIAL: "部分成交后到期",
  EXPIRED: "到期",
  INCOMPLETE_T: "第二腿未完成",
  SECOND_LEG: "第二腿",
  BLOCKED: "受约束",
  CANCELLED: "已取消",
  WATCHING: "观察中",
};

export function executionReviewView(review) {
  if (isPracticeReview(review)) return practiceReviewView(review);
  const r = review,
    s = r.summary;
  const policy = r.policy ?? {};
  const policyLabel = [
    policy.transitionState === "DRAINING" ? "旧仓结算中" : null,
    policy.tradingPolicyVersion === "dragon-risk-v1"
      ? "龙头风险预算"
      : "原交易政策",
    policy.configId ? `配置 ${policy.configId}` : policy.strategyVersion,
    policy.provenance?.validationMode === "MANUAL_UNVERIFIED"
      ? "人工指定 · 未验证"
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const pnl = (row) =>
    `${line("当日", moneyCell(row.dailyPnlCents))}${line("已实现", moneyCell(row.realizedPnlCents))}${line("收盘浮盈亏", moneyCell(row.unrealizedPnlCents))}`;
  return {
    dateLabel: `${r.snapshotDate} 计划 → ${r.date} 成交与表现`,
    metrics: [
      {
        name: "实际成交",
        value: s.stockCount,
        unit: "只",
        caption: `${s.fillCount} 笔 · 主账户实际成交`,
      },
      {
        name: "成交标的当日含费损益",
        value: reviewMoney(s.dailyPnlCents),
        unit: "元",
        caption: "仅成交标的合计 · 已含成交成本",
      },
      {
        name: "实际费用",
        value: reviewMoney(s.feeCents),
        unit: "元",
        caption: "费用已入账，不再重复扣除滑点",
      },
      {
        name: "资料覆盖",
        value: r.total ? `${r.validCount} / ${r.total}` : "—",
        unit: r.total ? "只" : "",
        caption: r.total
          ? "冻结计划、成交凭证与收盘行情可核验"
          : r.status === "NO_TRADES"
            ? "当日无成交，不评价策略优劣"
            : "成交归档待核对，不评价策略优劣",
      },
    ],
    conclusion: `${r.conclusion}${policyLabel ? ` ${policyLabel}。` : ""}`,
    rows: r.rows.length
      ? r.rows
          .map((row) => {
            const trade = (side, label) =>
              side.quantity > 0
                ? line(
                    label,
                    `${escape(side.quantity)} 股 · 均价 ¥${reviewMoney(side.averagePriceCents)}`,
                  )
                : "";
            const execution = row.execution
              .map((order) =>
                line(
                  escape(statusNames[order.status] ?? order.status),
                  escape(
                    order.reason ?? actionNames[order.action] ?? order.action,
                  ),
                ),
              )
              .join("");
            return `<tr><td><strong class="review-stock">${escape(row.name)}</strong><span class="stock-code">${escape(row.code)} · ${escape(row.sector)}</span></td><td>${row.buyPoints.length ? escape(row.buyPoints.map((type) => BUY_POINT_LABELS[type] ?? type).join("、")) : "无新建仓买点"}${line("动作", escape(row.actions.map((action) => actionNames[action] ?? action).join("、")))}</td><td>${trade(row.buy, "买入")}${trade(row.sell, "卖出")}${line("收盘持仓", `${escape(row.endingQuantity)} 股`)}</td><td>${line("开盘", marketReturn(row.openReturn))}${line("收盘", marketReturn(row.closeReturn))}${line("最低", marketReturn(row.lowReturn))}</td><td>${pnl(row)}${line("费用", reviewMoney(row.feeCents))}</td><td>${execution}${row.tStatus === "INCOMPLETE" ? line("做 T", "第二腿未完成，保留实际仓位") : row.tStatus === "RECOVERY" ? line("做 T", "恢复腿实际成交") : ""}${row.reasons.map((reason) => line("资料缺项", escape(reason))).join("")}</td></tr>`;
          })
          .join("")
      : `<tr><td colspan="6"><div class="empty"><strong>${r.status === "NO_TRADES" ? "当日无成交" : "成交资料待核对"}</strong>${escape(r.conclusion)}</div></td></tr>`,
    sectors: r.sectors.length
      ? r.sectors
          .map(
            (sector) =>
              `<tr><td>${escape(sector.name)}</td><td>${sector.stockCount} 只 / ${sector.fillCount} 笔</td><td>${line("买入", reviewMoney(sector.buyNotionalCents))}${line("卖出", reviewMoney(sector.sellNotionalCents))}</td><td>${pnl(sector)}</td><td>${line("可核验", `${sector.validCount} / ${sector.stockCount} 只`)}${line("费用", reviewMoney(sector.feeCents))}</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="5"><div class="empty compact">当日无成交，不生成板块表现结论。</div></td></tr>',
  };
}

function practiceReviewView(r) {
  const s = r.summary,
    a = r.account;
  const groups = (r.attribution.byBuyPoint ?? [])
    .map(
      (g) =>
        `${BUY_POINT_LABELS[g.key] ?? g.key}：${g.completedRounds}个已完成周期，含费 ${reviewMoney(g.netPnlCents)} 元`,
    )
    .join("；");
  const combined = (r.attribution.byOperationCombination ?? [])
    .map(
      (g) =>
        `${
          g.key === "OPEN_EXIT"
            ? "建仓退出"
            : g.key
                .split("+")
                .map((v) => actionNames[v] ?? v)
                .join("+")
        }：${g.completedRounds}个周期，胜率 ${g.winRate == null ? "—" : (g.winRate * 100).toFixed(1) + "%"}，含费 ${reviewMoney(g.netPnlCents)} 元，平均持有 ${g.averageHoldingCalendarDays?.toFixed(1) ?? "—"}天`,
    )
    .join("；");
  return {
    dateLabel: `${r.date} 全账户练习复盘`,
    metrics: [
      {
        name: "全账户当日含费损益",
        value: reviewMoney(a.dailyPnlCents),
        unit: "元",
        caption: "与期初至收盘权益变化核对",
      },
      {
        name: "实际成交 / 候选",
        value: `${s.fillCount} / ${s.candidateCount}`,
        unit: "笔 / 只",
        caption: `持仓 ${s.positionCount ?? "未知"} 只 · 完整周期 ${s.completedRounds}`,
      },
      {
        name: "当日费用 / 已完成T价差",
        value: `${reviewMoney(s.feeCents)} / ${reviewMoney(s.completedTNetPnlCents)}`,
        unit: "元",
        caption: "T价差已包含在账户收益内",
      },
      {
        name: "研究数据",
        value: r.researchEligible ? "完整" : "证据不足",
        unit: "",
        caption: `${r.coverage.frameCount ?? 0}帧 · ${r.coverage.gaps?.length ?? 0}类缺口`,
      },
    ],
    conclusion: `${r.conclusion} ${groups || "尚无当日完成周期；分组证据持续积累。"} ${combined ? `操作组合：${combined}。` : ""} ${!r.coverage.complete ? "行情或输入缺口仅作诊断，不进入正式验证。" : ""}`,
    rows:
      r.rows
        .map((row) => {
          const decisions = [...row.decisions].sort((x, y) =>
            String(y.last.observedAt).localeCompare(String(x.last.observedAt)),
          );
          const reasons = decisions
            .slice(0, 4)
            .map((d) =>
              line(
                escape(d.reason),
                `${escape(d.phase)} · ${escape(d.observations)}次观测`,
              ),
            )
            .join("");
          const risk = row.risk
            ? `${line("初始R / 保护位", `¥${reviewMoney(row.risk.r0Cents)} / ¥${reviewMoney(row.risk.stopCents)}`)}${line("减仓档 / 当前R", `${row.risk.stage ?? "—"} / ${Number.isFinite(row.risk.currentR) ? row.risk.currentR.toFixed(2) : "—"}`)}`
            : "无持仓风险敞口";
          return `<tr><td><strong class="review-stock">${escape(row.name)}</strong><span class="stock-code">${escape(row.code)} · ${row.role === "CANDIDATE" ? "观察候选" : "持仓或成交"}</span></td><td>${escape(row.buyPoints.map((p) => BUY_POINT_LABELS[p] ?? p).join("、") || "待触发")}${line("动作", escape(row.actions.join("、") || "无成交"))}</td><td>${line("期初 → 期末", `${row.openingQuantity} → ${row.endingQuantity} 股`)}${line("成交", `${row.fillCount} 笔`)}</td><td>${risk}${row.observedExcursion ? line("入场后已观察有利 / 不利波动", `${(row.observedExcursion.favorable * 100).toFixed(2)}% / ${(row.observedExcursion.adverse * 100).toFixed(2)}%`) : ""}</td><td>${line("当日", moneyCell(row.dailyPnlCents))}${line("历史成本浮盈", moneyCell(row.unrealizedPnlCents))}${line("费用", reviewMoney(row.feeCents))}</td><td>${reasons || "过程证据未知"}${row.risk?.pendingT ? line("做T", "第二腿未完成，实际仓位保留") : ""}${row.reasons.map((v) => line("资料缺项", escape(v))).join("")}</td></tr>`;
        })
        .join("") ||
      `<tr><td colspan="6">空仓且无实际准入候选；${escape(r.conclusion)}</td></tr>`,
    sectors:
      r.sectors
        .map(
          (sector) =>
            `<tr><td>${escape(sector.name)}</td><td>${sector.stockCount} 只 / ${sector.fillCount} 笔</td><td>全账户持仓及成交</td><td>${moneyCell(sector.dailyPnlCents)}</td><td>费用 ${reviewMoney(sector.feeCents)} 元</td></tr>`,
        )
        .join("") || '<tr><td colspan="5">无行业风险敞口</td></tr>',
  };
}
