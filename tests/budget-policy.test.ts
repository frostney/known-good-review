import { describe, expect, test } from "bun:test";
import {
  evaluateBudgetCandidate,
  shadowInputExceedances,
  type CompletedReviewUsage,
} from "../src/telemetry/budget-policy";

const dayMs = 24 * 60 * 60 * 1_000;

function reviews(maximum = 700): CompletedReviewUsage[] {
  return Array.from({ length: 50 }, (_, index) => ({
    completedAt: index * dayMs,
    inputTokens: index === 49 ? maximum : 500,
    outputTokens: 100,
  }));
}

describe("budget shadow promotion", () => {
  test("requires review count, active days, span, zero stops, and 20 percent headroom", () => {
    expect(
      evaluateBudgetCandidate({
        axis: "input",
        candidateTokens: 1_000,
        reviews: reviews(700),
      }),
    ).toMatchObject({ eligible: true, reason: "eligible" });
    expect(
      evaluateBudgetCandidate({
        axis: "input",
        candidateTokens: 1_000,
        reviews: reviews(900),
      }),
    ).toMatchObject({ eligible: false, reason: "insufficient-headroom" });
    expect(
      evaluateBudgetCandidate({
        axis: "input",
        candidateTokens: 1_000,
        reviews: reviews(1_001),
      }),
    ).toMatchObject({ eligible: false, reason: "would-interrupt" });
  });

  test("records every crossed input shadow threshold", () => {
    expect(shadowInputExceedances(4_500_000)).toEqual([
      2_000_000,
      3_000_000,
      4_000_000,
    ]);
  });
});
