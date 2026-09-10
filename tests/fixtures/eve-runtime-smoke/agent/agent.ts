import { defineAgent, defineDynamic } from "eve";
import { currentReviewRoute } from "../../../../agent/lib/review-route";
import {
  mockModel,
  type MockModelRequest,
  type MockModelResponse,
} from "eve/evals";
import { routingEnvelope } from "../../../../src/models/routing";

const subagentRoutingMarker = "KGR-EVAL-SUBAGENT-ROUTING";
const subagentChildMarker = "KGR-EVAL-SUBAGENT-CHILD";
const workflowRoutingMarker = "KGR-EVAL-WORKFLOW-ROUTING";

function hasToolResult(request: MockModelRequest, name: string): boolean {
  return request.toolResults.some((result) => result.name === name);
}

function respond(request: MockModelRequest): MockModelResponse | string {
  const prompt = request.userMessages.join("\n");

  if (prompt.includes(workflowRoutingMarker)) {
    const result = request.toolResults.find((item) => item.name === "fixture_workflow");
    if (result) {
      if (!JSON.stringify(result.output).includes("SUBAGENT-CHILD-COMPLETE")) {
        throw new Error("The waiting Workflow must return the child's final result");
      }
      return "WORKFLOW-ROUTING-COMPLETE";
    }
    return {
      toolCalls: [{
        name: "fixture_workflow",
        input: {
          message: `${routingEnvelope({
            role: "lane",
            axis: "engineering-quality",
            attempt: 0,
          })}\n${subagentChildMarker}`,
        },
      }],
    };
  }

  if (prompt.includes(subagentChildMarker) && !prompt.includes(subagentRoutingMarker)) {
    return hasToolResult(request, "fixture_step")
      ? "SUBAGENT-CHILD-COMPLETE"
      : {
          toolCalls: [
            {
              name: "fixture_step",
              input: { marker: "routing" },
            },
          ],
        };
  }

  if (prompt.includes(subagentRoutingMarker)) {
    return hasToolResult(request, "agent")
      ? request.messages.some((message) => message.text.includes("SUBAGENT-CHILD-COMPLETE"))
        ? "SUBAGENT-ROUTING-COMPLETE"
        : "SUBAGENT-ROUTING-PENDING"
      : {
          toolCalls: [
            {
              name: "agent",
              input: {
                message: `${routingEnvelope({
                  role: "lane",
                  axis: "engineering-quality",
                  attempt: 0,
                })}\n${subagentChildMarker}`,
              },
            },
          ],
        };
  }

  return "UNKNOWN-EVAL-SCENARIO";
}

const model = mockModel({
  modelId: "known-good-review-runtime-smoke",
  provider: "known-good-review-fixture",
  respond,
});

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        currentReviewRoute(ctx.channel.kind, ctx.messages);
        return { model, modelContextWindowTokens: 1_000_000 };
      },
    },
  }),
});
