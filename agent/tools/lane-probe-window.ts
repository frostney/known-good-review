import { defineDynamic, defineTool } from "eve/tools";
import type { HookEvent } from "eve/hooks";
import { z } from "zod";
import {
  coordinatorReviewWindowClosed,
  reviewLaneProbeWindowClosed,
} from "../../src/review/probe-window";
import { reviewContextAttributes } from "../../src/github/trusted-context";
import { parseSubagentRoute } from "../../src/models/routing";

const blockedInputSchema = z.record(z.string(), z.unknown());
const blockedDescription =
  "The deep-review probe window is complete. Do not inspect more material in this fresh context. Write the exact lane checkpoint now, then return the required structured complete or incomplete result. A fresh continuation receives the next evidence packet when work remains.";
const coordinatorBlockedDescription =
  "The coordinator review window is complete. Do not inspect more repository material or delegate more work. Read the exact lane checkpoints, then call publish_review once. If required evidence is incomplete, finish without publishing so the application fails closed.";

function reviewKind(raw: string | readonly string[] | undefined) {
  if (typeof raw !== "string") return undefined;
  try {
    return (JSON.parse(raw) as { kind?: string }).kind;
  } catch {
    return undefined;
  }
}

export default defineDynamic({
  events: {
    "step.started": (event, ctx) => {
      const step = event as HookEvent<"step.started">;
      if (
        coordinatorReviewWindowClosed({
          channelKind: ctx.channel.kind,
          reviewKind: reviewKind(
            ctx.session.auth.current?.attributes[reviewContextAttributes.plan],
          ),
          stepIndex: step.data.stepIndex,
        })
      ) {
        const blocked = defineTool({
          description: coordinatorBlockedDescription,
          inputSchema: blockedInputSchema,
          execute: (_input) => ({
            blocked: true,
            requiredAction:
              "Read complete lane checkpoints, then call publish_review exactly once.",
          }),
        });
        return {
          Workflow: blocked,
          agent: blocked,
          ask_question: blocked,
          bash: blocked,
          cleanup_review: blocked,
          connection_search: blocked,
          glob: blocked,
          grep: blocked,
          load_skill: blocked,
          read_file: blocked,
          read_review_evidence: blocked,
          retrieve_review_memory: blocked,
          sleep: blocked,
          todo: blocked,
          verify_review_head: blocked,
          web_fetch: blocked,
          web_search: blocked,
          write_file: blocked,
        };
      }
      if (ctx.channel.kind !== "subagent") return null;
      try {
        if (parseSubagentRoute(ctx.messages).role !== "lane") return null;
      } catch {
        return null;
      }
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
