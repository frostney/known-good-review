import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import {
  readReviewEvidenceManifest,
  readReviewEvidencePatch,
  reviewEvidencePage,
} from "../../src/review/evidence-bundle";

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
]);

export default defineTool({
  description:
    "Read the application-prepared immutable review evidence. Page the manifest to enumerate the exact included patches and excluded generated, vendored, or binary metadata. Page each included patch by its exact repository path. Use this instead of reconstructing the pull-request diff with Git.",
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
    return input.operation === "manifest"
      ? {
          operation: "manifest" as const,
          ...reviewEvidencePage(manifest, input.cursor),
        }
      : {
          operation: "patch" as const,
          ...(await readReviewEvidencePatch(sandbox, manifest, input)),
        };
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
