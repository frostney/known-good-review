import { defineHook } from "eve/hooks";
import { reviewContextAttributes } from "../../src/github/trusted-context";
import { assertReviewWorkflowWindow } from "../../src/review/probe-window";
import { z } from "zod";

// Eve's dynamic ordinary tools cannot replace a deferred workflow definition.
// Reject its request at the normal root hook boundary before durable dispatch.
export default defineHook({ events: {
  "actions.requested"(event, ctx) {
    if (!event.data.actions.some((action) => "toolName" in action && action.toolName === "workflow")) return;
    const raw = ctx.session.auth.current?.attributes[reviewContextAttributes.plan];
    const plan = typeof raw === "string" ? z.object({ kind: z.string() }).parse(JSON.parse(raw)) : null;
    assertReviewWorkflowWindow({ channelKind: ctx.channel.kind, reviewKind: plan?.kind, stepIndex: event.data.stepIndex });
  },
} });
