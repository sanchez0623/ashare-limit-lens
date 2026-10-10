export function selectResearchWindows(pairs, policy) {
  const total = policy.trainDays + policy.histTestDays;
  if (pairs.length < total)
    return {
      ready: false,
      have: pairs.length,
      need: total,
      reason: `需要至少 ${policy.trainDays} 个训练交易日和 ${policy.histTestDays} 个历史测试交易日`,
    };
  const ordered = [...pairs].sort((a, b) =>
    a.dataset.date < b.dataset.date ? -1 : 1,
  );
  for (const pair of ordered)
    if (
      pair.snapshot.date !== pair.dataset.previousTradingDate ||
      pair.snapshot.date >= pair.dataset.date
    )
      return {
        ready: false,
        reason: "冻结评分与行情不是相邻交易日，窗口不可用",
      };
  const holdout = ordered.slice(-policy.histTestDays);
  const training = ordered.slice(-total, -policy.histTestDays);
  const trainingDates = training.map((pair) => pair.dataset.date);
  const testDates = holdout.map((pair) => pair.dataset.date);
  if (new Set(trainingDates).size !== trainingDates.length)
    return { ready: false, reason: "训练窗口存在重复交易日" };
  if (new Set(testDates).size !== testDates.length)
    return { ready: false, reason: "测试窗口存在重复交易日" };
  if (trainingDates.at(-1) >= testDates[0])
    return {
      ready: false,
      reason: "训练标签与测试窗口时间边界交叉，已按政策剔除",
    };
  return {
    ready: true,
    training,
    holdout,
    trainingDates,
    testDates,
    trainingStart: trainingDates[0],
    trainingEnd: trainingDates.at(-1),
    testStart: testDates[0],
    testEnd: testDates.at(-1),
  };
}
export function beijingMonth(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).format(now);
}
