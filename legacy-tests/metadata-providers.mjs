import test from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import {
  buildLixingerSwRecords,
  fetchLixingerShenwanMetadata,
  metadataHttp,
} from "../backend/services/metadata-providers.js";
import {
  parseSwsClassifications,
  SWS_CLASSIFICATION_URL,
} from "../backend/services/sws-classification.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { StockMetadataRepository } from "../backend/storage/stock-metadata.js";
import { runDataUpdateJob } from "../backend/services/data-updates.js";
import { DataUpdateCancelled } from "../backend/domain/stock-metadata.js";

function fixture({ conflict = false, parentOnly = false } = {}) {
  const industries = [
    ["280000", "汽车", "one"],
    ["280200", "汽车零部件", "two"],
    ["280202", "车身附件及饰件", "three"],
    ["280205", "其他汽车零部件", "three"],
  ].map(([stockCode, name, level]) => ({
    stockCode,
    name,
    level,
    source: "sw_2021",
  }));
  const stock = { stockCode: "301680", stockName: { cmn_hans_cn: "固德电材" } };
  const parents = [stock, ...(parentOnly ? [{ stockCode: "002525" }] : [])];
  const memberships = [
    { stockCode: "280000", constituents: parents },
    { stockCode: "280200", constituents: parents },
    { stockCode: "280202", constituents: conflict ? [stock] : [] },
    { stockCode: "280205", constituents: [stock] },
    // Historical industries are not the current SW2021 catalog.
    { stockCode: "999999", constituents: [{ stockCode: "000001" }] },
  ];
  return { industries, memberships };
}
function workbook(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["股票代码", "计入日期", "行业代码", "更新日期"],
      ...rows,
    ]),
    "Sheet1",
  );
  return XLSX.write(book, { type: "buffer", bookType: "biff8" });
}
const history = () =>
  workbook([
    ["301680", "2026-03-05 11:31:00", "280205", "2026-04-27 14:53:00"],
    ["002525", "2010-01-08 00:00:00", "340303", "2015-10-27 15:29:00"],
  ]);

test("Lixinger bulk update uses two POST bodies, all three levels and no per-industry crawl", async () => {
  const { industries, memberships } = fixture();
  const calls = [],
    progress = [];
  const request = metadataHttp({
    intervalMs: 0,
    retries: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return Response.json({
        code: 1,
        data: calls.length === 1 ? industries : memberships,
      });
    },
  });
  const rows = await fetchLixingerShenwanMetadata({
    token: "test-only-credential",
    date: "2026-10-24",
    request,
    progress: async (_, value) => progress.push(value),
  });
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    ["/api/cn/industry", "/api/cn/industry/constituents/sw_2021"],
  );
  for (const call of calls) {
    assert.equal(call.method, "POST");
    assert.equal(call.headers["Content-Type"], "application/json");
    assert.equal(new URL(call.url).search, "");
    assert.equal(JSON.parse(call.body).token, "test-only-credential");
  }
  assert.equal(JSON.parse(calls[0].body).source, "sw_2021");
  assert.equal(JSON.parse(calls[1].body).date, "2026-10-24");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].swL1, "汽车");
  assert.equal(rows[0].swL2, "汽车零部件");
  assert.equal(rows[0].swL3, "其他汽车零部件");
  assert.equal(progress.at(-1).completed, 2);
});

test("missing credentials and rejected provider payloads stay explicit without exposing credential details", async () => {
  let calls = 0;
  await assert.rejects(
    fetchLixingerShenwanMetadata({ request: async () => calls++ }),
    /未配置理杏仁接口凭证/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    fetchLixingerShenwanMetadata({
      token: "test-only-credential",
      request: async () => {
        calls++;
        return { code: 0, message: "test-only-credential was rejected" };
      },
    }),
    (e) =>
      /未返回有效申万数据/.test(e.message) && !e.message.includes("test-only"),
  );
  assert.equal(calls, 1);
});

test("bulk validation rejects missing groups, duplicate codes, partial L3 coverage and parent disagreements", () => {
  const { industries, memberships } = fixture();
  assert.throws(
    () =>
      buildLixingerSwRecords(
        industries,
        memberships.filter((r) => r.stockCode !== "280205"),
      ),
    /名单不完整/,
  );
  const duplicate = structuredClone(memberships);
  duplicate
    .find((r) => r.stockCode === "280205")
    .constituents.push(
      duplicate.find((r) => r.stockCode === "280205").constituents[0],
    );
  assert.throws(() => buildLixingerSwRecords(industries, duplicate), /重复/);
  const partial = structuredClone(memberships);
  partial.find((r) => r.stockCode === "280205").constituents = [];
  const official = parseSwsClassifications(history(), { date: "2026-10-24" });
  assert.throws(
    () =>
      buildLixingerSwRecords(industries, partial, { resolutions: official }),
    /完整性核验/,
  );
  const badParent = structuredClone(memberships);
  badParent.find((r) => r.stockCode === "280200").constituents = [];
  assert.throws(
    () => buildLixingerSwRecords(industries, badParent),
    /父级与三级归属不一致/,
  );
});

test("multiple memberships need a matching official assignment and persist the rejected candidate provenance", () => {
  const { industries, memberships } = fixture({ conflict: true });
  assert.throws(
    () => buildLixingerSwRecords(industries, memberships),
    (e) => e.details.conflicts.length === 1,
  );
  const official = parseSwsClassifications(history(), { date: "2026-10-24" });
  const rows = buildLixingerSwRecords(industries, memberships, {
    resolutions: official,
  });
  assert.equal(rows[0].swCode, "280205");
  assert.equal(rows[0].swVerification.sourceUrl, SWS_CLASSIFICATION_URL);
  assert.match(rows[0].swVerification.documentSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(rows[0].swVerification.rejectedIndustryCodes, ["280202"]);
  assert.throws(
    () =>
      buildLixingerSwRecords(industries, memberships, {
        resolutions: new Map([["301680", { swCode: "123456" }]]),
      }),
    /完整性核验/,
  );
});

test("one official bulk file resolves conflicts and confirms historical parent-only rows; requests finish at 3/3", async () => {
  const { industries, memberships } = fixture({
    conflict: true,
    parentOnly: true,
  });
  const calls = [],
    progress = [];
  const rows = await fetchLixingerShenwanMetadata({
    token: "fixture",
    date: "2026-10-24",
    request: async (url, _, format) => {
      calls.push({ url, format });
      return calls.length === 1
        ? { code: 1, data: industries }
        : calls.length === 2
          ? { code: 1, data: memberships }
          : history();
    },
    progress: async (_, value) => progress.push(value),
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], { url: SWS_CLASSIFICATION_URL, format: "bytes" });
  assert.deepEqual(
    rows.map((r) => r.code),
    ["301680"],
  );
  assert.equal(rows[0].swCode, "280205");
  assert.equal(progress.at(-1).completed, 3);
  assert.equal(progress.at(-1).total, 3);
});

test("official history chooses the latest effective date, ignores future changes and late edits of old classifications", () => {
  const bytes = workbook([
    ["601112", "2026-01-23 16:30:00", "610202", "2026-04-27 14:53:00"],
    ["601112", "2026-01-09 16:32:00", "220901", "2026-10-23 15:00:00"],
    ["601112", "2026-10-25 00:00:00", "220901", "2026-10-24 15:00:00"],
    [1, 46023, 280205, 46023],
  ]);
  const rows = parseSwsClassifications(bytes, { date: "2026-10-24" });
  assert.equal(rows.get("601112").swCode, "610202");
  assert.equal(rows.get("601112").effectiveAt, "2026-01-23 16:30:00");
  assert.equal(rows.get("000001").swCode, "280205");
  assert.equal(
    parseSwsClassifications(bytes, {
      date: "2026-01-10",
      codes: ["601112"],
    }).get("601112").swCode,
    "220901",
  );
});

test("invalid official workbooks and ambiguous latest effective assignments fail instead of choosing by row order", () => {
  assert.throws(
    () =>
      parseSwsClassifications(Buffer.from("<html>429</html>"), {
        date: "2026-10-24",
      }),
    /格式异常/,
  );
  const oldTie = [
    ["301680", "2026-01-01", "280202", "2026-01-01"],
    ["301680", "2026-01-01", "280205", "2026-01-02"],
  ];
  assert.throws(
    () => parseSwsClassifications(workbook(oldTie), { date: "2026-10-24" }),
    /冲突/,
  );
  assert.equal(
    parseSwsClassifications(
      workbook([...oldTie, ["301680", "2026-03-05", "280205", "2026-03-05"]]),
      { date: "2026-10-24" },
    ).get("301680").swCode,
    "280205",
  );
});

test("official verification failure retains the previously published SW snapshot; successful evidence survives SQLite storage", async (t) => {
  const DB = localDatabase();
  t.after(() => DB.close());
  const env = { DB },
    repo = new StockMetadataRepository(env),
    owner = "fixture-worker";
  await repo.claimWorker(owner);
  const { industries, memberships } = fixture({ conflict: true });
  const verified = buildLixingerSwRecords(industries, memberships, {
    resolutions: parseSwsClassifications(history(), { date: "2026-10-24" }),
  });
  await repo.createJob("industry_sw");
  const first = await repo.claimJob(owner);
  const old = await repo.publish("industry_sw", verified, {
    jobId: first.id,
    owner,
    source: "lixinger-sw2021",
  });
  await repo.finish(first.id, owner, "SUCCEEDED", { industry_sw: old });
  assert.equal(old.verifiedConflicts, 1);
  assert.equal(
    (await repo.snapshot("industry_sw")).records[0].swVerification.swCode,
    "280205",
  );
  await repo.createJob("industry_sw");
  const job = await repo.claimJob(owner);
  let count = 0;
  const result = await runDataUpdateJob(env, job, owner, {
    providers: {
      industry_sw: (options) =>
        fetchLixingerShenwanMetadata({
          ...options,
          token: "fixture",
          date: "2026-10-24",
          request: async () => {
            if (++count === 3) throw new Error("申万官方服务中断，保留旧版");
            return { code: 1, data: count === 1 ? industries : memberships };
          },
        }),
    },
  });
  assert.equal(count, 3);
  assert.equal(result.status, "FAILED");
  assert.match(result.error, /申万官方服务中断/);
  assert.equal((await repo.snapshot("industry_sw")).id, old.snapshotId);
});

test("cancellation after the official response still prevents returning a publishable dataset", async () => {
  const { industries, memberships } = fixture({ conflict: true });
  let cancelled = false,
    calls = 0;
  await assert.rejects(
    fetchLixingerShenwanMetadata({
      token: "fixture",
      date: "2026-10-24",
      check: async () => {
        if (cancelled) throw new DataUpdateCancelled();
      },
      request: async () => {
        calls++;
        if (calls === 3) {
          cancelled = true;
          return history();
        }
        return { code: 1, data: calls === 1 ? industries : memberships };
      },
    }),
    DataUpdateCancelled,
  );
  assert.equal(calls, 3);
});
