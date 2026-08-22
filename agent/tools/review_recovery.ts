import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import {
  currentRecoveryState,
  reviewRecoveryState,
} from "../lib/review-recovery";
import {
  advanceReviewRecovery,
  recoveryWork,
  reviewRecoveryStages,
} from "../../src/review/recovery";
import { readLaneCheckpoint } from "../../src/review/lane-checkpoint";
import { trustedGitHubContext } from "../../src/github/trusted-context";

const advanceStages = reviewRecoveryStages.filter(
  (stage) => stage !== "started" && stage !== "published",
);

export const reviewRecoveryInputSchema = z
  .object({
    operation: z.enum(["read", "advance"]),
    stage: z.enum(advanceStages).nullable(),
  })
  .superRefine((input, context) => {
    if (input.operation === "read" && input.stage !== null) {
      context.addIssue({
        code: "custom",
        path: ["stage"],
        message: "Recovery reads do not accept a stage",
      });
    }
    if (input.operation === "advance" && input.stage === null) {
      context.addIssue({
        code: "custom",
        path: ["stage"],
        message: "Recovery advancement requires a stage",
      });
    }
  });

export default defineTool({
  description:
    "Read the trusted review recovery packet or advance one validated coordinator stage. Use null stage for reads. Axis completion is accepted only when every exact lane checkpoint is complete.",
  inputSchema: reviewRecoveryInputSchema,
  async execute(input, ctx) {
    if (ctx.session.parent) {
      throw new Error("Only the review coordinator can manage recovery state");
    }
    let recovery = currentRecoveryState(ctx.session.auth.current);
    if (input.operation === "advance") {
      if (input.stage === null) {
        throw new Error("Recovery advancement requires a stage");
      }
      if (input.stage === "axes-complete") {
        const trusted = trustedGitHubContext(ctx.session.auth.current);
        if (!trusted.patchFingerprint) {
          throw new Error("Trusted review recovery is missing patch identity");
        }
        const sandbox = await ctx.getSandbox();
        const completedAxes: typeof recovery.completedAxes = [];
        for (const axis of recovery.activeAxes) {
          const checkpoint = await readLaneCheckpoint(
            sandbox,
            {
              baseSha: trusted.baseSha,
              headSha: trusted.headSha,
              patchFingerprint: trusted.patchFingerprint,
            },
            axis,
          );
          if (checkpoint?.status === "complete") completedAxes.push(axis);
        }
        recovery = advanceReviewRecovery(recovery, {
          completedAxes,
          stage: input.stage,
        });
      } else {
        recovery = advanceReviewRecovery(recovery, { stage: input.stage });
      }
      reviewRecoveryState.update(() => recovery);
    }
    return {
      operation: input.operation,
      recovery,
      remainingWork: recoveryWork(recovery),
    };
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
