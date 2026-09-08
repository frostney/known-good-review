import { defineState } from "eve/context";
import type { ModelMessage } from "ai";
import { parseSubagentRoute, type ReviewRoute } from "../../src/models/routing";
import type { ReviewAxis } from "../../src/review/axes";

export const reviewRouteState = defineState<ReviewRoute | null>("known-good-review.route", () => null);

export function currentReviewRoute(channelKind: string | undefined, messages: readonly ModelMessage[]): ReviewRoute {
  if (channelKind !== "subagent") return { role: "coordinator", attempt: 0 };
  const bound = reviewRouteState.get();
  if (bound) return bound;
  const route = parseSubagentRoute(messages);
  reviewRouteState.update(() => route);
  return route;
}

export function requireReviewLane(axis: ReviewAxis): void {
  const route = reviewRouteState.get();
  if (route?.role !== "lane" || route.axis !== axis) {
    throw new Error("Only the assigned review lane can advance its evidence or checkpoint");
  }
}
