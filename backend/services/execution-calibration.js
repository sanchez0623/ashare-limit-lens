import { ExecutionCostRepository } from "../storage/execution-cost.js";
import { digestOf } from "../domain/research-lineage.js";
import {
  normalizeCalibrationInput,
  calibrateExecutionCost,
  verifyExecutionCalibration,
  calibrationInputDigest,
} from "../domain/execution-calibration.js";

export async function assertIndependentCalibration(db, input) {
  for (const date of new Set(
    input.orders.map((o) =>
      new Date(Date.parse(o.submittedAt) + 8 * 3600_000)
        .toISOString()
        .slice(0, 10),
    ),
  )) {
    const claim = await db
      .prepare(
        "SELECT role FROM research_test_claims WHERE namespace='main' AND outcome_date=?",
      )
      .bind(date)
      .first();
    if (claim)
      throw new Error(
        `校准日期 ${date} 与正式研究测试/前瞻日期重叠，拒绝反调成本`,
      );
  }
}

export async function importExecutionCalibration(env, rawInput) {
  const input = normalizeCalibrationInput(rawInput);
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  if (input.cutoff >= today)
    throw new Error("真实校准只能使用今日之前已完整结束的数据");
  await assertIndependentCalibration(env.DB, input);
  const rawDigest = await digestOf(input);
  const previous = await env.DB.prepare(
    "SELECT id,digest FROM execution_calibration_inputs WHERE raw_digest=?",
  )
    .bind(rawDigest)
    .first();
  if (previous)
    return { ...previous, orders: input.orders.length, cutoff: input.cutoff };
  const basePolicy = await new ExecutionCostRepository(env).latest();
  const digest = await calibrationInputDigest(input, basePolicy);
  const id = `cal-input-${digest}`;
  await env.DB.prepare(
    "INSERT INTO execution_calibration_inputs (id,payload,digest,raw_digest,created_at) VALUES (?,?,?,?,?) ON CONFLICT(raw_digest) DO NOTHING",
  )
    .bind(
      id,
      JSON.stringify({ input, basePolicy }),
      digest,
      rawDigest,
      new Date().toISOString(),
    )
    .run();
  const stored = await env.DB.prepare(
    "SELECT id,digest FROM execution_calibration_inputs WHERE raw_digest=?",
  )
    .bind(rawDigest)
    .first();
  return { ...stored, orders: input.orders.length, cutoff: input.cutoff };
}

async function loadInput(env, id) {
  const row = await env.DB.prepare(
    "SELECT * FROM execution_calibration_inputs WHERE id=?",
  )
    .bind(id)
    .first();
  if (!row) throw new Error("独立校准输入不存在");
  const { input: rawInput, basePolicy } = JSON.parse(row.payload);
  const input = normalizeCalibrationInput(rawInput);
  const digest = await calibrationInputDigest(input, basePolicy);
  if (
    digest !== row.digest ||
    id !== `cal-input-${digest}` ||
    row.raw_digest !== (await digestOf(input))
  )
    throw new Error("校准输入 id 或摘要损坏");
  await assertIndependentCalibration(env.DB, input);
  return { input, basePolicy };
}

export async function runExecutionCalibration(env, inputId) {
  const { input, basePolicy } = await loadInput(env, inputId);
  const report = await calibrateExecutionCost(input, basePolicy);
  const digest = await digestOf(report),
    id = `cal-${digest}`;
  await env.DB.prepare(
    "INSERT INTO execution_cost_calibrations (id,input_digest,cutoff,report,digest,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(
      id,
      report.inputDigest,
      report.cutoff,
      JSON.stringify({ inputId, report }),
      digest,
      new Date().toISOString(),
    )
    .run();
  return { id, inputId, digest, report };
}

export async function exportExecutionCalibration(
  env,
  id,
  { verify = true } = {},
) {
  const row = await env.DB.prepare(
    "SELECT * FROM execution_cost_calibrations WHERE id=?",
  )
    .bind(id)
    .first();
  if (!row) throw new Error("成本校准报告不存在");
  const { inputId, report } = JSON.parse(row.report);
  const { input, basePolicy } = await loadInput(env, inputId);
  const bundle = {
    schemaVersion: 1,
    id,
    inputId,
    digest: row.digest,
    input,
    report,
  };
  if (
    (await digestOf(report)) !== row.digest ||
    id !== `cal-${row.digest}` ||
    inputId !==
      `cal-input-${await calibrationInputDigest(input, basePolicy)}` ||
    (await digestOf(basePolicy)) !== (await digestOf(report.basePolicy))
  )
    throw new Error("校准报告 id 或摘要不一致");
  if (verify) await verifyExecutionCalibration(bundle);
  if (row.input_digest !== report.inputDigest || row.cutoff !== report.cutoff)
    throw new Error("校准记录元数据不一致");
  return bundle;
}

export async function listExecutionCalibrations(env) {
  const rows = (
    await env.DB.prepare(
      "SELECT id,cutoff,created_at FROM execution_cost_calibrations ORDER BY created_at DESC LIMIT 20",
    ).all()
  ).results;
  return {
    reports: rows,
    inputs: (
      await env.DB.prepare(
        "SELECT id,created_at FROM execution_calibration_inputs ORDER BY created_at DESC LIMIT 20",
      ).all()
    ).results,
  };
}

export async function calibrationForPolicy(env, policyId) {
  const row = await env.DB.prepare(
    "SELECT calibration_id FROM execution_cost_policies WHERE id=?",
  )
    .bind(policyId)
    .first();
  return row?.calibration_id
    ? await exportExecutionCalibration(env, row.calibration_id)
    : null;
}
