const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const count = (value) =>
  value == null ? "—" : Number(value).toLocaleString("zh-CN");
const percent = (value) =>
  value == null ? "—" : `${(value * 100).toFixed(1)}%`;
export const beijingTime = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "未初始化";
const labels = {
  stock_list: "股票名册",
  stock_em: "东财行业",
  industry_sw: "申万行业",
  all: "全部更新",
};
const statuses = {
  QUEUED: "等待执行",
  RUNNING: "更新中",
  SUCCEEDED: "成功",
  PARTIAL: "部分成功",
  FAILED: "失败",
  CANCELLED: "已取消",
};
const summary = (job) =>
  Object.entries(job.results ?? {})
    .map(([kind, r]) =>
      r.status === "SUCCEEDED"
        ? `${labels[kind]}：${r.sourceCount} 只，新增 ${r.added}，名称变化 ${r.nameChanges}${
            kind === "stock_list"
              ? `，来源：${Object.entries(r.sources ?? {})
                  .map(
                    ([source, n]) =>
                      `${sourceLabels[source] || source} ${n} 只`,
                  )
                  .join("、")}`
              : `，行业变化 ${r.industryChanges}`
          }${r.verifiedConflicts ? `，${r.verifiedConflicts} 只多归属已按申万官方变更记录核验` : ""}${r.warnings?.length ? `；${r.warnings.join("；")}` : ""}`
        : `${labels[kind]}：${r.error || "更新失败，保留旧版"}`,
    )
    .join("；");
const sourceLabels = {
  sse: "上交所",
  szse: "深交所",
  sina: "新浪",
  unknown: "未记录",
};

export function initializeDataManagement() {
  let visible = false,
    timer = null,
    loading = false,
    status = null,
    versions = null,
    error = "";
  const request = async (url, body) => {
    const response = await fetch(url, {
      ...(body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "数据管理请求失败");
    return data;
  };
  function render() {
    const em = status?.stockEm,
      roster = status?.stockList ?? em,
      sw = status?.industrySw,
      job = status?.activeJob;
    $("data-stock-count").textContent = count(roster?.sourceCount);
    $("data-stock-time").textContent = beijingTime(roster?.fetchedAt);
    $("data-stock-source").textContent = status?.stockList
      ? `当前版本来源：${Object.entries(status.stockList.sources ?? {})
          .map(
            ([source, n]) => `${sourceLabels[source] || source} ${count(n)} 只`,
          )
          .join("、")}`
      : status?.stockListFallback
        ? "当前使用旧东财名册；可独立更新为交易所／新浪名册"
        : "交易所优先 · 新浪备用 · 无需 Key";
    $("data-em-count").textContent = count(em?.industryCount);
    $("data-em-coverage").textContent = percent(
      status?.missingEm?.coverage ?? em?.coverage,
    );
    $("data-em-time").textContent = beijingTime(em?.fetchedAt);
    $("data-em-source").textContent = em
      ? `当前版本来源：${em.source === "eastmoney-ulist-f100" ? "东财原生 f100 批量接口" : em.source === "eastmoney-f10-board-level2" ? "东财 F10 当前二级行业" : "东财全市场分页接口"}`
      : "名册就绪后使用原生 f100 批量接口；连接失败时采用 F10 当前行业";
    $("data-sw-count").textContent = sw?.levels
      ? sw.levels.map(count).join(" / ")
      : "—";
    $("data-sw-coverage").textContent = percent(status?.missingSw?.coverage);
    $("data-sw-time").textContent = beijingTime(sw?.fetchedAt);
    $("data-sw-source").textContent = status?.swProvider
      ? `${status.swProvider.description}${status.swProvider.reason ? ` · ${status.swProvider.reason}` : ""}${sw ? ` · 当前版本来源：${sw.source?.startsWith("lixinger") ? "理杏仁" : "乐咕"}` : ""}`
      : "正在读取申万数据源配置";
    $("data-capability").textContent =
      status?.capabilityReason ||
      (status
        ? "本地后台执行 · 手动触发 · 北京时间"
        : "正在读取更新执行器状态");
    $("data-message").textContent =
      error ||
      (job?.cancelRequested
        ? "正在取消，已发布的结果保留，未完成的数据不会发布。"
        : "元数据范围为沪深主板与创业板，包含 ST 信息；交易筛选规则独立执行。");
    $("data-message").classList.toggle("data-error", !!error);
    document.querySelectorAll("[data-update-scope]").forEach((button) => {
      button.disabled =
        loading ||
        !!job ||
        !status?.workerHealthy ||
        (["industry_sw", "all"].includes(button.dataset.updateScope) &&
          status?.swProvider?.ready === false);
    });
    $("data-active").hidden = !job;
    $("data-cancel").disabled = loading || !job || job.cancelRequested;
    if (job) {
      const progress = job.progress ?? {},
        retrySeconds = progress.retryAt
          ? Math.max(
              0,
              Math.ceil((Date.parse(progress.retryAt) - Date.now()) / 1000),
            )
          : null,
        elapsed = Math.max(
          0,
          Math.floor(
            (Date.now() - Date.parse(job.startedAt ?? job.createdAt)) / 1000,
          ),
        );
      $("data-job-stage").textContent = `${labels[job.scope]} · ${job.stage}`;
      $("data-job-detail").textContent =
        `${progress.total ? `${count(progress.completed)} / ${count(progress.total)}` : job.status === "QUEUED" ? "等待任务开始" : "正在请求数据源"} · 已耗时 ${elapsed} 秒${retrySeconds === null ? "" : retrySeconds > 0 ? ` · ${retrySeconds} 秒后重试` : " · 正在重试"}`;
      const bar = $("data-progress");
      if (progress.total)
        bar.value = Math.min(
          100,
          (100 * (progress.completed ?? 0)) / progress.total,
        );
      else bar.removeAttribute("value");
    }
    for (const [kind, title] of [
      ["Em", "东财"],
      ["Sw", "申万"],
    ]) {
      const item = status?.[`missing${kind}`];
      $(`data-missing-${kind.toLowerCase()}`).textContent =
        item?.count == null
          ? "股票名册未初始化，暂无法计算覆盖率。"
          : `${title}未覆盖 ${count(item.count)} 只${item.samples.length ? `：${item.samples.map((r) => `${r.name} ${r.code}`).join("、")}（最多展示20只）` : "，当前名单均已覆盖。"}`;
    }
    $("data-job-rows").innerHTML = status?.jobs?.length
      ? status.jobs
          .map((j) => {
            const reportedErrors = Object.values(j.results ?? {})
              .map((r) => r.error)
              .filter(Boolean)
              .join("；");
            const extraError = j.error && !reportedErrors.includes(j.error);
            return `<tr><td>${escape(beijingTime(j.createdAt))}</td><td>${labels[j.scope] || escape(j.scope)}</td><td><span class="data-state data-state-${escape(j.status.toLowerCase())}">${statuses[j.status] || escape(j.status)}</span></td><td>${escape(summary(j) || j.stage)}${extraError ? `<small class="data-error">${escape(j.error)}</small>` : ""}</td></tr>`;
          })
          .join("")
      : '<tr><td colspan="4" class="small-muted">尚无更新记录。点击上方按钮初始化数据。</td></tr>';
  }
  function schedule() {
    clearTimeout(timer);
    if (visible) timer = setTimeout(refresh, status?.activeJob ? 2000 : 10000);
  }
  async function refresh() {
    if (loading) return schedule();
    loading = true;
    try {
      const next = await request("/api/data/status");
      const nextVersions = `${next.stockList?.snapshotId ?? ""}:${next.stockEm?.snapshotId ?? ""}:${next.industrySw?.snapshotId ?? ""}`;
      if (
        nextVersions !== versions &&
        (versions !== null || next.stockList || next.stockEm || next.industrySw)
      )
        window.dispatchEvent(new CustomEvent("metadata-updated"));
      versions = nextVersions;
      status = next;
      error = "";
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
      render();
      schedule();
    }
  }
  document.querySelectorAll("[data-update-scope]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (loading || status?.activeJob) return;
      loading = true;
      error = "";
      render();
      try {
        const result = await request("/api/data/update", {
          scope: button.dataset.updateScope,
        });
        status = { ...status, activeJob: result.job };
      } catch (e) {
        error = e.message;
      } finally {
        loading = false;
        render();
        schedule();
      }
    }),
  );
  $("data-cancel").addEventListener("click", async () => {
    if (!status?.activeJob || loading) return;
    loading = true;
    render();
    try {
      const result = await request(
        `/api/data/jobs/${status.activeJob.id}/cancel`,
        {},
      );
      status.activeJob = ["QUEUED", "RUNNING"].includes(result.job.status)
        ? result.job
        : null;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
      render();
      void refresh();
    }
  });
  $("data-refresh").addEventListener("click", refresh);
  return {
    refresh,
    setVisible(value) {
      visible = value;
      clearTimeout(timer);
      if (visible) void refresh();
    },
  };
}
