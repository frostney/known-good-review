import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubAdapter } from "../../src/github/chat-adapter";
import { publishReview } from "../../src/github/publication";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { reviewReportSchema } from "../../src/review/findings";

export default defineTool({
  description:
    "Validate and publish the final code-review v2 report to the one known-good-review Check Run and stable finding comments. Repository, pull request, and head are taken only from trusted GitHub context.",
  inputSchema: z.object({ report: reviewReportSchema }),
  async execute({ report }, ctx) {
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.patchFingerprint) {
      throw new Error("Trusted review context is missing the effective patch identity");
    }
    return publishReview({
      context: trusted,
      octokit: githubAdapter(trusted.installationId).octokit,
      report,
    });
  },
});
