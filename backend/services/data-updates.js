import { StockMetadataRepository } from "../storage/stock-metadata.js";
import {
  DataUpdateCancelled,
  DataUpdateError,
  METADATA_KINDS,
} from "../domain/stock-metadata.js";
import { safeError } from "../http.js";
export async function runDataUpdateJob(
  env,
  job,
  owner,
  { providers, signal } = {},
) {
  const repo = new StockMetadataRepository(env),
    kinds = job.scope === "all" ? METADATA_KINDS : [job.scope];
  let results = { ...job.results };
  const checkSignal = () => {
    if (signal?.aborted)
      throw signal.reason instanceof DataUpdateCancelled
        ? signal.reason
        : new DataUpdateError("更新执行器中断；未完成的数据未发布", 503);
  };
  const check = async () => {
    checkSignal();
    await repo.checkJob(job.id, owner);
  };
  try {
    for (const kind of kinds) {
      await check();
      try {
        await repo.progress(
          job.id,
          owner,
          kind === "stock_list"
            ? "准备股票名册（交易所优先，新浪备用）"
            : kind === "stock_em"
              ? "准备东财行业"
              : "准备申万行业",
          { kind, completed: 0, total: null },
        );
        const output = await providers[kind]({
          check,
          progress: (stage, progress) =>
            repo.progress(job.id, owner, stage, progress),
        });
        const records = Array.isArray(output) ? output : output.records;
        await check();
        await repo.progress(job.id, owner, "校验并发布快照", {
          kind,
          completed: records.length,
          total: records.length,
        });
        results[kind] = await repo.publish(kind, records, {
          jobId: job.id,
          owner,
          source:
            output.source ??
            providers[kind].source ??
            (kind === "stock_list"
              ? "exchanges-sina"
              : kind === "stock_em"
                ? "eastmoney-clist-f100"
                : "legulegu-sw2021"),
          warnings: output.warnings ?? [],
        });
      } catch (error) {
        checkSignal();
        if (error instanceof DataUpdateCancelled) throw error;
        const hasPrevious = !!(await repo.snapshot(kind));
        results[kind] = {
          status: "FAILED",
          error: safeError(error).replace(
            /保留旧版|旧版未替换|保留上一份有效快照/g,
            hasPrevious ? "保留旧版" : "尚未初始化，本次未发布数据",
          ),
        };
      }
    }
    await check();
    const succeeded = Object.values(results).filter(
      (r) => r.status === "SUCCEEDED",
    ).length;
    return repo.finish(
      job.id,
      owner,
      succeeded === kinds.length
        ? "SUCCEEDED"
        : succeeded
          ? "PARTIAL"
          : "FAILED",
      results,
      Object.values(results)
        .filter((r) => r.error)
        .map((r) => r.error)
        .join("；") || null,
    );
  } catch (error) {
    results = { ...results, ...((await repo.job(job.id))?.results ?? {}) };
    return repo.finish(
      job.id,
      owner,
      error instanceof DataUpdateCancelled ? "CANCELLED" : "FAILED",
      results,
      safeError(error),
    );
  }
}
