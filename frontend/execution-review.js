import { BUY_POINT_LABELS } from "../shared/buy-point-type.js";

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
