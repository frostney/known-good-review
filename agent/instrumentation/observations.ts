import { defineInstrumentation, type ProviderDefinition, type ProviderContext, type InstrumentationActionCompletedEvent, type InstrumentationActionFailedEvent } from "eve/instrumentation";
import { modelObservations, observeModelStart, observeModelCall, observeModelMetadata } from "../lib/model-observations";
import { z } from "zod";

const actionSchema = z.object({ name: z.string(), kind: z.string(), startedAt: z.number() });

export default defineInstrumentation({
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
  events: {
    "model.call.started"(event) {
      modelObservations.update(current => observeModelStart(current, event));
    },
    "model.call.completed"(event) {
      modelObservations.update(current => observeModelCall(current, event));
    },
    "step.attempt.metadata"(event) {
      modelObservations.update(current => observeModelMetadata(current, event));
    },
    "action.started"(event, ctx) {
      ctx.state.set({ name: event.name, kind: event.kind, startedAt: Date.now() });
    },
    "action.completed": logAction,
    "action.failed": logAction,
  },
} satisfies ProviderDefinition);

function logAction(
  event: InstrumentationActionCompletedEvent | InstrumentationActionFailedEvent,
  ctx: ProviderContext,
): void {
  const action = actionSchema.safeParse(ctx.state.get());
  console.info(JSON.stringify({
    event: "known-good-review.action.completed", telemetryId: event.idempotencyKey,
    sessionId: event.scope.sessionId, turnId: event.scope.turnId,
    stepIndex: event.scope.stepIndex, attemptIndex: event.scope.attemptIndex,
    name: action.success ? action.data.name : null,
    kind: action.success ? action.data.kind : null,
    durationMs: action.success ? Date.now() - action.data.startedAt : null,
    outcome: event.type === "action.completed" && event.output.type === "error" ? "failed" : event.outcome,
  }));
}
