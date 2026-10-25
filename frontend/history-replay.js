import { BUY_POINT_LABELS } from "../shared/buy-point-type.js";
const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const statusLabel = {
  UNVERIFIABLE: "不可验证",
  VERIFIABLE: "证据通过",
  VERIFIED_NO_TRIGGER: "未触发",
  TRIGGERED: "已成交",
  BLOCKED: "证据不足，已阻断",
  READY: "完成",
  PARTIAL: "部分资料已重构",
  FAILED: "导入失败",
};
let current = null,
  busy = false;
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
  if (!response.ok || data.error)
    throw new Error(data.error ?? "历史研究请求失败");
  return data;
}
function render(run) {
  current = run;
  const days = run.coverage?.days ?? [];
  $("strict-history-status").textContent =
    `${statusLabel[run.stage] ?? run.stage} · ${days.length} 个执行日 · ${run.createdAt.slice(0, 10)}`;
  $("strict-history-download").hidden = !days.length;
  $("strict-history-report").innerHTML =
    `<p>收益：${run.stage === "READY" && Number.isFinite(run.coverage.totalReturn) ? (run.coverage.totalReturn * 100).toFixed(2) + "%" : "未发布"}。${run.stage === "BLOCKED" ? "任一必要交易日缺证据，整段区间不生成收益曲线。" : "按归档原始帧复用实时执行内核。"}</p><p class="small-muted">历史重构不能替代主账户的真实影子观察。</p><div class="table-scroll" style="max-height:480px"><table><thead><tr><th>执行日 / 信号日</th><th>三类候选</th><th>逐帧证据</th>${Object.values(
      BUY_POINT_LABELS,
    )
      .map((label) => `<th>${escape(label)}</th>`)
      .join("")}<th>字段及股票缺口</th></tr></thead><tbody>${days
      .map(
        (d) =>
          `<tr><td>${escape(d.date)}<br><small>${escape(d.signalDate)}</small></td><td>涨停 ${escape(d.candidateCoverage?.counts?.stocks ?? "—")} / 炸板 ${escape(d.candidateCoverage?.counts?.brokenStocks ?? "—")} / EOD ${escape(d.candidateCoverage?.counts?.extraStocks ?? "—")}<br>${d.candidateCoverage?.status === "COMPLETE" ? "候选完整" : "候选待补证据"}</td><td>${escape(d.frameCount)} 帧<br>${escape(statusLabel[d.status] ?? d.status)}</td>${Object.keys(
            BUY_POINT_LABELS,
          )
            .map(
              (type) =>
                `<td>${escape(statusLabel[d.buyPoints?.[type]] ?? "不可验证")}</td>`,
            )
            .join(
              "",
            )}<td><details><summary>${d.gaps.length} 类缺口 · ${d.codes.length} 只候选或持仓</summary><p>${d.gaps.map((g) => `${escape(g.code ?? "全日")}：${escape(g.field)}（${escape(g.reason)}）`).join("<br>")}</p><p>${d.codes.map(escape).join(" · ")}</p></details></td></tr>`,
      )
      .join("")}</tbody></table></div>`;
}
async function refresh() {
  if (busy) return;
  try {
    $("strict-history-status").textContent = "正在读取历史验收…";
    const data = await request("/api/backtests");
    const run = data.backtests.find(
      (r) => r.executionModel === "ARCHIVED_OBSERVATIONS_V1",
    );
    if (run) render(run);
    else $("strict-history-status").textContent = "尚无六类严格回放报告。";
  } catch (error) {
    $("strict-history-status").textContent = error.message;
  }
}
async function run() {
  if (busy) return;
  busy = true;
  $("strict-history-run").disabled = true;
  try {
    const start = $("strict-history-start").value,
      end = $("strict-history-end").value;
    if (!start || !end || start > end)
      throw new Error("请选择有效的执行日期区间");
    $("strict-history-status").textContent =
      "正在重构三类候选并核验历史资料，全年导入可能需要数分钟…";
    const created = await request("/api/history/imports", {
      kind: "V5_RECONSTRUCTION",
      start,
      end,
    });
    const candidate = await request(
      `/api/history/imports/${created.job.id}/run`,
      {},
    );
    if (!candidate.datasetId || !["READY", "PARTIAL"].includes(candidate.stage))
      throw new Error(
        candidate.statusPayload?.error ??
          candidate.statusPayload?.reason ??
          "候选重构尚未完成",
      );
    $("strict-history-status").textContent =
      "正在复制真实行情归档并检查六类买点的执行证据…";
    const obs = await request("/api/history/imports", {
      kind: "OBSERVATIONS",
      start,
      end,
      datasetId: candidate.datasetId,
    });
    const observed = await request(
      `/api/history/imports/${obs.job.id}/run`,
      {},
    );
    if (!observed.datasetId || observed.stage === "FAILED")
      throw new Error(observed.statusPayload?.error ?? "行情归档导入失败");
    const result = await request("/api/backtests", {
      datasetId: observed.datasetId,
      executionModel: "ARCHIVED_OBSERVATIONS_V1",
    });
    render(result.run);
  } catch (error) {
    $("strict-history-status").textContent = error.message;
  } finally {
    busy = false;
    $("strict-history-run").disabled = false;
  }
}
function download() {
  if (!current) return;
  const quote = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const rows = [
    [
      "执行日",
      "信号日",
      "证据状态",
      "帧数",
      ...Object.values(BUY_POINT_LABELS),
      "股票",
      "字段缺口",
    ],
    ...current.coverage.days.map((d) => [
      d.date,
      d.signalDate,
      statusLabel[d.status],
      d.frameCount,
      ...Object.keys(BUY_POINT_LABELS).map((t) => statusLabel[d.buyPoints[t]]),
      d.codes.join(" "),
      d.gaps
        .map((g) => `${g.code ?? "全日"}:${g.field}:${g.reason}`)
        .join(" | "),
    ]),
  ];
  const url = URL.createObjectURL(
    new Blob(
      ["\ufeff" + rows.map((r) => r.map(quote).join(",")).join("\r\n")],
      { type: "text/csv;charset=utf-8" },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `v5-逐日缺口-${current.id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
if ($("strict-history-run")) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  $("strict-history-end").value = today;
  $("strict-history-end").max = today;
  $("strict-history-run").addEventListener("click", run);
  $("strict-history-refresh").addEventListener("click", refresh);
  $("strict-history-download").addEventListener("click", download);
}
