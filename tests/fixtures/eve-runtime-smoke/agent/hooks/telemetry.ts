import { defineHook } from "eve/hooks";
import telemetry from "../../../../../agent/hooks/telemetry";
import { modelObservations } from "../../../../../agent/lib/model-observations";

export default defineHook({
  events: {
    ...telemetry.events,
    "step.completed"(event, ctx) {
      const observations = modelObservations.get().filter(observation =>
        observation.completed && observation.sessionId === ctx.session.id && observation.turnId === event.data.turnId &&
        observation.stepIndex === event.data.stepIndex);
      if (observations.length === 0) {
        throw new Error("Production instrumentation did not persist the model call in the session context");
      }
      if (observations.some(observation => observation.actualModel !== "known-good-review-runtime-smoke")) {
        throw new Error("Production instrumentation lost the SDK model identity");
      }
      return telemetry.events?.["step.completed"]?.(event, ctx);
    },
  },
});
