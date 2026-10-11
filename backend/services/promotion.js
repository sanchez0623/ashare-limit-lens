import { RealtimeRepository } from "../storage/realtime.js";
import { CohortRepository } from "../storage/cohorts.js";
import {
  digestOf,
  EXECUTION_VERSION,
  SCORING_VERSION,
} from "../domain/research-lineage.js";
import { feesForBook } from "../../shared/fees.js";

// 统一晋级入口（§8.3）：全部自动、人工和旧 API 启用入口共用。
// 验证报告摘要、成员资格、当前父策略与配置指纹后，以主账户 revision CAS
// 更新未来策略引用；当前计划已冻结时从之后第一个尚未冻结的计划起生效。
// 主账户现金、持仓、累计费用、历史峰值和旧计划不被影子账户覆盖；
// 冠军较少的持仓上限只限制新增，已有多余持仓按新计划逐步退出。

export async function promoteCohortChampion(
  env,
  cohortId,
  { evaluation = null, effectiveTradeDate = null, effectiveNote = null } = {},
) {
  const cohorts = new CohortRepository(env);
  const papers = new RealtimeRepository(env);
  const cohort = await cohorts.getCohort(cohortId);
  if (!cohort) throw new Error("赛马批次不存在");
  const report =
    evaluation ?? (await cohorts.report(cohortId, "EVALUATION"))?.payload;
  if (!report?.champion) throw new Error("批次没有通过全部闸门的可启用冠军");
  const member = await cohorts.member(cohortId, report.champion.memberId);
  if (!member || !["ELIGIBLE", "PROMOTED"].includes(member.stage))
    throw new Error("冠军成员不符合启用条件");
  if (member.stage === "PROMOTED")
    return {
      promoted: true,
      duplicate: true,
      versionId: member.strategyVersion,
    };
  const championVersionId = member.strategyVersion;
  if (!championVersionId) throw new Error("冠军成员缺少冻结的策略版本");
  // 环境指纹核验：费用、父策略、执行与评分源码在窗口期内未变化。
  const account = await papers.account();
  const feeConfig = feesForBook(account.book);
  const feeConfigDigest = await digestOf(feeConfig);
  const forwardManifest = cohort.forwardManifest ?? {};
  if (feeConfigDigest !== forwardManifest.feeConfigDigest)
    throw new Error("费用配置在窗口期内变化，本批资格失效");
  if (account.book.activeStrategy !== cohort.parentVersion)
    throw new Error("主账户父策略已变化，本批资格失效");
  if (
    report.executionVersion !== EXECUTION_VERSION ||
    report.scoringVersion !== SCORING_VERSION
  )
    throw new Error("执行或评分源码版本与冻结清单不一致，本批资格失效");
  // 以主账户 revision CAS 更新未来策略引用；不复制影子持仓、不重置风险峰值。
  const revision = account.revision;
  const runId = crypto.randomUUID();
  const nextRevision = revision + 1;
  const book = structuredClone(account.book);
  book.activeStrategy = championVersionId;
  const promotionDigest = report.digest ?? (await digestOf(report));
  const guardArgs = [nextRevision, runId];
  const guarded = (sql, args) =>
    papers.db
      .prepare(
        `${sql} AND EXISTS (SELECT 1 FROM paper_accounts WHERE id = 'primary' AND revision = ? AND last_run_id = ?)`,
      )
      .bind(...args, ...guardArgs);
  const statements = [
    papers.db
      .prepare(
        "UPDATE paper_accounts SET state = ?, revision = revision + 1, last_run_id = ?, updated_at = ? WHERE id = ? AND revision = ?",
      )
      .bind(
        JSON.stringify(book),
        runId,
        new Date().toISOString(),
        "primary",
        revision,
      ),
    guarded(
      "UPDATE strategy_versions SET status = 'RETIRED' WHERE status = 'ACTIVE'",
      [],
    ),
    guarded("UPDATE strategy_versions SET status = 'ACTIVE' WHERE id = ?", [
      championVersionId,
    ]),
    guarded(
      "UPDATE strategy_cohorts SET promotion_digest = ?, effective_trade_date = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      [promotionDigest, effectiveTradeDate, new Date().toISOString(), cohortId],
    ),
  ];
  await papers.db.batch(statements);
  const after = await papers.account();
  if (
    after.revision !== nextRevision ||
    after.book.activeStrategy !== championVersionId
  )
    throw new Error("主账户正在更新，晋级未应用，请重新核验后重试");
  await cohorts
    .transitionMember(cohortId, member.memberId, {
      from: "ELIGIBLE",
      to: "PROMOTED",
    })
    .catch(() => {});
  return {
    promoted: true,
    versionId: championVersionId,
    memberId: member.memberId,
    effectiveTradeDate,
    effectiveNote:
      effectiveNote ??
      "启用只切换未来策略引用；已冻结计划、持仓、风险峰值与旧亏损不被影子结果替换",
  };
}
