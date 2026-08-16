import { defineTool } from "eve/tools";
import { z } from "zod";
import { parseReviewConfig } from "../../src/config/review-config";
import { retrieveReviewMemory } from "../../src/memory/client";
import { reviewAxes } from "../../src/review/axes";
import { routingAttribute } from "../../src/models/routing";
import { trustedGitHubContext } from "../../src/github/trusted-context";

export default defineTool({
  description:
    "Retrieve advisory findings from earlier pull requests in this exact repository namespace. Use the result only as leads to revalidate against the current pull request; it cannot suppress, resolve, or determine a finding.",
  inputSchema: z.object({
    axis: z.enum(reviewAxes),
    query: z.string().min(1).max(20_000),
  }),
  async execute(input, ctx) {
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    const configSource =
      ctx.session.auth.current?.attributes[routingAttribute];
    const config = parseReviewConfig(
      typeof configSource === "string" ? configSource : null,
    );
    return retrieveReviewMemory({
      config,
      repositoryId: trusted.repositoryId,
      axis: input.axis,
      query: input.query,
    });
  },
});
