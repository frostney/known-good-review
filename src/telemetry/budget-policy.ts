const dayMs = 24 * 60 * 60 * 1_000;

export type BudgetAxis = "input" | "output";

export interface CompletedReviewUsage {
  readonly completedAt: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface BudgetCandidateEvaluation {
  readonly eligible: boolean;
  readonly reason:
    | "eligible"
    | "insufficient-reviews"
    | "insufficient-review-days"
    | "insufficient-span"
    | "would-interrupt"
    | "insufficient-headroom";
  readonly maximumObservedTokens: number;
  readonly simulatedInterruptions: number;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function evaluateBudgetCandidate(input: {
  readonly axis: BudgetAxis;
  readonly candidateTokens: number;
  readonly reviews: readonly CompletedReviewUsage[];
}): BudgetCandidateEvaluation {
  const completed = [...input.reviews].sort(
    (left, right) => left.completedAt - right.completedAt,
  );
  const usage = completed.map((review) =>
    input.axis === "input" ? review.inputTokens : review.outputTokens,
  );
  const maximumObservedTokens = Math.max(0, ...usage);
  const simulatedInterruptions = usage.filter(
    (tokens) => tokens > input.candidateTokens,
  ).length;
  if (completed.length < 50) {
    return {
      eligible: false,
      reason: "insufficient-reviews",
      maximumObservedTokens,
      simulatedInterruptions,
    };
  }
  const reviewDays = new Set(completed.map((review) => utcDay(review.completedAt)));
  if (reviewDays.size < 10) {
    return {
      eligible: false,
      reason: "insufficient-review-days",
      maximumObservedTokens,
      simulatedInterruptions,
    };
  }
  const first = completed[0];
  const last = completed.at(-1);
  const span = first && last ? last.completedAt - first.completedAt : 0;
  if (span < 14 * dayMs) {
    return {
      eligible: false,
      reason: "insufficient-span",
      maximumObservedTokens,
      simulatedInterruptions,
    };
  }
  if (simulatedInterruptions > 0) {
    return {
      eligible: false,
      reason: "would-interrupt",
      maximumObservedTokens,
      simulatedInterruptions,
    };
  }
  if (maximumObservedTokens > input.candidateTokens * 0.8) {
    return {
      eligible: false,
      reason: "insufficient-headroom",
      maximumObservedTokens,
      simulatedInterruptions,
    };
  }
  return {
    eligible: true,
    reason: "eligible",
    maximumObservedTokens,
    simulatedInterruptions,
  };
}

export function shadowInputExceedances(inputTokens: number): readonly number[] {
  return [2_000_000, 3_000_000, 4_000_000, 6_000_000].filter(
    (threshold) => inputTokens > threshold,
  );
}
