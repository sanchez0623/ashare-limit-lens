import { renderPagination, bindPageJump } from "./pagination.js";
import { escapeHtml as escape } from "./observatory-model.js";
import { calibrationView } from "./scoring-view.js";
import { environmentResearchView } from "./environment-view.js";
import { BUY_POINT_LABELS } from "../shared/buy-point-type.js";
import { beijingTime } from "./data-management.js";

const $ = (id) => document.getElementById(id);
async function request(url, body) {
  const response = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "研究请求失败");
  return data;
}
const stage = (v) =>
  ({
    REQUESTING: "生成候选",
    HISTORICAL: "封存测试",
    FORWARD: "新日期前瞻",
    READY: "已通过，等待采用",
    PASSED: "研究通过",
    FAILED: "未通过",
    INVALIDATED: "已失效",
    INCONCLUSIVE: "证据不足",
    OBSERVING: "观察中",
    ACTIVE: "运行中",
    DRAINING: "旧仓结清中",
  })[v] ??
  v ??
  "待积累";
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(3)}%` : "—");
const kinds = {
  pattern: "龙头组合研究",
  template: "配置验证",
  cohort: "旧策略赛马",
  experiment: "旧单候选研究",
};
const deltas = (parent, config) =>
  Object.entries(config ?? {}).flatMap(([group, values]) =>
    values && typeof values === "object"
      ? Object.entries(values)
          .filter(([key, value]) => parent?.[group]?.[key] !== value)
          .map(
            ([key, value]) =>
              `${group}.${key}：${parent?.[group]?.[key] ?? "未知"} → ${value}`,
          )
      : [],
  );

export function researchRecordView(detail) {
  const r = detail.record,
    m = r.manifest ?? {},
    report = r.report ?? {};
  const candidates = m.candidates ?? [];
  const comparisons = [
    ...(Array.isArray(report.historical)
      ? report.historical.map((v) => ({ ...v, window: "封存" }))
      : []),
    ...(Array.isArray(report.forward)
      ? report.forward.map((v) => ({ ...v, window: "前瞻" }))
      : []),
  ];
  return `<h3>${escape(kinds[detail.kind])} · ${escape(stage(r.stage ?? r.status))}</h3><p class="small-muted">${escape(detail.id)} · ${escape(beijingTime(r.created_at))}</p><p>${escape(report.reason ?? "研究结果以完整冻结报告为准")}</p>${
    candidates.length
      ? `<h3>候选与父配置差异</h3>${candidates
          .map(
            (c) =>
              `<div class="research-candidate"><strong>${escape(c.id)}</strong><p>${escape(c.rationale)}</p><ul>${
                deltas(m.parent?.config, c.config)
                  .map((v) => `<li>${escape(v)}</li>`)
                  .join("") || "<li>尚未冻结参数差异</li>"
              }</ul></div>`,
          )
          .join("")}`
      : ""
  }${comparisons.length ? `<div class="table-scroll"><table><thead><tr><th>窗口 / 成本</th><th>候选</th><th>含费收益</th><th>父配置 / 固定模板</th><th>回撤</th><th>完整周期</th><th>对照检验</th></tr></thead><tbody>${comparisons.map((v) => `<tr><td>${v.window} / ${v.multiplier}×</td><td>${escape(v.candidateId)}</td><td>${pct(v.candidate?.netReturn)}</td><td>${pct(v.parent?.netReturn)} / ${pct(v.baseline?.netReturn)}</td><td>${pct(v.candidate?.maxDrawdown)}</td><td>${v.candidate?.completedRounds ?? "—"}</td><td>父 ${v.againstParent?.passed ? "通过" : "未通过"} / 基线 ${v.againstBaseline?.passed ? "通过" : "未通过"}</td></tr>`).join("")}</tbody></table></div>` : ""}<p class="small-muted">实际账户重放核验：${report.actualAccountsVerified === true ? "通过" : "尚无通过记录"}；所有历史内容只读。</p><a class="secondary" href="/api/research/records?kind=${encodeURIComponent(detail.kind)}&id=${encodeURIComponent(detail.id)}&format=json" download>导出原始研究记录</a><details class="research-raw"><summary>查看冻结证据与统计详情</summary><pre>${escape(JSON.stringify(detail, null, 2))}</pre></details>`;
}

export function initializeResearchHub({ navigate, onChanged }) {
  const environmentFilters = { page: 1, buyPoint: "", dimension: "strength" };
  let visible = false,
    tab = "current",
    busy = false,
    timer,
    offset = 0,
    requestId = 0;
  const message = (value) => {
    $("research-hub-message").textContent = value;
  };
  async function act(path) {
    if (busy) return;
    busy = true;
    $("research-hub-current")
      .querySelectorAll("button")
      .forEach((b) => {
        b.disabled = true;
      });
    message("正在检查并提交研究请求…");
    try {
      const data = await request(path, {});
      message(
        data.reason ??
          data.message ??
          `研究状态：${stage(data.status ?? data.state)}`,
      );
      onChanged();
    } catch (error) {
      message(error.message);
    } finally {
      busy = false;
      await refresh();
    }
  }
  function currentView(status, dragon) {
    const d = status.dashboard,
      patterns = status.practice,
      batch = patterns?.batches?.[0];
    $("research-hub-current").innerHTML =
      `<section class="panel"><div class="panel-heading"><div><h2>当前研究</h2><p>龙头组合研究与配置验证共用研究窗口，交易参数继续在模拟执行中编辑。</p></div><span class="outline-tag">${escape(stage(dragon.state))}</span></div><div class="metrics panel-metrics"><div><span>完整研究日</span><strong>${d.completeDays} / ${d.requiredDays}</strong><small>${d.adjacent ? "日期相邻" : "日期存在缺口"} · 60训练＋20封存</small></div><div><span>本月批次</span><strong>${d.budget.used} / ${d.budget.limit}</strong><small>${escape(d.budget.month)} · 前瞻30日</small></div><div><span>大模型连接</span><strong>${d.model.configured ? "已配置" : "未配置"}</strong><small>${escape(d.model.model ?? "服务端配置")}</small></div><div><span>验证通过后</span><strong>${d.improvementMode === "auto" ? "自动采用" : "人工批准"}</strong><small>下一份未冻结计划生效</small></div></div><p>${escape(dragon.validationLabel ?? "尚无配置验证")}</p><p class="small-muted">配置 ${escape(dragon.configId ?? "未登记")}；${escape(dragon.message ?? "")}</p><p class="research-blockers">${escape(d.reasons.join("；") || "研究前置条件齐备，提交时由服务端重新核验")}</p><div class="research-actions"><button class="primary" id="hub-propose" ${!d.canPropose || busy ? "disabled" : ""}>发起组合研究</button><button class="secondary" id="hub-validate" ${dragon.state !== "ACTIVE" || dragon.pendingConfigId || dragon.researchLock || dragon.requiresResearch || busy ? "disabled" : ""}>验证当前人工配置</button><button class="secondary" id="hub-approve" ${!dragon.ready || dragon.candidateState !== "READY" || dragon.pendingConfigId || busy ? "disabled" : ""}>批准已验证候选</button><button class="secondary" id="hub-config">修改风险参数与采用方式</button></div><p class="small-muted">固定评分只观察，不修改交易。研究通过、待批准、待生效与实际生效分别记录。</p></section><section class="panel"><div class="panel-heading"><h2>活动与最近研究</h2><span class="outline-tag">${escape(stage(batch?.stage ?? dragon.research?.status))}</span></div><p>${batch ? `${escape(batch.id)} · ${batch.candidateCount} 个候选 · 前瞻 ${batch.forwardDates.length} / 30 日` : "尚无龙头组合批次；配置验证与样本采集照常运行。"}</p><p>${escape(batch?.report?.reason ?? dragon.research?.report?.reason ?? "")}</p><p class="small-muted">真实技术核验：${dragon.observationVerified ? "已有通过报告" : "未完成"}；配置研究：${escape(stage(dragon.research?.status))}。</p><div id="research-current-record"></div></section>`;
    $("hub-propose").onclick = () => act("/api/paper/improve");
    $("hub-validate").onclick = () => act("/api/paper/dragon/validate");
    $("hub-approve").onclick = () => act("/api/paper/dragon/activate");
    $("hub-config").onclick = () => navigate("paper", "config");
    if (batch)
      void request(
        `/api/research/records?kind=pattern&id=${encodeURIComponent(batch.id)}`,
      )
        .then((record) => {
          if (visible && tab === "current" && $("research-current-record"))
            $("research-current-record").innerHTML = researchRecordView(record);
        })
        .catch((e) => message(e.message));
  }
  async function refresh() {
    if (!visible || busy) return;
    const id = ++requestId;
    try {
      if (tab === "current") {
        const [status, dragon] = await Promise.all([
          request("/api/research/status"),
          request("/api/paper/dragon"),
        ]);
        if (id !== requestId) return;
        currentView(status, dragon);
      } else if (tab === "scoring") {
        const [rule, report, environment] = await Promise.all([
          request("/api/research/scoring/policy"),
          request("/api/research/scoring/calibration"),
          request(
            `/api/research/environment?dimension=${environmentFilters.dimension}&buyPoint=${environmentFilters.buyPoint}`,
          ).catch((error) => ({
            groups: [],
            note: `环境报告暂不可用：${error.message}`,
          })),
        ]);
        if (id !== requestId) return;
        const p = rule.policy;
        $("research-hub-scoring").innerHTML =
          `<section class="panel"><div class="panel-heading"><h2>评分规则与自动校准</h2><span class="outline-tag">只读 · 固定规则</span></div><p>${escape(p.note)}</p><p class="small-muted">${escape(p.version)} · 发布 ${escape(rule.publishedAt ? beijingTime(rule.publishedAt) + "（北京时间）" : "等待评分进程登记")}；旧调权预设已退出日常设置。</p><div class="table-scroll"><table><thead><tr><th>买点</th><th>身份L</th><th>板块E</th><th>形态F</th><th>确认C</th></tr></thead><tbody>${Object.entries(
            p.weights,
          )
            .map(
              ([type, weights]) =>
                `<tr><td>${escape(BUY_POINT_LABELS[type])}</td>${Object.values(
                  weights,
                )
                  .map((w) => `<td>${w}%</td>`)
                  .join("")}</tr>`,
            )
            .join("")}</tbody></table></div><p>${Object.entries(p.definitions)
            .map(([key, value]) => `${key} ${escape(value)}`)
            .join(
              "；",
            )}。</p><p class="small-muted">任何必要分项缺失时质量分保持未知；风险压力由真实动态风险状态单独计算。</p></section><section class="panel"><div class="panel-heading"><h2>完整周期的真实结果</h2><a class="secondary" href="/api/research/scoring/calibration?format=json" download>导出校准报告</a></div>${calibrationView(report)}</section>`;
        $("research-hub-scoring").insertAdjacentHTML(
          "beforeend",
          environmentResearchView(environment, environmentFilters),
        );
        const panel = $("environment-research");
        for (const [selector, key] of [
          ["[data-environment-buy-point]", "buyPoint"],
          ["[data-environment-dimension]", "dimension"],
        ])
          panel.querySelector(selector).onchange = (event) => {
            environmentFilters[key] = event.target.value;
            environmentFilters.page = 1;
            void refresh();
          };
        const changePage = (page) => {
          environmentFilters.page = page;
          void refresh();
        };
        panel.querySelector("[data-environment-pager]").onclick = (event) => {
          const button = event.target.closest("[data-environment-page]");
          if (button && !button.disabled)
            changePage(Number(button.dataset.environmentPage));
        };
        bindPageJump(
          panel.querySelector("[data-environment-pager]"),
          changePage,
        );
      } else {
        const records = await request(
          `/api/research/records?limit=20&offset=${offset}`,
        );
        if (id !== requestId) return;
        $("research-hub-history").innerHTML =
          `<section class="panel"><div class="panel-heading"><h2>研究历史</h2><span class="outline-tag">全部只读</span></div><p>龙头组合、人工配置验证和旧研究按来源区分。原始预算、样本和失败记录保留。</p><div class="table-scroll"><table><thead><tr><th>来源</th><th>编号</th><th>创建时间</th><th>查看</th></tr></thead><tbody>${records.rows.map((r) => `<tr><td>${escape(kinds[r.kind])}</td><td>${escape(r.id)}</td><td>${escape(beijingTime(r.created_at))}</td><td><button class="secondary" data-record-id="${escape(r.id)}" data-record-kind="${r.kind}">详情</button></td></tr>`).join("") || '<tr><td colspan="4">暂无研究记录</td></tr>'}</tbody></table></div><div id="records-pager">${renderPagination({ page: Math.floor(offset / 20) + 1, totalPages: Math.max(1, Math.ceil(records.total / 20)), total: records.total, pageSize: 20 }, { attribute: "data-record-page", unit: "条" })}</div></section><section class="panel" id="research-record-detail" hidden></section>`;
        const changePage = (page) => {
          offset = (page - 1) * 20;
          void refresh();
        };
        const pager = $("records-pager");
        pager.onclick = (event) => {
          const button = event.target.closest("[data-record-page]");
          if (button && !button.disabled)
            changePage(Number(button.dataset.recordPage));
        };
        bindPageJump(pager, changePage);
        $("research-hub-history")
          .querySelectorAll("[data-record-id]")
          .forEach((button) => {
            button.onclick = async () => {
              try {
                const record = await request(
                  `/api/research/records?kind=${button.dataset.recordKind}&id=${encodeURIComponent(button.dataset.recordId)}`,
                );
                const target = $("research-record-detail");
                if (!target) return;
                target.hidden = false;
                target.innerHTML = researchRecordView(record);
              } catch (error) {
                message(error.message);
              }
            };
          });
      }
    } catch (error) {
      if (id === requestId) message(error.message);
    }
  }
  $("research-hub-refresh").onclick = () => {
    message("");
    void refresh();
  };
  return {
    setVisible(value, nextTab = "current") {
      visible = value;
      tab = nextTab;
      requestId++;
      for (const key of ["current", "scoring", "history"])
        $(`research-hub-${key}`).hidden = key !== tab;
      clearInterval(timer);
      if (visible) {
        void refresh();
        if (tab === "current")
          timer = setInterval(() => {
            void refresh();
          }, 30000);
      }
    },
  };
}
