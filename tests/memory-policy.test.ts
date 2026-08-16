import { describe, expect, test } from "bun:test";
import {
  durableClusterPullRequestThreshold,
  maximumEntriesPerCluster,
  memoryTier,
  memoryWeight,
  tieredMemoryIsActive,
  workingMemoryWindowMs,
  type RepositoryMemoryStats,
} from "../src/memory/policy";

const dayMs = 24 * 60 * 60 * 1_000;

function stats(
  overrides: Partial<RepositoryMemoryStats> = {},
): RepositoryMemoryStats {
  return {
    completedReviews: 0,
    firstReviewAt: null,
    lastReviewAt: null,
    recentReviewTimes: [],
    repositoryCreatedAt: 0,
    reviewDays: 0,
    ...overrides,
  };
}

describe("adaptive repository memory policy", () => {
  test("stays in bootstrap until repository age and evidence gates pass", () => {
    const now = 60 * dayMs;
    expect(
      tieredMemoryIsActive(
        stats({
          completedReviews: 50,
          firstReviewAt: 40 * dayMs,
          lastReviewAt: 59 * dayMs,
          repositoryCreatedAt: 40 * dayMs,
          reviewDays: 10,
        }),
        now,
      ),
    ).toBe(false);
    expect(
      tieredMemoryIsActive(
        stats({
          completedReviews: 50,
          firstReviewAt: 40 * dayMs,
          lastReviewAt: 59 * dayMs,
          repositoryCreatedAt: 0,
          reviewDays: 10,
        }),
        now,
      ),
    ).toBe(true);
  });

  test("supports the sustained gate with age-adaptive minimum spans", () => {
    const now = 400 * dayMs;
    expect(
      tieredMemoryIsActive(
        stats({
          completedReviews: 20,
          firstReviewAt: 380 * dayMs,
          lastReviewAt: 399 * dayMs,
          repositoryCreatedAt: 0,
          reviewDays: 6,
        }),
        now,
      ),
    ).toBe(true);
  });

  test("derives the working window from the latest reviews and clamps it", () => {
    expect(
      workingMemoryWindowMs(
        stats({ recentReviewTimes: [100 * dayMs, 99 * dayMs] }),
      ),
    ).toBe(14 * dayMs);
    expect(
      workingMemoryWindowMs(
        stats({ recentReviewTimes: [200 * dayMs, 20 * dayMs] }),
      ),
    ).toBe(90 * dayMs);
  });

  test("assigns short, mid, and long tiers only after activation", () => {
    const now = 100 * dayMs;
    const active = stats({
      completedReviews: 50,
      firstReviewAt: 70 * dayMs,
      lastReviewAt: 99 * dayMs,
      recentReviewTimes: [99 * dayMs, 85 * dayMs],
      repositoryCreatedAt: 0,
      reviewDays: 10,
    });
    expect(memoryTier({ observedAt: 90 * dayMs, stats: active, now })).toBe(
      "short",
    );
    expect(memoryTier({ observedAt: 60 * dayMs, stats: active, now })).toBe(
      "mid",
    );
    expect(memoryTier({ observedAt: 10 * dayMs, stats: active, now })).toBe(
      "long",
    );
  });

  test("adapts durable recurrence and favors fresh material open findings", () => {
    expect([20, 50, 150, 500, 1_500].map(durableClusterPullRequestThreshold)).toEqual(
      [3, 4, 5, 6, 7],
    );
    const fresh = memoryWeight({
      distinctPullRequests: 4,
      severity: "BLOCKING",
      status: "open",
      tier: "short",
    });
    const old = memoryWeight({
      distinctPullRequests: 1,
      severity: "IMPROVEMENT",
      status: "fixed",
      tier: "long",
    });
    expect(fresh).toBeGreaterThan(old);
    expect(maximumEntriesPerCluster("short")).toBeNull();
    expect(maximumEntriesPerCluster("mid")).toBe(2);
    expect(maximumEntriesPerCluster("long")).toBe(1);
  });
});
