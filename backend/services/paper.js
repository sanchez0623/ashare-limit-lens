import {
  PaperRepository,
  digest,
  buildOriginalScoreLookup,
} from "../storage/paper.js";
import {
  newBook,
  createPlan,
  defensivePlan,
  executePlan,
  auditLedger,
  assertProgramSnapshot,
} from "../domain/trading.js";
import {
  collectTradingDay,
  tradingCalendar,
  indexDailyCloses,
} from "./market.js";
import { readWeights, aiConfig } from "./review.js";
import { proposeImprovement } from "./research.js";
import { loadOrBuildExitContext } from "./exit-context.js";
import {
  extractTTrades,
  applyRecoveryFill,
  isRecoveryFill,
  summarizeTQuality,
  buildTQualityEvidence,
  tQualityEnabledForSnapshot,
} from "../domain/t-quality.js";
import { effectiveExecutionCostPolicy } from "./execution-cost.js";
import { verifyPolicyBundle } from "../storage/execution-cost.js";
import { calibrationForPolicy } from "./execution-calibration.js";
import { verifyCalibratedPolicy } from "../domain/execution-calibration.js";
import { safeError } from "../http.js";
import { exportProgramSignals } from "../storage/strategy-signals.js";
import { feesForBook } from "../../shared/fees.js";
import { riskLimitsForBook } from "../../shared/risk-limits.js";
import { DEFAULT_BENCHMARK } from "../../shared/benchmarks.js";
import { RealtimeRepository } from "../storage/realtime.js";
import {
  frozenSelectionPolicy,
  selectionSnapshotDigest,
} from "../domain/signal-selection.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../domain/realtime.js";
import { realtimeStatus } from "./realtime.js";
import { assertStoredProgramPlan } from "./strategy-program-evidence.js";

// 做T记录提取（方案 7）：当日成交 → paper_t_trades 的 upsert 记录集。
//   - 当日做T腿（T_FORWARD/T_REVERSE）：同日两腿齐 → 当日了结；单腿 →
//     未了结 open 记录（等待跨日恢复腿）；
//   - 当日恢复腿（实时恢复单，orderId 以 :recovery 结尾）：并入匹配的
//     open 记录，补齐尝试腿数量即了结（created_at 保留首次落库值）。
// 记录随 settle 同一 CAS 批落库：结算回滚时记录一并回滚，不领先账本。
export function buildTTradeRecords({ fills, openRecords, now }) {
  const { records: dayRecords, open: openToday } = extractTTrades(fills);
  const upserts = [...dayRecords, ...openToday].map((record) => ({
    ...record,
    created_at: now,
  }));
  // 当日已有新做T尝试的代码不会再有恢复腿（计划对存在待恢复腿的持仓
  // 不生成做T），恢复腿只匹配更早日未了结的 open 记录。
  const attemptedCodes = new Set(upserts.map((record) => record.code));
  const openByCode = new Map(
    (openRecords ?? [])
      .filter((record) => !attemptedCodes.has(record.code))
      .map((record) => [record.code, { ...record }]),
  );
  const recoveredCodes = new Set();
  for (const fill of fills) {
    if (!isRecoveryFill(fill)) continue;
    const record = openByCode.get(fill.code);
    if (!record) continue;
    openByCode.set(fill.code, {
      ...applyRecoveryFill(record, fill),
      created_at: record.created_at ?? now,
    });
    recoveredCodes.add(fill.code);
  }
  for (const code of recoveredCodes) upserts.push(openByCode.get(code));
  return upserts;
}
export async function runPaperDay(env, date) {
  try {
    return await settlePaperDay(env, date);
  } catch (error) {
    const reason = safeError(error);
    const repository = new PaperRepository(env);
    try {
      await repository.logRun(date, "ERROR", { date, status: "ERROR", reason });
    } catch {}
    return { date, status: "ERROR", reason };
  }
}

async function settlePaperDay(env, date) {
  const repository = new RealtimeRepository(env);
  let account = await repository.initialize(await readWeights(env));
  const existing = account.book.lastDate === date;
  let settlement = null;
  let calendarDates = [];
  let calendar = null;
  // 方案 6：降级检测需要当日评分快照，提前读取（评分流水线先于盘后结算
  // 落库；缺失时当日检测跳过，次日仍按当日数据检查）。
  const snapshot = await repository.snapshot(date);
  if (!existing) {
    const from = new Date(
      new Date(`${account.book.lastDate || date}T00:00:00Z`).getTime() -
        20 * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const benchmarkCode = account.book.benchmarkCode || DEFAULT_BENCHMARK;
    calendar = await tradingCalendar(from, date, benchmarkCode);
    calendarDates = calendar.dates.filter((day) => day > date).slice(0, 10);
    if (!calendar.dates.includes(date))
      return {
        status: "NON_TRADING_DAY",
        reason: "指数行情未确认当天为交易日",
        calendarDates,
      };
    const previousDate =
      calendar.dates.filter((day) => day < date).at(-1) || null;
    if (account.book.lastDate && account.book.lastDate !== previousDate) {
      const reason =
        "存在尚未结算的交易日，请补齐已冻结计划和对应行情后重放；账户暂不跨日结算";
      await repository.logRun(date, "BLOCKED", { reason });
      // 结算失败（漏日）也必须交出未来日历：赛马窗口据此冻结结束日，
      // 漏日保留在冻结窗口内，不会被后续结算日顺延补满。
      return { status: "BLOCKED", reason, calendarDates };
    }
    // A new account never retroactively executes an older plan.
    const plan = account.book.lastDate
      ? await repository.plan(previousDate)
      : null;
    if (account.book.lastDate && !plan) {
      const reason = "缺少上一交易日事前计划，结算暂停，避免事后构造交易";
      await repository.logRun(date, "BLOCKED", { reason });
      return { status: "BLOCKED", reason, calendarDates };
    }
    // 执行前核验计划冻结的成本政策摘要（§5.4）：损坏政策不进入结算链。
    if (
      plan?.executionCostPolicy &&
      !(await verifyPolicyBundle(plan.executionCostPolicy))
    ) {
      const reason = "计划成本政策与摘要不一致，结算暂停；请重新冻结计划";
      await repository.logRun(date, "BLOCKED", { reason });
      return { status: "BLOCKED", reason, calendarDates };
    }
    const historical = await repository.history("snapshots", 30);
    const codes = new Set(
      account.book.positions.map((position) => position.code),
    );
    for (const order of plan?.orders || []) codes.add(order.code);
    for (const row of historical)
      for (const stock of JSON.parse(row.payload).stocks.slice(0, 20)) {
        if (codes.size < 600) codes.add(stock.code);
      }
    const minuteCodes = [
      ...new Set([
        ...(plan?.orders || []).map((order) => order.code),
        ...account.book.positions.map((position) => position.code),
      ]),
    ];
    const benchmark = calendar.benchmark.find((row) => row.date === date);
    const dataset = await collectTradingDay(
      date,
      [...codes],
      minuteCodes,
      benchmark,
    );
    dataset.previousTradingDate = previousDate;
    try {
      if (plan) {
        const session =
          (await repository.session(date)) ||
          openSession(account.book, plan, date);
        await assertStoredProgramPlan(env, session.plan, session.initialBook);
        dataset.executionMode = "realtime";
        settlement = closeSession(account.book, session, dataset);
        if (!session.sequence)
          settlement.notices.push(
            "当日没有实时轮询记录，不补造开盘或盘中成交；仅结算实际持仓",
          );
      } else settlement = executePlan(account.book, plan, dataset);
    } catch (error) {
      await repository.logRun(date, "BLOCKED", { reason: error.message });
      return { status: "BLOCKED", reason: error.message, calendarDates };
    }
    // 基准指数可切换：切换后按新指数当日收盘重新起算，避免跨指数混算。
    settlement.book.benchmarkCode = benchmarkCode;
    settlement.book.benchmarkBaseCents =
      account.book.benchmarkCode === benchmarkCode
        ? account.book.benchmarkBaseCents || benchmark?.closeCents || null
        : benchmark?.closeCents || null;
    settlement.equity.benchmarkReturn =
      benchmark?.closeCents && settlement.book.benchmarkBaseCents
        ? benchmark.closeCents / settlement.book.benchmarkBaseCents - 1
        : null;
    // 方案 7：做T记录提取——派生投影随结算同一 CAS 批落库。盘后路径
    // 当日成交在 settlement.ledger；实时路径逐帧已落库，从账本读回。
    let tTradeRecords = [];
    try {
      const dayFills = settlement.ledger?.length
        ? settlement.ledger
        : await repository.ledgerRowsForDate(date);
      const recoveryCodes = dayFills
        .filter((fill) => isRecoveryFill(fill))
        .map((fill) => fill.code);
      tTradeRecords = buildTTradeRecords({
        fills: dayFills,
        openRecords: await repository.openTTradesByCodes(recoveryCodes),
        now: new Date().toISOString(),
      });
    } catch (error) {
      // 做T记录是账本的派生投影：提取失败不阻断结算（下次结算同日
      // 重放可自愈），只留 notice 提示。
      settlement.notices.push(`做T记录提取失败：${error.message}`);
    }
    const saved = await repository.settle(
      account.revision,
      settlement,
      dataset,
      { tTradeRecords },
    );
    if (!saved) settlement = null;
    account = await repository.account();
    if (account.book.lastDate !== date)
      return { status: "RETRY", reason: "账户设置同时更新，请重试盘后结算" };
  } else {
    // 当日已结算的重入同样交出未来日历：否则赛马窗口在重入场景下
    // 拿不到日历，会一直 WAITING_CALENDAR 而无法冻结与评估。
    const from = new Date(
      new Date(`${date}T00:00:00Z`).getTime() - 20 * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    calendar = await tradingCalendar(from, date);
    calendarDates = calendar.dates.filter((day) => day > date).slice(0, 10);
  }
  let improvement;
  try {
    improvement = await proposeImprovement(repository, env);
  } catch {
    improvement = {
      status: "ERROR",
      reason: "改进服务暂不可用，原策略继续生成计划",
    };
  }
  account = await repository.account();
  let nextPlan = await repository.plan(date);
  // 方案 5 卖出上下文（仅生成新计划时计算；已有冻结计划不重写）：
  // 与影子组合/研究重放引用同一固化版本（exit_context_inputs，首写固化），
  // 日线 Parquet 补齐后不漂移；同一快照在任一链路得到同一上下文。
  let exitContext = null;
  if (snapshot && !nextPlan) {
    exitContext = await loadOrBuildExitContext({
      env,
      db: repository.db,
      snapshot,
      date,
    });
  }
  // 方案 7：做T质量冻结摘要与证据（仅生成新计划时汇总；已有冻结计划
  // 不重写；快照未启用规则时不携带）。tradingDates 取截至信号日的结算
  // 日历——同一信号日在任一链路（影子/重放/回测）得到同一列表，停手
  // 判定只依赖过去窗口；证据随计划冻结，核验方用证据独立重算摘要，
  // 摘要不可直接声明。
  let tQuality = null;
  let tQualityEvidence = null;
  if (snapshot && !nextPlan && tQualityEnabledForSnapshot(snapshot)) {
    try {
      const tRecords = await repository.recentTTrades();
      const tradingDates = calendar?.dates ?? [];
      tQuality = summarizeTQuality(tRecords, {
        signalDate: snapshot.date,
        tradingDates,
      });
      tQualityEvidence = buildTQualityEvidence(tRecords, tradingDates);
    } catch {
      tQuality = null; // 汇总失败退化为无闸门（旧语义），不阻断计划冻结
      tQualityEvidence = null;
    }
  }
  if (!nextPlan) {
    // 新政策从下一个尚未冻结的计划生效（§3.2）：计划冻结完整政策 bundle。
    const executionCostPolicy = await effectiveExecutionCostPolicy(env);
    const strategy = await repository.strategy(account.book);
    // 持仓股掉出当日涨停池时，从最近快照归档回查原始评分用于计划展示。
    const originalScoreLookup = await buildOriginalScoreLookup(
      repository.db,
      date,
      account.book.positions.map((position) => position.code),
    );
    nextPlan = await repository.savePlan(
      snapshot
        ? createPlan(
            snapshot,
            account.book,
            strategy,
            account.book.activeStrategy,
            new Date().toISOString(),
            {
              executionCostPolicy,
              originalScoreLookup,
              snapshotDigest: await selectionSnapshotDigest(snapshot),
              ...(exitContext ?? {}),
              ...(tQuality
                ? {
                    tQuality,
                    ...(tQualityEvidence ? { tQualityEvidence } : {}),
                  }
                : {}),
            },
          )
        : defensivePlan(
            date,
            account.book,
            strategy,
            account.book.activeStrategy,
            new Date().toISOString(),
            { executionCostPolicy, originalScoreLookup },
          ),
    );
  }
  const response = {
    status: nextPlan ? "SETTLED" : "WAITING_SNAPSHOT",
    date,
    duplicate: existing || !settlement,
    calendarDates,
    fills: settlement?.ledger.length || 0,
    equity: settlement?.equity || null,
    outcomes: settlement?.outcomes || [],
    notices: settlement?.notices || [],
    nextPlan: nextPlan
      ? {
          signalDate: nextPlan.signalDate,
          orders: nextPlan.orders.length,
          strategyVersion: nextPlan.strategyVersion,
        }
      : null,
    improvement,
    reason: nextPlan
      ? "当日账本已结算，下一交易日计划已冻结"
      : "已结算，等待当日评分后生成下一交易日计划",
  };
  const storedRun = await repository.db
    .prepare("SELECT payload FROM paper_runs WHERE trade_date=? AND status=?")
    .bind(date, "SETTLED")
    .first();
  // A repeated run cannot erase execution feedback from the original settlement.
  if (!storedRun || settlement)
    await repository.logRun(date, response.status, response);
  return response;
}

export async function exportPaper(env, attempt = 0) {
  const repository = new RealtimeRepository(env);
  const { book, revision } = await repository.initialize(
    await readWeights(env),
  );
  const rows = await Promise.all(
    [
      "paper_equity",
      "paper_ledger",
      "paper_plans",
      "paper_market_days",
      "snapshots",
      "paper_configuration_history",
      "paper_plan_revisions",
    ].map((table) => repository.history(table, 100000)),
  );
  const liveSessions = await repository.sessions();
  const liveObservations = await Promise.all(
    liveSessions.map(async (row) => ({
      date: row.payload.date,
      observations: await repository.observations(row.payload.date),
    })),
  );
  const versions = await repository.versions();
  const calibrationIds = new Set(
    rows[2]
      .map((row) => JSON.parse(row.payload).executionCostPolicy)
      .filter((p) => p && p.calibrationStatus !== "PRIOR_UNCALIBRATED")
      .map((p) => p.id),
  );
  const executionCostCalibrations = await Promise.all(
    [...calibrationIds].map((id) => calibrationForPolicy(env, id)),
  );
  if ((await repository.account()).revision !== revision) {
    if (attempt < 3) return exportPaper(env, attempt + 1);
    throw new Error("账户正在提交成交，请稍后重新导出");
  }
  return {
    format: "limit-lens-paper-v1",
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    initialCashCents: book.initialCashCents,
    book,
    riskLimits: riskLimitsForBook(book),
    feeConfig: feesForBook(book),
    executionCostPolicy: await effectiveExecutionCostPolicy(env),
    executionCostCalibrations,
    equities: rows[0].map((row) => JSON.parse(row.payload)).reverse(),
    ledger: rows[1]
      .map((row) => JSON.parse(row.payload))
      .sort((a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence),
    plans: rows[2]
      .map((row) => ({ payload: JSON.parse(row.payload), digest: row.digest }))
      .reverse(),
    datasets: rows[3]
      .map((row) => ({ payload: JSON.parse(row.payload), digest: row.digest }))
      .reverse(),
    snapshots: rows[4].map((row) => JSON.parse(row.payload)).reverse(),
    versions,
    signalSnapshots: await exportProgramSignals(
      env.DB,
      rows[2].map((row) => JSON.parse(row.payload)),
    ),
    configurationHistory: rows[5]
      .map((row) => ({ payload: JSON.parse(row.payload), digest: row.digest }))
      .reverse(),
    supersededPlans: rows[6]
      .map((row) => ({ payload: JSON.parse(row.payload), digest: row.digest }))
      .reverse(),
    realtimeSessions: liveSessions,
    realtimeObservations: liveObservations,
  };
}

export async function verifyExport(bundle) {
  const latest = bundle.book;
  const accounting = auditLedger(
    bundle.initialCashCents,
    bundle.ledger,
    latest,
    bundle.book.positions,
  );
  const plans = new Map(
    bundle.plans.map((row) => [row.payload.signalDate, row.payload]),
  );
  const liveSessions = new Map(
    (bundle.realtimeSessions || []).map((row) => [
      row.payload.date,
      row.payload,
    ]),
  );
  const liveTicks = new Map(
    (bundle.realtimeObservations || []).map((row) => [
      row.date,
      row.observations,
    ]),
  );
  let hashes = true,
    replay = true;
  let book = newBook(bundle.initialCashCents / 100);
  let fillIndex = 0;
  // 方案 7：重放成交与交易日累积——做T质量摘要的独立锚点输入（重放
  // 成交与导出账本逐条比对绑定，不可篡改；数据集日期即交易日序列）。
  const replayedFills = [];
  const replayedDates = [];
  const sourceFor = (plan) =>
    plan &&
    (bundle.signalSnapshots?.find(
      (entry) =>
        entry.digest ===
        (plan.strategyProgram?.snapshotDigest ??
          plan.selectionAudit?.snapshotDigest),
    )?.payload ??
      bundle.snapshots?.find((s) => s.date === plan.signalDate));
  try {
    for (const row of [
      ...bundle.plans,
      ...bundle.datasets,
      ...(bundle.configurationHistory || []),
      ...(bundle.supersededPlans || []),
      ...(bundle.realtimeSessions || []),
      ...(bundle.realtimeObservations || []).flatMap((row) => row.observations),
    ])
      if ((await digest(row.payload)) !== row.digest) hashes = false;
    // 冻结政策的内容寻址核验（§3.2）：计划内嵌政策 payload 必须与摘要一致，
    // 否则重放无法证明使用了声明过的成交假设。
    for (const row of bundle.plans) {
      frozenSelectionPolicy(row.payload);
      const audit = row.payload.selectionAudit;
      if (audit?.snapshotDigest) {
        const snapshot =
          bundle.signalSnapshots?.find(
            (entry) => entry.digest === audit.snapshotDigest,
          )?.payload ??
          (row.payload.strategyProgram
            ? null
            : bundle.snapshots?.find((s) => s.date === row.payload.signalDate));
        if (
          !snapshot ||
          (await selectionSnapshotDigest(snapshot)) !== audit.snapshotDigest
        )
          hashes = false;
      }
      const frozen = row.payload.executionCostPolicy;
      if (frozen && (await digest(frozen.payload)) !== frozen.payloadDigest)
        hashes = false;
      await verifyCalibratedPolicy(
        frozen,
        (bundle.executionCostCalibrations ?? []).find(
          (c) =>
            c?.report?.payloadDigest === frozen?.payloadDigest &&
            c?.report?.cutoff === frozen?.calibrationCutoff,
        ),
      );
    }
    for (let index = 0; index < bundle.datasets.length; index++) {
      const dataset = bundle.datasets[index].payload;
      const plan = index ? plans.get(dataset.previousTradingDate) : null;
      // 方案 7：做T质量摘要的独立锚点——用重放成交（截至信号日）与
      // 数据集交易日独立重算摘要，与计划声明比对：改写摘要或其证据
      // 都无法通过核验。
      if (plan?.tQuality) {
        const recomputed = summarizeTQuality(
          extractTTrades(replayedFills).records,
          { signalDate: plan.signalDate, tradingDates: replayedDates },
        );
        if (JSON.stringify(recomputed) !== JSON.stringify(plan.tQuality))
          hashes = false;
      }
      assertProgramSnapshot(plan, sourceFor(plan), book);
      if (index && (!plan || book.lastDate !== dataset.previousTradingDate)) {
        replay = false;
        break;
      }
      let result;
      if (dataset.executionMode === "realtime") {
        let session = openSession(book, plan, dataset.date),
          fills = [];
        for (const tick of liveTicks.get(dataset.date) || []) {
          const step = advanceSession(book, session, tick.payload);
          book = step.book;
          session = step.session;
          fills.push(...step.ledger);
        }
        result = closeSession(book, session, dataset);
        result.ledger = fills;
        if (!liveSessions.has(dataset.date)) replay = false;
      } else result = executePlan(book, plan, dataset);
      if (
        JSON.stringify(result.ledger) !==
        JSON.stringify(
          bundle.ledger.slice(fillIndex, fillIndex + result.ledger.length),
        )
      )
        replay = false;
      const saved = bundle.equities[index];
      if (
        !saved ||
        [
          "cashCents",
          "equityCents",
          "dailyPnlCents",
          "feesCents",
          "totalReturn",
        ].some((key) => result.equity[key] !== saved[key])
      )
        replay = false;
      fillIndex += result.ledger.length;
      book = result.book;
      replayedFills.push(...result.ledger);
      replayedDates.push(dataset.date);
    }
    for (const [date, savedSession] of [...liveSessions].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      if (date <= (book.lastDate || "")) continue;
      const plan = plans.get(book.lastDate);
      // 方案 7：未结算日的已冻结计划同样用账本锚点复核质量摘要。
      if (plan?.tQuality) {
        const recomputed = summarizeTQuality(
          extractTTrades(replayedFills).records,
          { signalDate: plan.signalDate, tradingDates: replayedDates },
        );
        if (JSON.stringify(recomputed) !== JSON.stringify(plan.tQuality))
          hashes = false;
      }
      assertProgramSnapshot(plan, sourceFor(plan), book);
      let session = openSession(book, plan, date),
        fills = [];
      for (const tick of liveTicks.get(date) || []) {
        const step = advanceSession(book, session, tick.payload);
        book = step.book;
        session = step.session;
        fills.push(...step.ledger);
      }
      if (
        JSON.stringify(fills) !==
          JSON.stringify(
            bundle.ledger.slice(fillIndex, fillIndex + fills.length),
          ) ||
        session.sequence !== savedSession.sequence ||
        savedSession.status !== "OPEN"
      )
        replay = false;
      fillIndex += fills.length;
    }
    if (
      fillIndex !== bundle.ledger.length ||
      book.equityCents !== bundle.book.equityCents ||
      JSON.stringify(book.positions) !== JSON.stringify(bundle.book.positions)
    )
      replay = false;
  } catch {
    replay = false;
  }
  return {
    passed: accounting.passed && hashes && replay,
    checks: { ...accounting.checks, hashes, replay },
    days: bundle.datasets.length,
    fills: bundle.ledger.length,
    formula: accounting.formula,
    note: "哈希检验用于发现导出文件内部变更，不是第三方签名；公开行情模拟成交不等同于券商实际成交。",
  };
}

export async function paperOverview(env, attempt = 0) {
  const repository = new RealtimeRepository(env);
  const { book, revision } = await repository.initialize(
    await readWeights(env),
  );
  const rows = await Promise.all(
    ["paper_equity", "paper_ledger", "paper_plans", "paper_runs"].map((table) =>
      repository.history(table, table === "paper_ledger" ? 100 : 120),
    ),
  );
  const equities = rows[0].map((row) => JSON.parse(row.payload)).reverse();
  // 收益曲线基准随账户设置整体重算：切换指数后历史段仍保持同一基准口径。
  const benchmarkCode = book.benchmarkCode || DEFAULT_BENCHMARK;
  if (equities.length) {
    try {
      const closes = await indexDailyCloses(
        benchmarkCode,
        equities[0].date,
        equities.at(-1).date,
      );
      const base = closes.get(equities[0].date);
      if (base)
        for (const row of equities) {
          const close = closes.get(row.date);
          row.benchmarkReturn = close ? close / base - 1 : null;
        }
    } catch {
      // 基准行情暂不可用时保留结算时记录的数值
    }
  }
  const allLedger = (await repository.history("paper_ledger", 100000)).map(
    (row) => JSON.parse(row.payload),
  );
  // 历史个股盈亏：按代码聚合全部成交的 FIFO 已实现盈亏（买入腿恒为 0，
  // 口径与 auditLedger 的全账本合计一致）。history() 按日期倒序返回，
  // 最近交易日用比较取最大值，不依赖输入顺序。
  const stockPnl = [];
  const stockPnlByCode = new Map();
  for (const fill of allLedger) {
    let row = stockPnlByCode.get(fill.code);
    if (!row) {
      row = {
        code: fill.code,
        name: fill.name,
        lastDate: fill.date,
        sellCount: 0,
        winCount: 0,
        lossCount: 0,
        realizedPnlCents: 0,
      };
      stockPnlByCode.set(fill.code, row);
      stockPnl.push(row);
    }
    if (fill.date > row.lastDate) row.lastDate = fill.date;
    if (fill.side === "SELL") {
      row.sellCount += 1;
      if (fill.realizedPnlCents > 0) row.winCount += 1;
      else if (fill.realizedPnlCents < 0) row.lossCount += 1;
    }
    row.realizedPnlCents += fill.realizedPnlCents || 0;
  }
  stockPnl.sort(
    (a, b) =>
      b.realizedPnlCents - a.realizedPnlCents || a.code.localeCompare(b.code),
  );
  const audit = auditLedger(
    book.initialCashCents,
    allLedger,
    book,
    book.positions,
  );
  const canEditCapital = await repository.canEditCapital(book),
    versions = await repository.versions(),
    strategyParams = await repository.strategy(book),
    realtime = await realtimeStatus(env);
  if ((await repository.account()).revision !== revision) {
    if (attempt < 3) return paperOverview(env, attempt + 1);
    throw new Error("账户正在更新，请稍后重试");
  }
  // 盘中实时盯市：实时执行器已把账本按"晚于最近结算日"的交易时段报价
  // 盯市，但该日尚未盘后结算时，"当日盈亏"不能再停留在上一结算日的数字；
  // 用账本现值相对会话期初净值实时计算，盘后结算写入新记录后自动回落到
  // 已结算口径。
  let equity = equities.at(-1) || null;
  const unsettled = equity
    ? await repository.latestSessionAfter(equity.date)
    : null;
  if (equity && unsettled) {
    const baseCents = unsettled.initialBook?.equityCents || equity.equityCents;
    const dailyPnlCents = book.equityCents - baseCents;
    equity = {
      ...equity,
      date: unsettled.date,
      marketValueCents: book.equityCents - book.cashCents,
      equityCents: book.equityCents,
      dailyPnlCents,
      dailyReturn: dailyPnlCents / baseCents,
      totalReturn: book.equityCents / book.initialCashCents - 1,
      unrealizedPnlCents: book.positions.reduce(
        (sum, position) =>
          sum +
          position.lots.reduce((n, lot) => n + lot.quantity, 0) *
            position.markCents -
          position.lots.reduce((n, lot) => n + lot.costCents, 0),
        0,
      ),
      drawdown: 1 - book.equityCents / book.peakEquityCents,
      complete: false,
      source: "盘中实时盯市",
    };
  }
  // 做T质量追踪（方案 7）：最近做T记录 + 质量汇总（按最近结算日为
  // 信号日口径）。日历不可用时退化为记录展示（summary 为 null）。
  let tQuality = null;
  let tTrades = [];
  try {
    tTrades = await repository.tTrades(50);
    if (book.lastDate) {
      const tFrom = new Date(
        new Date(`${book.lastDate}T00:00:00Z`).getTime() - 30 * 86400000,
      )
        .toISOString()
        .slice(0, 10);
      const tCalendar = await tradingCalendar(
        tFrom,
        book.lastDate,
        benchmarkCode,
      );
      tQuality = summarizeTQuality(await repository.recentTTrades(), {
        signalDate: book.lastDate,
        tradingDates: tCalendar.dates,
      });
    }
  } catch {
    tQuality = null;
  }
  return {
    book,
    equity,
    lastSettled: equities.at(-1) || null,
    equities,
    benchmarkCode,
    ledger: rows[1].map((row) => JSON.parse(row.payload)),
    stockPnl,
    plan: rows[2][0] ? JSON.parse(rows[2][0].payload) : null,
    run: rows[3][0] ? JSON.parse(rows[3][0].payload) : null,
    audit,
    riskLimits: riskLimitsForBook(book),
    strategyParams,
    feeConfig: feesForBook(book),
    canEditCapital,
    versions,
    ai: aiConfig(env),
    realtime,
    tTrades,
    tQuality,
  };
}
