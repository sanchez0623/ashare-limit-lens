import { RESEARCH_STAGES } from "../shared/research-status.js";
const state = {
  initialized: false,
  selected: null,
  rows: [],
  cursor: null,
  status: null,
};
const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? "—").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const pct = (value) => (value == null ? "—" : `${(value * 100).toFixed(2)}%`);
const money = (value) =>
  value == null
    ? "—"
    : (value / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const stage = (value) => escape(RESEARCH_STAGES[value] ?? value);
const role = (value) =>
  escape(
    {
      CANDIDATE: "候选",
      PARENT_MATCH: "匹配父策略",
      BASELINE_MATCH: "匹配固定基线",
      BASELINE_CONTINUOUS: "持续固定基线",
      ROLLING: "滚动研究",
      BOOTSTRAP: "历史冷启动",
    }[value] ?? value,
  );
async function request(path, body = null) {
  const response = await fetch(
    path,
    body == null
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求失败");
  return value;
}
function message(value) {
  $("experiments-note").textContent = value;
}
function plot(performance) {
  const colors = ["#d47b46", "#298e8a", "#5c72a7", "#9b75a5"];
  const series = performance.filter(
    (row) => row.initialEquityCents && row.equities.length,
  );
  if (!series.length) return "<p>结算后展示同一起点的匹配净值。</p>";
  const dates = [
    ...new Set(series.flatMap((row) => row.equities.map((e) => e.tradeDate))),
  ].sort();
  const values = [
    1,
    ...series.flatMap((row) =>
      row.equities.map((e) => e.equityCents / row.initialEquityCents),
    ),
  ];
  const min = Math.min(...values),
    max = Math.max(...values),
    span = Math.max(0.005, max - min);
  const y = (value) => 170 - ((value - min) / span) * 140;
  return `<figure class="research-chart" aria-label="匹配组合净值比较"><svg viewBox="0 0 720 200" role="img" aria-label="归一化净值，期初为 1"><line x1="45" y1="${y(1)}" x2="700" y2="${y(1)}" stroke="#aaa" stroke-dasharray="4 4"/>${series.map((row, i) => `<polyline fill="none" stroke="${colors[i % 4]}" stroke-width="2" points="45,${y(1)} ${row.equities.map((e) => `${45 + ((dates.indexOf(e.tradeDate) + 1) / dates.length) * 655},${y(e.equityCents / row.initialEquityCents)}`).join(" ")}"/>`).join("")}<text x="5" y="20">${max.toFixed(3)}</text><text x="5" y="175">${min.toFixed(3)}</text><text x="45" y="195">${escape(dates[0])}</text><text x="615" y="195">${escape(dates.at(-1))}</text></svg><figcaption>${series.map((row, i) => `<span style="color:${colors[i % 4]}">${role(row.kind)}</span>`).join(" · ")} · 期初净值 = 1</figcaption></figure>`;
}
async function detail() {
  const container = $("experiments-detail");
  if (!state.selected) {
    container.innerHTML = "<p>选择实验查看前瞻进度、匹配净值和核验结果。</p>";
    return;
  }
  const id = state.selected;
  const data = await request(
    `/api/research/experiments/${encodeURIComponent(id)}`,
  );
  if (id !== state.selected) return;
  const experiment = data.experiment,
    manifest = experiment.proposalManifest;
  const forward = data.forward?.cohort.forwardManifest;
  const evaluation = data.forward?.evaluation;
  const verdict = evaluation?.verdicts.find(
    (row) =>
      row.memberId ===
      data.forward.members.find((m) => m.experimentId === id)?.memberId,
  );
  const names = {
    fingerprint: "环境指纹",
    coverage: "报价、快照与收盘覆盖",
    rounds: "完整新建仓轮次",
    returns: "净收益",
    drawdown: "回撤",
    statistics: "配对统计",
    executionStress: "成本压力",
    executionStressCoverage: "压力路径覆盖",
  };
  const historical = data.reports.find(
    (row) => row.stage === "historical" || row.stage === "dev_screen",
  );
  const endpoints = `/api/research/experiments/${encodeURIComponent(id)}`;
  container.innerHTML = `
    <div class="panel-heading"><div><h2>${stage(experiment.stage)}</h2><p>${escape(id)}</p></div><span class="outline-tag">${data.progress.completed}/${data.progress.required ?? "—"} 交易日</span></div>
    <p>${escape(manifest?.rationale ?? data.events.at(-1)?.payload?.reason ?? "提案未完成")}</p>
    <div class="metrics panel-metrics"><div><span class="mini-label">训练</span><strong>${escape(experiment.reservationPayload.trainingDates?.length ?? 0)} 日</strong><small>${escape(experiment.reservationPayload.trainingDates?.[0])} — ${escape(experiment.reservationPayload.trainingDates?.at(-1))}</small></div><div><span class="mini-label">历史筛查</span><strong>${experiment.kind === "BOOTSTRAP" ? "冷启动开发屏幕" : historical?.payload.passed ? "通过" : historical ? "未通过" : "等待"}</strong><small>${escape(experiment.reservationPayload.testDates?.[0])} — ${escape(experiment.reservationPayload.testDates?.at(-1))}</small></div><div><span class="mini-label">真正前瞻</span><strong>${forward ? "已捕获匹配起点" : "等待闭市结算"}</strong><small>捕获 ${escape(forward?.captureDate)} · ${escape(forward?.windowDates?.[0])} — ${escape(forward?.windowDates?.at(-1))}</small></div></div>
    <p class="panel-footnote">候选冻结于 ${escape(experiment.frozenAt)}；父策略 ${escape(experiment.parentVersion)}。历史筛查通过只允许进入前瞻，窗口内不延长、不改参数。${escape(evaluation?.promotion?.reason ?? "")}</p>
    ${plot(data.performance)}
    <div class="table-scroll"><table><thead><tr><th>组合</th><th>期间净收益</th><th>窗口回撤</th><th>费用增量（元）</th><th>完整轮次</th><th>缺失日</th></tr></thead><tbody>${data.performance.map((row) => `<tr><td>${role(row.kind)}</td><td>${pct(row.metrics.netReturn)}</td><td>${pct(row.metrics.windowDrawdown)}</td><td>${money(row.metrics.feesDeltaCents)}</td><td>${row.rounds.rounds}</td><td>${escape([...row.metrics.missingDates, ...row.metrics.incompleteDates].join("、") || "无")}</td></tr>`).join("") || "<tr><td colspan='6'>尚无前瞻净值</td></tr>"}</tbody></table></div>
    <div class="table-scroll"><table><thead><tr><th>角色</th><th>现金（元）</th><th>持仓数</th><th>持仓代码</th><th>结算日</th></tr></thead><tbody>${(data.forward?.accounts ?? []).map((row) => `<tr><td>${role(row.kind)}</td><td>${money(row.book.cashCents)}</td><td>${row.book.positions.length}</td><td>${escape(row.book.positions.map((p) => p.code).join("、") || "空仓")}</td><td>${escape(row.book.lastDate)}</td></tr>`).join("")}</tbody></table></div>
    <h3>前瞻启用检查</h3>${
      verdict
        ? `<div class="table-scroll"><table><tbody>${Object.entries(
            verdict.checks,
          )
            .map(
              ([key, value]) =>
                `<tr><td>${escape(names[key] ?? key)}</td><td>${value ? "通过" : "未通过或证据不足"}</td></tr>`,
            )
            .join(
              "",
            )}</tbody></table></div><p class="research-copy">结论：${stage(experiment.stage === "PROMOTED" ? "PROMOTED" : verdict.stage)} · ${escape(evaluation.executionStressError ?? "")}</p>`
        : "<p>固定窗口结束后才发布最终结论。</p>"
    }
    ${
      verdict?.statistics
        ? `<p class="panel-footnote">配对日对数收益循环区块 bootstrap，percentile 单侧下界。${Object.entries(
            verdict.statistics,
          )
            .map(
              ([key, s]) =>
                `${key === "againstParent" ? "父策略" : "固定基线"}：下界 ${pct(s.lowerBound)}，α ${s.alphaPerComparison.toExponential(2)}，${escape(s.reason)}`,
            )
            .join("；")}。短窗口统计是近似证据，不能保证未来盈利。</p>`
        : ""
    }
    <details class="research-copy"><summary>参数变化与冻结协议</summary><pre>${escape(JSON.stringify({ patch: manifest?.patch, policyId: experiment.policyId, protocol: experiment.reservationPayload.singleForward }, null, 2))}</pre></details>
    <details class="research-copy"><summary>完整血缘与切换记录</summary>${data.events.map((event) => `<p>#${event.sequence} ${escape(event.eventType)} · ${escape(event.createdAt)}<br><small>${escape(event.digest)}</small><br>${escape(event.payload.reason ?? event.payload.failureReason ?? "")}</p>`).join("")}<pre>${escape(JSON.stringify(data.switches, null, 2))}</pre></details>
    <div class="paper-toolbar"><button class="secondary" data-research-action="start" ${experiment.stage === "AWAITING_SHADOW" || experiment.stage === "SCHEDULED" ? "" : "disabled"}>开户 / 重试捕获</button><button class="primary" data-research-action="promote" ${data.canPromote ? "" : "disabled"}>核验并启用</button><button class="secondary" data-research-action="verify">独立核验</button><a class="secondary" href="${endpoints}/export" download="research-${escape(id)}.json">导出研究</a><a class="secondary" href="${endpoints}/lineage" download>导出血缘</a></div>
    ${data.canRollback ? `<label>回退原因<textarea id="research-rollback-reason" maxlength="500" rows="2" placeholder="填写回退原因"></textarea></label><button class="secondary" data-research-action="rollback">回退到原父策略</button>` : ""}
    <p class="panel-footnote">启用与回退只影响之后尚未冻结的计划；主账户持仓、费用、风险峰值与已有盈亏保留。已回退的报告不能再次启用。</p>`;
  container.querySelectorAll("[data-research-action]").forEach(
    (button) =>
      (button.onclick = async () => {
        button.disabled = true;
        try {
          const action = button.dataset.researchAction;
          const result = await request(
            `${endpoints}/${action}`,
            action === "rollback"
              ? { reason: $("research-rollback-reason").value }
              : {},
          );
          message(
            result.reason ??
              result.note ??
              (action === "verify"
                ? result.eligibleForPromotion
                  ? "核验通过，符合前瞻闸门"
                  : `没有启用资格：${result.reasons.join("；")}`
                : JSON.stringify(result)),
          );
          await refreshWalkForward();
        } catch (error) {
          message(error.message);
          button.disabled = false;
        }
      }),
  );
}
async function loadPage(append = false) {
  const page = await request(
    `/api/research/experiments?limit=20${append && state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : ""}`,
  );
  state.rows = append ? [...state.rows, ...page.experiments] : page.experiments;
  state.cursor = page.nextCursor;
  $("experiments-more").disabled = !state.cursor;
  $("experiments-rows").innerHTML =
    state.rows
      .map(
        (row) =>
          `<tr data-experiment="${escape(row.experimentId)}"><td>${escape(row.experimentId.slice(0, 18))}…</td><td>${stage(row.stage)}</td><td>${escape(row.attemptSequence)}</td><td>${role(row.kind)}</td><td>${escape(row.parentVersion)}</td><td>${escape(row.createdAt)}</td></tr>`,
      )
      .join("") || "<tr><td colspan='6'>尚无实验</td></tr>";
  $("experiments-rows")
    .querySelectorAll("[data-experiment]")
    .forEach(
      (row) =>
        (row.onclick = () => {
          state.selected = row.dataset.experiment;
          void detail().catch((error) => message(error.message));
        }),
    );
}
export async function refreshWalkForward() {
  try {
    state.status = await request("/api/research/status");
    const status = state.status;
    $("experiments-status").innerHTML =
      `<div class="metrics panel-metrics"><div><span class="mini-label">本月提案</span><strong>${status.budget.used}/${status.budget.limit}</strong><small>失败和错误也占用预算</small></div><div><span class="mini-label">全历史尝试</span><strong>${status.registry.attemptSequence}</strong><small>政策更新不清零</small></div><div><span class="mini-label">固定前瞻</span><strong>${status.policy.forwardDays} 交易日</strong><small>训练 ${status.policy.trainDays} / 历史 ${status.policy.histTestDays} 日</small></div><div><span class="mini-label">窗口占用</span><strong>${escape(status.activeExperiment?.stage ?? (status.activeExperiment ? "多候选批次" : "无"))}</strong><small>${escape(status.activeExperiment?.experimentId ?? status.activeExperiment?.ownerType)}</small></div></div>`;
    if (!$("research-forward-days").value)
      $("research-forward-days").value = status.policy.forwardDays;
    $("research-save-policy").disabled = Boolean(status.activeExperiment);
    await loadPage();
    await detail();
  } catch (error) {
    message(error.message);
  }
}
export function initializeWalkForward() {
  if (!state.initialized) {
    state.initialized = true;
    $("experiments-refresh").onclick = () => void refreshWalkForward();
    $("experiments-more").onclick = () =>
      void loadPage(true).catch((error) => message(error.message));
    $("experiments-propose").onclick = async () => {
      const button = $("experiments-propose");
      button.disabled = true;
      message("正在预留实验并生成候选…");
      try {
        const result = await request("/api/research/propose", {});
        state.selected = result.experimentId ?? state.selected;
        message(result.reason ?? result.status);
      } catch (error) {
        message(error.message);
      } finally {
        button.disabled = false;
        await refreshWalkForward();
      }
    };
    $("research-save-policy").onclick = async () => {
      try {
        await request("/api/research/policy", {
          forwardDays: Number($("research-forward-days").value),
        });
        message("已保存新政策，仅用于以后提案");
        await refreshWalkForward();
      } catch (error) {
        message(error.message);
      }
    };
  }
  void refreshWalkForward();
}
