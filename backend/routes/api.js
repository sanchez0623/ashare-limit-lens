import { json, validDate, readJson, safeError } from "../http.js";
import {
  database,
  beijingDate,
  afterClose,
  readWeights,
  validWeights,
  saveSnapshot,
  loadReview,
  aiConfig,
  gradeWithAI,
  historyList,
} from "../services/review.js";
import { marketData, latestTradingDate } from "../services/market.js";
import { marketForDisplay } from "../services/market-display.js";
import {
  paperOverview,
  runPaperDay,
  exportPaper,
  verifyExport,
} from "../services/paper.js";
import { PaperRepository } from "../storage/paper.js";
import {
  proposeImprovement,
  promoteCandidate,
  researchStatus,
  proposeBootstrapImprovement,
} from "../services/research.js";
import {
  createHistoryImport,
  historyImportDetail,
  probeHistoryCapabilities,
  runHistoryImport,
} from "../services/history.js";
import { HistoryJobRepository, openHistoryStore } from "../storage/history.js";
import { backtestDetail, runBacktest } from "../services/backtest.js";
import { pollTrading, realtimeStatus } from "../services/realtime.js";
import {
  reserveCohort,
  runDailyTournament,
  runTournamentPoll,
  tournamentStatus,
  cohortDetail,
  cohortLineage,
  cohortExport,
} from "../services/strategy-tournament.js";
import { promoteCohortChampion } from "../services/promotion.js";
import { CohortRepository } from "../storage/cohorts.js";
import {
  alertsStatus,
  listAlertIncidents,
  incidentDetail,
  ackIncident,
  saveAlertRules,
  sendTestNotification,
  setMaintenanceWindow,
} from "../services/alerts.js";
import {
  getExecutionCostConfig,
  saveExecutionCostPolicy,
  executionCostDiagnostics,
} from "../services/execution-cost.js";
import { runExecutionSensitivity } from "../services/execution-sensitivity.js";
import { ExecutionCostRepository } from "../storage/execution-cost.js";
import {
  evidenceOverview,
  getEvidence,
  exportEvidence,
  recomputeEvidence,
  refreshEvidence,
  REVIEW_SERIES,
  ACCOUNT_SERIES,
} from "../services/evidence.js";

async function runDaily(env) {
  const date = beijingDate();
  if (!afterClose())
    return {
      snapshot: { saved: false, reason: "收盘后 15:05 起保存评分与生成反馈" },
      paper: { status: "BEFORE_CLOSE" },
      review: null,
      reason: "盘中结果尚未定稿",
      aiStatus: aiConfig(env),
    };
  let market = null,
    marketError = null;
  try {
    market = await marketData(date);
  } catch (error) {
    marketError = safeError(error);
  }
  const snapshot = market
    ? await saveSnapshot(env, market, await readWeights(env))
    : { saved: false, reason: marketError };
  const paper = await runPaperDay(env, date);
  let tournament = null;
  try {
    tournament = await runDailyTournament(env, date, {
      calendarDates: paper?.calendarDates ?? [],
    });
  } catch (error) {
    tournament = { error: safeError(error) };
  }
  let result = { review: null, reason: marketError },
    aiError = null;
  if (market) {
    try {
      result = await loadReview(env, date, market);
    } catch (error) {
      result.reason = safeError(error);
    }
  }
  let ai = result.ai || null;
  if (aiConfig(env).configured && result.review && !ai) {
    try {
      ai = await gradeWithAI(env, result);
    } catch (error) {
      aiError = safeError(error);
    }
  }
  // 统计证据（§8.3）：必须在复盘核验行保存之后刷新，否则首次运行读不到
  // 当天复盘、漏登记当日指标（P1-1）。日历由证据服务自行冻结：账户结算
  // 交出的是未来日历，直接传入会冻结出空窗口（P1-2）。
  // 失败不阻塞交易与复盘，次日重跑按幂等 id 补齐。
  let evidence = null;
  try {
    evidence = await refreshEvidence(env, { date });
  } catch (error) {
    evidence = { error: safeError(error) };
  }
  return {
    ...result,
    ai,
    snapshot,
    paper,
    tournament,
    evidence,
    aiError,
    aiStatus: aiConfig(env),
    history: await historyList(env),
  };
}
export async function api(request, env) {
  const url = new URL(request.url),
    path = url.pathname;
  const methods = {
    "/api/settings": ["GET", "POST"],
    "/api/history": ["GET"],
    "/api/review": ["GET"],
    "/api/run-daily": ["POST"],
    "/api/ai-grade": ["POST"],
    "/api/market": ["GET"],
    "/api/market/latest-date": ["GET"],
    "/api/paper": ["GET"],
    "/api/paper/settings": ["POST"],
    "/api/paper/export": ["GET"],
    "/api/paper/verify": ["GET"],
    "/api/paper/execution-cost": ["GET", "PUT"],
    "/api/paper/execution-cost/diagnostics": ["GET"],
    "/api/research/execution-sensitivity": ["GET", "POST"],
    "/api/evidence": ["GET"],
    "/api/evidence/history": ["GET"],
    "/api/evidence/export": ["GET"],
    "/api/evidence/recompute": ["POST"],
    "/api/evidence/refresh": ["POST"],
    "/api/paper/improve": ["POST"],
    "/api/research/bootstrap": ["POST"],
    "/api/paper/activate": ["POST"],
    "/api/paper/live": ["GET"],
    "/api/paper/poll": ["POST"],
    "/api/research/status": ["GET"],
    "/api/strategies/cohorts": ["GET", "POST"],
    "/api/strategies/policy": ["POST"],
    "/api/history/capabilities": ["GET"],
    "/api/history/imports": ["GET", "POST"],
    "/api/backtests": ["GET", "POST"],
    "/api/alerts/status": ["GET"],
    "/api/alerts/incidents": ["GET"],
    "/api/alerts/rules": ["POST"],
    "/api/alerts/test": ["POST"],
    "/api/alerts/maintenance": ["POST"],
  };
  const historyImportMatch = path.match(
    /^\/api\/history\/imports\/([a-z0-9-]+)(\/run)?$/,
  );
  const backtestMatch = path.match(/^\/api\/backtests\/([a-z0-9-]+)$/);
  const cohortMatch = path.match(
    /^\/api\/strategies\/cohorts\/([a-z0-9-]+)(\/lineage|\/export)?$/,
  );
  // 告警实例 ID 形如 inc-<ISO 时间戳>-<随机段>，含 ":" 与 "."；
  // 只允许 [a-z0-9-] 会让确认按钮永远 404。
  const incidentMatch = path.match(
    /^\/api\/alerts\/incidents\/([A-Za-z0-9._:-]+)\/ack$/,
  );
  if (
    !methods[path] &&
    !historyImportMatch &&
    !backtestMatch &&
    !cohortMatch &&
    !incidentMatch
  )
    return json({ error: "接口不存在" }, 404);
  const allowedMethods = methods[path] ?? ["GET", "POST"];
  if (!allowedMethods.includes(request.method))
    return json({ error: "不支持此请求方法" }, 405);
  if (
    request.method === "POST" &&
    ((request.headers.get("Origin") &&
      request.headers.get("Origin") !== url.origin) ||
      request.headers.get("Sec-Fetch-Site") === "cross-site")
  )
    return json({ error: "不接受跨站写入请求" }, 403);
  if (Number(request.headers.get("Content-Length") || 0) > 12000)
    return json({ error: "请求内容过长" }, 413);
  try {
    if (path === "/api/settings") {
      if (request.method === "GET")
        return json({ weights: await readWeights(env), ai: aiConfig(env) });
      const body = await readJson(request);
      if (!validWeights(body.weights))
        return json(
          { error: "权重必须为六个 0–50 的整数，且至少一项大于零" },
          400,
        );
      await database(env)
        .prepare(
          "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .bind("weights", JSON.stringify(body.weights))
        .run();
      return json({ saved: true });
    }
    if (path === "/api/history") return json(await historyList(env));
    if (path === "/api/research/status") return json(await researchStatus(env));
    if (path === "/api/history/capabilities") {
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(start ?? "") ||
        !/^\d{4}-\d{2}-\d{2}$/.test(end ?? "")
      )
        return json({ error: "请提供 start 与 end 日期（YYYY-MM-DD）" }, 400);
      return json(await probeHistoryCapabilities(env, { start, end }));
    }
    if (path === "/api/history/imports") {
      if (request.method === "GET")
        return json({
          imports: await new HistoryJobRepository(env).listJobs(20),
        });
      const body = await readJson(request);
      const job = await createHistoryImport(env, {
        provider: body.provider,
        kind: body.kind,
        start: body.start,
        end: body.end,
        name: body.name,
        codes: body.codes,
        datasetId: body.datasetId,
      });
      return json({ job });
    }
    if (historyImportMatch) {
      const [, importId, action] = historyImportMatch;
      if (request.method === "GET")
        return json(
          (await historyImportDetail(env, importId)) ?? {
            error: "历史导入任务不存在",
          },
        );
      if (action === "/run") return json(await runHistoryImport(env, importId));
      return json({ error: "不支持此操作" }, 405);
    }
    if (path === "/api/backtests") {
      if (request.method === "GET") {
        const store = openHistoryStore(env);
        return json({
          backtests: store ? await store.listBacktestRuns(20) : [],
          note: store
            ? undefined
            : "历史研究存储仅本机可用：请配置 LOCAL_RESEARCH_DB_PATH 后在本机查看",
        });
      }
      const body = await readJson(request);
      const run = await runBacktest(env, {
        datasetId: body.datasetId,
        selectionPolicyVersion: body.selectionPolicyVersion,
        name: body.name,
        strategy: body.strategy,
        initialCapital: body.initialCapital,
        fees: body.fees,
      });
      return json({ run });
    }
    if (backtestMatch) {
      if (request.method !== "GET")
        return json({ error: "不支持此请求方法" }, 405);
      const detail = await backtestDetail(env, backtestMatch[1]);
      return json(detail ?? { error: "回测不存在" });
    }
    if (path === "/api/review") {
      const date = url.searchParams.get("date") || beijingDate();
      if (!validDate(date)) return json({ error: "日期格式无效" }, 400);
      const row = await database(env)
        .prepare("SELECT payload,ai_payload FROM reviews WHERE trade_date=?")
        .bind(date)
        .first();
      return json({
        review: row ? JSON.parse(row.payload) : null,
        ai: row?.ai_payload ? JSON.parse(row.ai_payload) : null,
        reason: row ? null : "该日期尚无保存的反馈",
        aiStatus: aiConfig(env),
      });
    }
    if (path === "/api/run-daily") return json(await runDaily(env));
    if (path === "/api/ai-grade") {
      const body = await readJson(request);
      if (!validDate(body.date)) return json({ error: "日期格式无效" }, 400);
      const row = await database(env)
        .prepare("SELECT payload,ai_payload FROM reviews WHERE trade_date=?")
        .bind(body.date)
        .first();
      if (!row) return json({ error: "尚无已核验反馈，不能调用 AI 评分" }, 409);
      return json({
        ai: await gradeWithAI(env, {
          review: JSON.parse(row.payload),
          ai: row.ai_payload ? JSON.parse(row.ai_payload) : null,
        }),
      });
    }
    if (path === "/api/market") {
      const date = url.searchParams.get("date") || beijingDate();
      if (!validDate(date) || date > beijingDate())
        return json({ error: "请选择今天或历史有效日期" }, 400);
      return json(await marketForDisplay(env, date));
    }
    if (path === "/api/market/latest-date")
      return json({ date: await latestTradingDate() });
    if (path === "/api/paper") return json(await paperOverview(env));
    if (path === "/api/paper/live") return json(await realtimeStatus(env));
    if (path === "/api/paper/poll") {
      // 赛马批次运行时：主账户由联合行情帧驱动一次观察，不再独立拉取，
      // 避免同一轮对主账本做两次行情观察（§7.1 一次采集，多账本消费）。
      let tournament = null;
      try {
        tournament = await runTournamentPoll(env, new Date());
      } catch {}
      const result = tournament?.primary ?? (await pollTrading(env));
      return json({ ...result, tournament });
    }
    if (path === "/api/strategies/cohorts") {
      if (request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 10);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return json(
          await tournamentStatus(env, {
            limit: Number.isFinite(limit) ? limit : 10,
            offset: Number.isFinite(offset) ? offset : 0,
          }),
        );
      }
      const repository = new PaperRepository(env);
      await repository.initialize(await readWeights(env));
      return json(await reserveCohort(repository, env));
    }
    if (path === "/api/strategies/policy") {
      const body = await readJson(request);
      const cohorts = new CohortRepository(env);
      const owner = await cohorts.windowOwner();
      if (owner)
        return json({ error: "存在活动研究窗口，不能保存新的赛马政策" }, 409);
      const saved = await cohorts.saveTournamentPolicy(body);
      return json({ policyId: saved.id, digest: saved.digest });
    }
    if (path === "/api/alerts/status") return json(await alertsStatus(env));
    if (path === "/api/alerts/incidents") {
      if (request.method === "GET")
        return json(
          await listAlertIncidents(env, {
            cursor: Number(url.searchParams.get("cursor") ?? 0),
            activeOnly: url.searchParams.get("active") === "true",
          }),
        );
      return json({ error: "不支持此请求方法" }, 405);
    }
    if (incidentMatch) {
      if (request.method !== "POST")
        return json({ error: "不支持此请求方法" }, 405);
      const body = await readJson(request);
      const result = await ackIncident(env, incidentMatch[1], {
        hours: Number(body?.hours ?? 1),
      });
      return result ? json(result) : json({ error: "告警实例不存在" }, 404);
    }
    if (path === "/api/alerts/rules") {
      const body = await readJson(request);
      const version = await saveAlertRules(env, body?.policy ?? body ?? {});
      return json({ ruleVersion: version.id, digest: version.digest });
    }
    if (path === "/api/alerts/test")
      return json(await sendTestNotification(env));
    if (path === "/api/alerts/maintenance") {
      const body = await readJson(request);
      return json(
        await setMaintenanceWindow(env, {
          minutes: Number(body?.minutes ?? 60),
          reason: body?.reason,
        }),
      );
    }
    if (cohortMatch) {
      const [, cohortId, action] = cohortMatch;
      if (action === "/lineage") {
        const lineage = await cohortLineage(env, cohortId);
        return lineage ? json(lineage) : json({ error: "赛马批次不存在" }, 404);
      }
      if (action === "/export") {
        const bundle = await cohortExport(env, cohortId);
        return bundle ? json(bundle) : json({ error: "赛马批次不存在" }, 404);
      }
      const detail = await cohortDetail(env, cohortId);
      return detail ? json(detail) : json({ error: "赛马批次不存在" }, 404);
    }
    if (path === "/api/paper/settings") {
      const body = await readJson(request);
      if (
        !body ||
        Object.keys(body).some(
          (key) =>
            ![
              "initialCapital",
              "improvementMode",
              "fees",
              "riskLimits",
              "strategyParams",
              "benchmarkCode",
            ].includes(key),
        )
      )
        return json({ error: "不支持的账户设置" }, 400);
      return json({ book: await new PaperRepository(env).configure(body) });
    }
    if (path === "/api/paper/export") {
      const bundle = await exportPaper(env);
      if (url.searchParams.get("format") === "csv") {
        const fields = [
          "date",
          "time",
          "code",
          "action",
          "side",
          "quantity",
          "priceCents",
          "notionalCents",
          "feeCents",
          "cashDeltaCents",
          "cashAfterCents",
          "realizedPnlCents",
          "strategyVersion",
          "dataQuality",
          "commissionCents",
          "stampTaxCents",
          "handlingCents",
          "regulatoryCents",
          "transferCents",
          "feeConfigVersion",
        ];
        const csv =
          "\ufeff" +
          [
            fields.join(","),
            ...bundle.ledger
              .map((fill) => ({
                ...fill,
                commissionCents: fill.feeBreakdown.commission,
                stampTaxCents: fill.feeBreakdown.stamp,
                handlingCents: fill.feeBreakdown.handling || 0,
                regulatoryCents: fill.feeBreakdown.regulatory || 0,
                transferCents: fill.feeBreakdown.transfer,
              }))
              .map((row) =>
                fields
                  .map(
                    (key) =>
                      `"${String(row[key] ?? "").replaceAll('"', '""')}"`,
                  )
                  .join(","),
              ),
          ].join("\r\n");
        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="limit-lens-ledger.csv"',
            "Cache-Control": "no-store",
          },
        });
      }
      const response = json(bundle);
      response.headers.set(
        "Content-Disposition",
        'attachment; filename="limit-lens-paper.json"',
      );
      return response;
    }
    if (path === "/api/paper/verify")
      return json(await verifyExport(await exportPaper(env)));
    if (path === "/api/paper/execution-cost") {
      if (request.method === "GET")
        return json(await getExecutionCostConfig(env));
      const body = await readJson(request);
      return json(await saveExecutionCostPolicy(env, body));
    }
    if (path === "/api/paper/execution-cost/diagnostics")
      return json(await executionCostDiagnostics(env));
    if (path === "/api/research/execution-sensitivity") {
      if (request.method === "GET")
        return json({
          runs: await new ExecutionCostRepository(env).listSensitivityRuns(20),
        });
      const body = await readJson(request);
      return json(
        await runExecutionSensitivity(env, {
          days: Number(body?.days ?? 40),
        }),
      );
    }
    if (path === "/api/evidence" || path === "/api/evidence/history") {
      const asOf = url.searchParams.get("asOf") || undefined;
      if (asOf && !validDate(asOf)) return json({ error: "日期格式无效" }, 400);
      const series = url.searchParams.get("series") || REVIEW_SERIES;
      const horizon = Number(url.searchParams.get("horizon") ?? 0);
      // 仅带 asOf：返回按所选日期截取的证据总览（复盘页历史日期不得
      // 混入该日期之后发布的滚动证据，P1-8）。
      if (
        path === "/api/evidence" &&
        !url.searchParams.get("series") &&
        !url.searchParams.get("horizon")
      )
        return json(await evidenceOverview(env, { asOf }));
      if (![REVIEW_SERIES, ACCOUNT_SERIES].includes(series))
        return json({ error: "未知证据系列" }, 400);
      if (!Number.isInteger(horizon) || horizon < 5 || horizon > 250)
        return json({ error: "horizon 必须是 5–250 的整数" }, 400);
      const result = await getEvidence(env, { series, asOf, horizon });
      return json(
        path === "/api/evidence/history"
          ? { series, horizon, history: result.history }
          : result,
      );
    }
    if (path === "/api/evidence/export") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "缺少报告 id" }, 400);
      const bundle = await exportEvidence(env, { id });
      return bundle.report
        ? json(bundle)
        : json({ error: "证据报告不存在" }, 404);
    }
    if (path === "/api/evidence/recompute") {
      const body = await readJson(request);
      if (!body?.id) return json({ error: "缺少报告 id" }, 400);
      return json(await recomputeEvidence(env, { id: body.id }));
    }
    if (path === "/api/evidence/refresh") {
      const body = await readJson(request);
      if (body?.date && !validDate(body.date))
        return json({ error: "日期格式无效" }, 400);
      return json(
        await refreshEvidence(env, { date: body?.date || beijingDate() }),
      );
    }
    const repository = new PaperRepository(env);
    await repository.initialize(await readWeights(env));
    if (path === "/api/paper/improve")
      return json(await proposeImprovement(repository, env));
    if (path === "/api/research/bootstrap") {
      const body = await readJson(request);
      return json(
        await proposeBootstrapImprovement(repository, env, {
          datasetId: body.datasetId,
        }),
      );
    }
    const body = await readJson(request);
    if (
      typeof body.id !== "string" ||
      !/^(?:ai-\d{4}-\d{2}-\d{2}|exp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(
        body.id,
      )
    )
      return json({ error: "策略版本无效" }, 400);
    // 统一晋级入口：赛马成员版本走批次晋级服务，不接受排名或状态绕过。
    if (body.id.startsWith("exp-")) {
      const cohorts = new CohortRepository(env);
      const member = await cohorts.memberByExperiment(body.id);
      if (member) {
        const evaluation = await cohorts.report(member.cohortId, "EVALUATION");
        const championMemberId = evaluation?.payload?.champion?.memberId;
        if (championMemberId !== member.memberId)
          return json(
            {
              error:
                "只有批次评估报告中的冠军支持启用；纸面领先或未通过成员没有启用资格",
            },
            403,
          );
        const promoted = await promoteCohortChampion(env, member.cohortId, {});
        return json({ activated: promoted.promoted, ...promoted });
      }
    }
    return json({
      activated: await promoteCandidate(repository, env, body.id),
    });
  } catch (error) {
    return json({ error: safeError(error) }, 503);
  }
}
