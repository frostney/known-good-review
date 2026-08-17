import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import { prepareReviewEvidence } from "../../src/review/prepare-review-evidence";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";
import verifyReviewHeadTool from "../tools/verify_review_head";

export default defineHook({
  events: {
    async "action.result"(event, ctx) {
      const verified = toolResultFrom(event.data.result, verifyReviewHeadTool);
      if (!verified?.output.valid || ctx.session.parent) return;
      const trusted = trustedGitHubContext(ctx.session.auth.current);
      const rawFiles =
        ctx.session.auth.current?.attributes[
          reviewContextAttributes.reviewFiles
        ];
      if (typeof rawFiles !== "string") {
        throw new Error(
          "Trusted review context is missing the exact file scope",
        );
      }
      await prepareReviewEvidence(
        await ctx.getSandbox(),
        trusted,
        JSON.parse(rawFiles),
      );
    },
  },
});
