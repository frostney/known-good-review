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

const inputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("manifest"),
    cursor: z.number().int().nonnegative().default(0),
  }),
  z.object({
    operation: z.literal("patch"),
    path: z.string().min(1),
    cursor: z.number().int().nonnegative().default(0),
  }),
  z.object({
    operation: z.literal("packet"),
    axis: z.enum(reviewAxes),
  }),
]);

export default defineTool({
  description:
    "Read the application-prepared immutable review evidence. Review lanes use exactly one application-advanced packet per fresh session; the packet contains bounded included patches and excluded generated, vendored, or binary metadata. Manifest and patch paging remain available to the coordinator. Use this instead of reconstructing the pull-request diff with Git.",
  inputSchema,
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
        ...reviewEvidencePage(manifest, input.cursor),
      };
    }
    if (input.operation === "packet") {
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
    return {
      operation: "patch" as const,
      ...(await readReviewEvidencePatch(sandbox, manifest, input)),
    };
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
