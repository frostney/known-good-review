import { defineDynamic } from "eve";
import { defineInstructions } from "eve/instructions";
import { reviewRouteState } from "./lib/review-route";
import { reviewChildInstructions, reviewInstructions } from "../src/review/policy";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const route = reviewRouteState.get();
      return defineInstructions({
        // Eve resolves this before appending the incoming child routing message.
        // The workflow supplies task policy; later turns have a durable bound route.
        content: ctx.channel.kind === "subagent"
          ? route ? reviewInstructions(route) : reviewChildInstructions()
          : reviewInstructions({ role: "coordinator", attempt: 0 }),
      });
    },
  },
});
