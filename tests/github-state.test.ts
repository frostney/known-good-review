import { describe, expect, test } from "bun:test";
import type { ChannelFrom, Session } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import {
  decodeReviewState,
  encodeReviewState,
  pendingReviewState,
} from "../src/github/review-state";
import {
  addressesKnownGoodReview,
  acknowledgeManualFullReview,
  canRequestManualFull,
  requestsManualFullReview,
  reviewControlResponse,
} from "../src/github/manual-full";
import { summarizeUsage } from "../src/telemetry/usage";
import {
  startsFreshReviewSession,
  withFreshReviewSessions,
} from "../src/github/session-routing";
import { reviewContextAttributes } from "../src/github/trusted-context";

function reviewAuth(
  kind: "delta" | "full",
  event = "synchronize",
): SessionAuthContext {
  return {
    attributes: {
      [reviewContextAttributes.event]: event,
      [reviewContextAttributes.plan]: JSON.stringify({ kind }),
    },
    authenticator: "github",
    principalId: "frostney",
    principalType: "user",
  };
}

describe("GitHub-owned state and telemetry", () => {
  test("round-trips state behind a visible GitHub result", () => {
    const state = {
      schemaVersion: 2 as const,
      app: "known-good-review" as const,
      pullRequest: 42,
      initialFullStatus: "completed" as const,
      baseline: {
        head: "abc123",
        patchFingerprint: "a".repeat(64),
        findingsArtifactUrl: "https://github.com/acme/repo/checks/1",
        files: { "src/index.ts": "b".repeat(64) },
        report: {
          schemaVersion: 2 as const,
          kind: "code-review" as const,
          generatedAt: "2026-08-16T12:00:00.000Z",
          verdict: "APPROVE" as const,
          scope: {
            claim: "Test the state marker",
            base: "base123",
            head: "abc123",
            dirtyState: "clean",
          },
          coverage: {
            activeAxes: [
              "deduplication" as const,
              "claim-and-specification" as const,
              "engineering-quality" as const,
            ],
            skippedAxes: [
              { name: "discoverability", reason: "No public web surface" },
            ],
            staticOnly: [],
            unreached: [],
          },
          churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
          probes: [],
          findings: [],
          verifiedClaims: [],
          limitations: [],
        },
      },
      updatedAt: "2026-08-16T12:00:00.000Z",
    };
    const encoded = encodeReviewState(state);
    expect(encoded).toContain("## ✅ known-good-review: approved");
    expect(encoded).toContain("No findings were reported.");
    expect(decodeReviewState(encoded)).toEqual(state);
    expect(decodeReviewState("ordinary comment")).toBeNull();
  });

  test("shows accepted review progress instead of an empty state comment", () => {
    const body = encodeReviewState(
      pendingReviewState({ pullRequest: 42, status: "running" }),
    );
    expect(body).toContain("## ⏳ known-good-review: in progress");
    expect(body).toContain("The review is currently running.");
    expect(decodeReviewState(body)?.initialFullStatus).toBe("running");
  });

  test("recognizes manual full commands and repository write authority", () => {
    expect(
      requestsManualFullReview("@known-good-review run full review please"),
    ).toBeTrue();
    expect(requestsManualFullReview("@known-good-review review this")).toBeFalse();
    expect(canRequestManualFull("write")).toBeTrue();
    expect(canRequestManualFull("maintain")).toBeTrue();
    expect(canRequestManualFull("read")).toBeFalse();
  });

  test("passes ordinary bot mentions to Eve's native response handling", () => {
    expect(addressesKnownGoodReview("@known-good-review Approve")).toBeTrue();
    expect(addressesKnownGoodReview("please @known-good-review Stop")).toBeTrue();
    expect(addressesKnownGoodReview("@known-good-reviewer Approve")).toBeFalse();
    expect(addressesKnownGoodReview("Approve")).toBeFalse();
    expect(reviewControlResponse("@known-good-review Approve")).toBe(
      "approve",
    );
    expect(reviewControlResponse("@known-good-review continue")).toBe(
      "approve",
    );
    expect(reviewControlResponse("@known-good-review Stop")).toBe("stop");
    expect(reviewControlResponse("@known-good-review review this")).toBeNull();
  });

  test("starts each review in a fresh PR session but preserves approvals", async () => {
    expect(startsFreshReviewSession(reviewAuth("full"))).toBeTrue();
    expect(startsFreshReviewSession(reviewAuth("delta"))).toBeTrue();
    expect(
      startsFreshReviewSession(
        reviewAuth("full", "review-control-response"),
      ),
    ).toBeFalse();

    const events: string[] = [];
    const from = (() => ({
      reset: async () => {
        events.push("reset");
        return {
          previousSessionId: "old-session",
          status: "reset" as const,
        };
      },
      send: async () => {
        events.push("send");
        return {} as Session;
      },
    })) as unknown as ChannelFrom;
    const routed = withFreshReviewSessions(from);
    await routed("repo:1:pull:53").send("review", {
      auth: reviewAuth("full"),
    });
    expect(events).toEqual(["reset", "send"]);

    events.length = 0;
    await routed("repo:1:pull:53").send("Approve", {
      auth: reviewAuth("full", "review-control-response"),
    });
    expect(events).toEqual(["send"]);
  });

  test("acknowledges the exact manual trigger without blocking the review", async () => {
    const reactions: string[] = [];
    expect(
      await acknowledgeManualFullReview({
        react: async (reaction) => {
          reactions.push(reaction);
        },
      }),
    ).toBeTrue();
    expect(reactions).toEqual(["eyes"]);
    expect(
      await acknowledgeManualFullReview({
        react: async () => {
          throw new Error("reaction unavailable");
        },
      }),
    ).toBeFalse();
  });

  test("aggregates metadata-only usage and exact reported cost", () => {
    const summary = summarizeUsage([
      {
        actualModel: "openai/gpt-5.6-sol",
        attempt: 0,
        axis: "coordinator",
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        costUsd: 0.12,
        durationMs: 100,
        fallbackReason: null,
        inputTokens: 10,
        outcome: "succeeded",
        outputTokens: 5,
        requestedModel: "openai/gpt-5.6-sol",
        reviewKind: "full",
      },
      {
        actualModel: "moonshotai/kimi-k3",
        attempt: 1,
        axis: "deduplication",
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        costUsd: 0.03,
        durationMs: 40,
        fallbackReason: "rate_limit",
        inputTokens: 8,
        outcome: "succeeded",
        outputTokens: 4,
        requestedModel: "openai/gpt-5.6-sol",
        reviewKind: "full",
      },
    ]);
    expect(summary).toEqual({
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      costUsd: 0.15,
      durationMs: 140,
      inputTokens: 18,
      invocations: 2,
      models: ["openai/gpt-5.6-sol", "moonshotai/kimi-k3"],
      outputTokens: 9,
    });
  });
});
