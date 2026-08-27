import { defineAgent } from "eve";
import {
  mockModel,
  type MockModelRequest,
  type MockModelResponse,
} from "eve/evals";
import { routingEnvelope } from "../../../../src/models/routing";

const fullReportMarker = "KGR-EVAL-FULL-REPORT";
const deltaRevalidationMarker = "KGR-EVAL-DELTA-REVALIDATION";
const subagentRoutingMarker = "KGR-EVAL-SUBAGENT-ROUTING";
const subagentChildMarker = "KGR-EVAL-SUBAGENT-CHILD";

const validFindingDraft = {
  category: "QUALITY" as const,
  severity: "IMPORTANT" as const,
  title: "Reject stale review fields before execution",
  location: { path: "src/review.ts", line: 1, symbol: null },
  evidence: ["The model-facing schema rejects application-owned status."],
  impact: "Invalid review output cannot reach application state.",
  remedy: "Keep the provider-visible schema aligned with the tool boundary.",
  staticOnly: true,
  churn: null,
};

const validReportDraft = {
  scope: { claim: "Validate the review contract.", dirtyState: "clean" },
  coverage: { staticOnly: [], unreached: [] },
  churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
  probes: [],
  freshFindings: [validFindingDraft],
  verifiedClaims: [],
  limitations: [],
};

const validRevalidatedFinding = {
  ...validFindingDraft,
  id: "CR-1",
  status: "fixed" as const,
};

function hasToolResult(request: MockModelRequest, name: string): boolean {
  return request.toolResults.some((result) => result.name === name);
}

function respond(request: MockModelRequest): MockModelResponse | string {
  const prompt = request.userMessages.join("\n");

  if (prompt.includes(subagentChildMarker)) {
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
      ? "SUBAGENT-ROUTING-COMPLETE"
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

  if (prompt.includes(fullReportMarker)) {
    return hasToolResult(request, "assemble_review_report")
      ? "FULL-REPORT-COMPLETE"
      : {
          toolCalls: [
            {
              name: "assemble_review_report",
              input: { draft: validReportDraft },
            },
          ],
        };
  }

  if (prompt.includes(deltaRevalidationMarker)) {
    return hasToolResult(request, "record_review_revalidation")
      ? "DELTA-REVALIDATION-COMPLETE"
      : {
          toolCalls: [
            {
              name: "record_review_revalidation",
              input: { findings: [validRevalidatedFinding] },
            },
          ],
        };
  }

  return "UNKNOWN-EVAL-SCENARIO";
}

export default defineAgent({
  model: mockModel({
    modelId: "known-good-review-contract",
    provider: "known-good-review-fixture",
    respond,
  }),
  modelContextWindowTokens: 1_000_000,
});
