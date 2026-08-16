import { defineInstrumentation } from "eve/instrumentation";
import { parseReviewConfig } from "../src/config/review-config";
import {
  chainForRoute,
  parseSubagentRoute,
  routingAttribute,
  type ReviewRoute,
} from "../src/models/routing";

export default defineInstrumentation({
  functionId: "known-good-review",
  recordInputs: false,
  recordOutputs: false,
  traceChannelRequests: true,
  events: {
    "step.started"(input) {
      const rawConfig =
        input.session.auth.current?.attributes[routingAttribute];
      const config = parseReviewConfig(
        typeof rawConfig === "string" ? rawConfig : null,
      );
      const route: ReviewRoute =
        input.channel.kind === "subagent"
          ? parseSubagentRoute(input.modelInput.messages)
          : { role: "coordinator", attempt: 0 };
      const chain = chainForRoute(config, route);
      return {
        runtimeContext: {
          "review.role": route.role,
          "review.axis": route.role === "lane" ? route.axis : route.role,
          "review.requested_model": chain[route.attempt] ?? chain[0],
          "review.fallback_models": chain.slice(route.attempt + 1),
        },
      };
    },
  },
});
