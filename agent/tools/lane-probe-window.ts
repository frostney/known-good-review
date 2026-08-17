import { defineDynamic, defineTool } from "eve/tools";
import type { HookEvent } from "eve/hooks";
import { z } from "zod";
import { reviewLaneProbeWindowClosed } from "../../src/review/probe-window";

const blockedInputSchema = z.record(z.string(), z.unknown());
const blockedDescription =
  "The deep-review probe window is complete. Do not inspect more material in this fresh context. Write the exact lane checkpoint now, then return the required structured complete or incomplete result. A fresh continuation receives the next evidence packet when work remains.";

export default defineDynamic({
  events: {
    "step.started": (event, ctx) => {
      const step = event as HookEvent<"step.started">;
      if (
        !reviewLaneProbeWindowClosed({
          channelKind: ctx.channel.kind,
          stepIndex: step.data.stepIndex,
        })
      ) {
        return null;
      }
      const blocked = defineTool({
        description: blockedDescription,
        inputSchema: blockedInputSchema,
        execute: (_input) => ({
          blocked: true,
          requiredAction:
            "Call review_lane_checkpoint with operation write, then return the required structured result.",
        }),
      });
      return {
        ask_question: blocked,
        bash: blocked,
        cleanup_review: blocked,
        connection_search: blocked,
        glob: blocked,
        grep: blocked,
        load_skill: blocked,
        publish_review: blocked,
        read_file: blocked,
        read_review_evidence: blocked,
        retrieve_review_memory: blocked,
        todo: blocked,
        verify_review_head: blocked,
        web_fetch: blocked,
        web_search: blocked,
        write_file: blocked,
      };
    },
  },
});
