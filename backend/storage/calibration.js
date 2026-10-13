import { canonicalJson, digestOf } from "../domain/research-lineage.js";
import {
  normalizeCalibrationInput,
  calibrationInputDigest,
  verifyExecutionCalibration,
  CALIBRATION_RULES,
  CALIBRATION_VERSION,
} from "../domain/execution-calibration.js";

const verificationCaches = new WeakMap();
const identityBackfills = new WeakMap();
const inputCaches = new WeakMap();

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function calibrationDates(input) {
  return [
    ...new Set(
      input.orders.map((o) =>
        new Date(Date.parse(o.submittedAt) + 8 * 3600_000)
          .toISOString()
          .slice(0, 10),
      ),
    ),
  ]
    .sort()
    .map((date) => ({
      date,
      role:
        date <= input.trainingEnd
          ? "CALIBRATION_TRAIN"
          : "CALIBRATION_VALIDATION",
    }));
}

// 身份只使用实际委托/成交事实。名称、盘口代理、分界和外部 ID 改名不创建新样本。
// 同一时刻的等价时区表示归一化；相同经济记录的数量保留在整个样本集摘要中。
export async function calibrationSamples(input) {
  const identities = input.orders
    .map((o) =>
      canonicalJson({
        code: o.code,
        side: o.side,
        quantity: o.quantity,
        status: o.status,
        submittedAt: new Date(o.submittedAt).toISOString(),
        completedAt: new Date(o.completedAt).toISOString(),
        fills: o.fills
          .map((f) => ({
            executedAt: new Date(f.executedAt).toISOString(),
            quantity: f.quantity,
            priceCents: f.priceCents,
          }))
          .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
      }),
    )
    .sort();
  return {
    digest: await digestOf(identities),
    identities: [...new Set(identities)],
  };
}

export async function assertIndependentCalibration(db, input) {
  const dates = calibrationDates(input).map((d) => d.date);
  const conflict = await db
    .prepare(
      `SELECT outcome_date FROM research_test_claims WHERE namespace='main' AND outcome_date IN (SELECT value FROM json_each(?))
    UNION SELECT outcome_date FROM research_sample_uses WHERE namespace='main' AND role NOT IN ('TRAIN','HISTORICAL_TRAIN') AND outcome_date IN (SELECT value FROM json_each(?)) LIMIT 1`,
    )
    .bind(JSON.stringify(dates), JSON.stringify(dates))
    .first();
  if (conflict)
    throw new Error(
      `校准日期 ${conflict.outcome_date} 与正式研究测试/前瞻日期重叠，拒绝反调成本`,
    );
}

// 0016 的输入尚无经济身份摘要。首次访问回填索引，保留最早协议及全部原始记录。
export async function ensureCalibrationIdentities(db) {
  if (identityBackfills.has(db)) return identityBackfills.get(db);
  const pending = (async () => {
    const rows = (
      await db
        .prepare(
          "SELECT id,payload FROM execution_calibration_inputs WHERE sample_digest IS NULL ORDER BY created_at,rowid",
        )
        .all()
    ).results;
    for (const row of rows) {
      const input = normalizeCalibrationInput(JSON.parse(row.payload).input);
      const samples = await calibrationSamples(input);
      // 可恢复的索引回填，最后更新完成标志；也可在研究预留的外层事务内运行。
      // 不开启嵌套事务；外层回滚后下次重新扫描 NULL 完成标志即可恢复。
      const statements = [
        db
          .prepare(
            "INSERT INTO execution_calibration_sample_sets(sample_digest,input_id) VALUES(?,?) ON CONFLICT DO NOTHING",
          )
          .bind(samples.digest, row.id),
        db
          .prepare(
            "INSERT INTO execution_calibration_sample_owners(sample_identity,input_id) SELECT value,? FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM execution_calibration_sample_owners WHERE sample_identity=j.value) ON CONFLICT DO NOTHING",
          )
          .bind(row.id, JSON.stringify(samples.identities)),
        db
          .prepare(
            "UPDATE execution_calibration_inputs SET sample_digest=? WHERE id=?",
          )
          .bind(samples.digest, row.id),
      ];
      for (const statement of statements) await statement.run();
    }
  })();
  identityBackfills.set(db, pending);
  try {
    await pending;
  } finally {
    identityBackfills.delete(db);
  }
}

export async function readCalibrationInput(db, id) {
  await ensureCalibrationIdentities(db);
  const row = await db
    .prepare("SELECT * FROM execution_calibration_inputs WHERE id=?")
    .bind(id)
    .first();
  if (!row) throw new Error("独立校准输入不存在");
  let inputs = inputCaches.get(db);
  if (!inputs) {
    inputs = new Map();
    inputCaches.set(db, inputs);
  }
  const rulesDigest = await digestOf({
    rules: CALIBRATION_RULES,
    version: CALIBRATION_VERSION,
  });
  let cached = inputs.get(id);
  if (
    !cached ||
    cached.payload !== row.payload ||
    cached.digest !== row.digest ||
    cached.rawDigest !== row.raw_digest ||
    cached.sampleDigest !== row.sample_digest ||
    cached.rulesDigest !== rulesDigest
  ) {
    const { input: rawInput, basePolicy } = JSON.parse(row.payload);
    const input = normalizeCalibrationInput(rawInput);
    const digest = await calibrationInputDigest(input, basePolicy);
    const samples = await calibrationSamples(input);
    if (
      digest !== row.digest ||
      id !== `cal-input-${digest}` ||
      row.raw_digest !== (await digestOf(input)) ||
      row.sample_digest !== samples.digest
    )
      throw new Error("校准输入 id 或摘要损坏");
    cached = {
      payload: row.payload,
      digest: row.digest,
      rawDigest: row.raw_digest,
      sampleDigest: row.sample_digest,
      rulesDigest,
      input: deepFreeze(input),
      basePolicy: deepFreeze(basePolicy),
      samples,
      identitiesJson: JSON.stringify(samples.identities),
    };
    inputs.set(id, cached);
    if (inputs.size > 4) inputs.delete(inputs.keys().next().value);
  }
  const { input, basePolicy, samples, identitiesJson } = cached;
  const owner = await db
    .prepare(
      "SELECT input_id FROM execution_calibration_sample_sets WHERE sample_digest=?",
    )
    .bind(samples.digest)
    .first();
  const owned = await db
    .prepare(
      "SELECT COUNT(*) n FROM execution_calibration_sample_owners WHERE input_id=? AND sample_identity IN (SELECT value FROM json_each(?))",
    )
    .bind(id, identitiesJson)
    .first();
  if (owner?.input_id !== id || owned.n !== samples.identities.length)
    throw new Error("校准样本已归属于首次冻结协议，不能重复拟合或改变划分");
  const registered = (
    await db
      .prepare(
        "SELECT outcome_date date,role FROM execution_calibration_date_uses WHERE input_id=? ORDER BY outcome_date",
      )
      .bind(id)
      .all()
  ).results;
  if (
    (await digestOf(registered)) !== (await digestOf(calibrationDates(input)))
  )
    throw new Error("校准日期用途登记缺失或与首次冻结划分不一致");
  await assertIndependentCalibration(db, input);
  return { row, input, basePolicy };
}

function cacheFor(db) {
  let cache = verificationCaches.get(db);
  if (!cache) {
    cache = new Map();
    verificationCaches.set(db, cache);
  }
  return cache;
}
async function verificationKey(bundle) {
  return digestOf({
    inputDigest: bundle.report.inputDigest,
    reportDigest: bundle.digest,
    rules: CALIBRATION_RULES,
    version: CALIBRATION_VERSION,
  });
}

export async function rememberGeneratedCalibration(db, bundle) {
  cacheFor(db).set(await verificationKey(bundle), {
    passed: true,
    eligible: bundle.report.passed,
    calibrationStatus: bundle.report.calibrationStatus,
  });
}

export async function readExecutionCalibration(db, id, { verify = true } = {}) {
  const row = await db
    .prepare("SELECT * FROM execution_cost_calibrations WHERE id=?")
    .bind(id)
    .first();
  if (!row) throw new Error("成本校准报告不存在");
  const { inputId, report } = JSON.parse(row.report);
  const {
    input,
    basePolicy,
    row: inputRow,
  } = await readCalibrationInput(db, inputId);
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
    (await digestOf(basePolicy)) !== (await digestOf(report.basePolicy)) ||
    row.input_digest !== inputRow.digest ||
    row.input_digest !== report.inputDigest ||
    row.cutoff !== report.cutoff
  )
    throw new Error("校准报告 id、摘要或记录元数据不一致");
  if (verify) {
    const key = await verificationKey(bundle),
      cache = cacheFor(db);
    if (!cache.has(key)) {
      const pending = verifyExecutionCalibration(bundle);
      cache.set(key, pending);
      try {
        cache.set(key, await pending);
      } catch (error) {
        cache.delete(key);
        throw error;
      }
    }
    await cache.get(key);
  }
  return bundle;
}
