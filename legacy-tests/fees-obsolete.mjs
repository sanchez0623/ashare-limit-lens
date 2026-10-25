import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FEES,
  LEGACY_FEES,
  validFees,
  normalizeFees,
} from "../shared/fees.js";
import {
  newBook,
  createPlan,
  executePlan,
  transactionFees,
  BASE_STRATEGY,
} from "../backend/domain/trading.js";
import { PaperRepository } from "../backend/storage/paper.js";
import {
  exportPaper,
  verifyExport,
  paperOverview,
} from "../backend/services/paper.js";
import { replayStrategy } from "../backend/domain/validation.js";
import { localDatabase } from "../scripts/local-db.mjs";
import { api } from "../backend/routes/api.js";
import {
  dateAt,
  dataset,
  plan,
  order,
  snapshot,
  pairs,
} from "./fixtures/trading.mjs";

test("旧版无费用快照的导出继续按三项旧费用重放，不替换历史默认值", async () => {
  const DB = localDatabase(),
    repository = new PaperRepository({ DB });
  const initial = await repository.initialize(),
    first = dataset(dateAt(0));
  await repository.settle(
    initial.revision,
    executePlan(initial.book, null, first),
    first,
  );
  const legacy = plan([order()], dateAt(0));
  delete legacy.feeConfig;
  delete legacy.feeModel;
  delete legacy.feeConfigVersion;
  await repository.savePlan(legacy);
  const current = await repository.account(),
    data = dataset(dateAt(1));
  const result = executePlan(current.book, legacy, data);
  assert.deepEqual(
    result.ledger[0].feeBreakdown,
    transactionFees(
      result.ledger[0].notionalCents,
      "BUY",
      LEGACY_FEES,
      "legacy-v1",
    ),
  );
  assert.equal(Object.hasOwn(result.ledger[0], "feeConfig"), false);
  await repository.settle(current.revision, result, data);
  const bundle = await exportPaper({ DB });
  delete bundle.configurationHistory;
  delete bundle.supersededPlans;
  assert.equal((await verifyExport(bundle)).passed, true);
  DB.close();
});

test("AI 重放使用自定义费用；旧费用验证通过的候选不能在新费用下启用", async () => {
  const data = pairs(10),
    expensive = { ...DEFAULT_FEES, commission_min: 1000 };
  assert.ok(
    replayStrategy(data, BASE_STRATEGY, 100000, expensive).feesCents >
      replayStrategy(data, BASE_STRATEGY, 100000, DEFAULT_FEES).feesCents,
  );
  const DB = localDatabase(),
    repository = new PaperRepository({ DB });
  const account = await repository.initialize();
  await repository.recordVersion({
    id: "ai-2026-01-30",
    createdAt: new Date().toISOString(),
    status: "VALIDATED",
    params: BASE_STRATEGY,
    evidence: {
      feeConfigVersion: account.book.feeConfigVersion,
      initialCashCents: account.book.initialCashCents,
    },
  });
  await repository.configure({ fees: expensive });
  await assert.rejects(
    () => repository.activate("ai-2026-01-30"),
    /费用或资金已变更/,
  );
  DB.close();
});
