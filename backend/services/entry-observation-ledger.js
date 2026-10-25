import { ShadowAccountRepository } from "../storage/shadow.js";
import { ENTRY_OBSERVER_ID } from "./entry-observation.js";

function positionValue(book, code) {
  const position = book.positions?.find((item) => item.code === code);
  if (!position)
    return { quantity: 0, marketValueCents: 0, unrealizedPnlCents: 0 };
  const quantity = position.lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const costCents = position.lots.reduce((sum, lot) => sum + lot.costCents, 0);
  const markCents = position.markCents > 0 ? position.markCents : null;
  const marketValueCents = markCents === null ? null : quantity * markCents;
  const unrealizedPnlCents =
    marketValueCents === null ? null : marketValueCents - costCents;
  return {
    quantity,
    markCents,
    markDate: position.markDate ?? null,
    marketValueCents,
    unrealizedPnlCents,
    unrealizedReturn:
      costCents > 0 && unrealizedPnlCents !== null
        ? unrealizedPnlCents / costCents
        : null,
  };
}

// 按执行账本的 T+1、先进先出和逐次四舍五入规则还原剩余批次。
// 买入行只展示该批次剩余浮盈，已卖部分的收益由卖出行展示，避免重复计算。
function fillPnlById(initialBook, book, fills) {
  const lotsByCode = new Map();
  const invalid = new Set();
  const result = new Map();
  for (const position of initialBook.positions ?? []) {
    lotsByCode.set(position.code, structuredClone(position.lots));
  }
  for (const fill of fills) {
    const lots = lotsByCode.get(fill.code) ?? [];
    lotsByCode.set(fill.code, lots);
    if (
      !Number.isInteger(fill.quantity) ||
      fill.quantity <= 0 ||
      !Number.isSafeInteger(fill.cashDeltaCents) ||
      !["BUY", "SELL"].includes(fill.side)
    ) {
      invalid.add(fill.code);
      continue;
    }
    if (fill.side === "BUY") {
      if (fill.cashDeltaCents >= 0) {
        invalid.add(fill.code);
        continue;
      }
      lots.push({
        fillId: fill.id,
        acquiredDate: fill.date,
        quantity: fill.quantity,
        costCents: -fill.cashDeltaCents,
      });
      continue;
    }
    let remaining = fill.quantity;
    let basisCents = 0;
    for (const lot of lots) {
      if (!remaining) break;
      if (lot.acquiredDate >= fill.date || !lot.quantity) continue;
      const taken = Math.min(remaining, lot.quantity);
      const cost =
        taken === lot.quantity
          ? lot.costCents
          : Math.round((lot.costCents * taken) / lot.quantity);
      lot.quantity -= taken;
      lot.costCents -= cost;
      basisCents += cost;
      remaining -= taken;
    }
    if (
      remaining ||
      (Number.isFinite(fill.basisCents) && fill.basisCents !== basisCents)
    )
      invalid.add(fill.code);
    // 卖出盈亏优先使用账本已记录的实际成本与费用。
    const basis = Number.isFinite(fill.basisCents)
      ? fill.basisCents
      : basisCents;
    const pnlCents = fill.cashDeltaCents - basis;
    result.set(fill.id, {
      kind: "REALIZED",
      pnlCents: !remaining && !invalid.has(fill.code) ? pnlCents : null,
      return:
        basis > 0 && !remaining && !invalid.has(fill.code)
          ? pnlCents / basis
          : null,
    });
  }
  for (const [code, lots] of lotsByCode) {
    const current = positionValue(book, code);
    const position = book.positions?.find((item) => item.code === code);
    const currentCost = (position?.lots ?? []).reduce(
      (sum, lot) => sum + lot.costCents,
      0,
    );
    if (
      lots.reduce((sum, lot) => sum + lot.quantity, 0) !== current.quantity ||
      lots.reduce((sum, lot) => sum + lot.costCents, 0) !== currentCost
    )
      invalid.add(code);
    for (const lot of lots) {
      if (!lot.fillId) continue;
      const pnlCents = invalid.has(code)
        ? null
        : lot.quantity === 0
          ? 0
          : current.markCents > 0
            ? lot.quantity * current.markCents - lot.costCents
            : null;
      result.set(lot.fillId, {
        kind: "UNREALIZED",
        remainingQuantity: lot.quantity,
        pnlCents,
        return:
          lot.costCents > 0 && pnlCents !== null
            ? pnlCents / lot.costCents
            : null,
      });
    }
  }
  return result;
}

// 明细分页只限制成交行；盈亏以完整观察期和同一版影子账户状态计算。
export async function entryObservationLedger(env, options = {}, attempt = 0) {
  const shadows = new ShadowAccountRepository(env);
  const account = await shadows.account(ENTRY_OBSERVER_ID);
  const page = await shadows.ledgerPage(ENTRY_OBSERVER_ID, options);
  if (!account) return { ...page, pnl: null };
  const [baseline, cashFlows, fills] = await Promise.all([
    shadows.db
      .prepare(
        `SELECT trade_date AS date, json_extract(payload, '$.initialBook') AS book
       FROM shadow_sessions WHERE account_id = ? ORDER BY trade_date LIMIT 1`,
      )
      .bind(ENTRY_OBSERVER_ID)
      .first(),
    shadows.db
      .prepare(
        `SELECT json_extract(payload, '$.code') AS code,
        MAX(json_extract(payload, '$.name')) AS name,
        SUM(COALESCE(json_extract(payload, '$.cashDeltaCents'), 0)) AS cashDeltaCents,
        SUM(CASE WHEN json_type(payload, '$.cashDeltaCents') IN ('integer', 'real') THEN 0 ELSE 1 END) AS missingCashFlows
       FROM shadow_ledger WHERE account_id = ?
       GROUP BY json_extract(payload, '$.code')`,
      )
      .bind(ENTRY_OBSERVER_ID)
      .all(),
    shadows.db
      .prepare(
        `SELECT id, trade_date AS date,
        json_extract(payload, '$.code') AS code,
        json_extract(payload, '$.side') AS side,
        json_extract(payload, '$.quantity') AS quantity,
        json_extract(payload, '$.cashDeltaCents') AS cashDeltaCents,
        json_extract(payload, '$.basisCents') AS basisCents
       FROM shadow_ledger WHERE account_id = ?
       ORDER BY trade_date, COALESCE(CAST(json_extract(payload, '$.sequence') AS INTEGER), 0), id`,
      )
      .bind(ENTRY_OBSERVER_ID)
      .all(),
  ]);
  const latest = await shadows.db
    .prepare("SELECT revision FROM shadow_accounts WHERE account_id = ?")
    .bind(ENTRY_OBSERVER_ID)
    .first();
  if (latest?.revision !== account.revision) {
    if (attempt < 2) return entryObservationLedger(env, options, attempt + 1);
    throw new Error("影子账户正在更新，请刷新明细重试");
  }
  const initialBook = baseline?.book ? JSON.parse(baseline.book) : null;
  if (!initialBook || !Number.isFinite(initialBook.equityCents))
    return { ...page, pnl: null };
  const book = account.book;
  const totalPnlCents = book.equityCents - initialBook.equityCents;
  const unrealized = (book.positions ?? []).map(
    (position) => positionValue(book, position.code).unrealizedPnlCents,
  );
  const flows = new Map(cashFlows.results.map((row) => [row.code, row]));
  const codes = [
    ...new Set([
      ...flows.keys(),
      ...(initialBook.positions ?? []).map((p) => p.code),
      ...(book.positions ?? []).map((p) => p.code),
    ]),
  ]
    .filter((code) => /^\d{6}$/.test(code))
    .sort();
  const stocks = codes.map((code) => {
    const current = positionValue(book, code);
    const initial = positionValue(initialBook, code);
    const flow = flows.get(code);
    return {
      code,
      name:
        book.positions?.find((p) => p.code === code)?.name ??
        initialBook.positions?.find((p) => p.code === code)?.name ??
        flow?.name ??
        code,
      quantity: current.quantity,
      markCents: current.markCents ?? null,
      markDate: current.markDate ?? null,
      unrealizedPnlCents: current.unrealizedPnlCents,
      unrealizedReturn: current.unrealizedReturn ?? null,
      totalPnlCents:
        !flow?.missingCashFlows &&
        current.marketValueCents !== null &&
        initial.marketValueCents !== null
          ? (flow?.cashDeltaCents ?? 0) +
            current.marketValueCents -
            initial.marketValueCents
          : null,
    };
  });
  const byCode = new Map(stocks.map((stock) => [stock.code, stock]));
  const byFill = fillPnlById(initialBook, book, fills.results);
  return {
    ...page,
    stocks,
    pnl: {
      baselineDate: baseline.date,
      baselineEquityCents: initialBook.equityCents,
      equityCents: book.equityCents,
      totalPnlCents,
      totalReturn:
        initialBook.equityCents > 0
          ? totalPnlCents / initialBook.equityCents
          : null,
      unrealizedPnlCents: unrealized.every(Number.isFinite)
        ? unrealized.reduce((sum, value) => sum + value, 0)
        : null,
      updatedAt: account.updatedAt,
    },
    rows: page.rows.map((row) => ({
      ...row,
      stockPnl: byCode.get(row.code) ?? null,
      fillPnl: byFill.get(row.id) ?? null,
    })),
  };
}
