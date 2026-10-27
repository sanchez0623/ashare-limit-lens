// Isolated synthetic UI verification. Never opens the user's trading database.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { localDatabase } from "./local-db.mjs";
import { api } from "../backend/routes/api.js";
import { PaperRepository } from "../backend/storage/paper.js";
import {
  registerDragonConfig,
  dragonBookFields,
} from "../backend/storage/dragon-risk.js";
import { defaultDragonConfig } from "../shared/dragon-risk-config.js";
import { analyze, normalize, PRESETS } from "../shared/scoring.js";
import { scoreObservation } from "../shared/observation-scoring.js";
import { initialAdaptiveRisk } from "../shared/adaptive-risk.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import { runScoringTick } from "../backend/services/observation-scoring.js";
import { advanceEnvironment } from "../shared/market-environment.js";

const verifyEnvironment = process.argv.includes("--environment");

const DB = localDatabase(),
  env = { DB },
  date = "2026-10-23",
  code = "600003",
  stamp = `${date}T10:00:00+08:00`;
const initial = await new PaperRepository(env).initialize();
const record = await registerDragonConfig(DB, defaultDragonConfig(), null, {
  origin: "MANUAL",
  validationMode: "MANUAL_UNVERIFIED",
});
await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
  .bind(
    JSON.stringify({
      ...initial.book,
      ...dragonBookFields(record),
      improvementMode: "manual",
    }),
  )
  .run();
await runScoringTick(env);
const raw = {
  c: code,
  n: "合成观察样本",
  hybk: "测试行业",
  p: 10900,
  zdp: 9,
  amount: 500000000,
  fund: 50000000,
  hs: 8,
  lbc: 4,
  zbc: 0,
  fbt: 100000,
  lbt: 100000,
};
const analysis = analyze([normalize(raw)], 3, null, PRESETS.balanced);
const market = {
  date,
  archived: true,
  archivedAt: stamp,
  fetchedAt: stamp,
  source: "合成界面验收",
  analysis,
  rows: [raw],
  broken: 3,
};
const environmentMembers = Array.from({ length: 8 }, (_, i) => ({
  code: `60000${i + 1}`,
  height: i < 3 ? 3 : 1,
  closeCents: 1000,
}));
const environment = advanceEnvironment(null, {
  date,
  observedAt: stamp,
  cohort: {
    signalDate: "2026-10-22",
    knownAt: "2026-10-22T07:10:00Z",
    members: environmentMembers,
  },
  market: {
    date,
    observedAt: stamp,
    metrics: { limitUp: 50, broken: 30, height: 5 },
  },
  quotes: Object.fromEntries(
    environmentMembers.map((m) => [
      m.code,
      { date, timestamp: stamp, closeCents: 940, previousCloseCents: 1000 },
    ]),
  ),
  baseline: { strength: 0.8, applied: 0.8, trend: { fiveMinutes: -0.03 } },
});
const environmentReport = {
  note: "合成界面验收数据，非实际交易结果",
  groups: Array.from({ length: 12 }, (_, i) => ({
    buyPoint: "auction-dip",
    dimension: "strength",
    band: ["WEAK", "NORMAL", "STRONG"][i % 3],
    opportunities: 2,
    fillRate: 0,
    cycles: 0,
    entryDates: 0,
    netPnlCents: 0,
    meanNetR: null,
    status: "INSUFFICIENT",
    mode: "FORWARD_OBSERVATION",
    blockingReasons: { CAPACITY: 1 },
  })),
  openCycles: [],
  comparison: null,
};
const layer = (factor) => ({
  valid: true,
  ready: true,
  observedAt: stamp,
  applied: factor,
  raw: factor,
  protectionApplied: factor,
  protectionKnown: true,
  reasons: ["合成连续观测"],
  coverage: 1,
  samples: [],
});
const risk = initialAdaptiveRisk(date);
risk.segment = "AM";
risk.observedAt = stamp;
risk.market = layer(0.8);
risk.market.label = "上升";
risk.sectors["测试行业"] = layer(0.9);
risk.stocks[code] = layer(0.7);
const plan = {
  createdAt: `${date}T09:00:00+08:00`,
  signalDate: "2026-10-22",
  dragonPolicy: { config: defaultDragonConfig() },
  entryExecutionPolicy: {
    firstNegMinPrevHeight: 3,
    history: {
      [code]: {
        name: raw.n,
        sector: "测试行业",
        stockClass: "relay-leader",
        previousHeight: 4,
        previousChange: 10,
        previousCloseCents: 1000,
        previousOpenCents: 1010,
        previousTouchedLimit: true,
        lastFourCloseSumCents: 4000,
      },
    },
  },
};
const quote = {
  code,
  date,
  timestamp: stamp,
  previousCloseCents: 1000,
  openCents: 1000,
  closeCents: 1090,
  limitUpCents: 1100,
  limitDownCents: 900,
};
const profile = scoreObservation({
  code,
  plan,
  session: {
    date,
    sequence: 1,
    adaptiveRisk: risk,
    entryState: {
      paths: {
        [code]: {
          stableQuotes: 5,
          touched: true,
          momentumAt: stamp,
          lastObservedAt: stamp,
        },
      },
      admissions: { [code]: {} },
    },
    practice: { decisions: {} },
  },
  observation: {
    observedAt: stamp,
    quotes: { [code]: quote },
    entryInputs: {
      market: {
        date,
        observedAt: stamp,
        sectors: [{ name: "测试行业", score: 90 }],
      },
    },
  },
});
await DB.prepare(
  "INSERT INTO observation_score_latest(trade_date,code,version,sequence,payload,digest) VALUES(?,?,?,?,?,?)",
)
  .bind(
    date,
    code,
    profile.version,
    1,
    JSON.stringify(profile),
    await digestOf(profile),
  )
  .run();
const manifest = {
  parent: record,
  candidates: [
    {
      id: "synthetic-c1",
      config: {
        ...record.config,
        operations: { ...record.config.operations, lossAdd: false },
      },
      rationale: "合成独立对照",
    },
  ],
};
await DB.prepare(
  "INSERT INTO dragon_pattern_batches(id,stage,manifest,manifest_digest,comparison_end,report,created_at,updated_at) VALUES('synthetic-ui-batch','INCONCLUSIVE',?,?,4,?,?,?)",
)
  .bind(
    JSON.stringify(manifest),
    await digestOf(manifest),
    JSON.stringify({ reason: "合成：真实样本积累中" }),
    stamp,
    stamp,
  )
  .run();

const assets = {
  "/": ["dist/client/index.html", "text/html"],
  "/assets/app.js": ["dist/client/assets/app.js", "text/javascript"],
  "/assets/styles.css": ["dist/client/assets/styles.css", "text/css"],
};
const writes = [],
  errors = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (assets[url.pathname]) {
      res.writeHead(200, { "Content-Type": assets[url.pathname][1] });
      res.end(readFileSync(assets[url.pathname][0]));
      return;
    }
    if (req.method !== "GET") writes.push(url.pathname);
    if (verifyEnvironment && url.pathname === "/api/research/environment") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ...environmentReport,
          groups: environmentReport.groups.map((g) => ({
            ...g,
            buyPoint: url.searchParams.get("buyPoint") || g.buyPoint,
            dimension: url.searchParams.get("dimension") || g.dimension,
          })),
        }),
      );
      return;
    }
    const fixtures = {
      "/api/market": market,
      "/api/market/latest-date": { date },
      "/api/review": {
        review: null,
        ai: null,
        aiStatus: { configured: false },
      },
      "/api/evidence": {},
      "/api/history": { snapshots: [], reviews: [] },
      ...(verifyEnvironment ? { "/api/market/environment": environment } : {}),
    };
    if (fixtures[url.pathname]) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(fixtures[url.pathname]));
      return;
    }
    if (url.pathname === "/api/paper" || url.pathname === "/api/paper/live") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "合成验收不连接实际执行器" }));
      return;
    }
    const response = await api(new Request(url), env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const root = `http://127.0.0.1:${server.address().port}`;
const directory = mkdtempSync(resolve(".sites-runtime/scoring-ui-browser-"));
const browser = spawn(
  process.env.BROWSER_BINARY ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${directory}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
let ws;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  let port;
  for (let i = 0; i < 150; i++) {
    try {
      port = Number(
        readFileSync(`${directory}/DevToolsActivePort`, "utf8").split("\n")[0],
      );
    } catch {}
    if (port) break;
    await pause(100);
  }
  assert.ok(port, "Headless browser did not start");
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
    if (m.method === "Runtime.exceptionThrown")
      errors.push(
        m.params.exceptionDetails.exception?.description ??
          m.params.exceptionDetails.text,
      );
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.exception?.description ?? "Evaluate failed",
      );
    return r.result.value;
  };
  const waitFor = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await pause(100);
    }
    throw new Error(`UI timeout: ${expression}; ${errors.join("; ")}`);
  };
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Page.navigate", { url: `${root}/#/research/stocks?date=${date}` });
  await waitFor(
    'document.querySelector("#stock-rows")?.textContent.includes("合成观察样本")',
  );
  await waitFor(
    'document.querySelector("#stock-rows")?.textContent.includes("30")',
  );
  if (verifyEnvironment) {
    await waitFor(
      'document.querySelector("#summary")?.textContent.includes("市场环境")',
    );
    assert.match(
      await evaluate('document.querySelector("#summary").textContent'),
      /偏强.*恶化/s,
    );
  }
  await evaluate(
    'document.querySelector("#buy-point-filter").value="limit-up-momentum";document.querySelector("#buy-point-filter").dispatchEvent(new Event("change"))',
  );
  assert.equal(
    await evaluate(
      'document.querySelector("#sort option[value=quality]").disabled',
    ),
    false,
  );
  await evaluate('document.querySelector("#stock-rows [data-stock]").click()');
  assert.equal(
    await evaluate(
      'document.querySelectorAll("#stock-detail .score-card").length',
    ),
    6,
  );
  await pause(350);
  await cdp("Page.captureScreenshot", { format: "png" }).then((r) =>
    writeFileSync(
      ".sites-runtime/scoring-ui-cards.png",
      Buffer.from(r.data, "base64"),
    ),
  );
  await evaluate(
    'document.querySelector("#stock-dialog").close();location.hash="/system/settings"',
  );
  await waitFor('document.querySelector("#hub-propose") !== null');
  assert.equal(
    await evaluate('document.querySelector("#hub-propose").disabled'),
    true,
  );
  await evaluate(
    'document.querySelector("[data-group=settings][data-workspace-tab=scoring]").click()',
  );
  await waitFor(
    'document.querySelector("#research-hub-scoring")?.textContent.includes("评分规则与自动校准")',
  );
  if (verifyEnvironment) {
    await waitFor(
      'document.querySelector("#environment-research [data-page-jump-input]")?.max === "2"',
    );
    await evaluate(
      'document.querySelector("#environment-research [data-page-jump-input]").value="2";document.querySelector("#environment-research [data-page-jump]").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))',
    );
    await waitFor(
      'document.querySelector("#environment-research [data-page-jump-input]")?.value === "2"',
    );
    await evaluate(
      'document.querySelector("[data-environment-dimension]").value="fragility";document.querySelector("[data-environment-dimension]").dispatchEvent(new Event("change"))',
    );
    await waitFor(
      'document.querySelector("#environment-research [data-page-jump-input]")?.value === "1"',
    );
    assert.match(
      await evaluate(
        'document.querySelector("#environment-research").textContent',
      ),
      /合成界面验收数据/,
    );
    await evaluate(
      'document.querySelector("#environment-research").scrollIntoView()',
    );
    await cdp("Page.captureScreenshot", { format: "png" }).then((r) =>
      writeFileSync(
        ".sites-runtime/environment-ui-desktop.png",
        Buffer.from(r.data, "base64"),
      ),
    );
  }
  assert.equal(
    await evaluate(
      'document.querySelectorAll("#weight-controls,[data-preset],#strategies-reserve").length',
    ),
    0,
  );
  await cdp("Page.captureScreenshot", { format: "png" }).then((r) =>
    writeFileSync(
      ".sites-runtime/scoring-ui-desktop.png",
      Buffer.from(r.data, "base64"),
    ),
  );
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await pause(150);
  assert.equal(
    await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"),
    true,
    "Mobile document must not overflow",
  );
  await cdp("Page.captureScreenshot", { format: "png" }).then((r) =>
    writeFileSync(
      ".sites-runtime/scoring-ui-mobile.png",
      Buffer.from(r.data, "base64"),
    ),
  );
  await evaluate('location.hash="/system/strategies"');
  await waitFor(
    'document.querySelector("#research-hub-history")?.textContent.includes("synthetic-ui-batch")',
  );
  await evaluate('document.querySelector("[data-record-id]").click()');
  await waitFor(
    'document.querySelector("#research-record-detail")?.textContent.includes("导出原始研究记录")',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  console.log(
    JSON.stringify({
      status: "PASS",
      cards: 6,
      legacyRoutes: true,
      mobile: true,
      unexpectedWrites: 0,
      uncaughtExceptions: 0,
      environment: verifyEnvironment,
    }),
  );
} finally {
  ws?.close();
  browser.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  DB.close();
}
