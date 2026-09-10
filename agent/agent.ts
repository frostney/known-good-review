import { defineAgent, defineDynamic } from "eve";
import { currentReviewRoute } from "./lib/review-route";
import { selectRoutedModel } from "../src/models/routing";
import { reviewExecutionRootBudget } from "../src/review/execution-budget";

export default defineAgent({
  experimental: { instrumentationProviders: true },
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) =>
        selectRoutedModel({
          route: currentReviewRoute(ctx.channel.kind, ctx.messages),
          attributes: ctx.session.auth.current?.attributes ?? null,
          channelKind: ctx.channel.kind,
          messages: ctx.messages,
        }),
    },
  }),
  limits: reviewExecutionRootBudget,
  compaction: {
    thresholdPercent: 0.25,
  },
  reasoning: "high",
});
