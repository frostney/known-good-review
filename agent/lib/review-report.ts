import { defineState, type SessionAuthContext } from "eve/context";
import { z } from "zod";
import {
  beginReportAssembly,
  reportAssemblyIdentitySchema,
  validateReportAssemblyIdentity,
  type ReportAssemblyIdentity,
  type ReportAssemblyState,
} from "../../src/review/report-assembly";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";
import { reviewAxes } from "../../src/review/axes";

const reportPlanSchema = z.object({
  kind: z.enum(["full", "delta"]),
  activeAxes: z.array(z.enum(reviewAxes)).min(1).max(reviewAxes.length),
  selectedFindingIds: z.array(z.string().regex(/^CR-[1-9]\d*$/)).max(100),
});

export const reviewReportState = defineState<ReportAssemblyState | null>(
  "known-good-review.report",
  () => null,
);

export function reportAssemblyIdentityFromAuth(
  auth: SessionAuthContext | null | undefined,
): ReportAssemblyIdentity {
  const trusted = trustedGitHubContext(auth);
  if (!trusted.patchFingerprint) {
    throw new Error("Trusted review report is missing patch identity");
  }
  const rawPlan = auth?.attributes[reviewContextAttributes.plan];
  if (typeof rawPlan !== "string") {
    throw new Error("Trusted review report is missing its plan");
  }
  const plan = reportPlanSchema.parse(JSON.parse(rawPlan));
  return reportAssemblyIdentitySchema.parse({
    executionRevision: "review-report-v1",
    repositoryId: trusted.repositoryId,
    pullRequest: trusted.pullRequest,
    baseSha: trusted.baseSha,
    headSha: trusted.headSha,
    patchFingerprint: trusted.patchFingerprint,
    planKind: plan.kind,
    activeAxes: plan.activeAxes,
    selectedFindingIds: plan.selectedFindingIds,
  });
}

export function currentReviewReportState(
  auth: SessionAuthContext | null | undefined,
): ReportAssemblyState {
  const identity = reportAssemblyIdentityFromAuth(auth);
  const current = reviewReportState.get();
  if (current) return validateReportAssemblyIdentity(current, identity);
  const started = beginReportAssembly(identity);
  reviewReportState.update(() => started);
  return started;
}
