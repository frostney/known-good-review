import { describe, expect, test } from "bun:test";
import { parseReviewConfig } from "../src/config/review-config";
import type { TrustedGitHubContext } from "../src/github/trusted-context";
import { normalizedReviewMemory } from "../src/memory/client";
import type { ReviewReport } from "../src/review/findings";

const context: TrustedGitHubContext = {
  installationId: 1,
  owner: "frostney",
  repo: "known-good-review",
  repository: "frostney/known-good-review",
  repositoryId: "R_repo",
  repositoryCreatedAt: 1_700_000_000_000,
  pullRequest: 42,
  baseSha: "base",
  headSha: "head",
  patchFingerprint: "a".repeat(64),
};

const report: ReviewReport = {
  schemaVersion: 2,
  kind: "code-review",
  generatedAt: "2026-08-16T00:00:00.000Z",
  verdict: "REQUEST_CHANGES",
  scope: {
    claim: "Remember repeated review findings",
    base: "base",
    head: "head",
    dirtyState: "clean",
  },
  coverage: {
    activeAxes: ["engineering-quality"],
    skippedAxes: [],
    staticOnly: [],
    unreached: [],
  },
  churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
  probes: [],
  findings: [
    {
      id: "CR-1",
      severity: "IMPORTANT",
      category: "QUALITY",
      title: "Retry loses durable state",
      location: { path: "src/retry.ts", line: 12, symbol: "retry" },
      evidence: ["private source excerpt that must not enter memory"],
      impact: "A retry can repeat a published side effect.",
      remedy: "Persist the idempotency key before retrying.",
      status: "open",
      staticOnly: false,
      churn: null,
    },
  ],
  verifiedClaims: [],
  limitations: [],
};

describe("normalized repository memory", () => {
  test("stores only the agreed normalized finding fields and provenance", () => {
    const memory = normalizedReviewMemory({
      config: parseReviewConfig(null),
      context,
      report,
      reviewKind: "full",
      publishedAt: 1_800_000_000_000,
    });

    expect(memory.memories).toHaveLength(1);
    expect(memory.installationId).toBe(1);
    expect(memory.memories[0]).toEqual({
      finding: "Retry loses durable state",
      invariant: "A retry can repeat a published side effect.",
      cause: null,
      remedy: "Persist the idempotency key before retrying.",
      outcome: "open",
      severity: "IMPORTANT",
      category: "QUALITY",
      provenance: {
        repositoryId: "R_repo",
        repository: "frostney/known-good-review",
        pullRequest: 42,
        base: "base",
        head: "head",
        path: "src/retry.ts",
        symbol: "retry",
        findingId: "CR-1",
      },
    });
    expect(JSON.stringify(memory)).not.toContain("private source excerpt");
  });

  test("derives a stable retry key without collapsing distinct pull requests", () => {
    const first = normalizedReviewMemory({
      config: parseReviewConfig(null),
      context,
      report,
      reviewKind: "full",
      publishedAt: 1_800_000_000_000,
    });
    const retry = normalizedReviewMemory({
      config: parseReviewConfig(null),
      context,
      report,
      reviewKind: "full",
      publishedAt: 1_800_000_001_000,
    });

    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    const otherPullRequest = normalizedReviewMemory({
      config: parseReviewConfig(null),
      context: { ...context, pullRequest: 43 },
      report,
      reviewKind: "full",
      publishedAt: 1_800_000_001_000,
    });
    expect(otherPullRequest.idempotencyKey).not.toBe(first.idempotencyKey);
    const correctedReport = normalizedReviewMemory({
      config: parseReviewConfig(null),
      context,
      report: {
        ...report,
        findings: report.findings.map((finding) => ({
          ...finding,
          status: "fixed" as const,
        })),
      },
      reviewKind: "full",
      publishedAt: 1_800_000_001_000,
    });
    expect(correctedReport.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
