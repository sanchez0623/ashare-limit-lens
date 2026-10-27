export const EXECUTION_REVIEW_KIND = "V5_EXECUTION";
export const REVIEW_ARCHIVE_START_DATE = "2026-10-26";
export { isPracticeReview } from "./practice.js";
import { PRACTICE_REVIEW_KIND } from "./practice.js";

export const isExecutionReview = (review) =>
  [EXECUTION_REVIEW_KIND, PRACTICE_REVIEW_KIND].includes(review?.reviewKind);
