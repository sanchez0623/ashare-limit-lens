import { ExecutionCostRepository } from "../storage/execution-cost.js";
import { digestOf } from "../domain/research-lineage.js";
import {
  normalizeCalibrationInput,
  calibrateExecutionCost,
  calibrationInputDigest,
} from "../domain/execution-calibration.js";
import {
  assertIndependentCalibration,
  calibrationDates,
  calibrationSamples,
  ensureCalibrationIdentities,
  readCalibrationInput,
  readExecutionCalibration,
  rememberGeneratedCalibration,
} from "../storage/calibration.js";
export { assertIndependentCalibration } from "../storage/calibration.js";

export async function importExecutionCalibration(env, rawInput) {
  const input = normalizeCalibrationInput(rawInput);
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  if (input.cutoff >= today)
    throw new Error("真实校准只能使用今日之前已完整结束的数据");
  await assertIndependentCalibration(env.DB, input);
  await ensureCalibrationIdentities(env.DB);
  const samples = await calibrationSamples(input);
  const rawDigest = await digestOf(input);
  const previous = await env.DB.prepare(
    "SELECT input_id FROM execution_calibration_sample_sets WHERE sample_digest=?",
  )
    .bind(samples.digest)
    .first();
  const frozenResult = async (id) => {
    const { row, input: original } = await readCalibrationInput(env.DB, id);
    return {
      id,
      digest: row.digest,
      orders: original.orders.length,
      cutoff: original.cutoff,
      trainingEnd: original.trainingEnd,
    };
  };
  if (previous) return frozenResult(previous.input_id);
  const reused = await env.DB.prepare(
    "SELECT input_id FROM execution_calibration_sample_owners WHERE sample_identity IN (SELECT value FROM json_each(?)) LIMIT 1",
  )
    .bind(JSON.stringify(samples.identities))
    .first();
  if (reused)
    throw new Error(
      "实际委托/成交样本已用于校准，不能通过子集或补单重用验证样本",
    );
  const basePolicy = await new ExecutionCostRepository(env).latest();
  const digest = await calibrationInputDigest(input, basePolicy);
  const id = `cal-input-${digest}`;
  const ownsSet =
    "EXISTS (SELECT 1 FROM execution_calibration_sample_sets WHERE sample_digest=? AND input_id=?)";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO execution_calibration_inputs(id,payload,digest,raw_digest,created_at,sample_digest) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM execution_calibration_sample_sets WHERE sample_digest=?) ON CONFLICT(raw_digest) DO NOTHING",
    ).bind(
      id,
      JSON.stringify({ input, basePolicy }),
      digest,
      rawDigest,
      new Date().toISOString(),
      samples.digest,
      samples.digest,
    ),
    env.DB.prepare(
      "INSERT INTO execution_calibration_sample_sets(sample_digest,input_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM execution_calibration_inputs WHERE id=?) ON CONFLICT DO NOTHING",
    ).bind(samples.digest, id, id),
    env.DB.prepare(
      `INSERT INTO execution_calibration_sample_owners(sample_identity,input_id) SELECT value,? FROM json_each(?) WHERE ${ownsSet} AND true ON CONFLICT(sample_identity) DO UPDATE SET input_id=excluded.input_id WHERE execution_calibration_sample_owners.input_id=excluded.input_id`,
    ).bind(id, JSON.stringify(samples.identities), samples.digest, id),
    ...calibrationDates(input).map((d) =>
      env.DB.prepare(
        `INSERT INTO execution_calibration_date_uses(input_id,outcome_date,role) SELECT ?,?,? WHERE ${ownsSet} ON CONFLICT DO NOTHING`,
      ).bind(id, d.date, d.role, samples.digest, id),
    ),
  ]);
  const stored = await env.DB.prepare(
    "SELECT input_id FROM execution_calibration_sample_sets WHERE sample_digest=?",
  )
    .bind(samples.digest)
    .first();
  if (!stored) throw new Error("校准样本预留冲突，输入未完整登记");
  return frozenResult(stored.input_id);
}

export async function runExecutionCalibration(env, inputId) {
  const { input, basePolicy } = await readCalibrationInput(env.DB, inputId);
  const existing = await env.DB.prepare(
    "SELECT id FROM execution_cost_calibrations WHERE input_digest=? ORDER BY created_at LIMIT 1",
  )
    .bind(await calibrationInputDigest(input, basePolicy))
    .first();
  if (existing) {
    const bundle = await readExecutionCalibration(env.DB, existing.id);
    return {
      id: bundle.id,
      inputId,
      digest: bundle.digest,
      report: bundle.report,
    };
  }
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
  await rememberGeneratedCalibration(env.DB, {
    input,
    inputId,
    report,
    digest,
    id,
  });
  return { id, inputId, digest, report };
}

export async function exportExecutionCalibration(
  env,
  id,
  { verify = true } = {},
) {
  return readExecutionCalibration(env.DB, id, { verify });
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
