import { defineState, type SessionAuthContext } from "eve/context";
import { z } from "zod";
import { reviewContextAttributes, trustedGitHubContext } from "../../src/github/trusted-context";
import { reviewAxes } from "../../src/review/axes";
import {
  beginReviewRecovery,
  validateReviewRecoveryIdentity,
  type ReviewRecoveryState,
} from "../../src/review/recovery";

const trustedRecoveryPlanSchema = z.object({
  kind: z.enum(["full", "delta"]),
  activeAxes: z.array(z.enum(reviewAxes)).min(1).max(reviewAxes.length),
  selectedFindingIds: z.array(z.string().regex(/^CR-[1-9]\d*$/)).max(100),
});

export const reviewRecoveryState = defineState<ReviewRecoveryState | null>(
  "known-good-review.recovery",
  () => null,
);

export function recoveryStateFromAuth(
  auth: SessionAuthContext | null | undefined,
): ReviewRecoveryState {
  const trusted = trustedGitHubContext(auth);
  if (!trusted.patchFingerprint) {
    throw new Error("Trusted review recovery is missing patch identity");
  }
  const rawPlan = auth?.attributes[reviewContextAttributes.plan];
  if (typeof rawPlan !== "string") {
    throw new Error("Trusted review recovery is missing its plan");
  }
  const plan = trustedRecoveryPlanSchema.parse(JSON.parse(rawPlan));
  return beginReviewRecovery({
    activeAxes: plan.activeAxes,
    identity: {
      baseSha: trusted.baseSha,
      headSha: trusted.headSha,
      patchFingerprint: trusted.patchFingerprint,
      planKind: plan.kind,
    },
    selectedFindingIds: plan.selectedFindingIds,
  });
}

export function currentRecoveryState(
  auth: SessionAuthContext | null | undefined,
): ReviewRecoveryState {
  const current = reviewRecoveryState.get();
  if (current) {
    const trusted = trustedGitHubContext(auth);
    if (!trusted.patchFingerprint) {
      throw new Error("Trusted review recovery is missing patch identity");
    }
    const rawPlan = auth?.attributes[reviewContextAttributes.plan];
    if (typeof rawPlan !== "string") {
      throw new Error("Trusted review recovery is missing its plan");
    }
    const plan = z.object({ kind: z.enum(["full", "delta"]) }).parse(
      JSON.parse(rawPlan),
    );
    return validateReviewRecoveryIdentity(current, {
      baseSha: trusted.baseSha,
      headSha: trusted.headSha,
      patchFingerprint: trusted.patchFingerprint,
      planKind: plan.kind,
    });
  }
  const started = recoveryStateFromAuth(auth);
  reviewRecoveryState.update(() => started);
  return started;
}
