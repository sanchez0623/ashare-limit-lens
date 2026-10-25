import fs from "node:fs";
import path from "node:path";
import { localDatabase } from "./local-db.mjs";
import {
  createHistoryImport,
  runHistoryImport,
} from "../backend/services/history.js";
import { runBacktest, backtestDetail } from "../backend/services/backtest.js";
import { openHistoryStore } from "../backend/storage/history.js";
import { PaperRepository } from "../backend/storage/paper.js";
import { digestOf } from "../backend/domain/research-lineage.js";
import { BUY_POINT_LABELS } from "../shared/buy-point-type.js";

// This command writes only research jobs/datasets/reports; never primary plans or accounts.
process.loadEnvFile?.(".env");
const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const start = arg("start") ?? "2026-01-01",
  end = arg("end") ?? "2026-10-22";
const env = {
  ...process.env,
  DB: localDatabase(
    process.env.LOCAL_DATABASE_PATH ?? ".sites-runtime/local.sqlite",
  ),
};
const before = await digestOf(await new PaperRepository(env).account());
let job;
if (arg("candidate")) job = null;
else if (arg("resume")) job = { id: arg("resume") };
else
  job = await createHistoryImport(env, {
    kind: "V5_RECONSTRUCTION",
    start,
    end,
    name: `${start}—${end} V5 候选验收`,
  });
console.log(
  JSON.stringify({ phase: "START", jobId: job?.id ?? null, start, end }),
);
const imported = job
  ? await runHistoryImport(env, job.id, {
      onProgress: (p) => console.log(JSON.stringify(p)),
    })
  : { datasetId: arg("candidate"), stage: "EXISTING", id: null };
if (!imported.datasetId || imported.stage === "FAILED")
  throw new Error(JSON.stringify(imported.statusPayload));
console.log(
  JSON.stringify({
    phase: "CANDIDATES",
    stage: imported.stage,
    datasetId: imported.datasetId,
  }),
);
const observation = await createHistoryImport(env, {
  kind: "OBSERVATIONS",
  start,
  end,
  datasetId: imported.datasetId,
  name: "真实归档帧独立复制",
});
const observed = await runHistoryImport(env, observation.id);
console.log(
  JSON.stringify({
    phase: "OBSERVATIONS",
    stage: observed.stage,
    datasetId: observed.datasetId,
  }),
);
if (!observed.datasetId || observed.stage === "FAILED")
  throw new Error(JSON.stringify(observed.statusPayload));
const run = await runBacktest(env, {
  datasetId: observed.datasetId,
  executionModel: "ARCHIVED_OBSERVATIONS_V1",
  name: `${start}—${end} 六类严格回放验收`,
});
const detail = await backtestDetail(env, run.id),
  store = openHistoryStore(env),
  dataset = await store.getDataset(imported.datasetId);
const after = await digestOf(await new PaperRepository(env).account());
if (before !== after)
  throw new Error("主账户在执行期间发生变化，请核对外部运行进程");
const report = {
  generatedAt: new Date().toISOString(),
  requestedRange: { start, end },
  candidateJob: imported.id,
  candidateDataset: imported.datasetId,
  observationJob: observed.id,
  observationDataset: observed.datasetId,
  runId: run.id,
  stage: run.stage,
  totalReturn: run.coverage.totalReturn,
  primaryUnchanged: true,
  verification: detail.verification,
  dataAcceptance: dataset.coverage,
  execution: run.coverage,
  minuteDiagnostics: {
    inspectedAt: new Date().toISOString(),
    fileCount: fs.existsSync(path.join(env.QUAN_DATA_DIR, "minute5"))
      ? fs
          .readdirSync(path.join(env.QUAN_DATA_DIR, "minute5"))
          .filter((n) => n.endsWith(".parquet")).length
      : 0,
    coverageStatus: "INVENTORY_ONLY_NOT_DAILY_VERIFIED",
    usedForExecution: false,
    note: "仅文件清单诊断，不证明逐日覆盖，也不替代十秒路径及盘口",
  },
};
let out = path.resolve(
  arg("out") ?? `.sites-runtime/v5-history-${start}-${end}`,
);
if (fs.existsSync(path.join(out, "report.json"))) out = path.join(out, run.id);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(out, "report.json"),
  JSON.stringify(report, null, 2),
);
const quote = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
const daily = new Map(
  dataset.coverage.candidateCoverage.map((d) => [d.date, d]),
);
const csv = [
  [
    "执行日",
    "信号日",
    "候选状态",
    "涨停候选",
    "炸板候选",
    "EOD候选",
    "帧数",
    "严格状态",
    ...Object.values(BUY_POINT_LABELS),
    "缺失股票",
    "缺失字段",
  ],
  ...run.coverage.days.map((d) => {
    const c = daily.get(d.signalDate);
    return [
      d.date,
      d.signalDate,
      c?.status,
      c?.counts.stocks,
      c?.counts.brokenStocks,
      c?.counts.extraStocks,
      d.frameCount,
      d.status,
      ...Object.keys(BUY_POINT_LABELS).map((t) => d.buyPoints[t]),
      [
        ...new Set([
          ...d.codes,
          ...d.gaps.filter((g) => g.code).map((g) => g.code),
        ]),
      ].join(" "),
      [...new Set(d.gaps.map((g) => `${g.code ?? "全日"}:${g.field}`))].join(
        " | ",
      ),
    ];
  }),
]
  .map((r) => r.map(quote).join(","))
  .join("\r\n");
fs.writeFileSync(path.join(out, "daily-gaps.csv"), "\ufeff" + csv);
const pools = dataset.coverage.candidateCoverage;
const md = [
  `# ${start} 至 ${end} V5 历史验收`,
  ``,
  `生成时间：${report.generatedAt}`,
  ``,
  `结果：**${run.stage}**。收益：${run.coverage.totalReturn === null ? "不发布（证据不足）" : run.coverage.totalReturn}。`,
  ``,
  `- 执行交易日：${run.coverage.days.length}`,
  `- 三类候选日：${pools.length}；完整 ${pools.filter((d) => d.status === "COMPLETE").length} 日，部分 ${pools.filter((d) => d.status !== "COMPLETE").length} 日`,
  `- 真实帧总数：${run.coverage.days.reduce((n, d) => n + d.frameCount, 0)}`,
  `- 阻断日期：${run.coverage.days.filter((d) => d.status !== "VERIFIABLE").length}`,
  `- 涨停候选累计：${pools.reduce((n, d) => n + d.counts.stocks, 0)}；炸板 ${pools.reduce((n, d) => n + d.counts.brokenStocks, 0)}；EOD ${pools.reduce((n, d) => n + d.counts.extraStocks, 0)}`,
  `- 主账户未改变：是；原始资料和重构时间均独立归档`,
  `- 结果校验：${detail.verification.verified ? "通过" : detail.verification.issues.join("；")}`,
  `- 备用历史日线仍无法补齐：${dataset.coverage.historicalDailySupplement?.failed?.length ?? 0} 个代码（详细原因见 JSON）`,
  `- 五分钟文件：${report.minuteDiagnostics.fileCount} 个，仅清单诊断，未用于严格执行`,
  ``,
  `完整逐日、逐股字段缺口见 [daily-gaps.csv](./daily-gaps.csv)，原始验收结果见 [report.json](./report.json)。`,
  ``,
  `当前历史池缺少部分六因子字段，名称、行业、退市状态缺少完整时点证据。竞价机会不是完整终态。五分钟线不补造十秒路径，历史研究不能替代主账户真实影子验证。`,
  ``,
  `候选数据集：\`${imported.datasetId}\`；归档帧数据集：\`${observed.datasetId}\`；回放：\`${run.id}\`。`,
].join("\n");
fs.writeFileSync(path.join(out, "README.md"), md);
store.db?.close();
console.log(
  JSON.stringify({
    phase: "DONE",
    stage: run.stage,
    runId: run.id,
    output: out,
    verification: detail.verification.verified,
  }),
);
