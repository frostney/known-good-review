import { describe, expect, test } from "bun:test";
import agent from "../agent/agent";
import { reviewExecutionRootBudget } from "../src/review/execution-budget";

type BudgetAxis = "input" | "output";

function exceededAxes(input: {
  readonly inputTokens: number;
  readonly outputTokens: number;
}): readonly BudgetAxis[] {
  const exceeded: BudgetAxis[] = [];
  if (
    input.inputTokens >
    reviewExecutionRootBudget.maxInputTokensPerSession
  ) {
    exceeded.push("input");
  }
  if (
    input.outputTokens >
    reviewExecutionRootBudget.maxOutputTokensPerSession
  ) {
    exceeded.push("output");
  }
  return exceeded;
}

const pascalMcpSdkPr60Runs = [
  {
    name: "initial full review",
    inputTokens: 1_956_039,
    outputTokens: 36_198,
    expectedExceededAxes: [],
  },
  {
    name: "first delta review",
    inputTokens: 1_583_749,
    outputTokens: 43_996,
    expectedExceededAxes: [],
  },
  {
    name: "latest disproportionate delta review",
    inputTokens: 2_071_106,
    outputTokens: 48_601,
    expectedExceededAxes: [],
  },
  {
    name: "post-cap full review with cached input reported separately",
    inputTokens: 1_500_000,
    cacheReadTokens: 1_200_000,
    outputTokens: 29_000,
    expectedExceededAxes: [],
  },
] as const;

describe("review execution token budget", () => {
  test("configures the root Eve session with the whole-tree review budget", () => {
    expect(agent.limits).toEqual(reviewExecutionRootBudget);
  });

  for (const run of pascalMcpSdkPr60Runs) {
    test(`${run.name} has the expected budget outcome`, () => {
      expect(exceededAxes(run)).toEqual(run.expectedExceededAxes);
    });
  }

  test("leaves enough input for each lane in the four-way review fan-out", () => {
    const coordinatorInputTokens = 60_000;
    const laneCount = 4;
    const observedMaximumLaneInputTokens = 582_771;
    const laneInputGrant = Math.floor(
      (reviewExecutionRootBudget.maxInputTokensPerSession -
        coordinatorInputTokens) /
        laneCount,
    );

    expect(laneInputGrant).toBe(735_000);
    expect(laneInputGrant).toBeGreaterThan(observedMaximumLaneInputTokens);
  });

  test("checks input and output independently at their exact boundaries", () => {
    expect(
      exceededAxes({
        inputTokens: reviewExecutionRootBudget.maxInputTokensPerSession,
        outputTokens: reviewExecutionRootBudget.maxOutputTokensPerSession,
      }),
    ).toEqual([]);
    expect(
      exceededAxes({
        inputTokens:
          reviewExecutionRootBudget.maxInputTokensPerSession + 1,
        outputTokens:
          reviewExecutionRootBudget.maxOutputTokensPerSession + 1,
      }),
    ).toEqual(["input", "output"]);
  });
});
