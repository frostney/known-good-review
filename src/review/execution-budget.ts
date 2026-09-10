// Eve grants child sessions shares of the root remainder and charges completed
// child usage back to the root. These per-session API fields therefore limit
// ordinary model usage across the review tree. Eve 0.52 does not charge its
// compaction generations to this budget; it is not a total provider spend cap.
export const reviewExecutionRootBudget = {
  maxInputTokensPerSession: 8_000_000,
  maxOutputTokensPerSession: 512_000,
} as const;
