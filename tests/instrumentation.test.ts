import { describe, expect, test } from "bun:test";
import type { InstrumentationStepStartedEventInput } from "eve/instrumentation";
import { reviewRuntimeContext } from "../agent/instrumentation";
import { routingAttribute, routingEnvelope } from "../src/models/routing";

const config = "model: openai/gpt-5.6-sol, anthropic/claude-opus-5";

function instrumentationInput(
  messages: InstrumentationStepStartedEventInput["modelInput"]["messages"],
): InstrumentationStepStartedEventInput {
  return {
    channel: { kind: "subagent", metadata: {} },
    modelInput: { instructions: undefined, messages },
    session: {
      auth: {
        current: {
          attributes: { [routingAttribute]: config },
          authenticator: "test",
          principalId: "test",
          principalType: "test",
        },
        initiator: null,
      },
      id: "session",
    },
    step: { index: 1 },
    turn: { id: "turn", sequence: 0 },
  };
}

describe("review instrumentation", () => {
  test("projects an exact routed lane onto runtime context", () => {
    expect(
      reviewRuntimeContext(
        instrumentationInput([
          {
            role: "user",
            content: routingEnvelope({
              role: "lane",
              axis: "engineering-quality",
              attempt: 0,
            }),
          },
        ]),
      ),
    ).toEqual({
      runtimeContext: {
        "review.role": "lane",
        "review.axis": "engineering-quality",
        "review.requested_model": "openai/gpt-5.6-sol",
        "review.fallback_models": ["anthropic/claude-opus-5"],
      },
    });
  });

  test("omits observability enrichment when Eve no longer carries the route envelope", () => {
    expect(
      reviewRuntimeContext(
        instrumentationInput([
          { role: "assistant", content: "Final lane report." },
        ]),
      ),
    ).toBeUndefined();
  });
});
