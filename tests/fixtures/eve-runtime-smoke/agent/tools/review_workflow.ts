import { defineWorkflowTool, toolOutput, type WorkflowToolContext } from "eve/tools";
import { createHook, FatalError, getWorkflowMetadata } from "workflow";
import { orchestrateReview, reviewWorkflowInputSchema, type ReviewOrchestrationPlan } from "../../../../../src/review/orchestration";
import { verifyReviewLaneReceipt } from "../../../../../agent/lib/review-workflow";
import type { ReviewAxis } from "../../../../../src/review/axes";
import { activeAxes, identity } from "../lib/orchestration";

export default defineWorkflowTool({
  description: "Exercise the production authored review protocol with synthetic authority.",
  inputSchema: reviewWorkflowInputSchema,
  async execute({ context }, ctx) {
    "use workflow";
    if (ctx.session.parent) throw new FatalError("Only the review coordinator can orchestrate lanes");
    using lock = createHook({ token: `known-good-review:orchestration:${ctx.session.id}` });
    if (await lock.getConflict()) throw new FatalError("Another workflow owns this review orchestration");
    const plan = await fixturePlan(ctx, context);
    const runId = getWorkflowMetadata().workflowRunId;
    if (typeof runId !== "string") throw new FatalError("Missing workflow run identity");
    return await orchestrateReview({ plan, invocationPrefix: runId,
      call: (dispatch) => ctx.agent({ ...dispatch, target: "agent" }),
      verifyLane: (raw, axis, attempt, key) => verifyLane(ctx, plan, raw, axis, attempt, key),
    });
  },
  toModelOutput: toolOutput.json,
});
async function fixturePlan(ctx: WorkflowToolContext, context: string): Promise<ReviewOrchestrationPlan> {
  "use step";
  return { ...identity, rootSessionId: ctx.session.id, activeAxes, commonPrefix: `KGR-EVAL-AUTHORED-CHILD ${context}` };
}
async function verifyLane(ctx: WorkflowToolContext, plan: ReviewOrchestrationPlan, raw: unknown, axis: ReviewAxis, attempt: number, key: string) {
  "use step";
  return verifyReviewLaneReceipt({ raw, axis, attempt, invocationId: `${ctx.callId}:${key}`, plan, secret: "1".repeat(64) });
}
