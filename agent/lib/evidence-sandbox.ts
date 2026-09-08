import type { SessionContext } from "eve/context";
import { authenticatedEvidenceSandbox } from "../../src/review/authenticated-evidence";

export async function getReviewEvidenceSandbox(ctx: Pick<SessionContext, "session" | "getSandbox">) {
  return authenticatedEvidenceSandbox(
    await ctx.getSandbox(),
    ctx.session.parent?.rootSessionId ?? ctx.session.id,
    process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY,
  );
}
