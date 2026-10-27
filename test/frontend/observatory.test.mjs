import test from "node:test";
import assert from "node:assert/strict";
import { load } from "cheerio";
import {
  parseRoute,
  routeHash,
  validDate,
  navigationGroup,
  ladderRows,
  marketSculptureSvg,
  marketPrintSvg,
  marketCycleDescription,
} from "../../frontend/observatory-model.js";

test("市场阶段明确区分实时观测与收盘冻结，并说明实际交易权限来源", () => {
  const analysis = {
    cycle: { score: 0.69, reason: "涨停55家，炸板23家，最高4板。" },
  };
  assert.match(
    marketCycleDescription(analysis, {}).caption,
    /实时观测.*69\/100/,
  );
  const frozen = marketCycleDescription(analysis, { archived: true });
  assert.match(frozen.caption, /收盘已冻结/);
  assert.match(frozen.explanation, /涨停55家/);
  assert.match(frozen.explanation, /跨过阈值会变化/);
  assert.match(frozen.explanation, /连续市场、板块、个股观测/);
  assert.match(marketCycleDescription(null, null).caption, /等待/);
});

test("工作区地址支持刷新恢复，中文和组合筛选可以无损往返", () => {
  const route = {
    view: "stocks",
    date: "2026-10-23",
    industryTaxonomy: "SW3",
    query: "海 & 科技",
    sector: "光学光电子",
    theme: "机器人 / 算力",
    height: "3",
    sort: "first",
  };
  const restored = parseRoute(routeHash(route), "2026-10-25");
  for (const [key, value] of Object.entries(route))
    assert.equal(restored[key], value);
  assert.equal(navigationGroup(restored.view), "research");
});

test("每个执行、复盘和研究子页都有独立、可恢复的地址", () => {
  for (const [view, values] of Object.entries({
    paper: ["live", "plan", "ledger", "config"],
    review: ["review", "replay"],
    sectors: ["industry", "theme"],
  }))
    for (const tab of values) {
      const restored = parseRoute(routeHash({ view, tab }));
      assert.equal(restored.view, view);
      assert.equal(restored.tab, tab);
    }
  for (const view of ["overview", "stocks", "data", "alerts", "settings"])
    assert.equal(parseRoute(routeHash({ view })).view, view);
  for (const tab of ["current", "scoring", "history"]) {
    assert.equal(parseRoute(routeHash({ view: "settings", tab })).tab, tab);
  }
});

test("旧页面链接和交易配置锚点继续到达对应功能", () => {
  assert.equal(parseRoute("#overview").view, "overview");
  assert.equal(parseRoute("#stocks").view, "stocks");
  assert.deepEqual(
    [
      parseRoute("#dragon-config-panel").view,
      parseRoute("#dragon-config-panel").tab,
    ],
    ["paper", "config"],
  );
  assert.equal(parseRoute("#paper-entry-plan").tab, "plan");
  assert.equal(parseRoute("#/system/settings").tab, "current");
  assert.equal(parseRoute("#/system/strategies").view, "settings");
  assert.equal(parseRoute("#strategies").tab, "history");
});

test("地址中的非法日期和筛选不会进入研究状态", () => {
  assert.equal(validDate("2024-02-29"), true);
  for (const value of ["2026-02-29", "2026-13-01", "2026-1-01", "bad"])
    assert.equal(validDate(value), false);
  const route = parseRoute(
    "#/research/stocks?date=2026-10-26&height=-1&taxonomy=foo&sort=invalid",
    "2026-10-25",
  );
  assert.equal(route.date, "");
  assert.equal(route.height, "all");
  assert.equal(route.industryTaxonomy, "EM");
  assert.equal(route.sort, "amount");
  assert.equal(
    parseRoute("#/archive/review?date=2026-10-23", "2026-10-26").date,
    "2026-10-26",
  );
  assert.equal(
    parseRoute("#/archive/review?date=2026-10-27", "2026-10-27").date,
    "2026-10-27",
  );
  assert.equal(
    parseRoute("#/research/stocks?date=2026-10-23", "2026-10-26").date,
    "2026-10-23",
  );
});

test("连板结构忽略缺失高度，明确区分零样本与未知", () => {
  const stocks = [
    { height: 1 },
    { height: 3 },
    { height: 3 },
    { height: null },
    { height: 0 },
    { height: 1.5 },
  ];
  assert.deepEqual(ladderRows(stocks), [
    { height: 3, count: 2 },
    { height: 1, count: 1 },
  ]);
  const empty = marketSculptureSvg([]);
  assert.match(empty, /暂无可用连板样本/);
  assert.doesNotMatch(empty, /0 家/);
});

test("交互图形为辅助技术暴露可操作的链接，筛选携带原研究日期", () => {
  const svg = marketSculptureSvg([{ height: 2 }], {
    date: "2026-10-23",
    interactive: true,
  });
  const $ = load(svg, { xmlMode: true });
  assert.equal($("svg").attr("role"), "group");
  assert.equal($("a").attr("aria-label"), "查看2板的1只个股");
  const route = parseRoute($("a").attr("href"));
  assert.equal(route.height, "2");
  assert.equal(route.date, "2026-10-23");
});

const snapshot = {
  date: "2026-10-23",
  archived: true,
  source: "公开行情 & 归档",
  analysis: {
    count: 2,
    sealRate: null,
    emotion: null,
    height: 3,
    stocks: [{ height: 3 }, { height: 1 }],
    sectors: [{ name: '光学 <script>alert("x")</script>' }],
  },
};

test("市场切片只接受真实归档，不把实时行情或演示包装成历史记录", () => {
  assert.equal(marketPrintSvg(null), null);
  assert.equal(marketPrintSvg({ ...snapshot, archived: false }), null);
  assert.equal(marketPrintSvg({ ...snapshot, demo: true }), null);
  assert.equal(marketPrintSvg({ ...snapshot, date: "演示" }), null);
  assert.ok(marketPrintSvg(snapshot));
});

test("切片保持缺失指标，转义来源和标签，不包含账户私有信息", () => {
  const svg = marketPrintSvg({
    ...snapshot,
    book: { cashCents: 87654321 },
    positions: ["private-position"],
  });
  const $ = load(svg, { xmlMode: true });
  assert.equal($("script").length, 0);
  assert.equal($("svg").attr("width"), "1200");
  assert.equal($("svg").attr("height"), "1500");
  assert.match($("svg").text(), /公开行情 & 归档/);
  assert.match($("svg").text(), /—/);
  assert.doesNotMatch(svg, /87654321|private-position/);
});
