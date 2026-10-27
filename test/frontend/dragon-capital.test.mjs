import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { load } from "cheerio";
import { renderDragonSettings } from "../../frontend/dragon-risk.js";
import {
  defaultDragonConfig,
  DRAGON_T_CAPITAL_POLICY,
} from "../../shared/dragon-risk-config.js";
import { newBook } from "../../backend/domain/trading.js";

test("优化入口填入方案但不自动保存；保存提交完整配置，草稿预览显示100%峰值", async (t) => {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        value: "",
        checked: false,
        hidden: false,
        disabled: false,
        dataset: {},
        innerHTML: "",
        textContent: "",
        addEventListener() {},
        querySelectorAll() {
          return [];
        },
        closest() {
          return { hidden: false, querySelectorAll: () => [] };
        },
      });
    return nodes.get(id);
  };
  const previous = globalThis.document;
  globalThis.document = { getElementById: get };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const config = defaultDragonConfig();
  Object.assign(config.risk, {
    entryRisk: 0.03,
    portfolioRisk: 0.2,
    stockWeight: 0.2,
    sectorWeight: 0.4,
    grossWeight: 0.7,
    dailyLoss: 0.03,
    drawdown: 0.12,
  });
  const calls = [];
  let pending;
  const data = {
    book: { ...newBook(), tradingPolicyVersion: "dragon-risk-v1" },
    dragon: {
      config,
      state: "ACTIVE",
      message: "运行中",
      ready: true,
      synthetic: { passed: true },
    },
    realtime: {
      session: {
        dragonExecution: {
          config,
          phase: "rising",
          tCapitalPolicy: DRAGON_T_CAPITAL_POLICY,
        },
      },
    },
  };
  const request = async (url, payload) => {
    calls.push({ url, payload });
    return url.endsWith("preview")
      ? {
          mode: "live",
          effective: {
            entryRisk: 0.03,
            portfolioRisk: 0.05,
            grossWeight: 0.7,
            stockWeight: 0.2,
            sectorWeight: 0.4,
            open: true,
            profitAdd: true,
            lossAdd: true,
            tForward: true,
            tReverse: true,
          },
        }
      : { dragon: { message: "已保存" } };
  };
  const perform = (fn) => (pending = fn());
  renderDragonSettings(data, { request, perform });
  assert.match(get("dragon-advanced-controls").innerHTML, /max="50"/);
  get("dragon-capital-preset").onclick();
  assert.equal(calls.length, 0);
  assert.equal(get("dragon-risk-portfolioRisk").value, 5);
  assert.equal(get("dragon-risk-grossWeight").value, 70);
  assert.equal(get("dragon-advanced-tFraction").value, 50);
  assert.equal(config.risk.portfolioRisk, 0.2);
  assert.match(get("dragon-save-note").textContent, /保存后/);
  get("dragon-config-form").onsubmit({ preventDefault() {} });
  await pending;
  assert.equal(calls[0].url, "/api/paper/settings");
  const submitted = calls[0].payload.dragonConfig;
  assert.equal(submitted.risk.portfolioRisk, 0.05);
  assert.equal(submitted.risk.grossWeight, 0.7);
  assert.equal(submitted.advanced.tFraction, 0.5);
  assert.equal(submitted.risk.entryRisk, 0.03);
  assert.deepEqual(submitted.operations, config.operations);
  get("dragon-preview-button").onclick();
  await pending;
  assert.match(get("dragon-preview").innerHTML, /T 峰值上限<strong>100%/);
  assert.match(get("dragon-preview").innerHTML, /T 旧仓比例<strong>50%/);
});

test("方案按钮和额度解释在设置中可见且标识唯一", async () => {
  const $ = load(
    await readFile(
      new URL("../../frontend/index.html", import.meta.url),
      "utf8",
    ),
  );
  assert.equal($("#dragon-capital-preset").length, 1);
  assert.equal($("#dragon-capital-preset").attr("type"), "button");
  assert.equal($("#dragon-t-capital-note").length, 1);
});
