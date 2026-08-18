// Eve grants child sessions shares of the root remainder and charges completed
// child usage back to the root. These per-session API fields therefore cap the
// complete review execution tree, not each lane independently.
export const reviewExecutionRootBudget = {
  maxInputTokensPerSession: 3_000_000,
  maxOutputTokensPerSession: 64_000,
} as const;
