import { database } from "./database.js";
import {
  BASE_STRATEGY,
  newBook,
  createPlan,
  defensivePlan,
} from "../domain/trading.js";
import { normalizeFees, feesForBook } from "../../shared/fees.js";
import {
  normalizeRiskLimits,
  riskLimitsForBook,
} from "../../shared/risk-limits.js";
import {
  normalizeStrategyParams,
  withExposureTiers,
  withPyramidReduce,
} from "../../shared/strategy-params.js";
import { BENCHMARK_CODES, DEFAULT_BENCHMARK } from "../../shared/benchmarks.js";
import { programIdentity } from "../../shared/strategy-program.js";
import { preserveProgramSignal } from "./strategy-signals.js";
import { freezeQualityStatement } from "./t-quality.js";
import { extractTTrades } from "../domain/t-quality.js";
import { latestPolicyBundle, verifyPolicyBundle } from "./execution-cost.js";
import {
  DEFAULT_SELECTION_VERSION,
  SELECTION_VERSION_V2,
  selectionPolicy,
  selectionPolicyFields,
  selectionPolicyForBook,
  selectionPolicyMatches,
  frozenSelectionPolicy,
  selectionSnapshotDigest,
} from "../domain/signal-selection.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export async function digest(value) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
const parse = (row) => (row ? JSON.parse(row.payload) : null);
// 做T记录（方案 7）：DB 行 → 记录对象（与成交流水提取器同一形状）。
function tTradeRowToRecord(row) {
  return {
    id: row.id,
    trade_date: row.trade_date,
    code: row.code,
    action: row.action,
    buy_price_cents: row.buy_price_cents,
    sell_price_cents: row.sell_price_cents,
    buy_quantity: row.buy_quantity ?? 0,
    sell_quantity: row.sell_quantity ?? 0,
    day_pnl_cents: row.day_pnl_cents ?? 0,
    total_pnl_cents: row.total_pnl_cents,
    completed_same_day: row.completed_same_day ? 1 : 0,
    completed_date: row.completed_date,
    completed_sequence: row.completed_sequence ?? 0,
  };
}
// 原始分跨日回查：从 snapshots 归档按日期倒序扫描，取每只股票最近一次
// 入池的有效评分；评分缺失的快照跳过，继续向前找，直到找齐或扫完窗口。
export async function buildOriginalScoreLookup(db, date, codes, lookback = 15) {
  const wanted = new Set(codes);
  const found = new Map();
  if (!wanted.size) return () => null;
  const result = await db
    .prepare(
      "SELECT trade_date, payload FROM snapshots WHERE trade_date <= ? ORDER BY trade_date DESC LIMIT ?",
    )
    .bind(date, lookback)
    .all();
  for (const row of result.results ?? []) {
    let stocks;
    try {
      stocks = JSON.parse(row.payload)?.stocks ?? [];
    } catch {
      continue;
    }
    for (const stock of stocks) {
      if (!wanted.has(stock.code) || found.has(stock.code)) continue;
      // Number(null) === 0，必须先判空，避免缺失评分被当作 0 分回填。
      if (stock?.score == null) continue;
      const score = Number(stock.score);
      if (Number.isFinite(score)) found.set(stock.code, score);
    }
    if (found.size === wanted.size) break;
  }
  return (code) => found.get(code) ?? null;
}
export class PaperRepository {
  constructor(env) {
    this.db = database(env);
  }
  async initialize(weights = BASE_STRATEGY.weights) {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO paper_accounts (id, revision, state, updated_at) VALUES (?, 0, ?, ?)",
      )
      .bind(
        "primary",
        JSON.stringify({ ...newBook(), improvementMode: "auto" }),
        now,
      )
      .run();
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO strategy_versions (id, created_at, status, params, evidence) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        "baseline-v1",
        now,
        "ACTIVE",
        JSON.stringify({ ...BASE_STRATEGY, weights }),
        JSON.stringify({
          type: "baseline",
          explanation: "规则初始版本；未声称获得历史收益验证",
        }),
      )
      .run();
    await this.upgradeSelectionPolicy();
    return this.account();
  }
  async upgradeSelectionPolicy() {
    const account = await this.account();
    // 升级范围：无显式版本的旧账户与 v2 账户，一律升到最新版本（当前 v3，
    // 启用股票分类路由）。显式登记的其他版本（含 v1）不自动改参——显式
    // 版本表示用户主动选择，不覆盖。v4 是显式选择的策略，不自动升级存量
    // 账户（见 signal-selection.js 中 DEFAULT_SELECTION_VERSION 的说明）。
    // 升级只在研究窗口释放后执行，留审计记录。
    const currentVersion = account?.book?.selectionPolicyVersion;
    if (
      !account ||
      (currentVersion !== undefined && currentVersion !== SELECTION_VERSION_V2)
    )
      return;
    const owner = await this.db
      .prepare(
        "SELECT owner_id FROM research_window_owners WHERE namespace = 'main'",
      )
      .first();
    if (owner) return;
    const nonce = crypto.randomUUID(),
      stamp = new Date().toISOString();
    const book = {
      ...account.book,
      selectionPolicyVersion: DEFAULT_SELECTION_VERSION,
    };
    const change = {
      id: nonce,
      createdAt: stamp,
      type: "SELECTION_POLICY_UPGRADE",
      before: selectionPolicyFields(selectionPolicyForBook(account.book)),
      after: selectionPolicyFields(selectionPolicy(DEFAULT_SELECTION_VERSION)),
      effective:
        "只用于后续未冻结的计划；旧计划及活动研究保持原政策；尚未声称收益改善",
    };
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE paper_accounts SET state=?, revision=revision+1, last_run_id=?, updated_at=? WHERE id='primary' AND revision=? AND NOT EXISTS (SELECT 1 FROM research_window_owners WHERE namespace='main')",
        )
        .bind(JSON.stringify(book), nonce, stamp, account.revision),
      this.db
        .prepare(
          "INSERT INTO paper_configuration_history (id,created_at,payload,digest) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM paper_accounts WHERE id='primary' AND revision=? AND last_run_id=?)",
        )
        .bind(
          nonce,
          stamp,
          JSON.stringify(change),
          await digest(change),
          account.revision + 1,
          nonce,
        ),
    ]);
  }
  async account() {
    const row = await this.db
      .prepare("SELECT revision, state FROM paper_accounts WHERE id = ?")
      .bind("primary")
      .first();
    return row ? { revision: row.revision, book: JSON.parse(row.state) } : null;
  }
  async snapshot(date) {
    return parse(
      await this.db
        .prepare("SELECT payload FROM snapshots WHERE trade_date = ?")
        .bind(date)
        .first(),
    );
  }
  async plan(date) {
    return parse(
      await this.db
        .prepare("SELECT payload FROM paper_plans WHERE signal_date = ?")
        .bind(date)
        .first(),
    );
  }
  async savePlan(plan) {
    frozenSelectionPolicy(plan);
    // 冻结入口核验（§3.2）：计划内嵌政策 payload 必须与摘要一致，
    // 防止改参不改编号的计划进入执行链。
    if (
      plan?.executionCostPolicy &&
      !(await verifyPolicyBundle(plan.executionCostPolicy))
    )
      throw new Error("计划成本政策与摘要不一致，拒绝冻结");
    await preserveProgramSignal(this.db, plan);
    const hash = await digest(plan);
    const statement = this.db
      .prepare(
        "INSERT OR IGNORE INTO paper_plans (signal_date, created_at, payload, digest) VALUES (?, ?, ?, ?)",
      )
      .bind(plan.signalDate, plan.createdAt, JSON.stringify(plan), hash);
    const quality = await freezeQualityStatement(this.db, plan, "main", hash);
    await this.db.batch([statement, ...(quality ? [quality] : [])]);
    return this.plan(plan.signalDate);
  }
  async history(table, limit = 120) {
    if (
      ![
        "paper_equity",
        "paper_ledger",
        "paper_market_days",
        "paper_plans",
        "snapshots",
        "paper_runs",
        "paper_configuration_history",
        "paper_plan_revisions",
      ].includes(table)
    )
      throw new Error("无效存储类别");
    const column =
      table === "paper_plans"
        ? "signal_date"
        : ["paper_configuration_history", "paper_plan_revisions"].includes(
              table,
            )
          ? "created_at"
          : "trade_date";
    const result = await this.db
      .prepare(`SELECT * FROM ${table} ORDER BY ${column} DESC LIMIT ?`)
      .bind(limit)
      .all();
    return result.results;
  }
  async versions() {
    const result = await this.db
      .prepare(
        "SELECT * FROM strategy_versions ORDER BY created_at DESC LIMIT 40",
      )
      .all();
    return result.results.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      status: row.status,
      params: JSON.parse(row.params),
      evidence: JSON.parse(row.evidence),
    }));
  }
  async strategy(book) {
    const row = await this.db
      .prepare("SELECT params FROM strategy_versions WHERE id = ?")
      .bind(book.activeStrategy)
      .first();
    if (!row) throw new Error("策略版本缺失");
    return JSON.parse(row.params);
  }
  async logRun(date, status, payload) {
    await this.db
      .prepare(
        "INSERT INTO paper_runs (trade_date, updated_at, status, payload) VALUES (?, ?, ?, ?) ON CONFLICT(trade_date) DO UPDATE SET updated_at=excluded.updated_at, status=excluded.status, payload=excluded.payload",
      )
      .bind(date, new Date().toISOString(), status, JSON.stringify(payload))
      .run();
  }
  async settle(expectedRevision, result, dataset, { tTradeRecords = [] } = {}) {
    const runId = crypto.randomUUID();
    const nextRevision = expectedRevision + 1;
    const guard =
      "WHERE EXISTS (SELECT 1 FROM paper_accounts WHERE id = ? AND revision = ? AND last_run_id = ?)";
    const stamp = new Date().toISOString();
    const statements = [
      this.db
        .prepare(
          "UPDATE paper_accounts SET state=?, revision=revision+1, last_run_id=?, updated_at=? WHERE id=? AND revision=?",
        )
        .bind(
          JSON.stringify(result.book),
          runId,
          stamp,
          "primary",
          expectedRevision,
        ),
    ];
    const guarded = (sql, args) =>
      this.db
        .prepare(`${sql} ${guard}`)
        .bind(...args, "primary", nextRevision, runId);
    statements.push(
      guarded("INSERT INTO paper_equity (trade_date, payload) SELECT ?, ?", [
        dataset.date,
        JSON.stringify(result.equity),
      ]),
    );
    statements.push(
      guarded(
        "INSERT INTO paper_market_days (trade_date, payload, digest) SELECT ?, ?, ?",
        [dataset.date, JSON.stringify(dataset), await digest(dataset)],
      ),
    );
    for (const fill of result.ledger)
      statements.push(
        guarded(
          "INSERT INTO paper_ledger (id, trade_date, payload) SELECT ?, ?, ?",
          [fill.id, fill.date, JSON.stringify(fill)],
        ),
      );
    if (result.session)
      statements.push(
        this.db
          .prepare(
            `INSERT INTO paper_live_sessions (trade_date,payload,digest) SELECT ?,?,? ${guard} ON CONFLICT(trade_date) DO UPDATE SET payload=excluded.payload,digest=excluded.digest`,
          )
          .bind(
            dataset.date,
            JSON.stringify(result.session),
            await digest(result.session),
            "primary",
            nextRevision,
            runId,
          ),
      );
    // 做T记录（方案 7）：派生投影与结算同批写入（同一 guard），任一
    // 失败整体回滚，记录不领先/滞后于账本；幂等覆盖（INSERT OR REPLACE）。
    for (const record of tTradeRecords)
      statements.push(
        guarded(
          "INSERT OR REPLACE INTO paper_t_trades (id,trade_date,code,action,buy_price_cents,sell_price_cents,buy_quantity,sell_quantity,day_pnl_cents,total_pnl_cents,completed_same_day,completed_date,completed_sequence,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?",
          [
            record.id,
            record.trade_date,
            record.code,
            record.action,
            record.buy_price_cents ?? null,
            record.sell_price_cents ?? null,
            record.buy_quantity ?? 0,
            record.sell_quantity ?? 0,
            record.day_pnl_cents ?? 0,
            record.total_pnl_cents ?? null,
            record.completed_same_day ? 1 : 0,
            record.completed_date ?? null,
            record.completed_sequence ?? 0,
            record.created_at ?? stamp,
            stamp,
          ],
        ),
      );
    await this.db.batch(statements);
    const row = await this.db
      .prepare("SELECT last_run_id FROM paper_accounts WHERE id=?")
      .bind("primary")
      .first();
    return row.last_run_id === runId;
  }
  // 某交易日的全部成交行（实时路径逐帧已落库；盘后路径 settlement.ledger
  // 在内存中，不需要此查询）。payload 内含 sequence，顺序由提取器排序。
  async ledgerRowsForDate(date) {
    const result = await this.db
      .prepare("SELECT payload FROM paper_ledger WHERE trade_date = ?")
      .bind(date)
      .all();
    return (result.results ?? []).map((row) => JSON.parse(row.payload));
  }
  // 做T记录：按了结日期倒序取最近若干条（质量汇总样本窗口）。
  async recentTTrades(limit = 200) {
    const result = await this.db
      .prepare(
        "SELECT * FROM paper_t_trades WHERE completed_date IS NOT NULL ORDER BY completed_date DESC, id DESC LIMIT ?",
      )
      .bind(limit)
      .all();
    return (result.results ?? []).map(tTradeRowToRecord);
  }
  // 未了结做T记录（等待恢复腿）：按代码过滤，供恢复腿并入。
  async openTTradesByCodes(codes, beforeDate) {
    const wanted = [...new Set(codes)].filter(Boolean);
    if (!wanted.length) return [];
    const placeholders = wanted.map(() => "?").join(",");
    const result = await this.db
      .prepare(
        `SELECT * FROM paper_t_trades WHERE completed_date IS NULL AND code IN (${placeholders})`,
      )
      .bind(...wanted)
      .all();
    const rows = result.results ?? [];
    if (!rows.length) return [];
    // 均价已经取整，不能乘回数量当作精确名义额。读取原始成交重建
    // open 累计值，也修复升级前已丢失名义额的部分成交记录。
    const from = rows.map((row) => row.trade_date).sort()[0];
    const ledger = await this.db
      .prepare(
        `SELECT payload FROM paper_ledger WHERE trade_date>=? ${beforeDate ? "AND trade_date<?" : ""} ORDER BY trade_date,id`,
      )
      .bind(from, ...(beforeDate ? [beforeDate] : []))
      .all();
    const open = new Map(
      extractTTrades(
        (ledger.results ?? [])
          .map((row) => JSON.parse(row.payload))
          .filter((fill) => wanted.includes(fill.code)),
      ).open.map((record) => [record.id, record]),
    );
    return rows.map((row) => {
      const record = open.get(row.id);
      if (!record) throw new Error("未了结做T记录缺少原始成交流水");
      return { ...record, created_at: row.created_at };
    });
  }
  // 全部做T记录（展示用，按尝试日倒序）。
  async tTrades(limit = 50) {
    const result = await this.db
      .prepare(
        "SELECT * FROM paper_t_trades ORDER BY trade_date DESC, id DESC LIMIT ?",
      )
      .bind(limit)
      .all();
    return (result.results ?? []).map(tTradeRowToRecord);
  }
  async canEditCapital(book) {
    const live = await this.db
      .prepare("SELECT COUNT(*) AS count FROM paper_live_sessions")
      .first();
    if (live.count) return false;
    if (
      book.settlementCount > 1 ||
      book.positions.length ||
      book.feesCents ||
      book.realizedPnlCents
    )
      return false;
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM paper_ledger")
      .first();
    return row.count === 0;
  }
  async configure(settings, now = new Date()) {
    const account = await this.initialize();
    const book = structuredClone(account.book);
    const feeConfig =
      settings.fees === undefined
        ? feesForBook(book)
        : normalizeFees(settings.fees);
    const feesChanged =
      settings.fees !== undefined &&
      (book.feeModel !== "itemized-v2" ||
        JSON.stringify(normalizeFees(feesForBook(book))) !==
          JSON.stringify(feeConfig));
    const initial =
      settings.initialCapital === undefined
        ? book.initialCashCents
        : newBook(settings.initialCapital, feeConfig).initialCashCents;
    const capitalChanged = initial !== book.initialCashCents;
    if (capitalChanged) {
      if (!(await this.canEditCapital(book)))
        throw new Error("交易计划开始执行后初始资金被冻结，不能改写收益基准");
      book.initialCashCents = initial;
      book.cashCents = initial;
      book.equityCents = initial;
      book.peakEquityCents = initial;
    }
    if (feesChanged) {
      book.feeConfig = feeConfig;
      book.feeModel = "itemized-v2";
      book.feeConfigVersion = (book.feeConfigVersion || 0) + 1;
    }
    const riskLimits =
      settings.riskLimits === undefined
        ? riskLimitsForBook(book)
        : normalizeRiskLimits(settings.riskLimits);
    const riskChanged =
      settings.riskLimits !== undefined &&
      JSON.stringify(riskLimitsForBook(book)) !== JSON.stringify(riskLimits);
    if (riskChanged) {
      book.riskLimits = riskLimits;
      book.riskLimitsVersion = (book.riskLimitsVersion || 0) + 1;
    }
    // 手动策略参数：校验后登记为新策略版本（evidence.type = "manual"）
    // 并切换 activeStrategy；与费用/风控同一生效纪律——只在下一个尚未
    // 冻结的计划生效，已冻结计划与历史成交保持原参数。
    const currentStrategy = withPyramidReduce(
      withExposureTiers(await this.strategy(account.book)),
    );
    let strategyChange = null;
    if (settings.strategyParams !== undefined) {
      const params = normalizeStrategyParams(settings.strategyParams);
      if (programIdentity(params) !== programIdentity(currentStrategy))
        throw new Error("家族、情绪选择器与资金分配变化需通过研究批次启用");
      const changed =
        JSON.stringify(
          canonical(withPyramidReduce(withExposureTiers(currentStrategy))),
        ) !== JSON.stringify(canonical(params));
      if (changed) {
        const changedKeys = Object.keys(params).filter(
          (key) =>
            JSON.stringify(canonical(params[key])) !==
            JSON.stringify(canonical(currentStrategy[key])),
        );
        const row = await this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM strategy_versions WHERE id LIKE 'manual-%'",
          )
          .first();
        strategyChange = {
          versionId: `manual-v${row.n + 1}`,
          params,
          evidence: {
            type: "manual",
            baseVersion: account.book.activeStrategy,
            rationale: `手动调整：${changedKeys.join("、")}`,
            changedKeys,
          },
        };
        book.activeStrategy = strategyChange.versionId;
      }
    }
    if (settings.improvementMode !== undefined) {
      if (!["auto", "manual"].includes(settings.improvementMode))
        throw new Error("改进模式无效");
      book.improvementMode = settings.improvementMode;
    }
    if (settings.benchmarkCode !== undefined) {
      if (!BENCHMARK_CODES.has(settings.benchmarkCode))
        throw new Error("基准指数无效");
      book.benchmarkCode = settings.benchmarkCode;
    }
    const stamp = now.toISOString(),
      nonce = crypto.randomUUID();
    const statements = [
      this.db
        .prepare(
          "UPDATE paper_accounts SET state=?, revision=revision+1, last_run_id=?, updated_at=? WHERE id=? AND revision=?",
        )
        .bind(JSON.stringify(book), nonce, stamp, "primary", account.revision),
    ];
    const guard =
      "EXISTS (SELECT 1 FROM paper_accounts WHERE id=? AND revision=? AND last_run_id=?)";
    const guardArgs = ["primary", account.revision + 1, nonce];
    const baselines = capitalChanged
      ? await this.history("paper_equity", 10)
      : [];
    for (const row of baselines) {
      const previous = JSON.parse(row.payload);
      if (
        previous.feesCents ||
        previous.marketValueCents ||
        previous.equityCents !== account.book.initialCashCents
      )
        throw new Error("已有账户收益记录，不能修改初始资金");
      const equity = { ...previous, cashCents: initial, equityCents: initial };
      statements.push(
        this.db
          .prepare(
            `UPDATE paper_equity SET payload=? WHERE trade_date=? AND ${guard}`,
          )
          .bind(JSON.stringify(equity), row.trade_date, ...guardArgs),
      );
    }
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
    let replacement = null;
    // Only revise a plan on its signal day after close; never alter an executable intraday plan.
    if (
      (capitalChanged || feesChanged || riskChanged || strategyChange) &&
      book.lastDate === day &&
      time >= "15:05"
    ) {
      const previousPlan = await this.db
        .prepare("SELECT payload,digest FROM paper_plans WHERE signal_date=?")
        .bind(day)
        .first();
      const snapshot = await this.snapshot(day),
        strategy = strategyChange
          ? strategyChange.params
          : await this.strategy(book);
      // 调整费用/资金不借机换选股政策；仍使用被替换计划的冻结版本。
      const policy = previousPlan
        ? frozenSelectionPolicy(JSON.parse(previousPlan.payload))
        : selectionPolicyForBook(book);
      // 重冻计划也带当前生效政策，避免替换计划悄悄退回旧口径。
      const executionCostPolicy = await latestPolicyBundle(this.db);
      // 持仓股掉出当日涨停池时，从最近快照归档回查原始评分用于计划展示。
      const originalScoreLookup = await buildOriginalScoreLookup(
        this.db,
        day,
        book.positions.map((position) => position.code),
      );
      // 卖出上下文沿用被替换计划的冻结快照：仅调费用/资金时，决策输入
      // 不变（行情当日快照、特征/EOD 行/板块退潮/情绪切换全部复用原值）。
      const previousPayload = previousPlan
        ? JSON.parse(previousPlan.payload)
        : null;
      const frozenExitContext = previousPayload?.exitContext ?? null;
      // 方案 7：做T质量摘要与证据同样沿用被替换计划的冻结版本——同日
      // 重冻时质量状态未变，正常修改费用不得解除停手/档位闸门。
      replacement = snapshot
        ? createPlan(snapshot, book, strategy, book.activeStrategy, stamp, {
            executionCostPolicy,
            originalScoreLookup,
            selectionPolicy: policy,
            snapshotDigest: await selectionSnapshotDigest(snapshot),
            ...(frozenExitContext
              ? { exitContextFrozen: frozenExitContext }
              : {}),
            ...(previousPayload?.tQuality
              ? { tQuality: previousPayload.tQuality }
              : {}),
            ...(previousPayload?.tQualityEvidence
              ? { tQualityEvidence: previousPayload.tQualityEvidence }
              : {}),
          })
        : defensivePlan(day, book, strategy, book.activeStrategy, stamp, {
            executionCostPolicy,
            originalScoreLookup,
            selectionPolicy: policy,
          });
      await preserveProgramSignal(this.db, replacement, snapshot);
      if (previousPlan)
        statements.push(
          this.db
            .prepare(
              `INSERT INTO paper_plan_revisions (id,signal_date,created_at,payload,digest) SELECT ?,?,?,?,? WHERE ${guard}`,
            )
            .bind(
              nonce,
              day,
              stamp,
              previousPlan.payload,
              previousPlan.digest,
              ...guardArgs,
            ),
        );
      statements.push(
        this.db
          .prepare(`DELETE FROM paper_plans WHERE signal_date=? AND ${guard}`)
          .bind(day, ...guardArgs),
      );
      statements.push(
        this.db
          .prepare(
            `INSERT INTO paper_plans (signal_date,created_at,payload,digest) SELECT ?,?,?,? WHERE ${guard}`,
          )
          .bind(
            day,
            stamp,
            JSON.stringify(replacement),
            await digest(replacement),
            ...guardArgs,
          ),
      );
    }
    const change = {
      id: nonce,
      createdAt: stamp,
      capitalChanged,
      feesChanged,
      riskChanged,
      strategyChanged: !!strategyChange,
      before: {
        initialCashCents: account.book.initialCashCents,
        fees: feesForBook(account.book),
        feeConfigVersion: account.book.feeConfigVersion || 0,
        riskLimits: riskLimitsForBook(account.book),
        riskLimitsVersion: account.book.riskLimitsVersion || 0,
        strategy: {
          id: account.book.activeStrategy,
          params: currentStrategy,
        },
        improvementMode: account.book.improvementMode,
        benchmarkCode: account.book.benchmarkCode || DEFAULT_BENCHMARK,
      },
      after: {
        initialCashCents: book.initialCashCents,
        fees: feesForBook(book),
        feeConfigVersion: book.feeConfigVersion || 0,
        riskLimits: riskLimitsForBook(book),
        riskLimitsVersion: book.riskLimitsVersion || 0,
        strategy: {
          id: book.activeStrategy,
          params: strategyChange ? strategyChange.params : currentStrategy,
        },
        improvementMode: book.improvementMode,
        benchmarkCode: book.benchmarkCode || DEFAULT_BENCHMARK,
      },
      previousBaselines: baselines.map((row) => JSON.parse(row.payload)),
      revisedPlanDate: replacement?.signalDate || null,
      effective: replacement
        ? "当日尚未执行的计划已重新冻结；原计划留档"
        : strategyChange
          ? "新策略参数已登记启用，将用于下一份计划；已冻结计划保持原参数"
          : "新配置适用于后续新计划，已冻结计划保持原配置",
    };
    if (strategyChange) {
      // 版本登记与账户切换同一事务：账户提交失败时版本一并回滚。
      statements.push(
        this.db
          .prepare(
            `INSERT INTO strategy_versions (id,created_at,status,params,evidence) SELECT ?,?,?,?,? WHERE ${guard}`,
          )
          .bind(
            strategyChange.versionId,
            stamp,
            "ACTIVE",
            JSON.stringify(strategyChange.params),
            JSON.stringify(strategyChange.evidence),
            ...guardArgs,
          ),
      );
      statements.push(
        this.db
          .prepare(
            `UPDATE strategy_versions SET status='RETIRED' WHERE status='ACTIVE' AND id<>? AND ${guard}`,
          )
          .bind(strategyChange.versionId, ...guardArgs),
      );
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO paper_configuration_history (id,created_at,payload,digest) SELECT ?,?,?,? WHERE ${guard}`,
        )
        .bind(
          nonce,
          stamp,
          JSON.stringify(change),
          await digest(change),
          ...guardArgs,
        ),
    );
    const results = await this.db.batch(statements);
    if ((results[0].meta?.changes ?? results[0].changes) !== 1)
      throw new Error("账户正在结算，请刷新后重试");
    return book;
  }
  async recordVersion(version) {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO strategy_versions (id, created_at, status, params, evidence) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        version.id,
        version.createdAt,
        version.status,
        JSON.stringify(version.params),
        JSON.stringify(version.evidence),
      )
      .run();
  }
  async activate(id) {
    const row = await this.db
      .prepare("SELECT status,evidence FROM strategy_versions WHERE id=?")
      .bind(id)
      .first();
    if (!row || row.status !== "VALIDATED")
      throw new Error("只允许启用通过样本外验证的新策略");
    const { book, revision } = await this.account();
    const evidence = JSON.parse(row.evidence);
    if (
      (evidence.feeConfigVersion !== undefined &&
        evidence.feeConfigVersion !== (book.feeConfigVersion || 0)) ||
      (evidence.initialCashCents !== undefined &&
        evidence.initialCashCents !== book.initialCashCents)
    )
      throw new Error("验证所用费用或资金已变更，请等待新配置下的独立验证");
    if (!selectionPolicyMatches(evidence, book))
      throw new Error(
        "验证所用选股政策与当前账户不一致，请等待新政策下的独立验证",
      );
    book.activeStrategy = id;
    const nonce = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE paper_accounts SET state=?, revision=revision+1, last_run_id=?, updated_at=? WHERE id=? AND revision=?",
        )
        .bind(
          JSON.stringify(book),
          nonce,
          new Date().toISOString(),
          "primary",
          revision,
        ),
      this.db
        .prepare(
          "UPDATE strategy_versions SET status='RETIRED' WHERE status='ACTIVE' AND EXISTS (SELECT 1 FROM paper_accounts WHERE last_run_id=?)",
        )
        .bind(nonce),
      this.db
        .prepare(
          "UPDATE strategy_versions SET status='ACTIVE' WHERE id=? AND EXISTS (SELECT 1 FROM paper_accounts WHERE last_run_id=?)",
        )
        .bind(id, nonce),
    ]);
    return (await this.account()).book.activeStrategy === id;
  }
}
