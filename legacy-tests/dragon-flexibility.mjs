import test from "node:test";
import assert from "node:assert/strict";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository } from "../backend/storage/paper.js";
import { ShadowAccountRepository } from "../backend/storage/shadow.js";
import {
  registerDragonConfig,
  dragonBookFields,
  loadDragonConfig,
} from "../backend/storage/dragon-risk.js";
import {
  saveDragonSettings,
  dragonStatus,
  refreshDragonEngine,
  applyDragonLifecycle,
  requestDragonActivation,
  requestDragonValidation,
} from "../backend/services/dragon-risk.js";
import { ensureDragonTemplateResearch } from "../backend/services/dragon-research.js";
import { preserveProgramSignal } from "../backend/storage/strategy-signals.js";
import { assertStoredProgramPlan } from "../backend/services/strategy-program-evidence.js";
import { defaultDragonConfig } from "../shared/dragon-risk-config.js";
import { defaultExecutionCostPolicy } from "../shared/execution-cost.js";
import { newBook, createPlan } from "../backend/domain/trading.js";
import { digestOf, eventDigest } from "../backend/domain/research-lineage.js";
import { executionEngineBuildDigest } from "../backend/domain/execution-build.js";
import { api } from "../backend/routes/api.js";
import { snapshot, dateAt } from "./fixtures/trading.mjs";

const signalDate = dateAt(0),
  tradeDate = dateAt(1),
  stamp = `${signalDate}T08:00:00Z`;
function changedConfig() {
  const config = defaultDragonConfig();
  Object.assign(config.advanced, {
    stopLoss: 0.05,
    tFraction: 0.18,
    tSpread: 0.03,
  });
  config.risk.maxPositions = 5;
  config.operations.lossAdd = false;
  config.buyPoints["late-dip"] = false;
  return config;
}
function source() {
  const s = snapshot(signalDate, [1000]);
  s.intradayEntryContext = {
    version: "intraday-entry-v1",
    asOf: signalDate,
    history: {
      600001: {
        name: "合成龙头",
        sector: "测试行业",
        stockClass: "relay-leader",
        amount: 500000000,
        recentLimitUp: true,
        previousCloseCents: 1000,
        previousOpenCents: 950,
        previousChange: 10,
        previousHeight: 3,
        previousTouchedLimit: true,
        lastFourCloseSumCents: 3600,
      },
    },
  };
  return s;
}
async function setup({ stale = false, active = true } = {}) {
  const DB = localDatabase(),
    env = { DB },
    repo = new PaperRepository(env);
  await repo.initialize();
  const config = defaultDragonConfig();
  let record;
  if (stale) {
    record = {
      id: "old-config",
      config,
      digest: await digestOf(config),
      engineBuild: "old-engine",
      baseId: null,
    };
    await DB.prepare(
      "INSERT INTO dragon_config_versions(id,payload,digest,engine_build,base_id,created_at) VALUES(?,?,?,?,NULL,?)",
    )
      .bind(
        record.id,
        JSON.stringify(config),
        record.digest,
        record.engineBuild,
        stamp,
      )
      .run();
  } else
    record = await registerDragonConfig(DB, config, null, {
      origin: "MANUAL",
      validationMode: "MANUAL_UNVERIFIED",
    });
  const book = {
    ...newBook(),
    lastDate: signalDate,
    ...(active ? dragonBookFields(record) : {}),
    dragonTransition: {
      state: active ? "ACTIVE" : "OBSERVING",
      configId: record.id,
      observerId: `dragon-observer:${record.id}`,
      candidate: false,
    },
  };
  await DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
    .bind(JSON.stringify(book))
    .run();
  const s = source();
  await DB.prepare(
    "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
  )
    .bind(signalDate, s.createdAt, JSON.stringify(s))
    .run();
  return { DB, env, repo, record, book, source: s };
}
async function seedDragonResearch(f) {
  const candidate = await registerDragonConfig(
    f.DB,
    changedConfig(),
    f.record.id,
    { origin: "AI" },
  );
  const book = {
    ...f.book,
    dragonTransition: {
      state: "OBSERVING",
      configId: candidate.id,
      observerId: `dragon-observer:${candidate.id}`,
      candidate: true,
    },
  };
  await f.DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
    .bind(JSON.stringify(book))
    .run();
  const manifest = JSON.stringify({ testDates: [signalDate], forwardDays: 30 }),
    report = JSON.stringify({ historical: [{ passed: true }] });
  await f.DB.prepare(
    "INSERT INTO dragon_research_runs(config_id,base_id,status,manifest,report,created_at,updated_at) VALUES(?,?,'FORWARD',?,?,?,?)",
  )
    .bind(candidate.id, f.record.id, manifest, report, stamp, stamp)
    .run();
  const owner = { ownerType: "DRAGON", ownerId: candidate.id };
  await f.DB.prepare(
    "INSERT INTO research_window_owners(namespace,owner_type,owner_id,window_payload,created_at) VALUES('main',?,?,?,?)",
  )
    .bind(owner.ownerType, owner.ownerId, manifest, stamp)
    .run();
  await f.DB.prepare(
    "INSERT INTO research_generation_slots(namespace,month,slot,owner_type,owner_id,reserved_at) VALUES('main','2026-10',1,'DRAGON',?,?)",
  )
    .bind(candidate.id, stamp)
    .run();
  await f.DB.prepare(
    "INSERT INTO dragon_research_sample_uses(trade_date,config_id,role) VALUES(?,?,'TEST')",
  )
    .bind(signalDate, candidate.id)
    .run();
  await new ShadowAccountRepository(f.env).ensureAccount(
    `dragon-observer:${candidate.id}`,
    {
      kind: "DRAGON_OBSERVATION",
      book: {
        ...newBook(),
        lastDate: signalDate,
        ...dragonBookFields(candidate),
      },
    },
  );
  return { candidate, owner, manifest, report, book };
}

test("人工一次保存所有参数：冻结计划保留，下一份计划生效并保留持仓和T基准", async () => {
  const f = await setup();
  try {
    const held = {
      code: "600001",
      name: "合成龙头",
      sector: "测试行业",
      markCents: 1000,
      lots: [{ quantity: 100, costCents: 100000, acquiredDate: signalDate }],
      dragon: {
        p0Cents: 1000,
        r0Cents: 40,
        stopCents: 960,
        strategicQuantity: 100,
        t: {
          direction: "REVERSE",
          firstQuantity: 100,
          secondQuantity: 0,
          targetCents: 980,
        },
      },
    };
    f.book.positions = [held];
    f.book.cashCents -= 100000;
    await f.DB.prepare("UPDATE paper_accounts SET state=? WHERE id='primary'")
      .bind(JSON.stringify(f.book))
      .run();
    const frozen = await f.repo.savePlan(
      createPlan(f.source, f.book, null, null, stamp, {
        executionCostPolicy: defaultExecutionCostPolicy(),
      }),
    );
    const saved = await saveDragonSettings(f.env, changedConfig());
    assert.equal(saved.dragon.provenance.origin, "MANUAL");
    assert.equal(saved.dragon.provenance.validationMode, "MANUAL_UNVERIFIED");
    assert.match(saved.dragon.validationLabel, /人工指定.*未验证/);
    assert.equal(saved.dragon.requiresResearch, false);
    assert.equal(saved.dragon.ready, true);
    assert.deepEqual(saved.book.dragonConfig, f.book.dragonConfig);
    assert.deepEqual(saved.book.positions, [held]);
    assert.deepEqual(await f.repo.plan(signalDate), frozen);
    assert.equal(
      await applyDragonLifecycle(
        f.env,
        signalDate,
        new Date(`${tradeDate}T09:00:00+08:00`),
      ),
      false,
    );
    await f.DB.prepare("DELETE FROM paper_plans WHERE signal_date=?")
      .bind(signalDate)
      .run();
    await f.DB.prepare(
      "DELETE FROM dragon_plan_bindings WHERE scope='main' AND signal_date=?",
    )
      .bind(signalDate)
      .run();
    assert.equal(
      await applyDragonLifecycle(
        f.env,
        signalDate,
        new Date(`${tradeDate}T09:00:00+08:00`),
      ),
      true,
    );
    const effective = (await f.repo.account()).book;
    assert.deepEqual(effective.dragonConfig, changedConfig());
    assert.deepEqual(effective.positions, [held]);
    assert.equal(effective.cashCents, f.book.cashCents);
    const plan = createPlan(f.source, effective, null, null, stamp, {
      executionCostPolicy: defaultExecutionCostPolicy(),
    });
    assert.equal(
      plan.dragonPolicy.provenance.validationMode,
      "MANUAL_UNVERIFIED",
    );
    assert.deepEqual(plan.dragonPolicy.config, changedConfig());
    await f.repo.savePlan(plan);
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT COUNT(*) n FROM dragon_research_runs",
        ).first()
      ).n,
      0,
    );
  } finally {
    f.DB.close();
  }
});

test("执行版本自动登记且重复调用幂等，首次启用仍需手动申请", async () => {
  const f = await setup({ stale: true, active: false });
  try {
    const results = await Promise.allSettled([
      refreshDragonEngine(f.env),
      refreshDragonEngine(f.env),
    ]);
    assert.ok(
      results.some(
        (r) => r.status === "fulfilled" && r.value.status === "REGISTERED",
      ),
    );
    assert.equal((await refreshDragonEngine(f.env)).status, "CURRENT");
    const b = (await f.repo.account()).book;
    assert.equal(b.tradingPolicyVersion, undefined);
    const record = await loadDragonConfig(f.DB, b.dragonTransition.configId);
    assert.equal(record.origin, "ENGINE_UPGRADE");
    assert.equal(record.replacesId, f.record.id);
    assert.equal(record.engineBuild, await executionEngineBuildDigest());
    assert.deepEqual(record.config, f.record.config);
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT COUNT(*) n FROM dragon_config_versions",
        ).first()
      ).n,
      2,
    );
    assert.equal((await dragonStatus(f.env)).ready, true);
    assert.equal((await requestDragonActivation(f.env)).state, "DRAINING");
  } finally {
    f.DB.close();
  }
});

test("自动升级保留未执行旧计划的修订，已执行会话不回写", async (t) => {
  for (const started of [false, true])
    await t.test(String(started), async () => {
      const f = await setup({ stale: true });
      try {
        const plan = createPlan(f.source, f.book, null, null, stamp, {
          executionCostPolicy: defaultExecutionCostPolicy(),
        });
        await preserveProgramSignal(f.DB, plan, f.source);
        const digest = await digestOf(plan);
        await f.DB.prepare(
          "INSERT INTO paper_plans(signal_date,created_at,payload,digest) VALUES(?,?,?,?)",
        )
          .bind(signalDate, stamp, JSON.stringify(plan), digest)
          .run();
        await f.DB.prepare(
          "INSERT INTO dragon_plan_bindings(scope,signal_date,config_id,plan_digest) VALUES('main',?,?,?)",
        )
          .bind(signalDate, f.record.id, digest)
          .run();
        if (started)
          await f.DB.prepare(
            "INSERT INTO paper_live_sessions(trade_date,payload,digest) VALUES(?,?,?)",
          )
            .bind(
              tradeDate,
              JSON.stringify({ status: "OPEN", plan }),
              "test-session",
            )
            .run();
        assert.equal(
          await applyDragonLifecycle(
            f.env,
            signalDate,
            new Date(`${tradeDate}T09:00:00+08:00`),
          ),
          !started,
        );
        if (started) {
          assert.equal(await digestOf(await f.repo.plan(signalDate)), digest);
          assert.equal(
            (await f.repo.account()).book.dragonEngineBuild,
            "old-engine",
          );
        } else {
          const replacement = await f.repo.plan(signalDate);
          assert.deepEqual(
            replacement.observationUniverse,
            plan.entryExecutionPolicy.candidates,
          );
          assert.equal(
            replacement.engineBuild,
            await executionEngineBuildDigest(),
          );
          await assertStoredProgramPlan(
            f.env,
            replacement,
            (await f.repo.account()).book,
          );
          const row = await f.DB.prepare(
            "SELECT payload,digest FROM paper_plan_revisions WHERE signal_date=?",
          )
            .bind(signalDate)
            .first();
          assert.equal(row.digest, digest);
          assert.deepEqual(JSON.parse(row.payload), plan);
          assert.equal(
            (await f.repo.account()).book.dragonEngineBuild,
            await executionEngineBuildDigest(),
          );
        }
      } finally {
        f.DB.close();
      }
    });
});

test("终止龙头研究后原子保存：验证输入与目标所有者，样本、预算和报告留存", async () => {
  const f = await setup();
  try {
    const trial = await seedDragonResearch(f);
    assert.deepEqual(
      { ...(await dragonStatus(f.env)).researchLock },
      trial.owner,
    );
    await assert.rejects(
      () => saveDragonSettings(f.env, changedConfig()),
      /终止当前研究/,
    );
    await assert.rejects(
      () =>
        saveDragonSettings(
          f.env,
          {
            ...changedConfig(),
            risk: { ...changedConfig().risk, maxPositions: 99 },
          },
          { cancelResearch: trial.owner },
        ),
      /允许范围/,
    );
    await assert.rejects(
      () =>
        saveDragonSettings(f.env, changedConfig(), {
          cancelResearch: { ...trial.owner, ownerId: "different" },
        }),
      /研究已变化/,
    );
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT status FROM dragon_research_runs WHERE config_id=?",
        )
          .bind(trial.candidate.id)
          .first()
      ).status,
      "FORWARD",
    );
    const saved = await saveDragonSettings(f.env, changedConfig(), {
      cancelResearch: trial.owner,
    });
    assert.equal(saved.dragon.researchLock, null);
    assert.equal(saved.dragon.requiresResearch, false);
    const run = await f.DB.prepare(
      "SELECT * FROM dragon_research_runs WHERE config_id=?",
    )
      .bind(trial.candidate.id)
      .first();
    assert.equal(run.status, "INVALIDATED");
    assert.equal(run.manifest, trial.manifest);
    assert.equal(run.report, trial.report);
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT COUNT(*) n FROM dragon_research_sample_uses",
        ).first()
      ).n,
      1,
    );
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT COUNT(*) n FROM research_generation_slots",
        ).first()
      ).n,
      1,
    );
    assert.equal(
      (
        await new ShadowAccountRepository(f.env).account(
          `dragon-observer:${trial.candidate.id}`,
        )
      ).status,
      "INVALIDATED",
    );
    await ensureDragonTemplateResearch(
      f.env,
      trial.candidate,
      { book: trial.book },
      f.source,
      new Date(),
    );
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT status FROM dragon_research_runs WHERE config_id=?",
        )
          .bind(trial.candidate.id)
          .first()
      ).status,
      "INVALIDATED",
    );
    const history = JSON.parse(
      (
        await f.DB.prepare(
          "SELECT payload FROM paper_configuration_history ORDER BY rowid DESC LIMIT 1",
        ).first()
      ).payload,
    );
    assert.equal(history.cancelledResearch.ownerId, trial.owner.ownerId);
  } finally {
    f.DB.close();
  }
});

test("研究终止遇到账户CAS冲突不会释放锁或作废研究", async () => {
  const f = await setup();
  try {
    const trial = await seedDragonResearch(f),
      batch = f.DB.batch.bind(f.DB);
    f.DB.batch = async (statements) => {
      f.DB.batch = batch;
      await f.DB.prepare(
        "UPDATE paper_accounts SET revision=revision+1 WHERE id='primary'",
      ).run();
      return batch(statements);
    };
    await assert.rejects(
      () =>
        saveDragonSettings(f.env, changedConfig(), {
          cancelResearch: trial.owner,
        }),
      /状态或研究窗口/,
    );
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT owner_id FROM research_window_owners",
        ).first()
      ).owner_id,
      trial.owner.ownerId,
    );
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT status FROM dragon_research_runs WHERE config_id=?",
        )
          .bind(trial.candidate.id)
          .first()
      ).status,
      "FORWARD",
    );
    assert.equal(
      (await f.repo.account()).book.pendingDragonConfigId,
      undefined,
    );
  } finally {
    f.DB.close();
  }
});

test("人工生效后可主动发起研究验证，参数与账本不改写，不直接冒充通过", async () => {
  const f = await setup();
  try {
    const manual = await saveDragonSettings(f.env, changedConfig());
    await assert.rejects(
      () => requestDragonValidation(f.env),
      /下一份计划生效/,
    );
    await applyDragonLifecycle(
      f.env,
      signalDate,
      new Date(`${tradeDate}T09:00:00+08:00`),
    );
    const active = (await f.repo.account()).book;
    const status = await requestDragonValidation(f.env);
    assert.equal(status.requiresResearch, true);
    assert.equal(status.ready, false);
    assert.equal(status.provenance.origin, "RESEARCH");
    assert.deepEqual(status.config, changedConfig());
    assert.deepEqual(
      (await f.repo.account()).book.dragonConfig,
      active.dragonConfig,
    );
    assert.equal(
      (await f.repo.account()).book.dragonConfigId,
      manual.book.pendingDragonConfigId,
    );
    const candidate = await loadDragonConfig(f.DB, status.configId),
      reference = await loadDragonConfig(f.DB, candidate.baseId);
    assert.deepEqual(reference.config, {
      ...f.record.config,
      risk: changedConfig().risk,
    });
    assert.deepEqual(reference.config.risk, candidate.config.risk);
    assert.equal(
      (await requestDragonValidation(f.env)).configId,
      status.configId,
    );
    await ensureDragonTemplateResearch(
      f.env,
      candidate,
      await f.repo.account(),
      f.source,
      new Date(),
    );
    assert.equal((await dragonStatus(f.env)).research.status, "COLLECTING");
    assert.equal((await dragonStatus(f.env)).ready, false);
    await assert.rejects(() => requestDragonActivation(f.env), /高级模板/);
  } finally {
    f.DB.close();
  }
});

test("人工路径不放宽AI候选；API禁止伪造来源或模糊终止指令", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      () => saveDragonSettings(f.env, changedConfig(), { origin: "AI" }),
      /AI候选/,
    );
    const config = defaultDragonConfig();
    config.advanced.tSpread = 0.025;
    const saved = await saveDragonSettings(f.env, config, { origin: "AI" });
    assert.equal(saved.dragon.requiresResearch, true);
    assert.equal(saved.dragon.ready, false);
    await assert.rejects(() => requestDragonActivation(f.env), /高级模板/);
    const send = (body) =>
      api(
        new Request("http://localhost/api/paper/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        f.env,
      );
    assert.equal(
      (await send({ dragonConfig: config, origin: "AI" })).status,
      400,
    );
    assert.equal(
      (await send({ dragonConfig: config, cancelResearch: true })).status,
      400,
    );
    const response = await send({ dragonConfig: changedConfig() });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.dragon.provenance.origin, "MANUAL");
    assert.equal(data.dragon.requiresResearch, false);
  } finally {
    f.DB.close();
  }
});

test("人工配置研究的前瞻起点绑定运行账户，与修改前对照不同也可冻结三组计划", async () => {
  const f = await setup();
  try {
    await saveDragonSettings(f.env, changedConfig());
    await applyDragonLifecycle(
      f.env,
      signalDate,
      new Date(`${tradeDate}T09:00:00+08:00`),
    );
    const status = await requestDragonValidation(f.env),
      account = await f.repo.account();
    const candidate = await loadDragonConfig(f.DB, status.configId),
      base = await loadDragonConfig(f.DB, candidate.baseId);
    const fixed = await registerDragonConfig(f.DB, base.config, base.id, {
      origin: "RESEARCH",
    });
    const manifest = {
      configId: candidate.id,
      baseId: base.id,
      engineBuild: candidate.engineBuild,
      configDigest: candidate.digest,
      initialBook: account.book,
      anchorConfigId: account.book.dragonConfigId,
      anchorConfigDigest: await digestOf(account.book.dragonConfig),
      fixed,
      forwardDays: 30,
    };
    await f.DB.prepare(
      "INSERT INTO dragon_research_runs(config_id,base_id,status,manifest,created_at,updated_at) VALUES(?,?,'FORWARD',?,?,?)",
    )
      .bind(candidate.id, base.id, JSON.stringify(manifest), stamp, stamp)
      .run();
    await f.DB.prepare(
      "INSERT INTO research_window_owners(namespace,owner_type,owner_id,window_payload,created_at) VALUES('main','DRAGON',?,'{}',?)",
    )
      .bind(candidate.id, stamp)
      .run();
    await ensureDragonTemplateResearch(
      f.env,
      candidate,
      account,
      f.source,
      new Date(`${signalDate}T17:00:00+08:00`),
    );
    assert.equal(
      (
        await f.DB.prepare(
          "SELECT status FROM dragon_research_runs WHERE config_id=?",
        )
          .bind(candidate.id)
          .first()
      ).status,
      "FORWARD",
    );
    const shadows = new ShadowAccountRepository(f.env);
    for (const prefix of [
      "dragon-observer",
      "dragon-parent",
      "dragon-baseline",
    ]) {
      const plan = await shadows.plan(`${prefix}:${candidate.id}`, signalDate);
      assert.ok(plan, `${prefix} plan`);
      assert.equal(plan.engineBuild, await executionEngineBuildDigest());
      assert.ok(plan.dragonPolicy.provenance.digest);
    }
    assert.equal(
      (await f.repo.account()).book.dragonConfigId,
      account.book.dragonConfigId,
    );
  } finally {
    f.DB.close();
  }
});

test("旧实验和赛马研究也可终止，事件链追加并保留历史结果", async (t) => {
  for (const type of ["EXPERIMENT", "COHORT"])
    await t.test(type, async () => {
      const f = await setup();
      try {
        const experimentId = "cancel-experiment",
          ownerId = type === "COHORT" ? "cancel-cohort" : experimentId;
        await f.DB.prepare(
          "INSERT INTO research_experiments(id,namespace,parent_version,policy_id,stage,reservation_payload,created_at) VALUES(?,'main','baseline-v1','policy','SHADOWING','{}',?)",
        )
          .bind(experimentId, stamp)
          .run();
        const first = {
          sequence: 1,
          eventType: "STARTED",
          createdAt: stamp,
          payload: {},
          previousDigest: null,
        };
        await f.DB.prepare(
          "INSERT INTO research_events(experiment_id,sequence,event_type,created_at,payload,previous_digest,digest) VALUES(?,1,'STARTED',?,'{}',NULL,?)",
        )
          .bind(experimentId, stamp, await eventDigest(first))
          .run();
        if (type === "COHORT") {
          await f.DB.prepare(
            "INSERT INTO strategy_cohorts(id,namespace,parent_version,policy_id,policy_digest,research_policy_id,research_policy_digest,stage,max_candidates,forward_days,reservation_manifest,created_at,updated_at) VALUES(?,'main','baseline-v1','policy','digest','research-policy','digest','RUNNING',1,30,'{}',?,?)",
          )
            .bind(ownerId, stamp, stamp)
            .run();
          await f.DB.prepare(
            "INSERT INTO strategy_cohort_members(cohort_id,member_id,slot_index,experiment_id,k,stage,created_at,updated_at) VALUES(?,'one',0,?,1,'RUNNING',?,?)",
          )
            .bind(ownerId, experimentId, stamp, stamp)
            .run();
        }
        await f.DB.prepare(
          "INSERT INTO research_window_owners(namespace,owner_type,owner_id,window_payload,created_at) VALUES('main',?,?,'{}',?)",
        )
          .bind(type, ownerId, stamp)
          .run();
        const saved = await saveDragonSettings(f.env, changedConfig(), {
          cancelResearch: { ownerType: type, ownerId },
        });
        assert.equal(saved.dragon.researchLock, null);
        assert.equal(
          (
            await f.DB.prepare(
              "SELECT stage FROM research_experiments WHERE id=?",
            )
              .bind(experimentId)
              .first()
          ).stage,
          "INVALIDATED",
        );
        const events = (
          await f.DB.prepare(
            "SELECT * FROM research_events WHERE experiment_id=? ORDER BY sequence",
          )
            .bind(experimentId)
            .all()
        ).results;
        assert.equal(events.length, 2);
        assert.equal(events[1].previous_digest, events[0].digest);
        assert.equal(
          events[1].digest,
          await eventDigest({
            sequence: 2,
            eventType: "INVALIDATED",
            createdAt: events[1].created_at,
            payload: JSON.parse(events[1].payload),
            previousDigest: events[0].digest,
          }),
        );
        if (type === "COHORT") {
          assert.equal(
            (
              await f.DB.prepare(
                "SELECT stage FROM strategy_cohorts WHERE id=?",
              )
                .bind(ownerId)
                .first()
            ).stage,
            "CLOSED",
          );
          assert.equal(
            (
              await f.DB.prepare(
                "SELECT stage FROM strategy_cohort_members WHERE cohort_id=?",
              )
                .bind(ownerId)
                .first()
            ).stage,
            "INVALIDATED",
          );
        }
      } finally {
        f.DB.close();
      }
    });
});
