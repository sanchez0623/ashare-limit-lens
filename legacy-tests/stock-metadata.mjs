import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import {
  StockMetadataRepository,
  metadataStatus,
} from "../backend/storage/stock-metadata.js";
import { runDataUpdateJob } from "../backend/services/data-updates.js";
import {
  fetchEastmoneyMetadata,
  fetchShenwanMetadata,
  parseSwTree,
  parseSwMembers,
  metadataHttp,
} from "../backend/services/metadata-providers.js";
import {
  DataUpdateCancelled,
  validateMetadataRecords,
  EM_SCORING_TAXONOMY,
} from "../backend/domain/stock-metadata.js";
import {
  enrichWithIndustry,
  loadIndustryMapping,
  researchIndustryMetadata,
} from "../backend/services/industry.js";
import {
  researchIndustryGroups,
  researchIndustryName,
} from "../shared/industry-research.js";
import { reviewContextDigest } from "../backend/domain/review-metrics.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import { marketForDisplay } from "../backend/services/market-display.js";
import { api } from "../backend/routes/api.js";
import { initializeDataManagement } from "../frontend/data-management.js";

const em = [
  { code: "601857", name: "中国石油", emIndustry: "炼化及贸易" },
  { code: "000001", name: "平安银行", emIndustry: "银行" },
];
const sw = [
  {
    code: "601857",
    swL1: "石油石化",
    swL2: "炼化及贸易",
    swL3: "炼化及贸易",
    swCode: "851111.SI",
  },
  {
    code: "000001",
    swL1: "银行",
    swL2: "股份制银行",
    swL3: "股份制银行",
    swCode: "852111.SI",
  },
];
const tree = `<div id="level1Items"><i class="lg-industries-item-chinese-title">801010.SI</i><b class="lg-industries-item-number">一级(2)</b></div><div id="level2Items"><i class="lg-industries-item-chinese-title">801011.SI</i><b class="lg-industries-item-number">二级(2)[一级]</b></div><div id="level3Items"><i class="lg-industries-item-chinese-title">850111.SI</i><b class="lg-industries-item-number">三级(2)[二级]</b></div>`;
const members =
  "<table><thead><tr><th>序号</th><th>股票代码</th><th>股票简称</th></tr></thead><tbody><tr><td>1</td><td>000001.SZ</td><td>样例一</td></tr><tr><td>2</td><td>688001.SH</td><td>范围外</td></tr></tbody></table>";
function setup(t) {
  const DB = localDatabase(),
    env = { DB, DATA_UPDATE_RUNNER: "local" },
    repo = new StockMetadataRepository(env),
    owner = "test-worker";
  t.after(() => DB.close());
  return { DB, env, repo, owner };
}
async function publish(repo, owner, kind, records) {
  await repo.claimWorker(owner);
  await repo.createJob(kind);
  const job = await repo.claimJob(owner);
  const result = await repo.publish(kind, records, {
    jobId: job.id,
    owner,
    source: "fixture",
  });
  await repo.finish(job.id, owner, "SUCCEEDED", { [kind]: result });
  return result;
}

test("stock registry appends new codes, updates names and industries, retains absent identities without delisting", async (t) => {
  const { repo, owner, env } = setup(t);
  const first = await publish(repo, owner, "stock_em", em);
  const second = await publish(repo, owner, "stock_em", [
    { ...em[0], name: "新名称", emIndustry: "更新行业" },
    { code: "300001", name: "新增股票", emIndustry: null },
  ]);
  assert.notEqual(first.snapshotId, second.snapshotId);
  assert.equal(second.added, 1);
  assert.equal(second.nameChanges, 1);
  assert.equal(second.industryChanges, 1);
  const snapshot = await repo.snapshot("stock_em");
  assert.equal(snapshot.records.length, 3);
  assert.equal(snapshot.byCode.get("000001").presentInSource, false);
  assert.equal(snapshot.byCode.get("300001").emIndustry, null);
  const mapping = await loadIndustryMapping(env);
  assert.equal(mapping.get("601857").industryName, "更新行业");
  const status = await metadataStatus(env);
  assert.equal(status.stockEm.sourceCount, 2);
  assert.equal(status.missingEm.count, 1);
});

test("empty and conflicting metadata never replace the current version", async (t) => {
  const { repo, owner } = setup(t);
  const old = await publish(repo, owner, "stock_em", em);
  await repo.createJob("stock_em");
  const job = await repo.claimJob(owner);
  await assert.rejects(
    repo.publish("stock_em", [], { jobId: job.id, owner, source: "broken" }),
    /数据为空/,
  );
  assert.equal((await repo.snapshot("stock_em")).id, old.snapshotId);
  assert.throws(
    () =>
      validateMetadataRecords("industry_sw", [
        sw[0],
        { ...sw[0], swL1: "冲突" },
      ]),
    /冲突/,
  );
});

test("native Eastmoney sectors are preserved, only EM missing values use the same-source snapshot", () => {
  const input = [
    { c: "601857", hybk: "炼化及贸易" },
    { c: "000001", hybk: "-" },
    { c: "300001", hybk: null },
  ];
  const original = structuredClone(input);
  const rows = enrichWithIndustry(
    input,
    new Map([
      ["601857", { industryName: "错误行业" }],
      ["000001", { industryName: "银行", metadataSnapshotId: "em-version" }],
    ]),
  );
  assert.equal(rows[0].hybk, "炼化及贸易");
  assert.deepEqual(rows[0], original[0]);
  assert.equal(rows[1].hybk, "银行");
  assert.equal(rows[2].hybk, null);
  assert.equal(rows[1]._industrySnapshotId, "em-version");
  assert.deepEqual(input, original);
});

test("EM pagination validates totals, duplicate codes, truncated pages and empty sectors", async () => {
  const page = (rows, total = 2) => ({ rc: 0, data: { total, diff: rows } });
  const one = { f12: "000001", f13: 0, f14: "平安银行", f100: "银行" },
    two = { f12: "601857", f13: 1, f14: "中国石油", f100: "炼化及贸易" };
  let calls = 0;
  const records = await fetchEastmoneyMetadata({
    pageSize: 1,
    request: async () => page([calls++ ? two : one]),
  });
  assert.equal(records.length, 2);
  assert.equal(records[0].code, "000001");
  await assert.rejects(
    fetchEastmoneyMetadata({ request: async () => page([one]) }),
    /重复/,
  );
  calls = 0;
  await assert.rejects(
    fetchEastmoneyMetadata({ request: async () => page(calls++ ? [] : [one]) }),
    /提前结束/,
  );
  calls = 0;
  await assert.rejects(
    fetchEastmoneyMetadata({
      request: async () => page([calls++ ? two : one], calls === 1 ? 2 : 3),
    }),
    /总数.*变化/,
  );
  await assert.rejects(
    fetchEastmoneyMetadata({
      request: async () => page([{ ...one, f100: "-" }], 1),
    }),
    /全部为空/,
  );
});

test("SW parser preserves leading zeroes, parent levels and rejects missing pages instead of partial publication", async () => {
  const leaves = parseSwTree(tree);
  assert.equal(leaves[0].swL1, "一级");
  assert.equal(leaves[0].swL2, "二级");
  const rows = parseSwMembers(members, leaves[0]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, "000001");
  const received = await fetchShenwanMetadata({
    request: async (url) => (url.includes("overview") ? tree : members),
  });
  assert.deepEqual(received[0].swL3, "三级");
  assert.throws(() => parseSwTree("<html>验证页面</html>"), /格式变化/);
  assert.throws(
    () => parseSwMembers("<html>限流</html>", leaves[0]),
    /格式变化/,
  );
  assert.throws(
    () => parseSwMembers(members, { ...leaves[0], expected: 3 }),
    /数量不完整/,
  );
  await assert.rejects(
    fetchShenwanMetadata({
      request: async (url) => {
        if (url.includes("overview")) return tree;
        throw new Error("断连");
      },
    }),
    /断连/,
  );
});

test("HTTP failures are bounded, sanitized and never bypass cancellation", async () => {
  let calls = 0;
  const request = metadataHttp({
    intervalMs: 0,
    retries: 1,
    retryBaseMs: 1,
    fetchImpl: async () => {
      calls++;
      throw new Error("sensitive-provider-url");
    },
  });
  await assert.rejects(
    request("https://example.test", "东财"),
    (error) =>
      /已尝试 2 次/.test(error.message) && !error.message.includes("sensitive"),
  );
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    metadataHttp({
      intervalMs: 0,
      fetchImpl: async () => {
        calls++;
        return new Response("", { status: 403 });
      },
    })("https://example.test", "东财"),
    /403/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    metadataHttp({
      intervalMs: 0,
      retries: 1,
      rateLimitMs: 1,
      fetchImpl: async () => {
        calls++;
        return new Response("", { status: 429 });
      },
    })("https://example.test", "东财"),
    /HTTP 429/,
  );
  assert.equal(calls, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    metadataHttp({ signal: controller.signal })("https://example.test", "东财"),
    DataUpdateCancelled,
  );
});

function requestClock() {
  let time = Date.parse("2026-10-24T03:00:00Z");
  const sleeps = [];
  return {
    sleeps,
    now: () => time,
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

test("429 respects numeric and dated Retry-After, reports the pause and preserves the host cooldown across jobs", async () => {
  for (const retryAfter of ["90", "Sat, 24 Oct 2026 03:01:30 GMT"]) {
    const clock = requestClock(),
      started = clock.now(),
      starts = [],
      notices = [];
    const request = metadataHttp({
      ...clock,
      onRetry: async (event) => notices.push(event),
      fetchImpl: async () => {
        starts.push(clock.now());
        return starts.length === 1
          ? new Response("", {
              status: 429,
              headers: { "Retry-After": retryAfter },
            })
          : Response.json({ ok: true });
      },
    });
    assert.deepEqual(await request("https://example.test/member", "申万"), {
      ok: true,
    });
    assert.equal(starts[1] - started, 90000);
    assert.equal(notices.length, 1);
    assert.equal(Date.parse(notices[0].retryAt) - started, 90000);
    assert.match(notices[0].reason, /限流.*HTTP 429/);
  }
  const clock = requestClock(),
    states = new Map(),
    started = clock.now();
  await assert.rejects(
    metadataHttp({
      ...clock,
      states,
      retries: 0,
      fetchImpl: async () => new Response("", { status: 429 }),
    })("https://example.test/member", "申万"),
    /HTTP 429/,
  );
  let resumedAt;
  await metadataHttp({
    ...clock,
    states,
    fetchImpl: async () => {
      resumedAt = clock.now();
      return Response.json({ ok: true });
    },
  })("https://example.test/member", "申万");
  assert.equal(resumedAt - started, 60000);
});

test("a long server cooldown ends with a bounded failure; cancellation interrupts a retry wait immediately", async () => {
  const clock = requestClock();
  let calls = 0;
  await assert.rejects(
    metadataHttp({
      ...clock,
      fetchImpl: async () => {
        calls++;
        return new Response("", {
          status: 429,
          headers: { "Retry-After": "900" },
        });
      },
    })("https://example.test/member", "申万"),
    /HTTP 429/,
  );
  assert.equal(calls, 1);
  assert.equal(clock.sleeps.length, 0);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(
    metadataHttp({
      signal: controller.signal,
      onRetry: async () => controller.abort(),
      fetchImpl: async () => {
        calls++;
        return new Response("", { status: 429 });
      },
    })("https://example.test/member", "申万"),
    DataUpdateCancelled,
  );
  assert.equal(calls, 1);
});

test("transport errors, timeouts, DNS and malformed JSON are distinguishable without exposing upstream error text", async () => {
  const failures = [
    [
      new TypeError("secret-url", { cause: { code: "UND_ERR_SOCKET" } }),
      /连接中断.*UND_ERR_SOCKET/,
    ],
    [new DOMException("secret-url", "TimeoutError"), /请求超时/],
    [
      new TypeError("secret-url", { cause: { code: "ENOTFOUND" } }),
      /域名解析失败/,
    ],
    [new SyntaxError("secret-url"), /不是有效 JSON/],
  ];
  for (const [failure, expected] of failures) {
    await assert.rejects(
      metadataHttp({
        retries: 0,
        fetchImpl: async () => {
          throw failure;
        },
      })("https://example.test/list", "东财"),
      (error) =>
        expected.test(error.message) && !error.message.includes("secret"),
    );
  }
});

test("EM transport fallback restarts pagination from page one; HTTP 429 and incomplete data do not switch endpoints", async () => {
  const urls = [],
    one = { f12: "000001", f13: 0, f14: "平安银行", f100: "银行" },
    two = { f12: "601857", f13: 1, f14: "中国石油", f100: "炼化及贸易" },
    page = (row) => Response.json({ rc: 0, data: { total: 2, diff: [row] } });
  const rows = await fetchEastmoneyMetadata({
    pageSize: 1,
    request: metadataHttp({
      intervalMs: 0,
      retries: 0,
      fetchImpl: async (url) => {
        const u = new URL(url);
        urls.push([u.host, u.searchParams.get("pn")]);
        if (u.host.startsWith("push2delay")) {
          if (u.searchParams.get("pn") === "1")
            return page({ ...one, f14: "未完成旧批次" });
          throw new TypeError("fetch failed", {
            cause: { code: "UND_ERR_SOCKET" },
          });
        }
        return page(u.searchParams.get("pn") === "1" ? one : two);
      },
    }),
  });
  assert.equal(rows[0].name, "平安银行");
  assert.deepEqual(urls, [
    ["push2delay.eastmoney.com", "1"],
    ["push2delay.eastmoney.com", "2"],
    ["push2.eastmoney.com", "1"],
    ["push2.eastmoney.com", "2"],
  ]);
  let calls = 0;
  await assert.rejects(
    fetchEastmoneyMetadata({
      request: metadataHttp({
        retries: 0,
        fetchImpl: async () => {
          calls++;
          return new Response("", { status: 429 });
        },
      }),
    }),
    /HTTP 429/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    fetchEastmoneyMetadata({
      request: async () => {
        calls++;
        return { rc: 0, data: { total: 0, diff: [] } };
      },
    }),
    /名单为空/,
  );
  assert.equal(calls, 1);
});

test("SW requests are serial and zero-member industries do not trigger unnecessary member calls", async () => {
  const withEmptyLeaf = tree.replace(
    '<b class="lg-industries-item-number">三级(2)[二级]</b>',
    '<b class="lg-industries-item-number">三级(2)[二级]</b><i class="lg-industries-item-chinese-title">850112.SI</i><b class="lg-industries-item-number">另一个行业(2)[二级]</b><i class="lg-industries-item-chinese-title">850113.SI</i><b class="lg-industries-item-number">空行业(0)[二级]</b>',
  );
  let active = 0,
    maxActive = 0,
    memberCalls = 0;
  const rows = await fetchShenwanMetadata({
    request: async (url) => {
      if (url.includes("overview")) return withEmptyLeaf;
      active++;
      maxActive = Math.max(maxActive, active);
      memberCalls++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return url.includes("850112")
        ? members.replace("000001", "300001")
        : members;
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(memberCalls, 2);
  assert.equal(maxActive, 1);
});

test("EM socket disconnection during an update preserves the published snapshot", async (t) => {
  const { repo, owner, env } = setup(t);
  const previous = await publish(repo, owner, "stock_em", em);
  await repo.createJob("stock_em");
  const job = await repo.claimJob(owner);
  const request = metadataHttp({
    intervalMs: 0,
    retries: 0,
    fetchImpl: async () => {
      throw new TypeError("fetch failed", {
        cause: { code: "UND_ERR_SOCKET", message: "other side closed" },
      });
    },
  });
  const result = await runDataUpdateJob(env, job, owner, {
    providers: { stock_em: () => fetchEastmoneyMetadata({ request }) },
  });
  assert.equal(result.status, "FAILED");
  assert.match(result.results.stock_em.error, /连接中断/);
  assert.equal((await repo.snapshot("stock_em")).id, previous.snapshotId);
});

test("one active job: duplicate scope is reused, another scope is rejected; queued cancellation frees the slot", async (t) => {
  const { repo } = setup(t);
  const created = await repo.createJob("stock_em"),
    repeat = await repo.createJob("stock_em");
  assert.equal(created.job.id, repeat.job.id);
  assert.equal(repeat.reused, true);
  await assert.rejects(
    repo.createJob("industry_sw"),
    (e) => e.status === 409 && e.details.activeJob.id === created.job.id,
  );
  assert.equal((await repo.cancel(created.job.id)).status, "CANCELLED");
  assert.equal((await repo.createJob("industry_sw")).job.scope, "industry_sw");
});

test("all update publishes independently and reports partial success with the previous SW snapshot retained", async (t) => {
  const { repo, owner, env } = setup(t);
  const previousSw = await publish(repo, owner, "industry_sw", sw);
  await repo.createJob("all");
  const job = await repo.claimJob(owner);
  const result = await runDataUpdateJob(env, job, owner, {
    providers: {
      stock_list: async () => em,
      stock_em: async () => em,
      industry_sw: async () => {
        throw new Error("申万成分连接中断");
      },
    },
  });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.results.stock_em.status, "SUCCEEDED");
  assert.equal(result.results.stock_list.status, "SUCCEEDED");
  assert.equal((await repo.snapshot("industry_sw")).id, previousSw.snapshotId);
  assert.equal((await repo.snapshot("stock_em")).stats.sourceCount, 2);
});

test("cancellation after staging but before publication preserves the old pointer and cleans staged data", async (t) => {
  const { DB, repo, owner } = setup(t);
  const previous = await publish(repo, owner, "stock_em", em);
  await repo.createJob("stock_em");
  const job = await repo.claimJob(owner);
  const transaction = DB.transaction.bind(DB);
  DB.transaction = async (fn) => {
    if (fn.constructor.name === "AsyncFunction") await repo.cancel(job.id);
    return transaction(fn);
  };
  await assert.rejects(
    repo.publish("stock_em", [{ ...em[0], name: "不得发布" }], {
      jobId: job.id,
      owner,
      source: "cancelled",
    }),
    DataUpdateCancelled,
  );
  assert.equal((await repo.snapshot("stock_em")).id, previous.snapshotId);
  assert.equal(
    (
      await DB.prepare(
        "SELECT COUNT(*) AS c FROM metadata_snapshots WHERE state='STAGED'",
      ).first()
    ).c,
    0,
  );
});

test("worker takeover fails interrupted jobs and fences the old publisher", async (t) => {
  const { repo, owner } = setup(t);
  await repo.claimWorker(owner);
  await repo.createJob("all");
  const job = await repo.claimJob(owner);
  assert.equal(await repo.claimWorker("other"), false);
  assert.equal(
    await repo.claimWorker("other", new Date(Date.now() + 40000).toISOString()),
    true,
  );
  await repo.recoverInterrupted("other");
  const recovered = await repo.job(job.id);
  assert.equal(recovered.status, "FAILED");
  assert.match(recovered.error, /中断/);
  await assert.rejects(repo.checkJob(job.id, owner), DataUpdateCancelled);
});

test("research grouping across SW levels never mutates stock scores or includes unmapped stocks as an industry", () => {
  const analysis = {
    stocks: [
      {
        code: "601857",
        sector: "东财A",
        score: 88,
        height: 2,
        breaks: 0,
        first: 93000,
        amount: 100,
      },
      {
        code: "000001",
        sector: "东财B",
        score: 77,
        height: 1,
        breaks: 1,
        first: 100000,
        amount: 50,
      },
      { code: "300001", sector: "东财C", score: 66, height: 1, breaks: 0 },
    ],
    sectors: [{ name: "原板块", score: 99 }],
  };
  const original = structuredClone(analysis),
    metadata = { byCode: Object.fromEntries(sw.map((r) => [r.code, r])) };
  for (const taxonomy of ["SW1", "SW2", "SW3"]) {
    const result = researchIndustryGroups(analysis, taxonomy, metadata);
    assert.equal(result.covered, 2);
    assert.equal(result.uncovered, 1);
    assert.equal(result.groups.length, 2);
    assert.equal(
      result.groups.flatMap((g) => g.members).includes("300001"),
      false,
    );
  }
  assert.equal(
    researchIndustryName(analysis.stocks[0], "SW1", metadata),
    "石油石化",
  );
  assert.deepEqual(researchIndustryGroups(analysis).groups, analysis.sectors);
  assert.deepEqual(analysis, original);
});

test("historical display uses current SW metadata without rewriting frozen names, scores or the archived payload", async (t) => {
  const { DB, repo, owner, env } = setup(t);
  await publish(repo, owner, "industry_sw", sw);
  const frozen = {
    date: "2026-01-05",
    stocks: [
      { code: "601857", name: "原名称", sector: "原快照行业", score: 93 },
    ],
    sectors: [{ name: "原快照行业", score: 81 }],
    marketSummary: { count: 1, promotion: 0.5 },
  };
  const text = JSON.stringify(frozen);
  await DB.prepare(
    "INSERT INTO snapshots(trade_date,created_at,payload) VALUES (?,?,?)",
  )
    .bind(frozen.date, "2026-01-05T08:00:00Z", text)
    .run();
  const result = await marketForDisplay(env, frozen.date, {
    today: "2026-02-05",
    loadMarket: async () => {
      throw new Error("不得追取");
    },
  });
  assert.equal(result.analysis.stocks[0].score, 93);
  assert.equal(result.analysis.stocks[0].name, "原名称");
  assert.equal(result.industryMetadata.byCode["601857"].swL1, "石油石化");
  assert.equal(
    result.industryMetadata.basis,
    "CURRENT_CLASSIFICATION_EXPLORATION_ONLY",
  );
  assert.equal(
    (
      await DB.prepare("SELECT payload FROM snapshots WHERE trade_date=?")
        .bind(frozen.date)
        .first()
    ).payload,
    text,
  );
});

test("old scoring-context digests remain identical; daily metadata versions do not create new scoring epochs", async () => {
  const old = { modelVersion: "rules-v1", weights: [1, 2, 3] };
  assert.equal(
    await reviewContextDigest(old),
    await digestOf({
      scoring: "rules-v1-frozen-pool",
      modelVersion: "rules-v1",
      weights: [1, 2, 3],
      poolDefinition: "EASTMONEY_ZT_POOL_FROZEN",
      topDefinition: "FROZEN_ORDER_TOP_20PCT",
      sectorRule: "FROZEN_PRIMARY_SECTOR",
      returnMeasure: "PREVIOUS_CLOSE_TO_CLOSE_DECIMAL",
    }),
  );
  const context = {
    ...old,
    industryContext: {
      scoringTaxonomy: EM_SCORING_TAXONOMY,
      stockEmSnapshotId: "one",
    },
  };
  assert.notEqual(
    await reviewContextDigest(context),
    await reviewContextDigest(old),
  );
  assert.equal(
    await reviewContextDigest(context),
    await reviewContextDigest({
      ...context,
      industryContext: { ...context.industryContext, stockEmSnapshotId: "two" },
    }),
  );
});

test("reopening data management refreshes research mappings even when the job finished before the first status read", async (t) => {
  const { repo, owner, env } = setup(t);
  await publish(repo, owner, "stock_em", em);
  const previousGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  const nodes = new Map(),
    events = [];
  globalThis.document = {
    getElementById(id) {
      if (!nodes.has(id))
        nodes.set(id, {
          textContent: "",
          innerHTML: "",
          classList: { toggle() {} },
          addEventListener() {},
          removeAttribute() {},
        });
      return nodes.get(id);
    },
    querySelectorAll() {
      return [];
    },
  };
  globalThis.window = {
    dispatchEvent(event) {
      events.push(event.type);
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(await metadataStatus(env)), {
      headers: { "Content-Type": "application/json" },
    });
  t.after(() => {
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const view = initializeDataManagement();
  await view.refresh();
  assert.deepEqual(events, ["metadata-updated"]);
  await view.refresh();
  assert.equal(events.length, 1);
  await publish(repo, owner, "industry_sw", sw);
  await view.refresh();
  assert.equal(events.length, 2);
  assert.equal(nodes.get("data-sw-coverage").textContent, "100.0%");
  await publish(repo, owner, "stock_list", [
    { code: "601857", name: "名册更新名称", registrySource: "sse" },
    { code: "300001", name: "新股", registrySource: "sina" },
    { code: "300002", name: "另一新股", registrySource: "sina" },
  ]);
  await view.refresh();
  assert.equal(events.length, 3);
  assert.equal(nodes.get("data-stock-count").textContent, "3");
  assert.match(nodes.get("data-stock-source").textContent, /上交所 1 只/);
  assert.match(nodes.get("data-stock-source").textContent, /新浪 2 只/);
  assert.equal(nodes.get("data-em-coverage").textContent, "33.3%");
  assert.equal(nodes.get("data-sw-coverage").textContent, "33.3%");
});

test("executor shutdown is recorded as interruption, not an explicit user cancellation", async (t) => {
  const { repo, owner, env } = setup(t);
  await repo.claimWorker(owner);
  await repo.createJob("stock_em");
  const job = await repo.claimJob(owner),
    controller = new AbortController();
  const result = await runDataUpdateJob(env, job, owner, {
    signal: controller.signal,
    providers: {
      stock_em: async () => {
        controller.abort(new Error("shutdown"));
        throw new DataUpdateCancelled();
      },
    },
  });
  assert.equal(result.status, "FAILED");
  assert.match(result.error, /执行器中断/);
  assert.equal(await repo.snapshot("stock_em"), null);
});

test("data management shows source readiness, retry countdown and one copy of each failure", async (t) => {
  const previous = Object.fromEntries(
    ["document", "window", "fetch"].map((k) => [k, globalThis[k]]),
  );
  const nodes = new Map();
  const buttons = ["stock_em", "industry_sw", "all"].map((scope) => ({
    dataset: { updateScope: scope },
    addEventListener() {},
  }));
  globalThis.document = {
    getElementById(id) {
      if (!nodes.has(id))
        nodes.set(id, {
          textContent: "",
          innerHTML: "",
          classList: { toggle() {} },
          addEventListener() {},
          removeAttribute() {},
        });
      return nodes.get(id);
    },
    querySelectorAll() {
      return buttons;
    },
  };
  globalThis.window = { dispatchEvent() {} };
  let state = {
    workerHealthy: true,
    jobs: [],
    swProvider: {
      ready: false,
      description: "理杏仁批量 API",
      reason: "请配置理杏仁凭证",
    },
  };
  globalThis.fetch = async () => Response.json(state);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const view = initializeDataManagement();
  await view.refresh();
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, true);
  assert.equal(buttons[2].disabled, true);
  assert.match(nodes.get("data-sw-source").textContent, /请配置理杏仁凭证/);
  state = {
    ...state,
    swProvider: { ...state.swProvider, ready: true, reason: null },
    activeJob: {
      scope: "industry_sw",
      status: "RUNNING",
      stage: "等待后重试",
      createdAt: new Date().toISOString(),
      progress: {
        completed: 1,
        total: 2,
        retryAt: new Date(Date.now() + 60000).toISOString(),
      },
    },
  };
  await view.refresh();
  assert.match(nodes.get("data-job-detail").textContent, /1 \/ 2.*秒后重试/);
  assert.equal(buttons[0].disabled, true);
  const failure = "东财连接中断（远端关闭连接），保留旧版";
  state = {
    ...state,
    activeJob: null,
    jobs: [
      {
        scope: "stock_em",
        status: "FAILED",
        createdAt: new Date().toISOString(),
        results: { stock_em: { status: "FAILED", error: failure } },
        error: failure,
      },
    ],
  };
  await view.refresh();
  assert.equal(
    nodes.get("data-job-rows").innerHTML.split("远端关闭连接").length - 1,
    1,
  );
  assert.equal(buttons[1].disabled, false);
});

test("data endpoints enforce capabilities, method/origin checks and return recoverable persistent jobs", async (t) => {
  const { env, repo, owner } = setup(t);
  const post = (body, headers = {}) =>
    new Request("http://local/api/data/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await api(post({ scope: "all" }), { DB: env.DB })).status, 503);
  await repo.claimWorker(owner);
  assert.equal((await api(post({ scope: "bad" }), env)).status, 400);
  assert.equal(
    (await api(post({ scope: "all" }, { Origin: "http://evil" }), env)).status,
    403,
  );
  const created = await api(post({ scope: "all" }), env);
  assert.equal(created.status, 202);
  const { job } = await created.json();
  const again = await api(post({ scope: "all" }), env);
  assert.equal((await again.json()).job.id, job.id);
  await repo.releaseWorker(owner);
  const duringRestart = await api(post({ scope: "all" }), env);
  assert.equal((await duringRestart.json()).job.id, job.id);
  const busy = await api(post({ scope: "stock_em" }), env);
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).activeJob.id, job.id);
  assert.equal(
    (
      await api(
        new Request(`http://local/api/data/jobs/${job.id}`, { method: "POST" }),
        env,
      )
    ).status,
    405,
  );
  const status = await (
    await api(new Request("http://local/api/data/status"), env)
  ).json();
  assert.equal(status.activeJob.id, job.id);
  const cancelled = await api(
    new Request(`http://local/api/data/jobs/${job.id}/cancel`, {
      method: "POST",
    }),
    env,
  );
  assert.equal((await cancelled.json()).job.status, "CANCELLED");
  assert.equal(
    (await api(new Request("http://local/api/data/jobs/does-not-exist"), env))
      .status,
    404,
  );
});
