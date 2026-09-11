// Use Eve's native root input default (40M in installed Eve 0.52.5).
// Its quota includes completed child usage; the former 8M override could stop
// reconciliation after every lane completed. Retain the separate output guard.
// Compaction is not charged here, so these limits are not a provider spend cap.
export const reviewExecutionRootBudget = {
  maxOutputTokensPerSession: 512_000,
} as const;
