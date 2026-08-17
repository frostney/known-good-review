import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { reviewAxes } from "../../src/review/axes";
import {
  laneCheckpointContentSchema,
  readLaneCheckpoint,
  validateLaneCheckpointCoverage,
  writeLaneCheckpoint,
} from "../../src/review/lane-checkpoint";
import { readReviewEvidenceManifest } from "../../src/review/evidence-bundle";

const inputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("read"),
    axis: z.enum(reviewAxes),
  }),
  z.object({
    operation: z.literal("write"),
    axis: z.enum(reviewAxes),
    checkpoint: laneCheckpointContentSchema,
  }),
]);

export default defineTool({
  description:
    "Read or replace the compact checkpoint for one exact review axis. A fresh lane continuation reads this first and reconciles it with the immutable evidence manifest. Write one checkpoint before returning complete or requesting a fresh continuation. Checkpoints preserve coverage, evidence-backed observations, remaining work, and limitations without preserving raw tool history.",
  inputSchema,
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
