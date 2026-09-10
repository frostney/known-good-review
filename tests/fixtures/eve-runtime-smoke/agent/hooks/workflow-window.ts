import { defineHook } from "eve/hooks";
import { assertReviewWorkflowWindow } from "../../../../../src/review/probe-window";
import { windowProbe } from "../lib/workflow-window";

export default defineHook({ events: {
  "actions.requested"(event) {
    if (!windowProbe.get() || !event.data.actions.some((action) => "toolName" in action && action.toolName === "review_workflow")) return;
    assertReviewWorkflowWindow({ channelKind: "github", reviewKind: "full", stepIndex: event.data.stepIndex });
  },
} });
