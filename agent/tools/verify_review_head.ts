import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubAdapter } from "../../src/github/chat-adapter";
import { writeReviewState } from "../../src/github/publication";
import { pendingReviewState } from "../../src/github/review-state";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";

export default defineTool({
  description:
    "Revalidate that the pull request is still open, reviewable, and at the trusted base/head before inspecting or publishing it. Call this after the initial debounce and immediately before every review.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    if (ctx.session.parent) {
      throw new Error(
        "Only the review coordinator can verify the pull request head",
      );
    }
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    const adapter = githubAdapter(trusted.installationId);
    const response = await adapter.octokit.rest.pulls.get({
      owner: trusted.owner,
      repo: trusted.repo,
      pull_number: trusted.pullRequest,
    });
    const current = response.data;
    const valid =
      current.state === "open" &&
      !current.draft &&
      current.head.sha === trusted.headSha &&
      current.base.sha === trusted.baseSha;
    if (valid) {
      const rawPlan =
        ctx.session.auth.current?.attributes[reviewContextAttributes.plan];
      if (typeof rawPlan === "string") {
        try {
          const plan = JSON.parse(rawPlan) as {
            kind?: string;
            reason?: string;
          };
          if (plan.kind === "full" && plan.reason === "initial") {
            await writeReviewState(
              adapter.octokit,
              trusted,
              pendingReviewState({
                pullRequest: trusted.pullRequest,
                status: "running",
              }),
            );
          }
        } catch {
          throw new Error("Trusted review plan is malformed");
        }
      }
    }
    return {
      valid,
      expected: { base: trusted.baseSha, head: trusted.headSha },
      current: {
        base: current.base.sha,
        draft: current.draft ?? false,
        head: current.head.sha,
        state: current.state,
      },
    };
  },
});
