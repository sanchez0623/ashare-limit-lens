export const EXECUTION_REVIEW_KIND = "V5_EXECUTION";

export const isExecutionReview = (review) =>
  review?.reviewKind === EXECUTION_REVIEW_KIND;
