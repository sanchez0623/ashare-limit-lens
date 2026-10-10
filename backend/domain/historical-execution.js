import { sanitizeMinuteSeries } from "./historical-input.js";

export const HISTORICAL_EXECUTION_VERSION = "minute-sample-v1";
export const HISTORICAL_EXECUTION_MODEL = "MINUTE_SAMPLE_V1";
export function assertCausalObservations(observations) {
  for (let index = 1; index < observations.length; index++) {
    if (
      new Date(observations[index].observedAt) <=
      new Date(observations[index - 1].observedAt)
    )
      throw new Error("研究观测时间非严格递增，违反因果顺序");
  }
  return true;
}
export function endOfDayDataset({ date, quotes, source }) {
  return {
    date,
    quotes,
    source: source ?? "历史研究（采样收盘）",
    fetchedAt: new Date().toISOString(),
  };
}
