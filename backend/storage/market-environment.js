import { MARKET_ENVIRONMENT_POLICY as POLICY } from "../../shared/market-environment.js";
import { digestOf } from "../domain/research-lineage.js";
import { marketEnvironmentBuildDigest } from "../domain/market-environment-build.js";
async function registerPolicyRow(db, version, policy) {
  const digest = await digestOf(policy);
  let row = await db
    .prepare("SELECT * FROM market_environment_policies WHERE version=?")
    .bind(version)
    .first();
  if (!row) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO market_environment_policies(version,payload,digest,published_at) VALUES(?,?,?,?)",
      )
      .bind(version, JSON.stringify(policy), digest, new Date().toISOString())
      .run();
    row = await db
      .prepare("SELECT * FROM market_environment_policies WHERE version=?")
      .bind(version)
      .first();
  }
  if (
    row.digest !== digest ||
    (await digestOf(JSON.parse(row.payload))) !== digest
  )
    throw new Error("市场环境同版本政策已改变，必须登记新版本");
  return row;
}
export async function registerEnvironmentPolicy(db) {
  // The definition and every implementation have separate immutable identities.
  // A rollout never overwrites a previously registered v1 policy.
  await registerPolicyRow(db, POLICY.version, POLICY);
  const implementationDigest = await marketEnvironmentBuildDigest();
  const version = `${POLICY.version}@${implementationDigest}`;
  return registerPolicyRow(db, version, {
    ...POLICY,
    implementationVersion: version,
    implementationDigest,
  });
}
export async function verifyEnvironmentOrigin(db, row) {
  const value = await verifyEnvironmentRow(row);
  if (!value) return null;
  const s = value.source;
  if (!s || s.knownAt !== row.as_of)
    throw new Error("市场环境缺少当时可得来源");
  const primary = row.scope === "primary";
  const sessionRow = await db
    .prepare(
      primary
        ? "SELECT payload,digest FROM paper_live_sessions WHERE trade_date=?"
        : "SELECT payload,digest FROM shadow_sessions WHERE trade_date=? AND account_id=?",
    )
    .bind(row.trade_date, ...(primary ? [] : [row.scope]))
    .first();
  const session = await verifyEnvironmentRow(sessionRow);
  const { digest: _transport, ...plan } = session?.plan ?? {};
  if (!session || (await digestOf(plan)) !== s.planDigest)
    throw new Error("市场环境原始计划缺失或已改变");
  let observation;
  if (primary) {
    observation = await verifyEnvironmentRow(
      await db
        .prepare(
          "SELECT payload,digest FROM paper_live_ticks WHERE trade_date=? AND sequence=?",
        )
        .bind(row.trade_date, s.sequence)
        .first(),
    );
  } else {
    const raw = await verifyEnvironmentRow(
      await db
        .prepare(
          "SELECT payload,digest FROM quote_frames WHERE trade_date=? AND observed_at=?",
        )
        .bind(row.trade_date, s.observationAt ?? row.as_of)
        .first(),
    );
    if (raw)
      observation = {
        observedAt: raw.observedAt,
        quotes: raw.quotes,
        pollIntervalSeconds: raw.pollIntervalSeconds,
        ...(raw.entryInputs ? { entryInputs: raw.entryInputs } : {}),
      };
  }
  if (!observation || (await digestOf(observation)) !== s.observationDigest)
    throw new Error("市场环境原始观测缺失或已改变");
  const policy = await db
    .prepare(
      "SELECT payload,digest FROM market_environment_policies WHERE version=?",
    )
    .bind(
      s.policyVersion ??
        value.version ??
        value.environment?.version ??
        POLICY.version,
    )
    .first();
  await verifyEnvironmentRow(policy);
  if (!policy || policy.digest !== s.policyDigest)
    throw new Error("市场环境模型登记缺失或已改变");
  return value;
}
export async function verifyEnvironmentRow(row) {
  if (!row) return null;
  const value = JSON.parse(row.payload);
  if ((await digestOf(value)) !== row.digest)
    throw new Error("市场环境证据摘要不一致");
  return value;
}
// All SELECT inserts carry the exact same account CAS guard as the ledger.
export async function environmentStatements(
  db,
  { book, session, ledger },
  observation,
  scope,
  guarded,
) {
  const environment = session.adaptiveRisk?.environment;
  if (!environment) return [];
  const policy = await registerEnvironmentPolicy(db),
    { digest: _transport, ...plan } = session.plan;
  const cycle = book.tradingCycleId ?? "primary",
    date = session.date,
    seq = session.sequence;
  const asOf = new Date(session.lastObservedAt).toISOString();
  const source = {
    planDigest: await digestOf(plan),
    observationDigest: await digestOf(observation),
    sequence: seq,
    engineBuild: plan.engineBuild,
    configDigest: plan.dragonPolicy.configDigest,
    feeDigest: await digestOf(plan.feeConfig),
    policyDigest: policy.digest,
    policyVersion: policy.version,
    knownAt: asOf,
    receivedAt: asOf,
    observationAt: observation.observedAt,
    prospective: Date.parse(policy.published_at) <= Date.parse(asOf),
  };
  const statements = [];
  const payload = { ...environment, source, scope, cycleId: cycle };
  statements.push(
    guarded(
      "INSERT OR IGNORE INTO market_environment_snapshots(id,scope,cycle_id,trade_date,sequence,as_of,payload,digest) SELECT ?,?,?,?,?,?,?,?",
      [
        `${scope}:${date}:${seq}`,
        scope,
        cycle,
        date,
        seq,
        asOf,
        JSON.stringify(payload),
        await digestOf(payload),
      ],
    ),
  );
  const record = async (kind, id, code, buyPoint, value, at = asOf) => {
    const item = { ...value, source, scope, accountCycleId: cycle, kind };
    statements.push(
      guarded(
        "INSERT OR IGNORE INTO market_environment_opportunities(id,scope,cycle_id,trade_date,code,buy_point,kind,as_of,payload,digest) SELECT ?,?,?,?,?,?,?,?,?,?",
        [
          `${scope}:${date}:${kind}:${id}`,
          scope,
          cycle,
          date,
          code,
          buyPoint,
          kind,
          new Date(at).toISOString(),
          JSON.stringify(item),
          await digestOf(item),
        ],
      ),
    );
  };
  for (const item of Object.values(session.environmentOpportunities ?? {}))
    if (item.sequence === seq)
      await record(
        "TRIGGER",
        `${item.code}:${item.buyPoint}`,
        item.code,
        item.buyPoint,
        item,
        item.observedAt,
      );
  for (const fill of ledger ?? [])
    if ((fill.intent ?? fill.action) === "OPEN")
      await record("ENTRY", fill.cycleId, fill.code, fill.buyPoint, {
        cycleId: fill.cycleId,
        fillId: fill.id,
        environment: fill.entryEvidence.environment,
        initialRiskPerShareCents: fill.entryEvidence.initialRiskPerShareCents,
      });
  for (const decision of Object.values(session.practice?.decisions ?? {}))
    if (decision.last?.observationSequence === seq && decision.code)
      await record(
        "DECISION",
        `${seq}:${decision.code}:${decision.intent}:${decision.reasonCode}:${decision.buyPoint ?? ""}`,
        decision.code,
        decision.buyPoint,
        {
          code: decision.code,
          reason: decision.reasonCode,
          sequence: seq,
          intent: decision.intent,
        },
      );
  return statements;
}
