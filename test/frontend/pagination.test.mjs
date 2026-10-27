import test from "node:test";
import assert from "node:assert/strict";
import { load } from "cheerio";
import { renderPagination, bindPageJump } from "../../frontend/pagination.js";
import { initializeEntryPlan } from "../../frontend/entry-plan.js";
import { INTRADAY_ENTRY_RULES } from "../../backend/domain/intraday-entry.js";

test("九页观察名单可直接点击每个页码，当前页及边界明确，加载中禁用跳转", () => {
  const $ = load(
    renderPagination(
      { page: 1, totalPages: 9, total: 82, pageSize: 10 },
      {
        attribute: "data-entry-plan-page",
        unit: "只",
      },
    ),
  );
  assert.equal($(".page-numbers button").length, 9);
  assert.equal($("[aria-current=page]").text(), "1");
  assert.equal($(".page-controls > button").first().is(":disabled"), true);
  assert.equal($(".page-controls > button").last().is(":disabled"), false);
  assert.equal($("[data-page-jump-input]").attr("max"), "9");
  assert.match($(".page-info").text(), /共 82 只/);
  const busy = load(
    renderPagination({ page: 9, totalPages: 9, total: 82 }, { loading: true }),
  );
  assert.equal(busy("button:not(:disabled),input:not(:disabled)").length, 0);
  const empty = load(renderPagination({ page: 1, totalPages: 1, total: 0 }));
  assert.equal(empty("[data-page-jump-input]").is(":disabled"), true);
});

test("万页记录只渲染附近页码与边界，保留任意页跳转", () => {
  const $ = load(
    renderPagination({ page: 9000, totalPages: 10000, total: 100000 }),
  );
  assert.ok($("[data-page]").length <= 7);
  assert.deepEqual(
    $(".page-numbers button")
      .map((_, el) => $(el).text())
      .get(),
    ["1", "8999", "9000", "9001", "10000"],
  );
  assert.equal($("[data-page-jump-input]").attr("max"), "10000");
});

function jump(
  root,
  value,
  { totalPages = 9, currentPage = 1, disabled = false } = {},
) {
  let message = "",
    reported = false,
    prevented = false;
  const input = {
    value,
    disabled,
    setCustomValidity(v) {
      message = v;
    },
    reportValidity() {
      reported = true;
    },
  };
  const form = {
    dataset: {
      totalPages: String(totalPages),
      currentPage: String(currentPage),
    },
    querySelector: () => input,
  };
  root.onsubmit({
    target: { closest: () => form },
    preventDefault() {
      prevented = true;
    },
  });
  return { input, message: () => message, reported, prevented };
}

test("输入页码跳转支持 Enter 提交，非法页码不导航，更正输入清除错误", () => {
  const root = {},
    pages = [];
  bindPageJump(root, (page) => pages.push(page));
  assert.equal(jump(root, "9").prevented, true);
  assert.deepEqual(pages, [9]);
  for (const value of [
    "",
    "0",
    "-1",
    "10",
    "2.5",
    "1e1",
    "abc",
    "9007199254740993",
  ]) {
    const result = jump(root, value);
    assert.equal(result.reported, true, value);
    assert.match(result.message(), /1 到 9/);
    result.input.matches = () => true;
    root.oninput({ target: result.input });
    assert.equal(result.message(), "");
  }
  jump(root, "1");
  jump(root, "8", { disabled: true });
  assert.deepEqual(pages, [9]);
});

test("82只计划支持页码和跳转、末页2只，自动刷新保留页码，筛选回第一页", () => {
  const elements = new Map(),
    listeners = new Map();
  const element = (key) => {
    if (!elements.has(key)) elements.set(key, { value: "", innerHTML: "" });
    return elements.get(key);
  };
  const root = {
    innerHTML: "",
    querySelector: element,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
  };
  const candidates = Array.from({ length: 82 }, (_, i) => String(600001 + i));
  const plan = {
    signalDate: "2026-10-23",
    createdAt: "2026-10-25T21:00:00Z",
    entryExecutionPolicy: {
      version: "intraday-entry-v1",
      sourceDate: "2026-10-23",
      rules: INTRADAY_ENTRY_RULES,
      candidates,
      history: Object.fromEntries(
        candidates.map((code) => [
          code,
          {
            name: `样本${code}`,
            sector: "测试行业",
            stockClass: "strong-reversal",
            recentLimitUp: true,
            amount: 500000000,
            previousCloseCents: 1000,
          },
        ]),
      ),
    },
  };
  const controller = initializeEntryPlan(root);
  controller.render(plan);
  const pager = () => load(element("[data-entry-plan-pager]").innerHTML);
  assert.equal(pager()(".page-numbers button").length, 9);
  listeners.get("click")({
    target: { closest: () => ({ dataset: { entryPlanPage: "7" } }) },
  });
  assert.match(pager()(".page-info").text(), /第 7 \/ 9 页/);
  jump(root, "9", { currentPage: 7 });
  assert.match(pager()(".page-info").text(), /第 9 \/ 9 页/);
  assert.equal(
    load(
      `<table><tbody>${element("[data-entry-plan-rows]").innerHTML}</tbody></table>`,
    )("tr").length,
    2,
  );
  controller.render(structuredClone(plan));
  assert.match(pager()(".page-info").text(), /第 9 \/ 9 页/);
  element("[data-entry-plan-search]").value = "600001";
  listeners.get("input")({ target: { matches: () => true } });
  assert.match(pager()(".page-info").text(), /筛选 1 \/ 82 只.*第 1 \/ 1 页/);
  assert.equal(pager()("[data-page-jump-input]").is(":disabled"), true);
});
