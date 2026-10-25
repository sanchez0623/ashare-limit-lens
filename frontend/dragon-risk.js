import {
  DRAGON_RISK_FIELDS,
  DRAGON_ADVANCED_FIELDS,
  DRAGON_OPERATION_FIELDS,
  DRAGON_BUY_POINT_FIELDS,
  DRAGON_REGIMES,
  normalizeDragonConfig,
  dragonEffectiveFields,
} from "../shared/dragon-risk-config.js";

const $ = (id) => document.getElementById(id);
let dirty = false,
  initialized = false,
  current = null;
const text = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
const states = {
  DRAFT: "待保存配置",
  OBSERVING: "检查中",
  READY: "可启用",
  DRAINING: "旧仓结清中",
  ACTIVE: "新政策运行",
};
function numberControls(fields, group) {
  return fields
    .map(
      (
        f,
      ) => `<label class="dragon-field"><span>${text(f.label)}</span><span class="dragon-number"><input id="dragon-${group}-${f.key}" aria-label="${text(f.label)}" type="number"
    min="${f.integer ? f.min : f.min * 100}" max="${f.integer ? f.max : f.max * 100}" step="${f.integer ? 1 : 0.01}" required><span>${f.integer ? "只" : "%"}</span></span></label>`,
    )
    .join("");
}
function switches(fields, group) {
  const descriptions = {
    profitAdd: "盈利后，有新买点再加仓",
    lossAdd: "限定亏损区间，企稳后补仓",
    tForward: "先低吸买入，再卖出旧仓",
    tReverse: "先高抛旧仓，再择机买回",
  };
  return fields
    .map(
      (f) =>
        `<label class="dragon-toggle"><span class="dragon-toggle-copy"><strong>${text(f.label)}</strong>${descriptions[f.key] ? `<small>${text(descriptions[f.key])}</small>` : ""}</span><input id="dragon-${group}-${f.key}" type="checkbox" role="switch" aria-label="${text(f.label)}"><span class="dragon-toggle-track" aria-hidden="true"></span></label>`,
    )
    .join("");
}
function collect() {
  const config = structuredClone(current.config);
  for (const [group, fields] of [
    ["risk", DRAGON_RISK_FIELDS],
    ["advanced", DRAGON_ADVANCED_FIELDS],
  ])
    for (const f of fields)
      config[group][f.key] =
        Number($(`dragon-${group}-${f.key}`).value) / (f.integer ? 1 : 100);
  for (const [group, fields] of [
    ["operations", DRAGON_OPERATION_FIELDS],
    ["buyPoints", DRAGON_BUY_POINT_FIELDS],
  ])
    for (const f of fields)
      config[group][f.key] = $(`dragon-${group}-${f.key}`).checked;
  return normalizeDragonConfig(config);
}
function showPreview(preview) {
  const e = preview.effective;
  $("dragon-preview").innerHTML =
    `<span class="dragon-preview-metrics"><span>新仓风险<strong>${(e.entryRisk * 100).toFixed(2)}%</strong></span><span>组合风险<strong>${(e.portfolioRisk * 100).toFixed(2)}%</strong></span><span>总仓位<strong>${e.grossWeight == null ? "仅保护" : (e.grossWeight * 100).toFixed(0) + "%"}</strong></span></span><span class="dragon-permissions">${[
      ["新仓", e.open],
      ["盈利加仓", e.profitAdd],
      ["亏损补仓", e.lossAdd],
      ["正向 T", e.tForward],
      ["反向 T", e.tReverse],
    ]
      .map(
        ([label, allowed]) =>
          `<span class="${allowed ? "is-on" : "is-off"}">${allowed ? "✓" : "−"} ${label}</span>`,
      )
      .join("")}</span>`;
}
export function renderDragonSettings(data, { request, perform }) {
  if (!$("dragon-config-panel") || !data.dragon) return;
  current = data.dragon;
  const active = data.book.tradingPolicyVersion === "dragon-risk-v1",
    draining = current.state === "DRAINING";
  if (!initialized) {
    $("dragon-risk-controls").innerHTML = numberControls(
      DRAGON_RISK_FIELDS,
      "risk",
    );
    $("dragon-operation-controls").innerHTML = switches(
      DRAGON_OPERATION_FIELDS,
      "operations",
    );
    $("dragon-buy-controls").innerHTML = switches(
      DRAGON_BUY_POINT_FIELDS,
      "buyPoints",
    );
    $("dragon-advanced-controls").innerHTML = numberControls(
      DRAGON_ADVANCED_FIELDS,
      "advanced",
    );
    $("dragon-preview-phase").innerHTML = Object.entries(DRAGON_REGIMES)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
      .join("");
    $("dragon-config-form").addEventListener("input", () => {
      dirty = true;
      $("dragon-save-note").textContent =
        "有未保存的更改；保存前不会影响执行。";
    });
    const save = (cancelResearch = false) =>
      void perform(async () => {
        const result = await request("/api/paper/settings", {
          dragonConfig: collect(),
          ...(cancelResearch ? { cancelResearch: current.researchLock } : {}),
        });
        dirty = false;
        return result.dragon.message;
      });
    $("dragon-config-form").onsubmit = (event) => {
      event.preventDefault();
      save();
    };
    $("dragon-cancel-research-save").onclick = () => save(true);
    $("dragon-preview-button").onclick = () =>
      void perform(async () => {
        const result = await request("/api/paper/dragon/preview", {
          config: collect(),
          phase: $("dragon-preview-phase").value,
        });
        showPreview(result);
        return "已按所选市场情境预览；未修改配置";
      });
    $("dragon-activate-button").onclick = () =>
      void perform(async () => {
        const result = await request("/api/paper/dragon/activate", {});
        return result.message;
      });
    $("dragon-resume-button").onclick = () =>
      void perform(async () => {
        await request("/api/paper/dragon/resume", {});
        return "已开启新的运行风险周期；历史净值、收益与绩效峰值保留";
      });
    $("dragon-validate-button").onclick = () =>
      void perform(async () => {
        await request("/api/paper/dragon/validate", {});
        return "已冻结当前人工参数为研究候选，历史测试及新前瞻通过前仍显示未验证";
      });
    initialized = true;
  }
  const observationLabels = {
    WAITING_PREPARATION: "等待影子准备",
    PREPARED: "等待开盘观察",
    WAITING_EXECUTION: "等待行情执行",
    WAITING_VERIFICATION: "等待盘后核验",
    STALLED: "影子执行中断",
  };
  $("dragon-policy-state").textContent =
    (current.state === "OBSERVING" &&
      (current.staleEngine
        ? "待更新执行版本"
        : current.activationIssues?.length
          ? "运行核对异常"
          : current.requiresResearch
            ? observationLabels[current.observation?.status]
            : "基础检查未通过")) ||
    states[current.state] ||
    current.state;
  $("dragon-policy-state").dataset.state = current.state;
  if (!dirty)
    $("dragon-save-note").textContent = current.pendingConfigId
      ? "配置已保存，等待下一份未冻结计划生效。"
      : current.state === "READY"
        ? "配置检查已通过，可以申请启用。"
        : current.state === "OBSERVING"
          ? current.staleEngine
            ? "执行版本已变化，基础检查通过后自动登记后续计划版本。"
            : current.activationIssues?.length
              ? "当前运行核对存在异常，排查后再申请启用。"
              : current.requiresResearch
                ? "高级模板验证中；09:30 前准备，完整交易日 17:00 起核验。"
                : "配置已保存，等待基础行为检查通过。"
          : "保存后可申请启用，整体切换用于下一份未冻结计划。";
  const stage =
    { DRAFT: 0, OBSERVING: 0, READY: 1, DRAINING: 2, ACTIVE: 3 }[
      current.state
    ] ?? 0;
  $("dragon-progress").innerHTML = [
    current.requiresResearch ? "模板验证" : "保存与检查",
    "可启用",
    "旧仓结清",
    "新政策运行",
  ]
    .map(
      (label, i) =>
        `<li class="${i < stage ? "is-done" : i === stage ? "is-current" : ""}"${i === stage ? ' aria-current="step"' : ""}><span>${i < stage ? "✓" : String(i + 1).padStart(2, "0")}</span>${label}</li>`,
    )
    .join("");
  $("dragon-policy-message").textContent =
    `${current.message}。${current.pendingConfigId ? "有配置等待下一份计划生效。" : ""}`;
  $("dragon-cancel-research-save").hidden = !current.researchLock;
  $("dragon-research-lock").hidden = !current.researchLock;
  $("dragon-research-lock").textContent = current.researchLock
    ? `当前研究 ${current.researchLock.ownerId} 正在占用窗口。选择“终止当前研究并保存”会作废本轮研究，保留报告、已用样本和预算记录。`
    : "";
  const execution = data.realtime?.session?.dragonExecution,
    executionPlan = execution ?? data.plan,
    frozenConfig = execution?.config ?? data.plan?.dragonPolicy?.config,
    phase = execution?.phase ?? "unknown",
    paused = !!(
      data.book.dragonHalted ||
      execution?.dailyPaused ||
      execution?.missingHoldingQuotes
    ),
    effectiveRows = dragonEffectiveFields(
      frozenConfig ?? current.config,
      phase,
      paused,
    ),
    format = (value, unit) =>
      value == null
        ? "仅保护已有仓位"
        : unit === "boolean"
          ? value
            ? "允许"
            : "禁止"
          : unit === "count"
            ? `${value} 只`
            : `${Number((value * 100).toFixed(4))}%`;
  $("dragon-effective-rows").innerHTML = effectiveRows
    .map((row) => {
      const configured = current.config[row.group][row.key],
        scheduled =
          active && frozenConfig
            ? configured === row.configured
              ? `已冻结 ${executionPlan.signalDate} 计划`
              : `下一份未冻结计划；当前冻结 ${format(row.configured, row.unit)}`
            : "整体切换后生效";
      return `<tr><td>${text(row.label)}</td><td>${text(format(configured, row.unit))}</td><td>${active && frozenConfig ? text(format(row.effective, row.unit)) : "尚未用于主账户"}</td><td>${text(row.reason)}</td><td>${text(scheduled)}</td></tr>`;
    })
    .join("");
  $("dragon-verification").textContent =
    `${current.validationLabel ?? ""}。基础行为检查${current.synthetic?.passed ? "已通过" : "未通过"}。${current.requiresResearch ? "研究候选仍须历史测试、新前瞻及整日影子核验通过。" : "整日影子报告用于运行诊断。"}` +
    (current.report
      ? `最近观察日 ${current.report.date}：全天覆盖${current.report.coverage ? "完整" : "不足"}，行情及账本重放${current.report.replay ? "一致" : "未通过"}，实际成交 ${current.report.fills} 笔。${current.report.note}`
      : "尚无真实整日核验报告。");
  if (current.research)
    $("dragon-verification").textContent +=
      ` 高级模板研究：${text(current.research.status)}，${current.research.report?.reason ?? "60日训练、20日封存、30日前瞻及压力验证"}。`;
  $("dragon-activate-button").disabled =
    !current.ready ||
    draining ||
    (active && (!current.candidateState || !!current.pendingConfigId));
  $("dragon-activate-button").textContent = active
    ? current.pendingConfigId
      ? "配置已排队，等待后续计划"
      : "批准已验证的 AI 模板"
    : "申请结清旧仓并整体切换";
  $("dragon-resume-button").hidden = !active || !data.book.dragonHalted;
  $("dragon-validate-button").hidden = !active || draining;
  $("dragon-validate-button").disabled =
    !!current.pendingConfigId ||
    !!current.researchLock ||
    !!current.requiresResearch;
  $("dragon-validate-button").textContent = current.requiresResearch
    ? "研究验证进行中"
    : "发起研究验证";
  const yuan = (cents) =>
    (Number(cents ?? 0) / 100).toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const totalPnl = data.book.equityCents - data.book.initialCashCents,
    tNet = data.book.dragonTNetPnlCents ?? 0;
  $("dragon-t-summary").textContent =
    `账户累计盈亏 ¥${yuan(totalPnl)} = 新政策已完成 T 净价差 ¥${yuan(tNet)} + 主仓及其他盈亏 ¥${yuan(totalPnl - tNet)}（含历史收益及未完成 T）。T 统计已计入账户总盈亏，不重复相加。`;
  const records = [...(data.book.dragonTRecords ?? [])].reverse().slice(0, 20);
  for (const p of data.book.positions)
    if (p.dragon?.t) {
      const t = p.dragon.t;
      records.unshift({
        code: p.code,
        startedDate: t.date,
        direction: t.direction,
        status: "INCOMPLETE",
        buyQuantity:
          t.direction === "FORWARD" ? t.firstQuantity : t.secondQuantity,
        sellQuantity:
          t.direction === "FORWARD" ? t.secondQuantity : t.firstQuantity,
        netPnlCents: null,
      });
    }
  const statusLabels = {
    COMPLETED: "已配对",
    ABORTED_BY_RISK: "风险中断",
    INCOMPLETE: "第二腿未完成",
  };
  $("dragon-t-records").innerHTML =
    records
      .map(
        (r) =>
          `<tr><td>${text(r.code)}<br>${text(r.startedDate)}</td><td>${r.direction === "FORWARD" ? "正向 T" : "反向 T"}</td><td>${text(statusLabels[r.status] ?? r.status)}</td><td>${r.buyQuantity} / ${r.sellQuantity}</td><td>${r.netPnlCents == null ? "未计完整收益" : "¥ " + yuan(r.netPnlCents)}</td></tr>`,
      )
      .join("") || '<tr><td colspan="5">尚无新政策做 T 记录</td></tr>';
  $("dragon-config-form")
    .querySelectorAll("input,button")
    .forEach((el) => (el.disabled = draining));
  if (draining && current.staleEngine) {
    $("dragon-config-form").querySelector('button[type="submit"]').disabled =
      false;
    $("dragon-policy-message").textContent +=
      " 执行版本已变化，常驻服务会自动登记原配置的新版本，期间仍停止旧体系新增风险。";
  }
  if (!dirty) {
    for (const [group, fields] of [
      ["risk", DRAGON_RISK_FIELDS],
      ["advanced", DRAGON_ADVANCED_FIELDS],
    ])
      for (const f of fields)
        $(`dragon-${group}-${f.key}`).value = Number(
          (current.config[group][f.key] * (f.integer ? 1 : 100)).toFixed(4),
        );
    for (const [group, fields] of [
      ["operations", DRAGON_OPERATION_FIELDS],
      ["buyPoints", DRAGON_BUY_POINT_FIELDS],
    ])
      for (const f of fields)
        $(`dragon-${group}-${f.key}`).checked = current.config[group][f.key];
  }
  for (const id of ["paper-risk-controls", "paper-strategy-controls"]) {
    const fieldset = $(id)?.closest("fieldset");
    if (fieldset) {
      fieldset.hidden = active || draining;
      fieldset
        .querySelectorAll("input,button")
        .forEach((el) => (el.disabled = active || draining));
    }
  }
  for (const id of ["paper-selection-version", "paper-entry-execution-mode"]) {
    $(id).closest("label").hidden = active || draining;
    $(id).disabled = active || draining;
  }
  $("paper-entry-observe").hidden = active || draining;
  $("paper-entry-observation-status").hidden = active || draining;
  $("dragon-legacy-history").hidden = !active && !draining;
  $("dragon-legacy-values").textContent = JSON.stringify(
    {
      policy: "旧记录只读，不参与新政策",
      strategy: data.strategyParams,
      risk: data.riskLimits,
    },
    null,
    2,
  );
}
