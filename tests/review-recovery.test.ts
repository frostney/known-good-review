import { describe, expect, test } from "bun:test";
import {
  advanceReviewRecovery,
  beginReviewRecovery,
  buildReviewFailureEnvelope,
  recoveryWork,
  validateReviewRecoveryIdentity,
} from "../src/review/recovery";

const identity = {
  baseSha: "1".repeat(40),
  headSha: "2".repeat(40),
  patchFingerprint: "3".repeat(64),
  planKind: "delta" as const,
};

describe("interrupted review recovery", () => {
  test("retains completed axes and resumes only missing stages", () => {
    const started = beginReviewRecovery({
      activeAxes: [
        "deduplication",
        "claim-and-specification",
        "engineering-quality",
        "discoverability",
      ],
      identity,
      selectedFindingIds: ["CR-7"],
    });
    const axesComplete = advanceReviewRecovery(started, {
      completedAxes: started.activeAxes,
      stage: "axes-complete",
    });

    expect(recoveryWork(axesComplete)).toEqual([
      "revalidation",
      "reconciliation",
      "publication",
    ]);
    expect(
      recoveryWork(
        advanceReviewRecovery(axesComplete, {
          stage: "revalidation-complete",
        }),
      ),
    ).toEqual(["reconciliation", "publication"]);
  });

  test("persists a bounded sanitized failure envelope", () => {
    const started = beginReviewRecovery({
      activeAxes: ["engineering-quality"],
      identity,
      selectedFindingIds: ["CR-7"],
    });
    const failure = buildReviewFailureEnvelope({
      errorClass: "WORKFLOW_INCOMPLETE",
      recovery: advanceReviewRecovery(started, {
        completedAxes: ["engineering-quality"],
        stage: "axes-complete",
      }),
      run: { sessionId: "session-safe", turnId: "turn-safe" },
    });

    expect(failure).toMatchObject({
      failedStage: "revalidation",
      retryEligible: true,
      activeAxes: ["engineering-quality"],
      completedAxes: ["engineering-quality"],
      errorClass: "WORKFLOW_INCOMPLETE",
    });
    expect(JSON.stringify(failure)).not.toContain("prompt");
    expect(JSON.stringify(failure).length).toBeLessThan(4_096);
  });

  test("rejects skipped stages and untrusted error text", () => {
    const started = beginReviewRecovery({
      activeAxes: ["engineering-quality"],
      identity,
      selectedFindingIds: ["CR-7"],
    });
    expect(() =>
      advanceReviewRecovery(started, { stage: "revalidation-complete" }),
    ).toThrow("axes");
    expect(() =>
      buildReviewFailureEnvelope({
        errorClass: "token=secret value",
        recovery: started,
        run: { sessionId: "session-safe", turnId: "turn-safe" },
      }),
    ).toThrow("error class");
    expect(() =>
      validateReviewRecoveryIdentity(started, {
        ...identity,
        headSha: "4".repeat(40),
      }),
    ).toThrow("trusted review");
  });
});
