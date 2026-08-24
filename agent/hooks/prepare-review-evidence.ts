import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import { z } from "zod";
import { githubAdapter } from "../../src/github/chat-adapter";
import { collectExactHeadGitHubEvidence } from "../../src/github/exact-head-evidence";
import { prepareReviewEvidence } from "../../src/review/prepare-review-evidence";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";
import verifyReviewHeadTool from "../tools/verify_review_head";

const reviewPlanSchema = z.object({ kind: z.enum(["full", "delta"]) });

export default defineHook({
  events: {
    async "action.result"(event, ctx) {
      const verified = toolResultFrom(event.data.result, verifyReviewHeadTool);
      if (!verified?.output.valid || ctx.session.parent) return;
      const trusted = trustedGitHubContext(ctx.session.auth.current);
      if (!trusted.repositoryDatabaseId) {
        throw new Error(
          "Trusted review context is missing the repository database id",
        );
      }
      const repositoryDatabaseId = trusted.repositoryDatabaseId;
      const rawFiles =
        ctx.session.auth.current?.attributes[
          reviewContextAttributes.reviewFiles
        ];
      if (typeof rawFiles !== "string") {
        throw new Error(
          "Trusted review context is missing the exact file scope",
        );
      }
      const rawPlan =
        ctx.session.auth.current?.attributes[reviewContextAttributes.plan];
      if (typeof rawPlan !== "string") {
        throw new Error("Trusted review context is missing the review plan");
      }
      const plan = reviewPlanSchema.parse(JSON.parse(rawPlan));
      await prepareReviewEvidence(
        await ctx.getSandbox(),
        trusted,
        JSON.parse(rawFiles),
        {
          planKind: plan.kind,
          collectGitHubEvidence: () =>
            collectExactHeadGitHubEvidence(
              githubAdapter(trusted.installationId).octokit,
              {
                headSha: trusted.headSha,
                owner: trusted.owner,
                repo: trusted.repo,
                repositoryDatabaseId,
              },
            ),
        },
      );
    },
  },
});
