import { PaperRepository } from "../storage/paper.js";
import { pendingManualExitRequests } from "../storage/manual-exits.js";
import { frozenProgramSignal } from "../storage/strategy-signals.js";
import { MANUAL_EXIT_VERSION } from "../domain/manual-exits.js";
import { createDragonPlan, isDragon } from "../domain/dragon-risk.js";
import { canonicalJson, digestOf } from "../domain/research-lineage.js";
import { marketClock } from "../domain/realtime.js";
import { executionEngineBuildDigest } from "../domain/execution-build.js";
import { assertStoredProgramPlan } from "./strategy-program-evidence.js";
import { applyDragonLifecycle } from "./dragon-risk.js";

const preparationOpen = (date, now) => {
  const clock = marketClock(now);
  return (
    (clock.date === date && clock.time >= "15:05:00") ||
    (clock.date > date && clock.time < "09:30:00")
  );
};
async function unused(db, signalDate) {
  if (
    await db
      .prepare(
        "SELECT 1 FROM paper_live_sessions WHERE json_extract(payload,'$.plan.signalDate')=? LIMIT 1",
      )
      .bind(signalDate)
      .first()
  )
    throw new Error("该计划已开始执行，不能预约改写本日清仓");
}

export async function requestManualExit(
  env,
  { code, tradeDate, reason, now = new Date() },
) {
  const papers = new PaperRepository(env),
    account = await papers.account();
  if (
    !isDragon(account?.book) ||
    !preparationOpen(account.book.lastDate, now) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) ||
    tradeDate <= account.book.lastDate ||
    Date.parse(now) >= Date.parse(`${tradeDate}T09:30:00+08:00`)
  )
    throw new Error("仅能在结算后、执行日开盘前预约清仓");
  const position = account.book.positions.find((p) => p.code === code);
  if (!position?.dragon?.id) throw new Error("不存在可预约清仓的独立政策持仓");
  await unused(env.DB, account.book.lastDate);
  const existing = (await pendingManualExitRequests(env.DB, account.book)).find(
    (row) => row.code === code,
  );
  if (existing) return { changed: false, status: "QUEUED", request: existing };
  const stamp = now.toISOString();
  const request = {
    version: MANUAL_EXIT_VERSION,
    id: `manual-exit-${crypto.randomUUID()}`,
    requestedBy: "USER",
    createdAt: stamp,
    signalDate: account.book.lastDate,
    tradeDate,
    cycleId: account.book.tradingCycleId ?? "primary",
    positionId: position.dragon.id,
    code,
    name: position.name,
    quantity: position.lots.reduce((n, lot) => n + lot.quantity, 0),
    reason: String(reason ?? "用户要求下一交易日优先清仓")
      .trim()
      .slice(0, 200),
  };
  if (!request.quantity || !request.reason)
    throw new Error("清仓数量或原因无效");
  const hash = await digestOf(request);
  await env.DB.transaction(async () => {
    const current = await papers.account();
    if (current.revision !== account.revision)
      throw new Error("持仓已变化，请重新核对后预约");
    await unused(env.DB, account.book.lastDate);
    await env.DB.prepare(
      "INSERT INTO paper_manual_exit_requests(id,cycle_id,position_id,trade_date,payload,digest,created_at) VALUES(?,?,?,?,?,?,?)",
    )
      .bind(
        request.id,
        request.cycleId,
        request.positionId,
        tradeDate,
        JSON.stringify(request),
        hash,
        stamp,
      )
      .run();
    const updated = await env.DB.prepare(
      "UPDATE paper_accounts SET revision=revision+1,last_run_id=?,updated_at=? WHERE id='primary' AND revision=?",
    )
      .bind(request.id, stamp, account.revision)
      .run();
    if (!updated.meta.changes) throw new Error("账户已变化，预约已回滚");
    const event = {
      type: "MANUAL_EXIT_REQUESTED",
      createdAt: stamp,
      requestId: request.id,
      requestDigest: hash,
      tradeDate,
      code,
      quantity: request.quantity,
    };
    await env.DB.prepare(
      "INSERT INTO paper_configuration_history(id,created_at,payload,digest) VALUES(?,?,?,?)",
    )
      .bind(request.id, stamp, JSON.stringify(event), await digestOf(event))
      .run();
  });
  return { changed: true, status: "QUEUED", request };
}

// Called before workers start and again during preparation. The command is
// separate from quotes; only a new, unused plan can acquire the instruction.
export async function prepareManualExitPlan(env, now = new Date()) {
  const papers = new PaperRepository(env);
  let account = await papers.account();
  if (
    !account ||
    !(await pendingManualExitRequests(env.DB, account.book)).length
  )
    return { changed: false };
  const date = account.book.lastDate;
  if (!preparationOpen(date, now))
    return { changed: false, status: "WAITING_PREPARATION" };
  await unused(env.DB, date);
  // Normal version lifecycle first: do not relabel an older execution build as
  // capable of a new user instruction.
  await applyDragonLifecycle(env, date, now);
  account = await papers.account();
  const requests = await pendingManualExitRequests(env.DB, account.book);
  const previousRow = await env.DB.prepare(
    "SELECT payload,digest FROM paper_plans WHERE signal_date=?",
  )
    .bind(date)
    .first();
  if (!previousRow) throw new Error("缺少待执行计划，清仓预约尚未准备完成");
  const previous = JSON.parse(previousRow.payload);
  if (
    canonicalJson(previous.manualExitRequests ?? []) === canonicalJson(requests)
  ) {
    await assertStoredProgramPlan(env, previous, account.book);
    return {
      changed: false,
      status: "PREPARED",
      requests: requests.map((row) => ({
        id: row.id,
        code: row.code,
        quantity: row.quantity,
        tradeDate: row.tradeDate,
      })),
    };
  }
  if (
    previous.engineBuild !== (await executionEngineBuildDigest()) ||
    (await digestOf(previous)) !== previousRow.digest
  )
    throw new Error("清仓计划执行版本或原摘要不一致");
  const source = await frozenProgramSignal(env.DB, previous),
    stamp = now.toISOString();
  const replacement = createDragonPlan(
    source,
    {
      ...account.book,
      feeConfig: previous.feeConfig,
      feeModel: previous.feeModel,
      feeConfigVersion: previous.feeConfigVersion,
    },
    stamp,
    {
      engineBuild: previous.engineBuild,
      dragonTemplateVersion: previous.dragonPolicy.templateVersion,
      adaptiveRiskPolicy: previous.dragonPolicy.adaptiveRiskPolicy,
      entryOrderPolicy: previous.dragonPolicy.entryOrderPolicy ?? null,
      tCapitalPolicy: previous.dragonPolicy.tCapitalPolicy ?? null,
      executionCostPolicy: previous.executionCostPolicy,
      snapshotDigest: previous.selectionAudit.snapshotDigest,
      observationUniverse: previous.entryExecutionPolicy.candidates,
      manualExitRequests: requests,
    },
  );
  const id = `manual-exit-plan-${crypto.randomUUID()}`,
    hash = await digestOf(replacement);
  await env.DB.transaction(async () => {
    await unused(env.DB, date);
    const current = await papers.account();
    const row = await env.DB.prepare(
      "SELECT digest FROM paper_plans WHERE signal_date=?",
    )
      .bind(date)
      .first();
    if (
      current.revision !== account.revision ||
      row?.digest !== previousRow.digest
    )
      throw new Error("账户或计划已变化，清仓计划修订已回滚");
    await env.DB.prepare(
      "INSERT INTO paper_plan_revisions(id,signal_date,created_at,payload,digest) VALUES(?,?,?,?,?)",
    )
      .bind(id, date, stamp, previousRow.payload, previousRow.digest)
      .run();
    await env.DB.prepare("DELETE FROM paper_plans WHERE signal_date=?")
      .bind(date)
      .run();
    await env.DB.prepare(
      "DELETE FROM dragon_plan_bindings WHERE scope='main' AND signal_date=?",
    )
      .bind(date)
      .run();
    await papers.savePlan(replacement);
    const updated = await env.DB.prepare(
      "UPDATE paper_accounts SET revision=revision+1,last_run_id=?,updated_at=? WHERE id='primary' AND revision=?",
    )
      .bind(id, stamp, account.revision)
      .run();
    if (!updated.meta.changes) throw new Error("账户已变化，清仓计划已回滚");
    const event = {
      type: "MANUAL_EXIT_PLAN_FROZEN",
      createdAt: stamp,
      signalDate: date,
      originalPlanDigest: previousRow.digest,
      planDigest: hash,
      requestIds: requests.map((row) => row.id),
    };
    await env.DB.prepare(
      "INSERT INTO paper_configuration_history(id,created_at,payload,digest) VALUES(?,?,?,?)",
    )
      .bind(id, stamp, JSON.stringify(event), await digestOf(event))
      .run();
    await assertStoredProgramPlan(env, replacement, account.book);
  });
  return {
    changed: true,
    status: "PREPARED",
    planDigest: hash,
    requests: requests.map((row) => ({
      id: row.id,
      code: row.code,
      quantity: row.quantity,
      tradeDate: row.tradeDate,
    })),
  };
}
