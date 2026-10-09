// All prices in this file are explicitly synthetic test fixtures.
export const dateAt = (index) =>
  new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
export function bars(price = 1000, changes = {}) {
  const rows = [];
  for (const [start, end] of [
    [570, 690],
    [780, 900],
  ]) {
    for (let minute = start; minute <= end; minute++) {
      const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      rows.push({
        time,
        priceCents: changes[time] ?? price,
        volumeShares: 10000000,
      });
    }
  }
  return rows;
}
export function dataset(date, code = "600001", options = {}) {
  const price = options.open ?? 1000;
  return {
    date,
    previousTradingDate: options.previousDate ?? dateAt(0),
    source: "synthetic-test-fixture",
    quotes: {
      [code]: {
        date,
        previousCloseCents: options.previous ?? 1000,
        openCents: price,
        closeCents: options.close ?? price,
        limitUpCents: options.limitUp ?? 1100,
        limitDownCents: options.limitDown ?? 900,
      },
    },
    minutes: { [code]: options.minutes ?? bars(price) },
  };
}
export function order(action = "OPEN", quantity = 1000, options = {}) {
  return {
    id: `fixture:${action}`,
    code: "600001",
    name: "合成样本",
    sector: "测试行业",
    score: 90,
    referenceCents: 1000,
    action,
    side: ["OPEN", "ADD"].includes(action)
      ? "BUY"
      : ["T_FORWARD", "T_REVERSE"].includes(action)
        ? "PAIR"
        : action === "HOLD"
          ? "NONE"
          : "SELL",
    quantity,
    maxPriceCents: 1040,
    stopCents: 940,
    takeProfitCents: 1120,
    buyTriggerCents: 980,
    sellTriggerCents: 1020,
    ...options,
  };
}
export function plan(orders, date = dateAt(0)) {
  return {
    signalDate: date,
    createdAt: `${date}T07:10:00.000Z`,
    strategyVersion: "baseline-v1",
    orders,
  };
}
export function snapshot(date, prices = [1000, 1000]) {
  return {
    date,
    createdAt: `${date}T07:10:00.000Z`,
    emotion: 70,
    sectors: [{ name: "测试行业", score: 75 }],
    stocks: [90, 82].map((score, index) => ({
      code: `60000${index + 1}`,
      name: `合成样本${index + 1}`,
      sector: "测试行业",
      score,
      deduction: 0,
      factors: Array.from({ length: 6 }, () => ({ value: score })),
      coverage: 100,
      height: 1,
      risks: [],
      price: prices[index] / 100,
    })),
  };
}
export function pairs(count = 40) {
  const result = [];
  let prices = [1000, 1000];
  for (let index = 1; index <= count; index++) {
    const previous = [...prices];
    const frozen = snapshot(dateAt(index - 1), previous);
    prices = [Math.round(previous[0] * 1.007), Math.round(previous[1] * 0.99)];
    const day = {
      date: dateAt(index),
      previousTradingDate: dateAt(index - 1),
      source: "synthetic-test-fixture",
      quotes: {},
      minutes: {},
    };
    for (let stock = 0; stock < 2; stock++) {
      const code = `60000${stock + 1}`;
      day.quotes[code] = {
        date: day.date,
        previousCloseCents: previous[stock],
        openCents: prices[stock],
        closeCents: prices[stock],
        limitUpCents: Math.round(previous[stock] * 1.1),
        limitDownCents: Math.round(previous[stock] * 0.9),
      };
      day.minutes[code] = bars(prices[stock]);
    }
    result.push({ snapshot: frozen, dataset: day });
  }
  return result;
}
