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
import { marketData } from "../services/market.js";
import {
  paperOverview,
  runPaperDay,
  exportPaper,
  verifyExport,
} from "../services/paper.js";
import { PaperRepository } from "../storage/paper.js";
import { improveStrategy } from "../services/improvement.js";
import { pollTrading, realtimeStatus } from "../services/realtime.js";

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
  return {
    ...result,
    ai,
    snapshot,
    paper,
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
    "/api/paper": ["GET"],
    "/api/paper/settings": ["POST"],
    "/api/paper/export": ["GET"],
    "/api/paper/verify": ["GET"],
    "/api/paper/improve": ["POST"],
    "/api/paper/activate": ["POST"],
    "/api/paper/live": ["GET"],
    "/api/paper/poll": ["POST"],
  };
  if (!methods[path]) return json({ error: "接口不存在" }, 404);
  if (!methods[path].includes(request.method))
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
      return json(await marketData(date));
    }
    if (path === "/api/paper") return json(await paperOverview(env));
    if (path === "/api/paper/live") return json(await realtimeStatus(env));
    if (path === "/api/paper/poll") return json(await pollTrading(env));
    if (path === "/api/paper/settings") {
      const body = await readJson(request);
      if (
        !body ||
        Object.keys(body).some(
          (key) => !["initialCapital", "improvementMode", "fees"].includes(key),
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
    const repository = new PaperRepository(env);
    await repository.initialize(await readWeights(env));
    if (path === "/api/paper/improve")
      return json(await improveStrategy(repository, env));
    const body = await readJson(request);
    if (typeof body.id !== "string" || !/^ai-\d{4}-\d{2}-\d{2}$/.test(body.id))
      return json({ error: "策略版本无效" }, 400);
    return json({ activated: await repository.activate(body.id) });
  } catch (error) {
    return json({ error: safeError(error) }, 503);
  }
}
