import {
  defineInstrumentation,
  type InstrumentationStepStartedEventInput,
  type InstrumentationStepStartedEventResult,
} from "eve/instrumentation";
import { parseReviewConfig } from "../src/config/review-config";
import {
  chainForRoute,
  parseSubagentRoute,
  routingAttribute,
  type ReviewRoute,
} from "../src/models/routing";

export function reviewRuntimeContext(
  input: InstrumentationStepStartedEventInput,
): InstrumentationStepStartedEventResult | undefined {
  const rawConfig =
    input.session.auth.current?.attributes[routingAttribute];
  const config = parseReviewConfig(
    typeof rawConfig === "string" ? rawConfig : null,
  );
  let route: ReviewRoute = { role: "coordinator", attempt: 0 };
  if (input.channel.kind === "subagent") {
    try {
      route = parseSubagentRoute(input.modelInput.messages);
    } catch {
      // Model selection remains fail-closed. Instrumentation is observe-only,
      // and Eve's finalized model input may omit the original child envelope.
      return undefined;
    }
  }
  const chain = chainForRoute(config, route);
  return {
    runtimeContext: {
      "review.role": route.role,
      "review.axis": route.role === "lane" ? route.axis : route.role,
      "review.requested_model": chain[route.attempt] ?? chain[0],
      "review.fallback_models": chain.slice(route.attempt + 1),
    },
  };
}

export default defineInstrumentation({
  functionId: "known-good-review",
  recordInputs: false,
  recordOutputs: false,
  traceChannelRequests: true,
  events: {
    "step.started": reviewRuntimeContext,
  },
});
