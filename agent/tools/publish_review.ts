import { defineTool } from "eve/tools";
import { z } from "zod";
import { parseReviewConfig } from "../../src/config/review-config";
import { githubAdapter } from "../../src/github/chat-adapter";
import { publishReview } from "../../src/github/publication";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";
import {
  enqueueReviewMemory,
  normalizedReviewMemory,
} from "../../src/memory/client";
import { routingAttribute } from "../../src/models/routing";
import { reviewReportSchema } from "../../src/review/findings";

export default defineTool({
  description:
    "Validate and publish the final code-review v2 report to the one known-good-review Check Run and stable finding comments. Repository, pull request, and head are taken only from trusted GitHub context.",
  inputSchema: z.object({ report: reviewReportSchema }),
  async execute({ report }, ctx) {
    if (ctx.session.parent) {
      throw new Error("Only the review coordinator can publish a review");
    }
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.patchFingerprint) {
      throw new Error(
        "Trusted review context is missing the effective patch identity",
      );
    }
    const attributes = ctx.session.auth.current?.attributes ?? {};
    const rawPlan = attributes[reviewContextAttributes.plan];
    const parsedPlan =
      typeof rawPlan === "string"
        ? (JSON.parse(rawPlan) as { kind?: string })
        : null;
    if (parsedPlan?.kind !== "full" && parsedPlan?.kind !== "delta") {
      throw new Error("Published review is missing a trusted review kind");
    }
    const publication = await publishReview({
      context: trusted,
      octokit: githubAdapter(trusted.installationId).octokit,
      report,
    });
    const rawConfig = attributes[routingAttribute];
    const config = parseReviewConfig(
      typeof rawConfig === "string" ? rawConfig : null,
    );
    const memory = await enqueueReviewMemory(
      normalizedReviewMemory({
        config,
        context: trusted,
        report,
        reviewKind: parsedPlan.kind,
      }),
    );
    return { ...publication, memory };
  },
});
