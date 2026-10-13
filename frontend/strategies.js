// 策略赛马页面：批次列表、净值比较、资格与血缘（§11）。
// 只请求后端 DTO，不持有模型密钥，也不在前端计算成交。
const state = { status: null, detailId: null, initialized: false };

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

const percent = (value) =>
  value === null || value === undefined ? "—" : `${(value * 100).toFixed(2)}%`;

const cents = (value) =>
  value === null || value === undefined
    ? "—"
    : (value / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 });

const stageNames = {
  RESERVED: "已预留",
  PROPOSING: "候选生成中",
  FROZEN: "候选已冻结",
  HISTORICAL_CHECK: "历史筛查中",
  SCHEDULED: "已排期",
  RUNNING: "前瞻运行中",
  EVALUATING: "评估中",
  CLOSED: "已结束",
  ELIGIBLE: "符合晋级条件",
  PROMOTED: "已启用",
  REJECTED: "历史筛查未通过",
  ERROR: "出错",
  INCONCLUSIVE: "证据不足",
  INVALIDATED: "已失效",
};

function el(id) {
  return document.getElementById(id);
}

function renderStatus() {
  const { status } = state;
  const container = el("strategies-status");
  if (!status) {
    container.innerHTML = "<p>尚未获取批次状态。</p>";
    return;
  }
  const active = status.activeCohort;
  container.innerHTML = `
    <div class="metrics panel-metrics strategy-metrics">
      <div><span class="mini-label">活动批次</span><strong>${
        active ? `${active.id.slice(0, 18)}…` : "无"
      }</strong><small>${active ? (stageNames[active.stage] ?? active.stage) : "可发起新批次"}</small></div>
      <div><span class="mini-label">候选上限</span><strong>${status.policy.maxCandidates}</strong><small>每月生成批次 ${status.policy.monthlyGenerationLimit} 次</small></div>
      <div><span class="mini-label">前瞻窗口</span><strong>${status.policy.forwardDays} 交易日</strong><small>完整轮次门槛 ${status.policy.minimumCompletedRounds}</small></div>
      <div><span class="mini-label">当前策略</span><strong>${
        active?.parentVersion ?? "baseline-v1"
      }</strong><small>${active ? "赛马期间保持父策略" : "等待批次结论"}</small></div>
    </div>
    <p class="panel-footnote">${status.note ?? ""}</p>`;
}

function renderCohortList() {
  const { status, detailId } = state;
  const rows = (status?.cohorts ?? [])
    .map(
      (cohort) => `
      <tr data-cohort="${cohort.id}" class="${cohort.id === detailId ? "active" : ""}">
        <td>${cohort.id.slice(0, 22)}…</td>
        <td>${stageNames[cohort.stage] ?? cohort.stage}</td>
        <td>${cohort.parentVersion}</td>
        <td>${cohort.maxCandidates}</td>
        <td>${(cohort.createdAt ?? "").replace("T", " ").slice(0, 16)}</td>
      </tr>`,
    )
    .join("");
  el("strategies-cohort-rows").innerHTML =
    rows || `<tr><td colspan="5">尚无批次记录</td></tr>`;
  el("strategies-cohort-rows")
    .querySelectorAll("tr[data-cohort]")
    .forEach((row) => {
      row.onclick = () => {
        state.detailId = row.dataset.cohort;
        void refresh();
      };
    });
}

async function renderDetail() {
  const container = el("strategies-detail");
  const { detailId } = state;
  if (!detailId) {
    container.innerHTML =
      "<p class='panel-footnote'>点击上方批次查看固定成员、净值与资格。</p>";
    return;
  }
  let detail;
  try {
    detail = await request(`/api/strategies/cohorts/${detailId}`);
  } catch (error) {
    container.innerHTML = `<p>${error.message}</p>`;
    return;
  }
  const members = (detail.members ?? [])
    .map(
      (member) => `
      <tr>
        <td>${member.memberId}</td>
        <td>${stageNames[member.stage] ?? member.stage}</td>
        <td>${member.k}</td>
        <td>${member.strategyVersion ? `${member.strategyVersion.slice(0, 18)}…` : "—"}</td>
        <td>${member.paramsDistance ?? "—"}</td>
        <td>${member.failureReason ?? "—"}</td>
      </tr>`,
    )
    .join("");
  const accounts = (detail.accounts ?? [])
    .map(
      (account) => `
      <tr>
        <td>${account.kind}</td>
        <td>${account.memberId ?? "—"}</td>
        <td>${cents(account.book?.equityCents)}</td>
        <td>${account.cursor?.date ?? "—"} #${account.cursor?.sequence ?? 0}</td>
        <td>${account.book?.lastDate ?? "—"}</td>
      </tr>`,
    )
    .join("");
  const evaluation = detail.evaluation;
  // 正式统计展示（statistical-evidence.md §9 批次 C）：展示两个对照的单侧
  // 下界、实际 α、方法名与证据不足原因，不只画一个绿色"统计通过"。
  const controlStats = (statistics) => {
    if (!statistics)
      return '<p class="small-muted">未评估（指纹或覆盖未通过）</p>';
    const rows = [
      { stat: statistics.againstParent, label: "对照=匹配父策略" },
      { stat: statistics.againstBaseline, label: "对照=匹配固定基线" },
    ].filter((row) => row.stat);
    return (
      rows
        .map(
          (row) =>
            `<p class="small-muted">${row.label}：单侧下界 ${(row.stat.lowerBound * 100).toFixed(3)}pp · 观察均值 ${(row.stat.observedMean * 100).toFixed(3)}pp · α/对照 ${row.stat.alphaPerComparison?.toExponential(2)} · ${row.stat.days} 日 — ${escape(row.stat.reason)}</p>`,
        )
        .join("") || '<p class="small-muted">证据不足</p>'
    );
  };
  const verdicts = (evaluation?.verdicts ?? [])
    .map(
      (verdict) => `
      <tr>
        <td>${verdict.memberId}</td>
        <td>${stageNames[verdict.stage] ?? verdict.stage}</td>
        <td>${percent(verdict.metrics?.netReturn)}</td>
        <td>${percent(verdict.metrics?.windowDrawdown)}</td>
        <td>${verdict.rounds?.rounds ?? "—"}</td>
        <td class="evidence-cell">${
          verdict.statistics
            ? `<details><summary>${verdict.checks?.statistics ? "统计通过" : "统计未通过"}</summary>${controlStats(verdict.statistics)}</details>`
            : '<span class="small-muted">未评估</span>'
        }</td>
      </tr>`,
    )
    .join("");
  const budget = evaluation?.statisticsBudget;
  const cost = evaluation?.fingerprint?.executionCost;
  const stress = evaluation?.executionStress;
  container.innerHTML = `
    <div class="metrics panel-metrics strategy-metrics">
      <div><span class="mini-label">冠军</span><strong>${
        evaluation?.champion?.memberId ?? "无"
      }</strong><small>${
        evaluation?.promotion?.promoted
          ? `已启用，生效日 ${evaluation.promotion.effectiveTradeDate ?? "待定"}`
          : "仅合格报告支持启用"
      }</small></div>
      <div><span class="mini-label">窗口</span><strong>${
        detail.cohort.forwardManifest?.tradingDates?.length ?? 0
      }/${detail.cohort.forwardDays}</strong><small>捕获日 ${
        detail.cohort.forwardManifest?.captureDate ?? "—"
      }</small></div>
      <div><span class="mini-label">报告摘要</span><strong>${
        detail.evaluationDigest ? "已冻结" : "等待评估"
      }</strong><small>闸门与统计可重放</small></div>
    </div>
    ${
      budget
        ? `<p class="panel-footnote">统计预算：α/对照 = ${budget.alphaPerComparison?.toExponential(2)}（全历史尝试序号 k 的误差预算）· 重采样 ${budget.resamples} · 区块 ${budget.blockLength} 日 · 方法 percentile 单侧下界（正式口径，与滚动诊断的 basic 区间为不同方法版本）</p>`
        : ""
    }
    ${
      cost
        ? `<p class="panel-footnote">执行成本指纹：${cost.modelVersion} v${cost.version} · 校准 ${cost.calibrationStatus}${cost.matchesManifest === false ? " · 与捕获清单不一致（本批资格失效）" : cost.matchesManifest === true ? " · 与捕获清单一致" : ""}</p>`
        : ""
    }
    <div class="table-scroll">
      ${
        stress
          ? `<p class="panel-footnote">成本压力为独立经济闸门，不是收益置信区间。<a href="/api/research/execution-stress/export?id=${encodeURIComponent(stress.id)}" download="execution-stress.json">下载完整路径及冻结输入</a></p>
      <table><thead><tr><th>情景</th><th>候选</th><th>对父策略</th><th>对固定基线</th><th>回撤</th><th>闸门</th></tr></thead><tbody>${stress.scenarios.flatMap((s) => Object.entries(s.checks).map(([id, check]) => `<tr><td>${s.multiplier}×</td><td>${escape(id)}</td><td>${percent(s.paths[id].netReturn - s.paths.parent.netReturn)}</td><td>${percent(s.paths[id].netReturn - s.paths.baseline.netReturn)}</td><td>${percent(s.paths[id].drawdownPpm / 1000000)}</td><td>${check.passed ? "通过" : check.coverage ? "经济门槛未通过" : "数据不足"}</td></tr>`)).join("")}</tbody></table>`
          : evaluation
            ? `<p class="panel-footnote">成本压力证据不足：${escape(evaluation.executionStressError ?? "未冻结情景，需重新建立批次")}</p>`
            : ""
      }
      <table>
        <thead><tr><th>成员</th><th>状态</th><th>尝试序号 k</th><th>策略版本</th><th>参数距离</th><th>失败原因</th></tr></thead>
        <tbody>${members || "<tr><td colspan='6'>无成员</td></tr>"}</tbody>
      </table>
    </div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>账户</th><th>角色</th><th>期末权益（分）</th><th>消费游标</th><th>已结算日</th></tr></thead>
        <tbody>${accounts || "<tr><td colspan='5'>尚无匹配账户</td></tr>"}</tbody>
      </table>
    </div>
    ${
      verdicts
        ? `<div class="table-scroll">
        <table>
          <thead><tr><th>成员</th><th>结论</th><th>期间净收益</th><th>窗口回撤</th><th>完整轮次</th><th>统计检验</th></tr></thead>
          <tbody>${verdicts}</tbody>
        </table>
      </div>`
        : ""
    }
    <p class="panel-footnote">收益不在独立候选之间求和；纸面领先不等于可启用资格。</p>
    <a class="secondary" href="/api/strategies/cohorts/${detailId}/export" download>导出批次检查点</a>`;
}

export async function refresh() {
  try {
    state.status = await request("/api/strategies/cohorts");
    renderStatus();
    renderCohortList();
    await renderDetail();
  } catch (error) {
    el("strategies-status").innerHTML = `<p>${error.message}</p>`;
  }
}

export function initializeStrategies() {
  if (state.initialized) return;
  state.initialized = true;
  el("strategies-reserve").onclick = async () => {
    const button = el("strategies-reserve");
    button.disabled = true;
    el("strategies-status-note").textContent =
      "正在预留批次并调用模型生成候选…";
    try {
      const result = await request("/api/strategies/cohorts", {
        method: "POST",
        body: "{}",
      });
      el("strategies-status-note").textContent =
        result.reason ?? result.status ?? "批次已预留";
    } catch (error) {
      el("strategies-status-note").textContent = error.message;
    } finally {
      button.disabled = false;
      await refresh();
    }
  };
  void refresh();
}
