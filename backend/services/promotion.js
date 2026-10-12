import { RealtimeRepository } from "../storage/realtime.js";
import { CohortRepository } from "../storage/cohorts.js";
import { ShadowAccountRepository } from "../storage/shadow.js";
import { digest } from "../storage/paper.js";
import { latestPolicyBundle } from "../storage/execution-cost.js";
import {
  digestOf,
  EXECUTION_VERSION,
  SCORING_VERSION,
} from "../domain/research-lineage.js";
import { feesForBook } from "../../shared/fees.js";
import {
  selectionPolicyMatches,
  selectionPolicyDigest,
  frozenSelectionPolicy,
} from "../domain/signal-selection.js";
import { portfolioSelectionMatches } from "./portfolio-runner.js";

// 统一晋级入口（§8.3）：全部自动、人工和旧 API 启用入口共用。
// 验证报告摘要、成员资格、当前父策略和配置指纹后，以主账户 revision CAS
// 更新未来策略引用；当前计划已冻结时从之后第一个尚未冻结的计划起生效。
// 主账户现金、持仓、累计费用、历史峰值和旧计划不被影子账户覆盖；
// 冠军较少的持仓上限只限制新增，已有多余持仓按新计划逐步退出。

const REPORT_UNTRUSTED = "没有通过全部闸门的报告不能启用";

export async function promoteCohortChampion(
  env,
  cohortId,
  { evaluation = null, effectiveTradeDate = null, effectiveNote = null } = {},
) {
  const cohorts = new CohortRepository(env);
  const papers = new RealtimeRepository(env);
  const shadows = new ShadowAccountRepository(env);
  const cohort = await cohorts.getCohort(cohortId);
  if (!cohort) throw new Error("赛马批次不存在");
  const report =
    evaluation ?? (await cohorts.report(cohortId, "EVALUATION"))?.payload;
  if (!report?.champion) throw new Error("批次没有通过全部闸门的可启用冠军");
  // 统一晋级入口拒绝诊断证据报告（statistical-evidence.md §7.2 批次 C）：
  // 包括人工与 API 重试；滚动诊断固定无启用资格，正式启用只读取
  // 固定终点前瞻评估报告。
  if (report.purpose === "DIAGNOSTIC")
    throw new Error("诊断证据报告没有启用资格；正式启用只读取冻结前瞻评估报告");
  if (report.eligibleForPromotion === true && report.purpose)
    throw new Error("报告携带的用途与启用资格不一致，拒绝晋级");
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
  // 报告完整性（§8.3）：重算报告摘要，防篡改的报告输入才可晋级。
  const { digest: reportDigest, ...digestSource } = report;
  if (!reportDigest || (await digestOf(digestSource)) !== reportDigest)
    throw new Error(`晋级报告摘要缺失或不匹配；${REPORT_UNTRUSTED}`);
  const forwardManifest = cohort.forwardManifest ?? {};
  // 净值摘要（§6/§8.2）：捕获期初快照清单完整且未被篡改。
  if (!forwardManifest.initialAccountsDigest)
    throw new Error(`捕获清单缺少期初净值摘要；${REPORT_UNTRUSTED}`);
  const initialAccountsDigest = await digestOf(
    forwardManifest.initialAccounts ?? {},
  );
  if (initialAccountsDigest !== forwardManifest.initialAccountsDigest)
    throw new Error(`期初净值摘要与捕获清单不一致；${REPORT_UNTRUSTED}`);
  // 共同日期占用与完整登记（§8.2）：报告窗口必须覆盖要求的共同市场日数，
  // 且每个窗口日都由主账户结算（dataset 落库）、登记在批次名下（claim）、
  // 并计入批次 tradingDates（claim、样本用途与窗口推进全部落库的完整日
  // 登记）。重试入口对三项独立重验，不信任报告自带的覆盖结论——旧版
  // 报告只按 claim 校验，claim 成功但完整登记失败的日子不构成晋级证据。
  const windowDates = report.windowDates ?? [];
  const tradingDates = Array.isArray(forwardManifest.tradingDates)
    ? forwardManifest.tradingDates
    : [];
  const requiredDays =
    forwardManifest.requiredDays ?? report.requiredDays ?? windowDates.length;
  if (windowDates.length < requiredDays)
    throw new Error(
      `报告窗口仅覆盖 ${windowDates.length}/${requiredDays} 个共同市场日；${REPORT_UNTRUSTED}`,
    );
  for (const date of windowDates) {
    const datasetRow = await papers.db
      .prepare("SELECT payload FROM paper_market_days WHERE trade_date = ?")
      .bind(date)
      .first();
    if (!datasetRow)
      throw new Error(
        `共同市场日 ${date} 缺少主账户结算数据；${REPORT_UNTRUSTED}`,
      );
    const claim = await papers.db
      .prepare(
        "SELECT owner_type, owner_id FROM research_test_claims WHERE namespace = 'main' AND outcome_date = ?",
      )
      .bind(date)
      .first();
    if (!claim || claim.owner_type !== "COHORT" || claim.owner_id !== cohortId)
      throw new Error(
        `共同市场日 ${date} 缺少批次占用登记；${REPORT_UNTRUSTED}`,
      );
    if (!tradingDates.includes(date))
      throw new Error(
        `共同市场日 ${date} 未完整登记（缺少样本用途或窗口推进）；${REPORT_UNTRUSTED}`,
      );
  }
  // 冠军期末净值（§8.2）：报告中的期末权益必须与影子账本窗口末日一致。
  const championAccountId =
    forwardManifest.accounts?.candidates?.find(
      (accountId) => accountId === `shadow-${member.experimentId}`,
    ) ?? `shadow-${member.experimentId}`;
  const championShadow = await shadows.account(championAccountId);
  if (!championShadow) throw new Error(`冠军影子账户缺失；${REPORT_UNTRUSTED}`);
  // 日净值摘要（§8.2）：冠军与两个共同对照的窗口净值行都必须与存储摘要
  // 一致——共同对照是统计与收益闸门的比较基准，其净值被篡改同样会
  // 伪造晋级证据（payload 改动而 digest 未同步在此暴露）。
  const evidenceAccountIds = [
    championAccountId,
    forwardManifest.accounts?.parentMatch,
    forwardManifest.accounts?.baselineMatch,
  ].filter(Boolean);
  for (const accountId of evidenceAccountIds) {
    if (!(await shadows.account(accountId)))
      throw new Error(`评估影子账户 ${accountId} 缺失；${REPORT_UNTRUSTED}`);
    for (const row of await shadows.equities(accountId)) {
      if (!windowDates.includes(row.tradeDate)) continue;
      const { tradeDate, digest: storedDigest, ...payload } = row;
      // 摘要缺失同样不放行：无法核验完整性的净值行不构成晋级证据。
      if (!storedDigest)
        throw new Error(
          `窗口净值行 ${accountId}/${tradeDate} 缺少摘要；${REPORT_UNTRUSTED}`,
        );
      if ((await digest(payload)) !== storedDigest)
        throw new Error(
          `窗口净值行 ${accountId}/${tradeDate} 摘要与内容不一致；${REPORT_UNTRUSTED}`,
        );
      // 盘中观测价盯市不是收盘数据：对照证据不完整使批次无资格。
      if (payload.complete === false)
        throw new Error(
          `窗口净值行 ${accountId}/${tradeDate} 按盘中观测价盯市，收盘数据缺失；${REPORT_UNTRUSTED}`,
        );
    }
  }
  const championEquities = await shadows.equities(championAccountId);
  const windowEndEquity = championEquities
    .filter((row) => windowDates.includes(row.tradeDate ?? row.trade_date))
    .at(-1);
  if (
    !windowEndEquity ||
    windowEndEquity.equityCents !== report.champion.finalEquityCents
  )
    throw new Error(`冠军期末净值与影子账本不一致；${REPORT_UNTRUSTED}`);
  // 环境指纹核验：费用、父策略、执行与评分源码在窗口期内未变化。
  const account = await papers.account();
  if (
    !selectionPolicyMatches(forwardManifest, account.book) ||
    selectionPolicyDigest(frozenSelectionPolicy(report)) !==
      selectionPolicyDigest(frozenSelectionPolicy(forwardManifest))
  )
    throw new Error("选股政策与冻结清单或晋级报告不一致，本批资格失效");
  for (const accountId of evidenceAccountIds)
    if (
      !(await portfolioSelectionMatches(env, accountId, {
        ...forwardManifest,
        windowDates,
      }))
    )
      throw new Error("评估账户计划的选股政策或摘要不一致，本批资格失效");
  const feeConfig = feesForBook(account.book);
  const feeConfigDigest = await digestOf(feeConfig);
  if (feeConfigDigest !== forwardManifest.feeConfigDigest)
    throw new Error("费用配置在窗口期内变化，本批资格失效");
  // 成本指纹核验（statistical-evidence.md §7.2 批次 C）：捕获清单记录了
  // 执行成本政策摘要的批次，在成本口径变化后不再晋级；旧批次无该字段不受影响。
  const costPolicy = await latestPolicyBundle(env.DB).catch(() => null);
  if (
    forwardManifest.executionCostDigest &&
    costPolicy &&
    costPolicy.payloadDigest !== forwardManifest.executionCostDigest
  )
    throw new Error("执行成本政策在窗口期内变化，本批资格失效");
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
