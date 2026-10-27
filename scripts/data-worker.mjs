import { localDatabase } from "./local-db.mjs";
import { StockMetadataRepository } from "../backend/storage/stock-metadata.js";
import { runDataUpdateJob } from "../backend/services/data-updates.js";
import { fetchStockRegistryMetadata } from "../backend/services/stock-list-providers.js";
import { fetchEastmoneyIndustryUpdate } from "../backend/services/eastmoney-industry-providers.js";
import {
  metadataHttp,
  fetchShenwanMetadata,
  fetchLixingerShenwanMetadata,
} from "../backend/services/metadata-providers.js";
import {
  DataUpdateCancelled,
  DataUpdateError,
} from "../backend/domain/stock-metadata.js";
import { installRuntimeLogTimestamps } from "./runtime-log.mjs";
installRuntimeLogTimestamps();
try {
  process.loadEnvFile();
} catch {}
const DB = localDatabase(
  process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite",
);
const env = { DB },
  repo = new StockMetadataRepository(env),
  owner = `metadata-${crypto.randomUUID()}`,
  requestStates = new Map();
let stopping = false,
  controller = null,
  timer = null,
  heartbeat = null;
const stop = () => {
  stopping = true;
  controller?.abort(new Error("更新执行器中断"));
  if (timer) {
    clearTimeout(timer.id);
    timer.resolve();
  }
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("disconnect", stop);
const pause = (ms) =>
  new Promise((resolve) => {
    timer = {
      resolve,
      id: setTimeout(() => {
        timer = null;
        resolve();
      }, ms),
    };
  });
let heartbeatWork = Promise.resolve();
try {
  while (!stopping && !(await repo.claimWorker(owner))) await pause(1000);
  if (!stopping) {
    await repo.recoverInterrupted(owner);
    console.log(`[data-worker] 执行器已就绪（pid=${process.pid}）`);
    heartbeat = setInterval(() => {
      heartbeatWork = heartbeatWork
        .then(async () => {
          if (!(await repo.heartbeat(owner))) return stop();
          const active = await repo.activeJob();
          if (active?.workerId === owner && active.cancelRequested)
            controller?.abort(new DataUpdateCancelled());
        })
        .catch((error) => {
          console.error("[data-worker] 心跳失败：", error.message);
          process.exitCode = 1;
          stop();
        });
    }, 3000);
    while (!stopping) {
      const job = await repo.claimJob(owner);
      if (!job) {
        await pause(1000);
        continue;
      }
      controller = new AbortController();
      const signal = controller.signal,
        check = () => repo.checkJob(job.id, owner),
        requestOptions = {
          signal,
          check,
          states: requestStates,
          onRetry: async ({ reason, attempt, maxRetries, retryAt }) => {
            const current = await repo.job(job.id);
            await repo.progress(
              job.id,
              owner,
              `${reason}，等待后重试（${attempt}/${maxRetries}）`,
              {
                ...current.progress,
                retryAt,
                retryAttempt: attempt,
                maxRetries,
              },
            );
          },
        },
        request = metadataHttp(requestOptions),
        registryRequest = metadataHttp({
          ...requestOptions,
          timeoutMs: 8000,
          retries: 1,
        });
      console.log(`[data-worker] 开始 ${job.id} (${job.scope})`);
      const swSource = process.env.SW_METADATA_SOURCE || "lixinger";
      const swProvider = (options) => {
        if (swSource === "legulegu")
          return fetchShenwanMetadata({ ...options, request });
        if (swSource === "lixinger")
          return fetchLixingerShenwanMetadata({
            ...options,
            request,
            token: process.env.LIXINGER_TOKEN,
          });
        throw new DataUpdateError(
          "SW_METADATA_SOURCE 必须为 lixinger 或 legulegu",
        );
      };
      swProvider.source = `${swSource}-sw2021`;
      const result = await runDataUpdateJob(env, job, owner, {
        signal,
        providers: {
          stock_list: (options) =>
            fetchStockRegistryMetadata({
              ...options,
              request: registryRequest,
            }),
          stock_em: async (options) => {
            const registry = await repo.snapshot("stock_list");
            return fetchEastmoneyIndustryUpdate({
              ...options,
              request,
              stocks: registry?.records.filter(
                (row) => row.presentInSource !== false,
              ),
            });
          },
          industry_sw: swProvider,
        },
      });
      console.log(
        `[data-worker] ${job.id} ${result?.status ?? "执行权已转移"}`,
      );
      controller = null;
    }
  }
} catch (error) {
  console.error("[data-worker] 执行器异常：", error.message);
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  try {
    await heartbeatWork;
    await repo.releaseWorker(owner);
  } catch (error) {
    console.error("[data-worker] 退出清理失败：", error.message);
    process.exitCode = 1;
  }
  try {
    DB.close();
  } catch (error) {
    console.error("[data-worker] 数据库关闭失败：", error.message);
    process.exitCode = 1;
  }
  // An open supervisor IPC channel keeps Node alive after an error. Closing it
  // lets the parent observe exit and perform its existing delayed restart.
  if (process.connected) process.disconnect();
}
