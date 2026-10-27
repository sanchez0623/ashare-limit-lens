const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export function renderPagination(
  meta,
  { attribute = "data-page", unit = "条", loading = false, summary } = {},
) {
  const totalPages = Math.max(1, Math.floor(meta.totalPages || 1));
  const page = Math.max(1, Math.min(totalPages, Math.floor(meta.page || 1)));
  const pages =
    totalPages <= 9
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : [...new Set([1, page - 1, page, page + 1, totalPages])]
          .filter((p) => p >= 1 && p <= totalPages)
          .sort((a, b) => a - b);
  const button = (label, target, disabled = false, active = false) =>
    `<button type="button" class="page-btn${active ? " active" : ""}" ${attribute}="${target}" ${loading || disabled ? "disabled" : ""}${active ? ' aria-current="page"' : ""}>${label}</button>`;
  const numbers = pages
    .map(
      (p, i) =>
        `${i && p - pages[i - 1] > 1 ? '<span class="page-ellipsis" aria-hidden="true">…</span>' : ""}${button(p, p, p === page, p === page)}`,
    )
    .join("");
  const info =
    summary ??
    `第 ${page} / ${totalPages} 页 · 共 ${meta.total ?? 0} ${unit}${meta.pageSize ? ` · 每页 ${meta.pageSize} ${unit}` : ""}`;
  const disabled = loading || totalPages <= 1 ? "disabled" : "";
  return `<div class="ledger-pager">
    <span class="page-info" role="status">${escape(info)}</span>
    <div class="page-controls">${button("‹ 上一页", Math.max(1, page - 1), page <= 1)}<div class="page-numbers">${numbers}</div>${button("下一页 ›", Math.min(totalPages, page + 1), page >= totalPages)}</div>
    <form class="page-jump" data-page-jump data-total-pages="${totalPages}" data-current-page="${page}" novalidate>
      <label>前往 <input type="number" inputmode="numeric" min="1" max="${totalPages}" step="1" value="${page}" required aria-label="跳转页码" data-page-jump-input ${disabled}> 页</label>
      <button type="submit" class="page-btn" ${disabled}>跳转</button>
    </form>
  </div>`;
}

// Delegation keeps jump controls working when a page or API response rerenders.
export function bindPageJump(root, onPage) {
  root.oninput = (event) => {
    if (event.target.matches?.("[data-page-jump-input]"))
      event.target.setCustomValidity("");
  };
  root.onsubmit = (event) => {
    const form = event.target.closest("[data-page-jump]");
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector("[data-page-jump-input]");
    if (!input || input.disabled) return;
    const value = String(input.value).trim(),
      page = Number(value);
    const totalPages = Number(form.dataset.totalPages);
    input.setCustomValidity("");
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > totalPages
    ) {
      input.setCustomValidity(`请输入 1 到 ${totalPages} 之间的整数页码`);
      input.reportValidity();
      return;
    }
    if (page !== Number(form.dataset.currentPage)) onPage(page);
  };
}
