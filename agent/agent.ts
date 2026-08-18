import { defineAgent, defineDynamic } from "eve";
import { selectRoutedModel } from "../src/models/routing";
import { reviewExecutionRootBudget } from "../src/review/execution-budget";

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) =>
        selectRoutedModel({
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
