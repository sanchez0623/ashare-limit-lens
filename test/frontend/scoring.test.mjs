import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { load } from "cheerio";
import {
  scoringCards,
  scoringCells,
  calibrationView,
} from "../../frontend/scoring-view.js";
import { parseRoute, routeHash } from "../../frontend/observatory-model.js";
import { scoreObservation } from "../../shared/observation-scoring.js";
import { defaultDragonConfig } from "../../shared/dragon-risk-config.js";

test("研究三子页和旧地址兼容；只有明确同类买点才能按质量排序", () => {
  for (const tab of ["current", "scoring", "history"])
    assert.equal(parseRoute(routeHash({ view: "settings", tab })).tab, tab);
  assert.equal(parseRoute("#/system/strategies").tab, "history");
  assert.equal(parseRoute("#/system/settings").tab, "current");
  assert.equal(parseRoute("#/research/stocks?sort=quality").sort, "amount");
  assert.equal(
    parseRoute("#/research/stocks?sort=quality&buyPoint=bad").sort,
    "amount",
  );
  const route = { view: "stocks", sort: "quality", buyPoint: "late-dip" };
  assert.equal(parseRoute(routeHash(route)).sort, "quality");
  assert.equal(parseRoute(routeHash(route)).buyPoint, "late-dip");
});

test("日常设置移除旧调权和赛马创建，保留可访问的新入口", async () => {
  const $ = load(
    await readFile(
      new URL("../../frontend/index.html", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    $(".system-menu [data-view=settings]").text().trim(),
    "研究与验证",
  );
  assert.equal($(".system-menu [data-view=strategies]").length, 0);
  assert.equal(
    $("#weight-controls,#reset-model,[data-preset],#strategies-reserve").length,
    0,
  );
  assert.equal(
    $("#research-hub-current,#research-hub-scoring,#research-hub-history")
      .length,
    3,
  );
  assert.equal($("#sort option").first().val(), "amount");
  assert.equal($("#sort option[value=quality]").is(":disabled"), true);
  assert.equal($("#buy-point-filter option").length, 7);
});

test("未知评分保持未知、六卡展开证据并转义外部文本", () => {
  assert.match(scoringCells(null, "late-dip", "relay-leader"), /身份 100/);
  assert.match(scoringCells(null, "late-dip", "relay-leader"), /未观测/);
  const profile = scoreObservation({
    code: "600003",
    plan: {
      createdAt: "2026-10-23T17:00:00+08:00",
      dragonPolicy: { config: defaultDragonConfig() },
      entryExecutionPolicy: {
        history: { 600003: { stockClass: "relay-leader", sector: "<script>" } },
      },
    },
  });
  const html = scoringCards(profile),
    $ = load(html);
  assert.equal($(".score-card").length, 6);
  assert.equal($("script").length, 0);
  assert.match(html, /待盘中确认/);
  assert.match(html, /覆盖 25%/);
  assert.match(calibrationView({ groups: [], note: "<img src=x>" }), /&lt;img/);
});

test("冻结身份未知时不借用当前市场分类补分", () => {
  const html = scoringCells(
    {
      stockClass: null,
      identity: null,
      cards: [],
      risk: { value: null, level: "未知" },
    },
    "late-dip",
    "relay-leader",
  );
  assert.match(html, /未分类/);
  assert.doesNotMatch(html, /身份 100/);
});
