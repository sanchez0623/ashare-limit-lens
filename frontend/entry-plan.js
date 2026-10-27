import {
  BUY_POINT_LABELS,
  BUY_POINT_TYPES as TYPES,
} from "../shared/buy-point-type.js";
import { OBSERVATION_CLASS_LABELS } from "../shared/entry-observation-display.js";
import { planRiskLimits } from "../shared/risk-limits.js";
import { renderPagination, bindPageJump } from "./pagination.js";

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const number = (value) => (Number.isFinite(value) ? String(value) : "未知");
const amount = (value) =>
  Number.isFinite(value) ? `${Number((value / 1e8).toFixed(2))} 亿元` : "未知";
const percent = (value) =>
  Number.isFinite(value) ? `${Number((value * 100).toFixed(2))}%` : "未知";
const change = (value) =>
  Number.isFinite(value)
    ? `${value > 0 ? "+" : ""}${Number(value.toFixed(2))}%`
    : "未知";
const PAGE_SIZE = 10;
const STATES = {
  ready: "静态准入通过",
  turnover: "待成交额确认",
  missing: "资料待核对",
};
const CLASSES = ["relay-leader", "strong-reversal", "swing-range"];

// 仅解释 intraday-entry-v1 的冻结历史前提；不把历史标签当成盘中触发。
export function entryPlanRows(policy) {
  return policy.candidates.map((code, index) => {
    const history = policy.history?.[code];
    const pending = [];
    if (!history) pending.push("缺少冻结历史");
    else {
      if (history.recentLimitUp !== true) pending.push("近期涨停基因未确认");
      if (!CLASSES.includes(history.stockClass))
        pending.push("股票分类不符合准入");
      if (!history.sector || history.sector === "未分类")
        pending.push("行业分类缺失");
      if (!(history.previousCloseCents > 0)) pending.push("信号日收盘价缺失");
      if (typeof history.name !== "string" || /ST|退/i.test(history.name))
        pending.push("名称未通过准入检查");
    }
    const amountReady =
      Number.isFinite(history?.amount) &&
      Number.isFinite(policy.rules?.minTurnoverCny) &&
      history.amount >= policy.rules.minTurnoverCny;
    const state = pending.length
      ? "missing"
      : amountReady
        ? "ready"
        : "turnover";
    const types = [];
    if (history && CLASSES.includes(history.stockClass)) {
      const leader = history.stockClass === "relay-leader";
      const strong = leader || history.stockClass === "strong-reversal";
      if (leader) types.push(TYPES.LIMIT_UP_MOMENTUM, TYPES.BROKEN_BOARD_DIP);
      if (strong && history.previousChange >= 5) types.push(TYPES.AUCTION_DIP);
      if (
        strong &&
        history.previousOpenCents > history.previousCloseCents &&
        history.previousChange >= -2 &&
        history.previousChange <= 2 &&
        history.previousTouchedLimit === true
      )
        types.push(TYPES.FAKE_NEG_LIMIT_DIP);
      if (
        strong &&
        history.previousHeight >= policy.firstNegMinPrevHeight &&
        history.lastFourCloseSumCents > 0
      )
        types.push(TYPES.FIRST_NEG_DIP);
      types.push(TYPES.LATE_DIP);
    }
    return {
      rank: index + 1,
      code,
      name: history?.name ?? code,
      sector: history?.sector ?? "行业未知",
      stockClass: history?.stockClass ?? "unclassified",
      history,
      state,
      pending,
      types: (policy.rules?.priority ?? []).filter((type) =>
        types.includes(type),
      ),
    };
  });
}

function buyPointRules(policy) {
  const rules = {
    [TYPES.AUCTION_DIP]: {
      stockClass: "连板龙头 / 强势反包",
      condition:
        "信号日涨幅 ≥ 5%；次日低开幅度 ≥ 5%，且小于涨停幅度 − 0.5 个百分点（10% 涨停股票须低开 < 9.5%）；竞价终态与当日开盘价、昨收一致。",
    },
    [TYPES.FAKE_NEG_LIMIT_DIP]: {
      stockClass: "连板龙头 / 强势反包",
      condition:
        "信号日开盘价 > 收盘价、涨跌幅在 −2%～+2%，且曾触板；次日低开 ≥ 8%，现价高于跌停价；竞价终态核对一致。",
    },
    [TYPES.LIMIT_UP_MOMENTUM]: {
      stockClass: "连板龙头",
      condition:
        "最近 60 秒实际采样曾触及涨停，现价 ≥ 涨停价的 99%；午后须有采样确认的开板后回封。封死涨停不能假定成交。",
    },
    [TYPES.BROKEN_BOARD_DIP]: {
      stockClass: "连板龙头",
      condition: "当日已触板，现价相对涨停价回撤 3%～7%，再确认企稳。",
    },
    [TYPES.FIRST_NEG_DIP]: {
      stockClass: "连板龙头 / 强势反包",
      condition: `信号日连板 ≥ ${number(policy.firstNegMinPrevHeight)}；次日现价低于开盘价、涨跌幅在 −5%（含）至 0%（不含），且不低于动态 MA5（前四日收盘价与现价的均值）。`,
    },
    [TYPES.LATE_DIP]: {
      stockClass: "三类准入股票",
      condition:
        "相对 14:30 后实际采样的最高价回撤 3%～5%，现价处于涨跌停价之间，再确认企稳。",
    },
  };
  return (policy.rules?.priority ?? [])
    .map((type, index) => {
      const rule = rules[type];
      const windows = (policy.rules.windows?.[type] ?? [])
        .map(
          ([start, end]) =>
            `${escape(start.slice(0, 5))}—${escape(end.slice(0, 5))}`,
        )
        .join("<br>");
      return `<tr><th scope="row"><span class="entry-plan-priority">${index + 1}</span>${escape(BUY_POINT_LABELS[type] ?? type)}</th><td>${escape(rule?.stockClass ?? "未保存说明")}</td><td class="entry-plan-time">${windows || "未保存窗口"}</td><td>${escape(rule?.condition ?? "当前页面尚不支持解释此买点。")}</td></tr>`;
    })
    .join("");
}

export function renderEntryPlanRules(plan, rows) {
  const policy = plan.entryExecutionPolicy,
    rules = policy.rules,
    dragon =
      plan.tradingPolicyVersion === "dragon-risk-v1" ? plan.dragonPolicy : null,
    risk = dragon ? null : planRiskLimits(plan);
  const sourceRules = dragon
    ? `<section><h3>01 · 如何进入观察池</h3><p>从已冻结历史中筛选符合分类、涨停基因与流动性要求的股票，观察池按信号日成交额降序、代码升序展示。</p><p>盘中同时满足买点时，按下表买点优先级、信号日成交额、代码排序，共享风险预算按此顺序分配。综合评分不参与排序。盘前最多 ${number(rules.maxPremarketCandidates)} 只，全天最多 ${number(rules.maxCandidates)} 只。</p></section>`
    : `<section><h3>01 · 如何进入观察池</h3><p>信号日涨停池、炸板池、日线扩展池中，有冻结历史且未持仓的股票先按快照分数降序、同分代码升序入池；再按代码升序补入历史准入合格股。</p><p>盘前最多 ${number(rules.maxPremarketCandidates)} 只；盘中仅从冻结历史范围扩展，全天最多 ${number(rules.maxCandidates)} 只。</p></section>`;
  const marketRules = dragon
    ? dragon.adaptiveRiskPolicy
      ? `当日板块分 ≥ ${number(dragon.rules.sectorMinimum)}；市场、板块、个股三层连续感知共同约束预算与权限。恶化及时收紧，改善至少三份独立观测、持续 60 秒后逐步恢复。超过可信敞口时减仓；缺数据暂停新增，不因缺失数据强制卖出。阶段标签只作解释。`
      : `当日板块分 ≥ ${number(dragon.rules.sectorMinimum)}；市场改善需两份不同的有效快照确认，恶化立即收紧。上升允许已启用操作，高潮收紧预算且禁止亏损补仓，退潮停止新增，冰点退出；数据不足时仅保留保护。`
    : `当日板块分 ≥ ${number(plan.strategy?.minSectorScore)}、情绪 ≥ ${number(plan.strategy?.exposureTiers?.midEmotion ?? 40)}，周期仓位上限 > 20%。`;
  const budgetRules = dragon
    ? `<section><h3>03 · 风险预算与 R 管理</h3><p>单笔计划风险 ${percent(dragon.config.risk.entryRisk)}，组合计划风险 ${percent(dragon.config.risk.portfolioRisk)}。按可用风险预算和止损距离、预计双边费用计算数量，100 股整手；现金、单股 ${percent(dragon.config.risk.stockWeight)}、板块 ${percent(dragon.config.risk.sectorWeight)}、总仓位 ${percent(dragon.config.risk.grossWeight)} 及最多 ${number(dragon.config.risk.maxPositions)} 只持仓共同约束。</p><p>初始保护幅度 ${percent(dragon.config.advanced.stopLoss)} 冻结为 R；${dragon.config.operations.profitAdd ? `盈利 ${number(dragon.rules.profitAddAt)}R 至 ${number(dragon.rules.profitAddBefore)}R 前，有新买点可加初仓 ${percent(dragon.rules.profitAddFraction)} 一次` : "盈利加仓关闭"}；${dragon.config.operations.lossAdd ? `亏损 ${number(-dragon.rules.lossAddTo)}R～${number(-dragon.rules.lossAddFrom)}R，有低吸确认可补初仓 ${percent(dragon.rules.lossAddFraction)} 一次` : "亏损补仓关闭"}。${dragon.rules.profitMilestones.map((r, index) => `${number(r)}R 减仓 ${percent(dragon.rules.profitFractions[index])}`).join("、")}，余量按 ${number(dragon.rules.trailingR)}R 跟踪保护。</p><p>日内亏损暂停 ${percent(dragon.config.risk.dailyLoss)}，回撤熔断 ${percent(dragon.config.risk.drawdown)}。追价上限 ${percent(dragon.rules.maxChase)}；卖盘、共享容量及成本不满足时不模拟成交。</p></section>`
    : `<section><h3>03 · 仓位与成交纪律</h3><p>单股仓位上限 ${percent(risk.maxPositionWeight)}；总仓位还受目标 ${percent(plan.targetExposure)}、计划上限 ${percent(plan.maxExposure)}、风控上限 ${percent(risk.maxGrossExposure)} 和当日周期上限共同约束。最多 ${number(plan.strategy?.maxPositions)} 只持仓。</p><p>数量触发时按实际现金与共享预算计算，100 股整手，并核对家族分配、卖盘、成交容量及成本。追价上限为首次触发价 + ${percent(plan.strategy?.maxBuyGap)}；窗口结束取消余单。${Number.isFinite(rules.maxVolumeMultiple) ? `有已验证昨日成交量时，当日累计量不得超过其 ${rules.maxVolumeMultiple} 倍。` : ""}</p></section>`;
  const count = (state) => rows.filter((row) => row.state === state).length;
  return `<details class="entry-plan-details" open>
    <summary>盘中条件计划 · ${rows.length} 只观察标的<span class="entry-plan-version">${escape(policy.version)} · 信号日 ${escape(policy.sourceDate)}</span></summary>
    <p class="entry-plan-intro">先核对入池依据，再等盘中买点触发。以下读取本计划冻结的历史与参数；观察池顺序保留，同股不重复建仓。</p>
    <dl class="entry-plan-stats">
      <div><dt>观察标的</dt><dd>${rows.length}<span>只</span></dd></div>
      <div><dt>静态准入通过</dt><dd>${count("ready")}<span>只 · 等待买点</span></dd></div>
      <div><dt>待成交额确认</dt><dd>${count("turnover")}<span>只 · 等待流动性</span></dd></div>
      <div><dt>资料待核对</dt><dd>${count("missing")}<span>只 · 暂停买入</span></dd></div>
    </dl>
    <div class="entry-plan-rule-grid">
      ${sourceRules}
      <section><h3>02 · 买入前的共同门槛</h3><p>近期有涨停基因；分类属于连板龙头、强势反包或波段震荡；行业及信号日收盘价有效，名称不含 ST、退市标识。冻结成交额或当日有效成交额 ≥ ${amount(rules.minTurnoverCny)}。</p><p>${marketRules}报价及卖盘有效，连续 ${number(rules.confirmationQuotes)} 次有效报价确认企稳且有增量成交量，才继续核验成交条件。</p></section>
      ${budgetRules}
    </div>
    <details class="entry-plan-buy-rules" open><summary>六类买点 · 时间窗口与触发条件</summary>
      <p class="small-muted">全部为北京时间。序号为同一行情帧内多个买点同时满足时的选择优先级；所有买点还需通过上方共同门槛。</p>
      <div class="table-scroll"><table class="entry-plan-rules-table"><thead><tr><th scope="col">买点 / 优先级</th><th scope="col">适用股票类型</th><th scope="col">观察时段</th><th scope="col">必须满足的条件</th></tr></thead><tbody>${buyPointRules(policy)}</tbody></table></div>
    </details>
    <section class="entry-plan-candidates" aria-label="逐股入选依据">
      <h3>逐股入选依据</h3><p class="small-muted">可观察买点仅匹配冻结历史前提，下一交易日仍须重新触发；“静态准入通过”表示历史条件齐备。</p>
      <div class="entry-plan-filters">
        <label>搜索标的<input type="search" data-entry-plan-search placeholder="名称或代码" aria-label="搜索观察标的名称或代码"></label>
        <label>股票类型<select data-entry-plan-class aria-label="筛选观察股票类型"><option value="">全部类型</option>${Object.entries(
          OBSERVATION_CLASS_LABELS,
        )
          .map(
            ([key, label]) =>
              `<option value="${escape(key)}">${escape(label)}</option>`,
          )
          .join("")}</select></label>
        <label>准入状态<select data-entry-plan-state aria-label="筛选观察准入状态"><option value="">全部状态</option>${Object.entries(
          STATES,
        )
          .map(([key, label]) => `<option value="${key}">${label}</option>`)
          .join("")}</select></label>
      </div>
      <p class="entry-plan-scroll-hint small-muted">左右滑动表格，查看个股的历史依据、可观察买点和准入状态。</p>
      <div class="table-scroll"><table class="entry-plan-candidate-table"><thead><tr><th scope="col">序号</th><th scope="col">标的 / 行业</th><th scope="col">冻结分类</th><th scope="col">冻结历史依据</th><th scope="col">可观察买点</th><th scope="col">准入核对</th></tr></thead><tbody data-entry-plan-rows></tbody></table></div>
      <div class="entry-plan-pager" data-entry-plan-pager aria-label="观察标的分页"></div>
    </section>
  </details>`;
}

function renderCandidate(row, policy) {
  const history = row.history;
  const evidence = history
    ? `${history.recentLimitUp === true ? "近期有涨停基因" : "涨停基因未确认"} · 信号日 ${number(history.previousHeight)} 连板<br>涨跌幅 ${change(history.previousChange)} · 成交额 ${amount(history.amount)}`
    : "缺少冻结历史";
  const statusReason =
    row.state === "ready"
      ? "待当日市场、板块、买点及成交条件确认"
      : row.state === "turnover"
        ? `待当日有效成交额 ≥ ${amount(policy.rules.minTurnoverCny)}`
        : row.pending.join("；");
  return `<tr><td>${row.rank}</td><td><strong>${escape(row.name)}</strong><span class="stock-code">${escape(row.code)} · ${escape(row.sector)}</span></td><td>${escape(OBSERVATION_CLASS_LABELS[row.stockClass] ?? "未分类")}</td><td>${evidence}</td><td>${row.types.length ? row.types.map((type) => `<span class="entry-plan-buy-point">${escape(BUY_POINT_LABELS[type] ?? type)}</span>`).join("") : "历史前提不足"}</td><td><span class="entry-plan-state entry-plan-state-${row.state}">${STATES[row.state]}</span><span class="stock-code">${escape(statusReason)}</span></td></tr>`;
}

export function initializeEntryPlan(root) {
  let signature,
    plan,
    rows = [],
    page = 1;
  function renderCandidates() {
    const query = root.querySelector("[data-entry-plan-search]").value.trim();
    const stockClass = root.querySelector("[data-entry-plan-class]").value;
    const state = root.querySelector("[data-entry-plan-state]").value;
    const filtered = rows.filter(
      (row) =>
        (!query || row.name.includes(query) || row.code.includes(query)) &&
        (!stockClass || row.stockClass === stockClass) &&
        (!state || row.state === state),
    );
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.max(1, Math.min(page, pages));
    root.querySelector("[data-entry-plan-rows]").innerHTML = filtered.length
      ? filtered
          .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
          .map((row) => renderCandidate(row, plan.entryExecutionPolicy))
          .join("")
      : `<tr><td colspan="6"><div class="empty compact">${rows.length ? "没有匹配的观察标的，可调整搜索或筛选。" : "冻结观察池为空，候选历史不足或资格未满足，暂不新增买入。"}</div></td></tr>`;
    root.querySelector("[data-entry-plan-pager]").innerHTML = renderPagination(
      { page, totalPages: pages, total: filtered.length, pageSize: PAGE_SIZE },
      {
        attribute: "data-entry-plan-page",
        unit: "只",
        summary: `筛选 ${filtered.length} / ${rows.length} 只 · 每页 ${PAGE_SIZE} 只 · 第 ${page} / ${pages} 页`,
      },
    );
  }
  bindPageJump(root, (target) => {
    page = target;
    renderCandidates();
  });
  root.addEventListener("input", (event) => {
    if (!event.target.matches("[data-entry-plan-search]")) return;
    page = 1;
    renderCandidates();
  });
  root.addEventListener("change", (event) => {
    if (
      !event.target.matches("[data-entry-plan-class], [data-entry-plan-state]")
    )
      return;
    page = 1;
    renderCandidates();
  });
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-entry-plan-page]");
    if (!button || button.disabled) return;
    page = Number(button.dataset.entryPlanPage);
    renderCandidates();
  });
  return {
    render(value) {
      const policy = value?.entryExecutionPolicy;
      // 冻结计划不变时保留折叠、搜索和页码，避免 15 秒自动刷新打断阅读。
      const nextSignature = policy
        ? JSON.stringify([
            value.signalDate,
            value.createdAt,
            policy.version,
            policy.rules,
            policy.candidates.map((code) => [code, policy.history?.[code]]),
            policy.firstNegMinPrevHeight,
            value.strategy,
            value.riskLimits,
            value.targetExposure,
            value.maxExposure,
            value.tradingPolicyVersion,
            value.dragonPolicy,
          ])
        : "";
      if (signature === nextSignature) return;
      signature = nextSignature;
      plan = value;
      page = 1;
      if (!policy) {
        root.innerHTML = "";
        return;
      }
      if (policy.version !== "intraday-entry-v1") {
        root.innerHTML = `<p class="small-muted">本计划使用 ${escape(policy.version)}，当前页面尚不支持解释其冻结规则。</p>`;
        return;
      }
      rows = entryPlanRows(policy);
      root.innerHTML = renderEntryPlanRules(plan, rows);
      renderCandidates();
    },
  };
}
