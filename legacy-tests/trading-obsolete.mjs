import test from "node:test";
import assert from "node:assert/strict";
import {
  newBook,
  createPlan,
  defensivePlan,
  executePlan,
  auditLedger,
  availableQuantity,
  totalQuantity,
  protectivePyramidReduce,
  BASE_STRATEGY,
  transactionFees,
} from "../backend/domain/trading.js";
import {
  replayStrategy,
  validateProposal,
  validateCandidate,
} from "../backend/domain/validation.js";
import {
  loadOrBuildExitContext,
  loadPersistedExitInputs,
} from "../backend/services/exit-context.js";
import {
  openSession,
  advanceSession,
  closeSession,
} from "../backend/domain/realtime.js";
import {
  EXPOSURE_TIERS_DEFAULTS,
  STRATEGY_DEFAULTS,
  normalizeStrategyParams,
} from "../shared/strategy-params.js";
import {
  PaperRepository,
  buildOriginalScoreLookup,
} from "../backend/storage/paper.js";
import { exportPaper, verifyExport } from "../backend/services/paper.js";
import { requestProposal } from "../backend/services/improvement.js";
import { proposeImprovement as improveStrategy } from "../backend/services/research.js";
import { aiConfig } from "../backend/services/review.js";
import { api } from "../backend/routes/api.js";
import { localDatabase } from "../scripts/local-db.mjs";
import {
  bars,
  dataset,
  order,
  plan,
  snapshot,
  pairs,
  dateAt,
} from "./fixtures/trading.mjs";

function entered() {
  return executePlan(newBook(100000), plan([order()]), dataset(dateAt(1)));
}

test("AI 参数禁止代码、资金和风险上限修改；无改进或覆盖不足拒绝启用", () => {
  assert.throws(
    () =>
      validateProposal({ rationale: "test", patch: { maxGrossExposure: 1 } }),
    /未授权/,
  );
  assert.throws(
    () => validateProposal({ rationale: "test", patch: { stopLoss: 0.5 } }),
    /越界/,
  );
  const all = pairs();
  const train = all.slice(0, 20),
    holdout = all.slice(20, 30);
  const candidate = validateProposal({
    rationale: "测试候选",
    patch: { minScore: 85 },
  }).params;
  const good = validateCandidate(
    train,
    holdout,
    BASE_STRATEGY,
    candidate,
    100000,
  );
  assert.equal(good.passed, true, JSON.stringify(good.checks));
  assert.equal(
    validateCandidate(train, holdout, BASE_STRATEGY, BASE_STRATEGY, 100000)
      .passed,
    false,
  );
  const missing = structuredClone(holdout);
  missing[0].dataset.quotes = {};
  assert.equal(
    validateCandidate(train, missing, BASE_STRATEGY, candidate, 100000).passed,
    false,
  );
});
test("研究闸门下数据不足不发起提案，历史通过不再自动启用", async () => {
  const DB = localDatabase(),
    env = {
      DB,
      AI_API_KEY: "test-only-secret",
      AI_BASE_URL: "https://api.deepseek.com/v1",
    };
  const repository = new PaperRepository(env);
  await repository.initialize();
  const all = pairs(30);
  for (const pair of all) {
    await DB.prepare(
      "INSERT OR IGNORE INTO snapshots (trade_date,created_at,payload) VALUES (?,?,?)",
    )
      .bind(
        pair.snapshot.date,
        pair.snapshot.createdAt,
        JSON.stringify(pair.snapshot),
      )
      .run();
    await DB.prepare(
      "INSERT INTO paper_market_days (trade_date,payload,digest) VALUES (?,?,?)",
    )
      .bind(pair.dataset.date, JSON.stringify(pair.dataset), "fixture")
      .run();
  }
  let calls = 0;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              rationale: "基于训练数据过滤较弱评分",
              patch: { minScore: 85 },
            }),
          },
        },
      ],
    });
  };
  try {
    const result = await improveStrategy(repository, env, requestProposal);
    assert.equal(result.status, "COLLECTING");
    assert.deepEqual(result.required, { trainDays: 60, histTestDays: 20 });
    assert.equal(calls, 0);
    assert.equal(
      (await repository.account()).book.activeStrategy,
      "baseline-v1",
    );
  } finally {
    globalThis.fetch = fetchBefore;
    DB.close();
  }
});

// P1-1：持仓股跌出当日涨停池时，仍要通过日线 EOD 行补齐卖出信号。
// 复现用户验收用例：持仓收盘 10（元）、MA5=10.8，原实现只从评分池取行，
// 跌出池后 row=null，跌破 MA5 信号被跳过，仍按做 T 走。

// P1-2：冻结上下文复算必须得到同一决策（用户复现：仅改手续费后 EXIT 变 ADD）。

// P1-1（第二轮）：出池持仓的炸板次数接入真实炸板池记录，炸板不回封
// 信号不再漏检。复现用户验收用例：炸板 3 次、收盘涨 5%（未回封），
// 原实现 breaks 固定 null → 信号跳过，仍生成正向做 T。

// 出池持仓测试夹具：1000 股、成本 10 元，可按 markCents 调整现价、
// pyramidStage 指定已执行的金字塔档位。
function outOfPoolBook(markCents = 1000, pyramidStage = 0) {
  const book = newBook(100000);
  book.positions = [
    {
      code: "600099", // 不在 snapshot.stocks（合成池只有 600001/600002）
      name: "跌出池样本",
      sector: "测试行业",
      heldDays: 0,
      markCents,
      ...(pyramidStage ? { pyramidStage } : {}),
      lots: [
        {
          acquiredDate: dateAt(0),
          quantity: 1000,
          costCents: 1000000,
          priceCents: 1000,
        },
      ],
    },
  ];
  book.cashCents = book.initialCashCents - 1000000;
  book.equityCents = book.initialCashCents;
  book.peakEquityCents = book.equityCents;
  return book;
}

// P1-1（第三轮）：日线缺失时炸板池记录单独触发炸板不回封清仓。

// P1-1（第三轮）：炸板池明确的未封板状态优先于涨幅推断——收涨 9.8%
// 会被阈值推断误判为封板而漏检，炸板池记录是权威事实。

// P1（第三轮）：研究重放读取 pair 携带的固化卖出上下文，与主账户同日
// 决策一致。复现用户验收用例：同一策略/快照/初始持仓，主账户清仓 1000
// 股，重放缺上下文却生成买入。

// P2（第三轮）：卖出上下文输入按日期固化并绑定摘要——主账户冻结后日线
// Parquet 补齐，影子/研究重放重读仍得到首写版本，决策不漂移。

// P2（第四轮）：并发首写收敛——两条链路在空表上交错执行时都不得各自
// 采用本地计算结果，必须回读并采用实际落盘的固化版本。

// ---------- 方案 4：金字塔减仓参数化 ----------

// ---------- 方案 6：判断失误降级检测器 ----------

// 门控开启的快照：池行剥离 height/change/turnover/breaks——检测器对
// 数据缺失的触发项跳过不猜，测试只施加持仓既有的管理类别；需要触发
// 降级时显式传入带板块高度的自定义池行。
const downgradeSnapshot = (date, stocks) => {
  const snap = snapshot(date);
  snap.downgradeRulesVersion = 1;
  snap.market = { brokenRows: [] };
  snap.stocks = stocks ?? snap.stocks.map(({ height, ...rest }) => rest);
  return snap;
};

test("AI 赛马候选：pyramidReduce 向量校验", () => {
  const ok = validateProposal({
    rationale: "r",
    patch: { pyramidReduce: [0.4, 0.3, 0.2] },
  });
  assert.deepEqual(ok.params.pyramidReduce, [0.4, 0.3, 0.2]);
  for (const bad of [
    [0.4, 0.3],
    [0.4, 0.3, 0.2, 0.1],
    [0.4, 0.3, 0.6],
    [0.4, 0.3, "x"],
  ])
    assert.throws(
      () => validateProposal({ rationale: "r", patch: { pyramidReduce: bad } }),
      /金字塔/,
    );
});
