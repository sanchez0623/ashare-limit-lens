import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { load } from "cheerio";
import {
  renderAdaptiveRisk,
  renderAdaptiveComparison,
} from "../../frontend/adaptive-risk-view.js";
import {
  initialAdaptiveRisk,
  advanceAdaptiveRisk,
  adaptiveRiskView,
} from "../../shared/adaptive-risk.js";
import { defaultDragonConfig } from "../../shared/dragon-risk-config.js";

function fixture() {
  const date = "2026-10-26",
    state = initialAdaptiveRisk(date);
  const sector = '<script>alert("sector")</script>';
  const start = Date.parse(`${date}T09:30:00+08:00`);
  for (let i = 0; i <= 180; i += 10) {
    const observedAt = new Date(start + i * 1000).toISOString();
    advanceAdaptiveRisk(state, {
      observedAt,
      sectors: { 600001: sector },
      market: {
        date,
        observedAt,
        metrics: {
          limitUp: 60,
          broken: 10,
          height: 5,
          premium: 2,
          premiumCoverage: 1,
        },
        sectorsComplete: true,
        sectors: [{ name: sector, score: 80, count: 4, broken: 1 }],
      },
      quotes: {
        600001: {
          date,
          timestamp: observedAt,
          closeCents: 1000,
          volumeShares: 1000000,
        },
      },
    });
  }
  return adaptiveRiskView(defaultDragonConfig(), state);
}

test("动态面板展示三层系数、采集时间和原因，阶段标签不替代预算", () => {
  const view = fixture(),
    $ = load(renderAdaptiveRisk(view));
  assert.match($.text(), /市场系数|板块感知|个股感知/);
  assert.match($.text(), /工程默认值|指标覆盖|1 分钟/);
  assert.match($.text(), /连续确认|当前操作上限|权限上限/);
  assert.equal($("script").length, 0);
  assert.equal($("svg[role=img]").length, 1);
  assert.match($.text(), /600001/);
  assert.match($.text(), /预热不触发强制卖出/);
});

test("无会话展示等待状态，草稿与实际并排且只读", () => {
  assert.match(renderAdaptiveRisk(null), /等待今日动态会话/);
  const view = fixture();
  const $ = load(
    renderAdaptiveComparison({
      mode: "live",
      actual: view,
      effective: { ...view.effective, entryRisk: 0.001 },
      note: "只读 <script>",
    }),
  );
  assert.equal($("script").length, 0);
  assert.match($.text(), /实际执行|草稿预览|同一份感知依据/);
  assert.equal($("tbody tr").length, 3);
  assert.equal(renderAdaptiveComparison({ mode: "stress" }), "");
});

test("当前状态预览默认可见，手动四态收在压力情境，表单标识唯一", async () => {
  const $ = load(
    await readFile(
      new URL("../../frontend/index.html", import.meta.url),
      "utf8",
    ),
  );
  assert.equal($("#dragon-preview-button").length, 1);
  assert.equal($("#dragon-preview-button").closest("details").length, 0);
  assert.equal(
    $("#dragon-stress-preview-button").closest("details.dragon-stress-preview")
      .length,
    1,
  );
  assert.equal($("#dragon-preview-phase").length, 1);
  assert.equal($("#dragon-dynamic-state[aria-live=polite]").length, 1);
});
