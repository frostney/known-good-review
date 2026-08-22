import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  routingAttribute,
  routingEnvelope,
  selectRoutedModel,
} from "../src/models/routing";

const config = `
model: openai/gpt-5.6-sol, anthropic/claude-opus-5
agents:
  deduplication: moonshotai/kimi-k3, openai/gpt-5.6-sol
`;

function childMessage(content: string): ModelMessage[] {
  return [{ role: "user", content }];
}

describe("dynamic Eve model routing", () => {
  test("uses the trusted coordinator chain for root turns", () => {
    expect(
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "channel:github",
        messages: [],
      }),
    ).toEqual({
      model: "openai/gpt-5.6-sol",
      modelOptions: {
        providerOptions: {
          gateway: {
            caching: "auto",
            models: ["anthropic/claude-opus-5"],
          },
        },
      },
    });
  });

  test("maps a subagent lane to its review-axis override", () => {
    expect(
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "subagent",
        messages: childMessage(
          routingEnvelope({
            role: "lane",
            axis: "deduplication",
            attempt: 0,
          }),
        ),
      }),
    ).toEqual({
      model: "moonshotai/kimi-k3",
      modelOptions: {
        providerOptions: {
          gateway: {
            caching: "auto",
            models: ["openai/gpt-5.6-sol"],
          },
        },
      },
    });
  });

  test("uses only explicitly configured fallback entries", () => {
    expect(
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "subagent",
        messages: childMessage(
          routingEnvelope({
            role: "lane",
            axis: "deduplication",
            attempt: 1,
          }),
        ),
      }),
    ).toEqual({
      model: "openai/gpt-5.6-sol",
      modelOptions: {
        providerOptions: { gateway: { caching: "auto" } },
      },
    });
    expect(() =>
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "subagent",
        messages: childMessage(
          routingEnvelope({
            role: "lane",
            axis: "deduplication",
            attempt: 2,
          }),
        ),
      }),
    ).toThrow("outside the trusted chain");
  });

  test("routes scout copies to Luna with xhigh OpenAI reasoning", () => {
    expect(
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "subagent",
        messages: childMessage(
          routingEnvelope({ role: "scout", attempt: 0 }),
        ),
      }),
    ).toEqual({
      model: "openai/gpt-5.6-luna",
      modelOptions: {
        providerOptions: {
          gateway: { caching: "auto" },
          openai: { reasoningEffort: "xhigh" },
        },
      },
    });
  });

  test("fails closed for missing or invented lane routes", () => {
    expect(() =>
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "subagent",
        messages: childMessage("review this"),
      }),
    ).toThrow("missing");
    expect(() =>
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "subagent",
        messages: childMessage(
          '<known-good-review-routing>{"role":"lane","axis":"correctness"}</known-good-review-routing>',
        ),
      }),
    ).toThrow("Unknown review axis");
  });
});
