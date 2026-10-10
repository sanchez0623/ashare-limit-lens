import { localDatabase } from "../scripts/local-db.mjs";
import {
  createHistoryImport,
  runHistoryImport,
} from "../backend/services/history.js";

const args = process.argv.slice(2);
const readArg = (key) => {
  const index = args.indexOf(`--${key}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const kind = readArg("kind");
const start = readArg("start");
const end = readArg("end");
const name = readArg("name");
const provider = readArg("provider") ?? "tencent-free";
const codesArg = readArg("codes");
const codes = codesArg
  ? codesArg
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean)
  : undefined;
if (!kind || !start || !end) {
  console.error(
    "用法：node scripts/history-import.mjs --kind LIMIT_FEATURES|DAILY|MINUTES --start YYYY-MM-DD --end YYYY-MM-DD [--codes 600001,600002] [--provider tencent-free] [--name 名称]",
  );
  console.error(
    "注意：LIMIT_FEATURES 依赖涨停池可用日期（能力探测会先验证）；DAILY/MINUTES 必须提供 --codes；大范围导入建议在收盘后运行。",
  );
  process.exit(1);
}
try {
  process.loadEnvFile();
} catch {}
const dbPath = process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite";
const DB = localDatabase(dbPath);
const env = {
  DB,
  AI_API_KEY: process.env.AI_API_KEY,
  AI_BASE_URL: process.env.AI_BASE_URL,
  AI_MODEL: process.env.AI_MODEL,
  LOCAL_RESEARCH_DB_PATH:
    process.env.LOCAL_RESEARCH_DB_PATH ||
    ".sites-runtime/research-history.sqlite",
};
const job = await createHistoryImport(env, {
  provider,
  kind,
  start,
  end,
  name,
  codes,
});
console.log(`任务已登记：${job.id}（${kind}，${start}..${end}）`);
const result = await runHistoryImport(env, job.id);
console.log(
  JSON.stringify(
    {
      id: result.id,
      stage: result.stage,
      executionModel: result.statusPayload?.executionModel,
      coverage: result.statusPayload?.coverage,
    },
    null,
    2,
  ),
);
DB.close();
