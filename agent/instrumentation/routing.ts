import { otelIntegration } from "eve/instrumentation/otel";
import { reviewRouteState } from "../lib/review-route";
import { parseReviewConfig } from "../../src/config/review-config";
import {
  chainForRoute,
  parseSubagentRoute,
  routingAttribute,
  type ReviewRoute,
} from "../../src/models/routing";

export default otelIntegration({
  runtimeContext(input) {
    const rawConfig =
      input.session.auth.current?.attributes[routingAttribute];
    const config = parseReviewConfig(
      typeof rawConfig === "string" ? rawConfig : null,
    );
    const route: ReviewRoute =
      input.channel.kind === "subagent"
        ? reviewRouteState.get() ?? parseSubagentRoute(input.modelInput.messages)
        : { role: "coordinator", attempt: 0 };
    const chain = chainForRoute(config, route);
    return {
      "review.role": route.role,
      "review.axis": route.role === "lane" ? route.axis : route.role,
      "review.requested_model": chain[0],
      "review.fallback_models": chain.slice(1),
    };
  },
});
