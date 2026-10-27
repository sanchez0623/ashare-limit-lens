import { localDatabase } from "./local-db.mjs";
import { runScoringTick } from "../backend/services/observation-scoring.js";
import { maintainEnvironmentTrials } from "../backend/services/market-environment.js";
import { installRuntimeLogTimestamps } from "./runtime-log.mjs";
installRuntimeLogTimestamps();
try {
  process.loadEnvFile();
} catch {}
const DB = localDatabase(
  process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite",
);
let stopping = false,
  wake;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    wake?.();
  });
do {
  let pending = false;
  try {
    const result = await runScoringTick({ DB });
    pending = result.processed === 5;
    if (!pending) await maintainEnvironmentTrials({ DB });
  } catch (error) {
    console.error(`[scoring-worker] ${error.message}`);
  }
  if (process.argv.includes("--once") || stopping) break;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, pending ? 50 : 5000);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
} while (!stopping);
DB.close();
