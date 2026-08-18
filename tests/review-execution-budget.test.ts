import { describe, expect, test } from "bun:test";
import agent from "../agent/agent";
import { reviewExecutionTokenLimits } from "../src/review/execution-budget";

type BudgetAxis = "input" | "output";

function exceededAxes(input: {
  readonly inputTokens: number;
  readonly outputTokens: number;
}): readonly BudgetAxis[] {
  const exceeded: BudgetAxis[] = [];
  if (
    input.inputTokens >
    reviewExecutionTokenLimits.maxInputTokensPerSession
  ) {
    exceeded.push("input");
  }
  if (
    input.outputTokens >
    reviewExecutionTokenLimits.maxOutputTokensPerSession
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
    expectedExceededAxes: ["input"],
  },
] as const;

describe("review execution token budget", () => {
  test("configures the root Eve session with the review budget", () => {
    expect(agent.limits).toEqual(reviewExecutionTokenLimits);
  });

  for (const run of pascalMcpSdkPr60Runs) {
    test(`${run.name} has the expected budget outcome`, () => {
      expect(exceededAxes(run)).toEqual(run.expectedExceededAxes);
    });
  }

  test("checks input and output independently at their exact boundaries", () => {
    expect(
      exceededAxes({
        inputTokens: reviewExecutionTokenLimits.maxInputTokensPerSession,
        outputTokens: reviewExecutionTokenLimits.maxOutputTokensPerSession,
      }),
    ).toEqual([]);
    expect(
      exceededAxes({
        inputTokens:
          reviewExecutionTokenLimits.maxInputTokensPerSession + 1,
        outputTokens:
          reviewExecutionTokenLimits.maxOutputTokensPerSession + 1,
      }),
    ).toEqual(["input", "output"]);
  });
});
