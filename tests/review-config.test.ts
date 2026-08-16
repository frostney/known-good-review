import { describe, expect, test } from "bun:test";
import {
  defaultEmbedding,
  defaultModels,
  modelsForAxis,
  parseReviewConfig,
} from "../src/config/review-config";

describe("trusted review configuration", () => {
  test("defaults every invocation to the configured Gateway fallback chain", () => {
    const config = parseReviewConfig(null);
    expect(config.model).toEqual(defaultModels);
    expect(config.embedding).toEqual(defaultEmbedding);
    expect(modelsForAxis(config, "deduplication")).toEqual(defaultModels);
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

  test("accepts arbitrary Gateway model IDs and explicit embedding dimensions", () => {
    const config = parseReviewConfig(`
model: xai/grok-code-fast-1
embedding: openai/text-embedding-3-large
embeddingDimension: 3072
`);
    expect(config.model).toEqual(["xai/grok-code-fast-1"]);
    expect(config.embedding).toEqual({
      model: "openai/text-embedding-3-large",
      dimension: 3072,
    });
  });

  test("fails closed for unknown keys, malformed IDs, dimensions, and duplicate fallbacks", () => {
    expect(() => parseReviewConfig("version: 1")).toThrow("Invalid");
    expect(() => parseReviewConfig("model: gpt-5")).toThrow("creator/model");
    expect(() => parseReviewConfig("embeddingDimension: 1000")).toThrow(
      "dimension must be one of",
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
