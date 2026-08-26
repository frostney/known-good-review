import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { reviewAxes } from "../../src/review/axes";
import {
  laneCheckpointContentSchema,
  readLaneCheckpoint,
  validateLaneCheckpointCoverage,
  validateLaneCheckpointEvidenceProgress,
  writeLaneCheckpoint,
} from "../../src/review/lane-checkpoint";
import {
  readReviewEvidenceManifest,
  readReviewEvidenceProgress,
} from "../../src/review/evidence-bundle";
import { githubAdapter } from "../../src/github/chat-adapter";
import { publishAxisCheckpoint } from "../../src/github/publication";
import { currentLaneCheckpointIdentity } from "../lib/review-evidence";

export const reviewLaneCheckpointInputSchema = z
  .object({
    operation: z
      .enum(["read", "write"])
      .describe("Read the current checkpoint or replace it."),
    axis: z.enum(reviewAxes),
    checkpoint: laneCheckpointContentSchema
      .nullable()
      .describe(
        "Use null for a read operation and checkpoint content for a write operation.",
      ),
  })
  .superRefine((input, refinement) => {
    if (input.operation === "write" && input.checkpoint === null) {
      refinement.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Checkpoint writes require checkpoint content",
      });
    }
    if (input.operation === "read" && input.checkpoint !== null) {
      refinement.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Checkpoint reads do not accept checkpoint content",
      });
    }
  });

export default defineTool({
  description:
    "Read or replace the compact schema-v3 checkpoint for one exact review axis. The application binds each checkpoint to the immutable evidence-ledger digest. A fresh lane continuation reads this first and reconciles it with the exact manifest. Write one checkpoint before returning complete or requesting a fresh continuation. Complete checkpoints preserve a strict typed terminal report; in-progress checkpoints preserve coverage, evidence-backed observations, remaining work, and limitations without raw tool history.",
  inputSchema: reviewLaneCheckpointInputSchema,
  async execute(input, ctx) {
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.patchFingerprint) {
      throw new Error(
        "Trusted review context is missing the patch fingerprint",
      );
    }
    const sandbox = await ctx.getSandbox();
    const identity = await currentLaneCheckpointIdentity(
      ctx.session.auth.current,
      sandbox,
    );
    const manifest = await readReviewEvidenceManifest(sandbox, identity);
    if (input.operation === "read") {
      const checkpoint = await readLaneCheckpoint(
        sandbox,
        identity,
        input.axis,
      );
      if (checkpoint) {
        validateLaneCheckpointCoverage(checkpoint, manifest.entries.length);
      }
      return {
        operation: "read" as const,
        checkpoint,
      };
    }
    if (input.checkpoint === null) {
      throw new Error("Checkpoint writes require checkpoint content");
    }
    const progress = await readReviewEvidenceProgress(
      sandbox,
      manifest,
      input.axis,
    );
    validateLaneCheckpointEvidenceProgress(input.checkpoint, progress);
    const checkpoint = await writeLaneCheckpoint(
      sandbox,
      identity,
      input.axis,
      input.checkpoint,
      manifest.entries.length,
    );
    await publishAxisCheckpoint({
      axis: input.axis,
      context: trusted,
      octokit: githubAdapter(trusted.installationId).octokit,
      status: checkpoint.status,
    });
    return {
      operation: "write" as const,
      checkpoint,
    };
  },
  toModelOutput(output) {
    return toolOutput.json(
      output.operation === "write"
        ? {
            operation: output.operation,
            checkpoint: {
              axis: output.checkpoint.axis,
              revision: output.checkpoint.revision,
              status: output.checkpoint.status,
            },
          }
        : output,
    );
  },
});
