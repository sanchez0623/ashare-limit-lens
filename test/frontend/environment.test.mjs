import test from "node:test";
import assert from "node:assert/strict";
import { load } from "cheerio";
import {
  environmentSummary,
  environmentResearchView,
} from "../../frontend/environment-view.js";

test("三维环境显示真实数据质量和预算，未知强度不冒充零分", () => {
  const view = environmentSummary({
    asOf: "2026-10-27T02:00:00Z",
    strength: null,
    strengthBand: "UNKNOWN",
    direction: { band: "UNKNOWN" },
    fragility: {
      band: "UNKNOWN",
      ordinary: { valid: 3, total: 8, coverage: 3 / 8 },
      high: { applicable: false },
    },
    status: "RETAINED",
    budget: { baselineFactor: 0.8, newRiskFactor: 0.25 },
  });
  assert.match(view.caption, /强度 —/);
  assert.match(view.explanation, /3\/8/);
  assert.match(view.explanation, /80.0% → 25.0%/);
  assert.match(view.explanation, /保留最近有效上限/);
  assert.match(view.explanation, /不触发已有持仓卖出/);
  assert.equal(environmentSummary({ asOf: null }), null);
});

test("买点环境可筛选、翻页及跳转；不足样本与未完成周期显式标明，内容转义", () => {
  const groups = Array.from({ length: 12 }, (_, i) => ({
    buyPoint: "auction-dip",
    band: "LOW",
    opportunities: i + 1,
    cycles: 1,
    entryDates: 1,
    netPnlCents: 50,
    meanNetR: 0.01,
    status: "INSUFFICIENT",
    mode: "FORWARD_OBSERVATION",
    blockingReasons: { "<script>bad()</script>": 1 },
  }));
  const $ = load(
    environmentResearchView(
      { groups, openCycles: [{ id: 1 }], note: "<script>bad()</script>" },
      { page: 2 },
    ),
  );
  assert.equal($("[data-environment-buy-point] option").length, 7);
  assert.equal($("[data-environment-dimension] option").length, 3);
  assert.equal(
    $("#environment-research table").first().find("tbody tr").length,
    2,
  );
  assert.equal($("[data-page-jump-input]").attr("max"), "2");
  assert.equal($("[data-page-jump-input]").attr("value"), "2");
  assert.match($.text(), /样本不足|尚未清仓 1/);
  assert.match($.text(), /1×、1.5×、2×/);
  assert.equal($("script").length, 0);
});
