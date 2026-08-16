import { describe, expect, test } from "bun:test";
import {
  defaultModel,
  modelsForAxis,
  parseReviewConfig,
} from "../src/config/review-config";

describe("trusted review configuration", () => {
  test("defaults every invocation to Sol", () => {
    const config = parseReviewConfig(null);
    expect(config.model).toEqual([defaultModel]);
    expect(modelsForAxis(config, "deduplication")).toEqual([defaultModel]);
  });

  test("supports ordered fallbacks and per-axis overrides", () => {
    const config = parseReviewConfig(`
model: openai/gpt-5.6-sol, anthropic/claude-opus-5
agents:
  deduplication: moonshotai/kimi-k3, openai/gpt-5.6-sol
  engineering-quality: anthropic/claude-opus-5
`);

    expect(config.model).toEqual([
      "openai/gpt-5.6-sol",
      "anthropic/claude-opus-5",
    ]);
    expect(modelsForAxis(config, "deduplication")).toEqual([
      "moonshotai/kimi-k3",
      "openai/gpt-5.6-sol",
    ]);
    expect(modelsForAxis(config, "claim-and-specification")).toEqual(
      config.model,
    );
  });

  test("supports one scalar chain for all subagents", () => {
    const config = parseReviewConfig(`
agents: moonshotai/kimi-k3, openai/gpt-5.6-sol
`);
    expect(modelsForAxis(config, "discoverability")).toEqual([
      "moonshotai/kimi-k3",
      "openai/gpt-5.6-sol",
    ]);
  });

  test("fails closed for unknown keys, models, and duplicate fallbacks", () => {
    expect(() => parseReviewConfig("version: 1")).toThrow("Invalid");
    expect(() => parseReviewConfig("model: openai/gpt-4o")).toThrow(
      "unknown model",
    );
    expect(() =>
      parseReviewConfig(
        "model: openai/gpt-5.6-sol, openai/gpt-5.6-sol",
      ),
    ).toThrow("must not repeat");
    expect(() =>
      parseReviewConfig("agents:\n  correctness: openai/gpt-5.6-sol"),
    ).toThrow("Invalid");
  });
});
