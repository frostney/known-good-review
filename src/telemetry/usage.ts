import type { ReviewAxis } from "../review/axes";

export interface InvocationUsage {
  readonly actualModel: string;
  readonly attempt: number;
  readonly axis: ReviewAxis | "coordinator" | "revalidation";
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly fallbackReason: string | null;
  readonly inputTokens: number;
  readonly outcome: "cancelled" | "failed" | "succeeded";
  readonly outputTokens: number;
  readonly requestedModel: string;
  readonly reviewKind: "delta" | "full" | "revalidation";
}

export interface UsageSummary {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly invocations: number;
  readonly models: readonly string[];
  readonly outputTokens: number;
}

export function summarizeUsage(
  entries: readonly InvocationUsage[],
): UsageSummary {
  return {
    cacheReadTokens: entries.reduce(
      (total, entry) => total + entry.cacheReadTokens,
      0,
    ),
    cacheWriteTokens: entries.reduce(
      (total, entry) => total + entry.cacheWriteTokens,
      0,
    ),
    costUsd: entries.reduce((total, entry) => total + entry.costUsd, 0),
    durationMs: entries.reduce((total, entry) => total + entry.durationMs, 0),
    inputTokens: entries.reduce(
      (total, entry) => total + entry.inputTokens,
      0,
    ),
    invocations: entries.length,
    models: [...new Set(entries.map((entry) => entry.actualModel))],
    outputTokens: entries.reduce(
      (total, entry) => total + entry.outputTokens,
      0,
    ),
  };
}
