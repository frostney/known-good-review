import { z } from "zod";
import { reviewAxes } from "./axes";

export const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/);

export const findingLocationSchema = z
  .strictObject({
    path: repositoryRelativePathSchema,
    line: z.number().int().positive(),
    symbol: z.string().nullable(),
  });

export const findingChurnSchema = z
  .strictObject({
    granularity: z.enum(["symbol", "file"]),
    window: z.string(),
    touches: z.number().int().nonnegative(),
    linesAdded: z.number().int().nonnegative(),
    linesDeleted: z.number().int().nonnegative(),
    coSignals: z.array(z.string()),
  });

export const findingImpactSummarySchema = z.string().min(1).max(300)
  .describe("Plain-text consequence summary, at most 300 characters. Preserve the full analysis in impact.");

export const reviewFindingEvidenceSchema = z
  .strictObject({
    title: z.string().min(1),
    location: findingLocationSchema,
    evidence: z.array(z.string().min(1)).min(1),
    impact: z.string().min(1),
    impactSummary: findingImpactSummarySchema.optional(),
    remedy: z.string().min(1),
    staticOnly: z.boolean(),
  });

const findingDraftBaseShape = {
  severity: z.enum(["BLOCKING", "IMPORTANT", "IMPROVEMENT", "NITPICK"]),
  ...reviewFindingEvidenceSchema.shape,
  impactSummary: findingImpactSummarySchema,
};

const claimFindingDraftSchema = z
  .strictObject({
    ...findingDraftBaseShape,
    category: z.literal("CLAIM"),
    churn: z.null(),
  });
const qualityFindingDraftSchema = z
  .strictObject({
    ...findingDraftBaseShape,
    category: z.literal("QUALITY"),
    churn: z.null(),
  });
const architectureRiskFindingDraftSchema = z
  .strictObject({
    ...findingDraftBaseShape,
    category: z.literal("ARCHITECTURE_RISK"),
    churn: findingChurnSchema,
  });
const discoverabilityFindingDraftSchema = z
  .strictObject({
    ...findingDraftBaseShape,
    category: z.literal("DISCOVERABILITY"),
    churn: z.null(),
  });

export const reviewFindingDraftSchema = z.discriminatedUnion("category", [
  claimFindingDraftSchema,
  qualityFindingDraftSchema,
  architectureRiskFindingDraftSchema,
  discoverabilityFindingDraftSchema,
]);

const canonicalFindingShape = {
  id: z.string().regex(/^CR-[1-9]\d*$/),
  status: z.enum(["open", "fixed", "deferred"]),
  // Reports and revalidation can carry findings recorded before summaries existed.
  impactSummary: findingImpactSummarySchema.optional(),
};

export const reviewFindingSchema = z.discriminatedUnion("category", [
  claimFindingDraftSchema.extend(canonicalFindingShape),
  qualityFindingDraftSchema.extend(canonicalFindingShape),
  architectureRiskFindingDraftSchema.extend(canonicalFindingShape),
  discoverabilityFindingDraftSchema.extend(canonicalFindingShape),
]);

export const reviewReportSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal("code-review"),
    generatedAt: z.iso.datetime(),
    verdict: z.enum([
      "APPROVE",
      "APPROVE_WITH_IMPROVEMENTS",
      "REQUEST_CHANGES",
    ]),
    scope: z.object({
      claim: z.string(),
      base: z.string().min(1),
      head: z.string().min(1),
      dirtyState: z.string(),
    }),
    coverage: z.object({
      activeAxes: z.array(z.enum(reviewAxes)),
      skippedAxes: z.array(
        z.object({ name: z.string(), reason: z.string().min(1) }),
      ),
      staticOnly: z.array(z.string()),
      unreached: z.array(z.string()),
    }),
    churn: z.object({
      window: z.string(),
      symbolCoverage: z.array(z.string()),
      fileFallbacks: z.array(z.string()),
    }),
    probes: z.array(
      z.object({ commandOrAction: z.string(), result: z.string() }),
    ),
    findings: z.array(reviewFindingSchema),
    verifiedClaims: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .superRefine((report, ctx) => {
    const ids = report.findings.map((finding) => finding.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "Finding IDs must be unique",
      });
    }
  });

export type ReviewFindingDraft = z.infer<typeof reviewFindingDraftSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewReport = z.infer<typeof reviewReportSchema>;
