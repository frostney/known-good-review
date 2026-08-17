import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import {
  readNextReviewEvidencePacket,
  readReviewEvidenceManifest,
  readReviewEvidencePatch,
  reviewEvidencePage,
} from "../../src/review/evidence-bundle";
import { reviewAxes } from "../../src/review/axes";

export const readReviewEvidenceInputSchema = z
  .object({
    operation: z
      .enum(["manifest", "patch", "packet"])
      .describe("Evidence operation to perform."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Required only for a patch operation."),
    axis: z
      .enum(reviewAxes)
      .optional()
      .describe("Required only for a packet operation."),
    cursor: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Optional manifest or patch paging cursor."),
  })
  .superRefine((input, refinement) => {
    if (input.operation === "patch" && input.path === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["path"],
        message: "Patch reads require a path",
      });
    }
    if (input.operation !== "patch" && input.path !== undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["path"],
        message: "Only patch reads accept a path",
      });
    }
    if (input.operation === "packet" && input.axis === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["axis"],
        message: "Packet reads require a review axis",
      });
    }
    if (input.operation !== "packet" && input.axis !== undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["axis"],
        message: "Only packet reads accept a review axis",
      });
    }
  });

export default defineTool({
  description:
    "Read the application-prepared immutable review evidence. Review lanes use exactly one application-advanced packet per fresh session; the packet contains bounded included patches and excluded generated, vendored, or binary metadata. Manifest and patch paging remain available to the coordinator. Use this instead of reconstructing the pull-request diff with Git.",
  inputSchema: readReviewEvidenceInputSchema,
  async execute(input, ctx) {
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.patchFingerprint) {
      throw new Error(
        "Trusted review context is missing the patch fingerprint",
      );
    }
    const sandbox = await ctx.getSandbox();
    const manifest = await readReviewEvidenceManifest(sandbox, {
      baseSha: trusted.baseSha,
      headSha: trusted.headSha,
      patchFingerprint: trusted.patchFingerprint,
    });
    if (input.operation === "manifest") {
      return {
        operation: "manifest" as const,
        ...reviewEvidencePage(manifest, input.cursor ?? 0),
      };
    }
    if (input.operation === "packet") {
      if (input.axis === undefined) {
        throw new Error("Packet reads require a review axis");
      }
      return {
        operation: "packet" as const,
        ...(await readNextReviewEvidencePacket(
          sandbox,
          manifest,
          input.axis,
          ctx.session.id,
        )),
      };
    }
    if (input.path === undefined) {
      throw new Error("Patch reads require a path");
    }
    return {
      operation: "patch" as const,
      ...(await readReviewEvidencePatch(sandbox, manifest, {
        path: input.path,
        cursor: input.cursor ?? 0,
      })),
    };
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
