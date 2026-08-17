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

export const reviewLaneCheckpointInputSchema = z
  .object({
    operation: z
      .enum(["read", "write"])
      .describe("Read the current checkpoint or replace it."),
    axis: z.enum(reviewAxes),
    checkpoint: laneCheckpointContentSchema
      .optional()
      .describe("Required only for a write operation."),
  })
  .superRefine((input, refinement) => {
    if (input.operation === "write" && input.checkpoint === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Checkpoint writes require checkpoint content",
      });
    }
    if (input.operation === "read" && input.checkpoint !== undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Checkpoint reads do not accept checkpoint content",
      });
    }
  });

export default defineTool({
  description:
    "Read or replace the compact checkpoint for one exact review axis. A fresh lane continuation reads this first and reconciles it with the immutable evidence manifest. Write one checkpoint before returning complete or requesting a fresh continuation. Checkpoints preserve coverage, evidence-backed observations, remaining work, and limitations without preserving raw tool history.",
  inputSchema: reviewLaneCheckpointInputSchema,
  async execute(input, ctx) {
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.patchFingerprint) {
      throw new Error(
        "Trusted review context is missing the patch fingerprint",
      );
    }
    const identity = {
      baseSha: trusted.baseSha,
      headSha: trusted.headSha,
      patchFingerprint: trusted.patchFingerprint,
    };
    const sandbox = await ctx.getSandbox();
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
    if (input.checkpoint === undefined) {
      throw new Error("Checkpoint writes require checkpoint content");
    }
    const progress = await readReviewEvidenceProgress(
      sandbox,
      manifest,
      input.axis,
    );
    validateLaneCheckpointEvidenceProgress(input.checkpoint, progress);
    return {
      operation: "write" as const,
      checkpoint: await writeLaneCheckpoint(
        sandbox,
        identity,
        input.axis,
        input.checkpoint,
        manifest.entries.length,
      ),
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
