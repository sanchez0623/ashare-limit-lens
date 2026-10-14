import { digestOf } from "./research-lineage.js";

const check = (condition, reason) => {
  if (!condition) throw new Error(`切换审计：${reason}`);
};
const reportCore = ({ digest, promotion, ...core }) => core;
export async function verifySwitchReport(row, cohortId) {
  const p = row?.payload;
  check(
    p && row.digest === p.digest && p.cohortId === cohortId,
    "冻结报告身份或引用不一致",
  );
  const { digest, ...source } = p;
  check((await digestOf(source)) === digest, "冻结报告摘要不一致");
  return p;
}

// 0018 旧事件可从最终报告恢复原始核验输入，仅在原摘要完全匹配时成立。
// 不回写事件、不替换其摘要、不把猜测过的输入登记为证明。
export async function recoverSwitchReport(evaluation, reference, cohortId) {
  if (!evaluation) throw new Error("切换审计：事件实际引用的冻结报告缺失");
  const candidates = [evaluation];
  const { digest, ...source } = evaluation;
  const beforePromotion = { ...source, promotion: null };
  candidates.push({
    ...beforePromotion,
    digest: await digestOf(beforePromotion),
  });
  for (const payload of candidates) {
    if (payload.digest !== reference) continue;
    const row = { digest: reference, payload };
    await verifySwitchReport(row, cohortId);
    return row;
  }
  throw new Error("切换审计：最终报告无法还原事件引用的原始摘要");
}

export async function verifyStrategySwitches({
  experiment,
  members = [],
  versions = [],
  switches = [],
  switchReports = [],
  events = [],
  cohortEvents = [],
  evaluation = null,
  allowLegacyReports = false,
}) {
  check(
    new Set(switches.map((row) => row.payload.id)).size === switches.length,
    "事件 id 重复",
  );
  check(
    new Set(switchReports.map((row) => row.digest)).size ===
      switchReports.length,
    "冻结报告引用重复",
  );
  const member = members.find((m) => m.experimentId === experiment.id);
  const parent = versions.find((v) => v.id === experiment.parentVersion);
  const candidate = versions.find((v) => v.id === experiment.candidateVersion);
  const byType = new Map();
  let previousRevision = 0;
  for (const row of switches) {
    const p = row.payload;
    check((await digestOf(p)) === row.digest, "事件摘要不一致");
    check(
      member &&
        p.experimentId === experiment.id &&
        p.cohortId === member.cohortId,
      "事件与实验或运行组不一致",
    );
    check(
      Number.isInteger(p.accountRevision) &&
        p.accountRevision > previousRevision,
      "账户 revision 次序无效",
    );
    previousRevision = p.accountRevision;
    check(
      !byType.has(p.eventType) && ["PROMOTE", "ROLLBACK"].includes(p.eventType),
      "事件类型重复或无效",
    );
    check(
      parent && candidate && member.strategyVersion === candidate.id,
      "事件引用的策略版本不存在",
    );
    const researchEvent = events.filter(
      (e) => e.payload?.switchEventId === p.id,
    );
    check(
      researchEvent.length === 1 && researchEvent[0].createdAt === p.createdAt,
      "研究事件未绑定切换记录",
    );
    if (p.eventType === "PROMOTE") {
      if (experiment.reservationPayload.singleForward?.switchAuditVersion === 2)
        check(
          p.researchPolicyId === experiment.policyId &&
            p.researchPolicyDigest ===
              experiment.reservationPayload.policyDigest,
          "启用事件与冻结研究政策不一致",
        );
      check(
        p.fromVersion === parent.id &&
          p.toVersion === candidate.id &&
          p.parentParamsDigest === (await digestOf(parent.params)) &&
          p.candidateParamsDigest === (await digestOf(candidate.params)) &&
          p.candidateParamsDigest === member.paramsDigest,
        "启用版本或参数与冻结候选不一致",
      );
      check(
        researchEvent[0].eventType === "MEMBER_PROMOTED",
        "启用未绑定正确研究事件",
      );
      const cohortEvent = cohortEvents.filter(
        (e) => e.payload?.switchEventId === p.id,
      );
      check(
        cohortEvent.length === 1 &&
          cohortEvent[0].eventType === "MEMBER_PROMOTED" &&
          cohortEvent[0].createdAt === p.createdAt,
        "运行组事件未绑定启用记录",
      );
      let reportRow = switchReports.find((r) => r.digest === p.reportDigest);
      if (!reportRow && allowLegacyReports)
        reportRow = await recoverSwitchReport(
          evaluation,
          p.reportDigest,
          p.cohortId,
        );
      const frozen = await verifySwitchReport(reportRow, p.cohortId);
      check(
        frozen.champion?.memberId === member.memberId &&
          frozen.verdicts.some(
            (v) =>
              v.memberId === member.memberId &&
              ["ELIGIBLE", "PROMOTED"].includes(v.stage),
          ),
        "冻结报告未批准该候选",
      );
      if (evaluation)
        check(
          (await digestOf(reportCore(frozen))) ===
            (await digestOf(reportCore(evaluation))),
          "事件引用报告与发布报告的验证输入不一致",
        );
      if (evaluation?.promotion?.promoted) {
        const legacy =
          experiment.reservationPayload.singleForward?.switchAuditVersion !== 2;
        check(
          evaluation.promotion.versionId === p.toVersion &&
            (evaluation.promotion.memberId === member.memberId ||
              (legacy && evaluation.promotion.memberId === undefined)) &&
            (evaluation.promotion.reportDigest === p.reportDigest ||
              (legacy && evaluation.promotion.reportDigest === undefined)),
          "发布报告的启用结果未绑定实际版本或报告",
        );
      }
    } else {
      const promotion = byType.get("PROMOTE");
      check(
        promotion &&
          p.promotionEventId === promotion.id &&
          p.fromVersion === promotion.toVersion &&
          p.toVersion === promotion.fromVersion,
        "回退未反向引用原启用事件",
      );
      check(
        researchEvent[0].eventType === "ROLLED_BACK" &&
          researchEvent[0].payload.fromVersion === p.fromVersion &&
          researchEvent[0].payload.toVersion === p.toVersion,
        "回退研究事件的版本关联不一致",
      );
    }
    byType.set(p.eventType, p);
  }
  if (experiment.stage === "PROMOTED")
    check(
      byType.has("PROMOTE") && !byType.has("ROLLBACK"),
      "实验启用状态缺少有效切换事件",
    );
  if (experiment.stage === "ROLLED_BACK")
    check(byType.has("ROLLBACK"), "实验回退状态缺少有效切换事件");
  return { passed: true, switches: switches.length };
}
