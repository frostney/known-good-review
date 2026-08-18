import { describe, expect, test } from "bun:test";
import {
  defaultEmbedding,
  defaultModels,
  defaultSpecialistModels,
  modelsForAxis,
  modelsForSpecialist,
  parseReviewConfig,
} from "../src/config/review-config";

describe("trusted review configuration", () => {
  test("defaults every invocation to the configured Gateway fallback chain", () => {
    const config = parseReviewConfig(null);
    expect(config.model).toEqual(defaultModels);
    expect(config.embedding).toEqual(defaultEmbedding);
    expect(config.profile).toBe("balanced");
    expect(config.blocking).toBeFalse();
    expect(modelsForAxis(config, "deduplication")).toEqual(defaultModels);
    expect(modelsForSpecialist(config, "scout")).toEqual(
      defaultSpecialistModels,
    );
  });

  test("supports ordered fallbacks and per-axis overrides", () => {
    const config = parseReviewConfig(`
model: openai/gpt-5.6-sol, anthropic/claude-opus-5
agents:
  deduplication: moonshotai/kimi-k3, openai/gpt-5.6-sol
  engineering-quality: anthropic/claude-opus-5
  scout: openai/gpt-5.6-luna
  commenter: xai/grok-code-fast-1
profile: thorough
blocking: true
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
    expect(modelsForSpecialist(config, "scout")).toEqual([
      "openai/gpt-5.6-luna",
    ]);
    expect(modelsForSpecialist(config, "commenter")).toEqual([
      "xai/grok-code-fast-1",
    ]);
    expect(config.profile).toBe("thorough");
    expect(config.blocking).toBeTrue();
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
