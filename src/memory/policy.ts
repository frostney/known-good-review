import { createHash } from "node:crypto";

const dayMs = 24 * 60 * 60 * 1_000;

export interface MemoryPolicy {
  readonly activation: {
    readonly minimumRepositoryAgeDays: number;
    readonly dense: {
      readonly completedReviews: number;
      readonly reviewDays: number;
      readonly spanDays: number;
    };
    readonly sustained: {
      readonly completedReviews: number;
      readonly reviewDays: number;
    };
  };
  readonly tiers: {
    readonly workingReviewCount: number;
    readonly minimumWindowDays: number;
    readonly maximumWindowDays: number;
    readonly midWindowMultiplier: number;
  };
  readonly clustering: {
    readonly minimumVectorScore: number;
    readonly midTierEntriesPerCluster: number;
    readonly longTierEntriesPerCluster: number;
  };
  readonly ranking: {
    readonly recency: Readonly<Record<MemoryTier, number>>;
    readonly severity: Readonly<Record<MemorySeverity, number>>;
    readonly status: Readonly<Record<MemoryStatus, number>>;
    readonly recurrenceStep: number;
    readonly maximumRecurrenceBoost: number;
  };
}

export const memoryPolicy: MemoryPolicy = {
  activation: {
    minimumRepositoryAgeDays: 30,
    dense: { completedReviews: 50, reviewDays: 10, spanDays: 14 },
    sustained: { completedReviews: 20, reviewDays: 6 },
  },
  tiers: {
    workingReviewCount: 20,
    minimumWindowDays: 14,
    maximumWindowDays: 90,
    midWindowMultiplier: 4,
  },
  clustering: {
    minimumVectorScore: 0.82,
    midTierEntriesPerCluster: 2,
    longTierEntriesPerCluster: 1,
  },
  ranking: {
    recency: { bootstrap: 1, short: 1, mid: 0.72, long: 0.48 },
    severity: { BLOCKING: 1.25, IMPORTANT: 1.1, IMPROVEMENT: 0.9 },
    status: { open: 1.15, deferred: 1, fixed: 0.7 },
    recurrenceStep: 0.08,
    maximumRecurrenceBoost: 0.5,
  },
};

export type MemoryTier = "bootstrap" | "short" | "mid" | "long";
export type MemorySeverity = "BLOCKING" | "IMPORTANT" | "IMPROVEMENT";
export type MemoryStatus = "open" | "deferred" | "fixed";

export interface RepositoryMemoryStats {
  readonly completedReviews: number;
  readonly firstReviewAt: number | null;
  readonly lastReviewAt: number | null;
  readonly recentReviewTimes: readonly number[];
  readonly repositoryCreatedAt: number;
  readonly reviewDays: number;
}

function days(milliseconds: number): number {
  return milliseconds / dayMs;
}

function reviewSpanDays(stats: RepositoryMemoryStats): number {
  if (stats.firstReviewAt === null || stats.lastReviewAt === null) return 0;
  return days(Math.max(0, stats.lastReviewAt - stats.firstReviewAt));
}

function sustainedMinimumSpanDays(repositoryAgeDays: number): number {
  if (repositoryAgeDays < 90) return 30;
  if (repositoryAgeDays < 365) return 21;
  return 14;
}

export function tieredMemoryIsActive(
  stats: RepositoryMemoryStats,
  now: number,
  policy: MemoryPolicy = memoryPolicy,
): boolean {
  const repositoryAgeDays = days(now - stats.repositoryCreatedAt);
  if (repositoryAgeDays < policy.activation.minimumRepositoryAgeDays) {
    return false;
  }
  const spanDays = reviewSpanDays(stats);
  const dense =
    stats.completedReviews >= policy.activation.dense.completedReviews &&
    stats.reviewDays >= policy.activation.dense.reviewDays &&
    spanDays >= policy.activation.dense.spanDays;
  const sustained =
    stats.completedReviews >= policy.activation.sustained.completedReviews &&
    stats.reviewDays >= policy.activation.sustained.reviewDays &&
    spanDays >= sustainedMinimumSpanDays(repositoryAgeDays);
  return dense || sustained;
}

export function workingMemoryWindowMs(
  stats: RepositoryMemoryStats,
  policy: MemoryPolicy = memoryPolicy,
): number {
  const recent = [...stats.recentReviewTimes]
    .sort((left, right) => right - left)
    .slice(0, policy.tiers.workingReviewCount);
  const newest = recent[0] ?? 0;
  const oldest = recent.at(-1) ?? newest;
  const observedSpan = Math.max(0, newest - oldest);
  return Math.min(
    policy.tiers.maximumWindowDays * dayMs,
    Math.max(policy.tiers.minimumWindowDays * dayMs, observedSpan),
  );
}

export function memoryTier(input: {
  readonly observedAt: number;
  readonly stats: RepositoryMemoryStats;
  readonly now: number;
  readonly policy?: MemoryPolicy;
}): MemoryTier {
  const policy = input.policy ?? memoryPolicy;
  if (!tieredMemoryIsActive(input.stats, input.now, policy)) return "bootstrap";
  const age = Math.max(0, input.now - input.observedAt);
  const window = workingMemoryWindowMs(input.stats, policy);
  if (age <= window) return "short";
  if (age <= window * policy.tiers.midWindowMultiplier) return "mid";
  return "long";
}

export function durableClusterPullRequestThreshold(
  completedReviews: number,
): number {
  if (completedReviews >= 1_500) return 7;
  if (completedReviews >= 500) return 6;
  if (completedReviews >= 150) return 5;
  if (completedReviews >= 50) return 4;
  return 3;
}

export function maximumEntriesPerCluster(
  tier: MemoryTier,
  policy: MemoryPolicy = memoryPolicy,
): number | null {
  if (tier === "mid") return policy.clustering.midTierEntriesPerCluster;
  if (tier === "long") return policy.clustering.longTierEntriesPerCluster;
  return null;
}

export function memoryWeight(input: {
  readonly distinctPullRequests: number;
  readonly severity: MemorySeverity;
  readonly status: MemoryStatus;
  readonly tier: MemoryTier;
  readonly policy?: MemoryPolicy;
}): number {
  const policy = input.policy ?? memoryPolicy;
  const recurrence = Math.min(
    policy.ranking.maximumRecurrenceBoost,
    Math.max(0, input.distinctPullRequests - 1) * policy.ranking.recurrenceStep,
  );
  return (
    policy.ranking.recency[input.tier] *
    policy.ranking.severity[input.severity] *
    policy.ranking.status[input.status] *
    (1 + recurrence)
  );
}

export function memoryPolicyHash(policy: MemoryPolicy = memoryPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}
