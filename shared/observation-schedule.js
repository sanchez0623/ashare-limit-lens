// All observation schedule times are China Standard Time (UTC+08:00).
export const OBSERVATION_SCHEDULE = Object.freeze({
  preparationEnd: "09:30:00",
  verificationStart: "17:00:00",
});

export function observationMaintenanceOpen(clock, signalDate) {
  return (
    (clock.date === signalDate &&
      clock.time >= OBSERVATION_SCHEDULE.verificationStart) ||
    (clock.date > signalDate &&
      clock.time < OBSERVATION_SCHEDULE.preparationEnd)
  );
}

export function observationVerificationOpen(clock, tradeDate) {
  return (
    clock.date > tradeDate ||
    (clock.date === tradeDate &&
      clock.time >= OBSERVATION_SCHEDULE.verificationStart)
  );
}

export function planFreezeDeadline(plan, date) {
  const intraday =
    plan?.tradingPolicyVersion === "dragon-risk-v1" ||
    (plan?.entryExecutionMode === "intraday-conditional" &&
      plan?.entryExecutionPolicy?.version === "intraday-entry-v1");
  const time = intraday ? OBSERVATION_SCHEDULE.preparationEnd : "09:15:00";
  return Date.parse(`${date}T${time}+08:00`);
}
