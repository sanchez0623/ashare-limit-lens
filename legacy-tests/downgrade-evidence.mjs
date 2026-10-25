import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createPlan,
  executePlan,
  assertProgramSnapshot,
} from "../backend/domain/trading.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../backend/domain/realtime.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { PaperRepository, digest } from "../backend/storage/paper.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import { assertStoredProgramPlan } from "../backend/services/strategy-program-evidence.js";
import {
  OBSERVATION_GRADE_RULES_VERSION,
  selectionSnapshotDigest,
} from "../backend/domain/signal-selection.js";
import {
  frozenProgramSignal,
  exportProgramSignals,
} from "../backend/storage/strategy-signals.js";
import { dataset, dateAt } from "./fixtures/trading.mjs";
import { BUY_POINT_TYPES } from "../shared/buy-point-type.js";

const legacy = () =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/downgrade-legacy-program.json", import.meta.url),
      "utf8",
    ),
  );

// 观察池分级是纯附加展示字段（方案 8）：旧版冻结计划不含这些字段，
// 重放时只允许新增分级注解，其余字段仍须逐字段一致。
function withoutObservationGrades(plan) {
  const { gradeRulesVersion, ...audit } = plan.selectionAudit;
  return {
    ...plan,
    selectionAudit: {
      ...audit,
      candidates: audit.candidates.map(
        ({ grade, gradeReason, ...candidate }) => candidate,
      ),
    },
  };
}

async function fixture(program = true) {
  const { book, source, strategy } = legacy();
  book.positions[0].stockClass = "relay-leader";
  source.downgradeRulesVersion = 1;
  source.stocks.push({
    ...structuredClone(source.stocks[0]),
    code: "600002",
    height: 4,
    consecutiveBoards: 4,
    score: 70,
    factors: Array.from({ length: 6 }, () => ({ value: 70 })),
  });
  if (!program) delete strategy.program;
  const plan = createPlan(
    source,
    book,
    strategy,
    program ? "downgrade-program" : "baseline-v1",
    source.createdAt,
    { snapshotDigest: await selectionSnapshotDigest(source) },
  );
  assert.deepEqual(
    plan.downgrades.map(({ code, from, to }) => ({ code, from, to })),
    [{ code: "600001", from: "relay-leader", to: "strong-reversal" }],
  );
  assert.equal(plan.orders.find((o) => o.code === "600001").action, "REDUCE");
  return { book, source, strategy, plan };
}

async function store(DB, { source, strategy, plan }) {
  const repository = new PaperRepository({ DB });
  await repository.initialize();
  if (strategy.program)
    await DB.prepare(
      "INSERT INTO strategy_versions(id,created_at,status,params,evidence) VALUES(?,?,'SHADOW_PENDING',?,'{}')",
    )
      .bind(plan.strategyVersion, plan.createdAt, JSON.stringify(strategy))
      .run();
  await DB.prepare(
    "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
  )
    .bind(source.date, source.createdAt, JSON.stringify(source))
    .run();
  return { repository, saved: await repository.savePlan(plan) };
}

test("main 5044416 冻结的程序计划：原快照已有 brokenRows，升级后仍可核验和重放", async () => {
  const f = legacy();
  assert.ok(Object.hasOwn(f.source.market, "brokenRows"));
  assert.equal(f.plan.downgradeRulesVersion, undefined);
  assert.equal(f.plan.downgrades, undefined);
  assertProgramSnapshot(f.plan, f.source, f.book);
  const replay = createPlan(
    f.source,
    f.book,
    f.strategy,
    f.plan.strategyVersion,
    f.plan.createdAt,
    { snapshotDigest: await selectionSnapshotDigest(f.source) },
  );
  assert.deepEqual(
    withoutObservationGrades(replay),
    f.plan,
    "逐字段保持旧版冻结计划（而非用新版重新生成期望值）",
  );
  assert.equal(
    replay.selectionAudit.gradeRulesVersion,
    OBSERVATION_GRADE_RULES_VERSION,
  );
  const DB = localDatabase();
  try {
    const { saved } = await store(DB, f);
    await assertStoredProgramPlan({ DB }, saved, f.book);
    const result = executePlan(
      f.book,
      saved,
      dataset(dateAt(2), "600001", { previousDate: dateAt(1) }),
    );
    assert.equal(result.book.positions[0].stockClass, "strong-reversal");
    assert.equal(result.book.positions[0].downgradedAt, undefined);
  } finally {
    DB.close();
  }
});

for (const program of [true, false]) {
  test(`${program ? "程序" : "普通"}策略：重算摘要也不能篡改、删除降级声明或降格规则版本`, async () => {
    const f = await fixture(program),
      DB = localDatabase();
    try {
      const { repository, saved } = await store(DB, f);
      await assertStoredProgramPlan({ DB }, saved, f.book);
      // 展示归档可被重新计算；核验必须仍使用不可修改的冻结输入。
      await DB.prepare("UPDATE snapshots SET payload=? WHERE trade_date=?")
        .bind(JSON.stringify(legacy().source), f.source.date)
        .run();
      assert.deepEqual(await frozenProgramSignal(DB, saved), f.source);
      await assertStoredProgramPlan({ DB }, saved, f.book);
      assert.equal((await exportProgramSignals(DB, [saved])).length, 1);
      const mutations = [
        (p) => {
          p.downgrades[0].to = "mediocre";
        },
        (p) => {
          p.downgrades[0].from = "strong-reversal";
        },
        (p) => {
          p.downgrades[0].code = "600999";
        },
        (p) => {
          p.downgrades[0].reason = "伪造原因";
        },
        (p) => {
          p.downgrades = [];
        },
        (p) => {
          p.downgrades.push({ ...p.downgrades[0] });
        },
        (p) => {
          delete p.downgrades;
        },
        (p) => {
          delete p.downgradeRulesVersion;
        },
        (p) => {
          delete p.downgradeRulesVersion;
          delete p.downgrades;
        },
        (p) => {
          p.downgradeRulesVersion = 2;
        },
        (p) => {
          delete p.downgradeRulesVersion;
          delete p.downgrades;
          delete p.selectionAudit.snapshotDigest;
          if (!program) delete p.strategyProgram;
        },
      ];
      for (const mutate of mutations) {
        const fake = structuredClone(saved);
        mutate(fake);
        await DB.prepare(
          "UPDATE paper_plans SET payload=?,digest=? WHERE signal_date=?",
        )
          .bind(JSON.stringify(fake), await digest(fake), fake.signalDate)
          .run();
        const loaded = await repository.plan(fake.signalDate);
        await assert.rejects(
          () => assertStoredProgramPlan({ DB }, loaded, f.book),
          /不一致|规则版本|声明|快照引用/,
        );
        assert.throws(
          () => assertProgramSnapshot(fake, f.source, f.book),
          /不一致|规则版本|声明/,
        );
      }
    } finally {
      DB.close();
    }
  });

  test(`${program ? "程序" : "普通"}策略：实际账本导出可重放，同步重写摘要与最终类别仍不能伪造降级`, async () => {
    const DB = localDatabase();
    try {
      const env = { DB },
        repository = new PaperRepository(env);
      let account = await repository.initialize();
      const genesis = dataset(dateAt(0));
      await repository.settle(
        account.revision,
        executePlan(account.book, null, genesis),
        genesis,
      );
      const f = await fixture(program);
      if (program)
        await DB.prepare(
          "INSERT INTO strategy_versions(id,created_at,status,params,evidence) VALUES(?,?,'SHADOW_PENDING',?,'{}')",
        )
          .bind(
            f.plan.strategyVersion,
            f.plan.createdAt,
            JSON.stringify(f.strategy),
          )
          .run();
      for (let index = 0; index < 2; index++) {
        account = await repository.account();
        const source = structuredClone(f.source);
        // 新账户采用 v5；合成建仓样本显式具备打板买点。
        for (const stock of source.stocks)
          stock.buyPoint = {
            primary: { type: BUY_POINT_TYPES.LIMIT_UP_MOMENTUM },
            all: [{ type: BUY_POINT_TYPES.LIMIT_UP_MOMENTUM }],
            labels: [BUY_POINT_TYPES.LIMIT_UP_MOMENTUM],
          };
        source.date = dateAt(index);
        source.createdAt = `${source.date}T07:10:00.000Z`;
        if (!index) source.stocks = source.stocks.slice(0, 1);
        await DB.prepare(
          "INSERT INTO snapshots(trade_date,created_at,payload) VALUES(?,?,?)",
        )
          .bind(source.date, source.createdAt, JSON.stringify(source))
          .run();
        const plan = await repository.savePlan(
          createPlan(
            source,
            account.book,
            f.strategy,
            f.plan.strategyVersion,
            source.createdAt,
            { snapshotDigest: await selectionSnapshotDigest(source) },
          ),
        );
        await assertStoredProgramPlan(env, plan, account.book);
        const day = dataset(dateAt(index + 1), "600001", {
          previousDate: dateAt(index),
        });
        await repository.settle(
          account.revision,
          executePlan(account.book, plan, day),
          day,
        );
      }
      const bundle = await exportPaper(env);
      assert.equal(bundle.book.positions[0].stockClass, "strong-reversal");
      assert.equal((await verifyExport(bundle)).passed, true);
      for (const removeVersion of [false, true]) {
        const fake = structuredClone(bundle),
          row = fake.plans.find((p) => p.payload.signalDate === dateAt(1));
        if (removeVersion) {
          delete row.payload.downgradeRulesVersion;
          delete row.payload.downgrades;
        } else {
          row.payload.downgrades[0].to = "mediocre";
          fake.book.positions[0].stockClass = "mediocre";
        }
        row.digest = await digest(row.payload);
        const verified = await verifyExport(fake);
        assert.equal(
          verified.checks.hashes,
          true,
          "攻击同步更新了所有被改动的摘要",
        );
        assert.equal(
          verified.passed,
          false,
          "声明必须从冻结输入重算，不能只靠摘要自洽",
        );
        assert.equal(verified.checks.replay, false);
      }
    } finally {
      DB.close();
    }
  });
}

test("新计划的降级状态在分钟、实时与零轮询结算保持一致，重放不改变输入", async () => {
  const { book, source, plan } = await fixture(false);
  const day = dataset(dateAt(2), "600001", { previousDate: source.date });
  const original = structuredClone(book);
  const minute = executePlan(book, plan, day);
  const session = openSession(book, plan, day.date);
  const zero = closeSession(book, session, day);
  const time = `${day.date}T09:30:00+08:00`;
  const realtime = advanceSession(book, session, {
    observedAt: new Date(time).toISOString(),
    quotes: {
      600001: {
        date: day.date,
        timestamp: time,
        previousCloseCents: 1000,
        openCents: 1000,
        closeCents: 1000,
        volumeShares: 1000000,
        limitUpCents: 1100,
        limitDownCents: 900,
      },
    },
  });
  for (const result of [minute, zero, realtime]) {
    assert.equal(result.book.positions[0].stockClass, "strong-reversal");
    assert.equal(result.book.positions[0].downgradedAt, source.date);
  }
  assert.deepEqual(book, original);
});

test("完整板块均值随原始快照冻结，替换均值会改变降级结论并被核验拒绝", async () => {
  const f = await fixture(false);
  f.source.stocks = f.source.stocks.slice(0, 1);
  f.source.stocks[0].change = 1;
  f.source.sectorPerformance = {
    date: f.source.date,
    complete: true,
    source: "synthetic-full-sector",
    sectors: [
      {
        name: "测试行业",
        memberCount: 100,
        observedCount: 100,
        averageChange: 4,
      },
    ],
  };
  f.plan = createPlan(
    f.source,
    f.book,
    f.strategy,
    f.plan.strategyVersion,
    f.plan.createdAt,
    { snapshotDigest: await selectionSnapshotDigest(f.source) },
  );
  assert.match(f.plan.downgrades[0].reason, /完整板块平均涨幅 4.00%/);
  assertProgramSnapshot(f.plan, f.source, f.book);
  const wrong = structuredClone(f.source);
  wrong.sectorPerformance.sectors[0].averageChange = 0;
  assert.throws(
    () => assertProgramSnapshot(f.plan, wrong, f.book),
    /重算不一致/,
  );
});
