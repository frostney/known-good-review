import { z } from "zod";
import { defineAgent, defineDynamic } from "eve";
import { currentReviewRoute } from "../../../../agent/lib/review-route";
import {
  mockModel,
  type MockModelRequest,
  type MockModelResponse,
} from "eve/evals";
import { routingEnvelope } from "../../../../src/models/routing";
import { parseSubagentRoute } from "../../../../src/models/routing";

const subagentRoutingMarker = "KGR-EVAL-SUBAGENT-ROUTING";
const subagentChildMarker = "KGR-EVAL-SUBAGENT-CHILD";
const workflowRoutingMarker = "KGR-EVAL-WORKFLOW-ROUTING";

function hasToolResult(request: MockModelRequest, name: string): boolean {
  return request.toolResults.some((result) => result.name === name);
}

function respond(request: MockModelRequest): MockModelResponse | string {
  const prompt = request.userMessages.join("\n");

  if (prompt.includes("KGR-EVAL-WINDOW-ROOT")) {
    if (!hasToolResult(request, "fixture_window")) return { toolCalls: [{ name: "fixture_window", input: {} }] };
    if (request.toolResults.filter((item) => item.name === "fixture_step").length < 15) return { toolCalls: [{ name: "fixture_step", input: { marker: "routing" } }] };
    return { toolCalls: [{ name: "review_workflow", input: { context: "Synthetic review claim" } }] };
  }

  if (prompt.includes("KGR-EVAL-GUARD-CHILD")) {
    const result = request.toolResults.find((item) => item.name === "review_workflow");
    if (!result) return { toolCalls: [{ name: "review_workflow", input: { context: "Synthetic review claim" } }] };
    if (!result.isError || !JSON.stringify(result.output).includes("Only the review coordinator")) throw new Error("Nested orchestration was not rejected at entry");
    return "GUARD-REJECTED";
  }
  if (prompt.includes("KGR-EVAL-ROOT-GUARD")) {
    const result = request.toolResults.find((item) => item.name === "fixture_workflow");
    if (result) return JSON.stringify(result.output).includes("GUARD-REJECTED") ? "ROOT-GUARD-COMPLETE" : "ROOT-GUARD-FAILED";
    return { toolCalls: [{ name: "fixture_workflow", input: { message: `${routingEnvelope({ role: "lane", axis: "engineering-quality", attempt: 0 })}\nKGR-EVAL-GUARD-CHILD` } }] };
  }
  if (prompt.includes("KGR-EVAL-CONCURRENT-ROOT")) {
    if (!hasToolResult(request, "fixture_prepare")) return { toolCalls: [{ name: "fixture_prepare", input: {} }] };
    const results = request.toolResults.filter((item) => item.name === "review_workflow");
    if (!results.length) return { toolCalls: [{ name: "review_workflow", input: { context: "Synthetic review claim" } }, { name: "review_workflow", input: { context: "Synthetic review claim" } }] };
    if (results.filter((result) => result.isError && JSON.stringify(result.output).includes("already in use by another workflow")).length !== 1 || results.filter((result) => !result.isError).length !== 1) throw new Error("Concurrent workflow admission did not preserve one owner: " + JSON.stringify(results));
    return "CONCURRENT-GUARD-COMPLETE";
  }

  if (prompt.includes("KGR-EVAL-AUTHORED-CHILD")) {
    const route = parseSubagentRoute(request.userMessages.map((content) => ({ role: "user", content })));
    if (route.role === "scout") return { toolCalls: [{ name: "final_output", input: { request: "lookup", evidence: "found-symbol", limitations: [] } }] };
    if (route.role !== "lane") throw new Error("Invalid authored child route");
    if (route.attempt === 1 && !prompt.includes("found-symbol")) throw new Error("Fresh continuation lost scout evidence");
    if (!hasToolResult(request, "fixture_checkpoint")) return { toolCalls: [{ name: "fixture_checkpoint", input: {} }] };
    const checkpointResult = request.toolResults.find((item) => item.name === "fixture_checkpoint");
    const checkpoint = z.object({ attestation: z.string(), status: z.enum(["in-progress", "complete"]) }).parse(checkpointResult?.output);
    const incomplete = checkpoint.status === "in-progress";
    return { toolCalls: [{ name: "final_output", input: { axis: route.axis, status: incomplete ? "incomplete" : "complete", scoutRequests: incomplete ? ["lookup"] : [], checkpoint: checkpoint.attestation } }] };
  }

  if (prompt.includes("KGR-EVAL-AUTHORED-REPEAT")) {
    const results = request.toolResults.filter((item) => item.name === "review_workflow");
    if (results.length < 2) return { toolCalls: [{ name: "review_workflow", input: { context: "Synthetic review claim" } }] };
    if (results.some((result) => result.isError)) throw new Error("Sequential workflow invocation failed");
    return "AUTHORED-REPLAY-COMPLETE";
  }
  if (prompt.includes("KGR-EVAL-AUTHORED-ROOT")) {
    if (!hasToolResult(request, "fixture_prepare")) return { toolCalls: [{ name: "fixture_prepare", input: {} }] };
    const result = request.toolResults.find((item) => item.name === "review_workflow");
    if (!result) return { toolCalls: [{ name: "review_workflow", input: { context: "Synthetic review claim" } }] };
    if (result.isError || !JSON.stringify(result.output).includes('"complete":true')) throw new Error("Authored review failed: " + JSON.stringify(result.output));
    return "AUTHORED-REVIEW-COMPLETE";
  }

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
