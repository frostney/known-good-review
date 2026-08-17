import { defineAgent, defineDynamic } from "eve";
import { selectRoutedModel } from "../src/models/routing";

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
  limits: {
    maxInputTokensPerSession: 8_000_000,
    maxOutputTokensPerSession: 512_000,
  },
  compaction: {
    thresholdPercent: 0.25,
  },
  reasoning: "high",
});
