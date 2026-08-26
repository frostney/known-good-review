import { z } from "zod";
import { reviewAxes } from "./axes";

export const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/);

export const findingLocationSchema = z
  .object({
    path: repositoryRelativePathSchema,
    line: z.number().int().positive(),
    symbol: z.string().nullable(),
  })
  .strict();

export const findingChurnSchema = z
  .object({
    granularity: z.enum(["symbol", "file"]),
    window: z.string(),
    touches: z.number().int().nonnegative(),
    linesAdded: z.number().int().nonnegative(),
    linesDeleted: z.number().int().nonnegative(),
    coSignals: z.array(z.string()),
  })
  .strict();

export const reviewFindingEvidenceSchema = z
  .object({
    title: z.string().min(1),
    location: findingLocationSchema,
    evidence: z.array(z.string().min(1)).min(1),
    impact: z.string().min(1),
    remedy: z.string().min(1),
    staticOnly: z.boolean(),
  })
  .strict();

const findingDraftBaseShape = {
  severity: z.enum(["BLOCKING", "IMPORTANT", "IMPROVEMENT", "NITPICK"]),
  ...reviewFindingEvidenceSchema.shape,
};

const claimFindingDraftSchema = z
  .object({
    ...findingDraftBaseShape,
    category: z.literal("CLAIM"),
    churn: z.null(),
  })
  .strict();
const qualityFindingDraftSchema = z
  .object({
    ...findingDraftBaseShape,
    category: z.literal("QUALITY"),
    churn: z.null(),
  })
  .strict();
const architectureRiskFindingDraftSchema = z
  .object({
    ...findingDraftBaseShape,
    category: z.literal("ARCHITECTURE_RISK"),
    churn: findingChurnSchema,
  })
  .strict();
const discoverabilityFindingDraftSchema = z
  .object({
    ...findingDraftBaseShape,
    category: z.literal("DISCOVERABILITY"),
    churn: z.null(),
  })
  .strict();

export const reviewFindingDraftSchema = z.discriminatedUnion("category", [
  claimFindingDraftSchema,
  qualityFindingDraftSchema,
  architectureRiskFindingDraftSchema,
  discoverabilityFindingDraftSchema,
]);

const canonicalFindingShape = {
  id: z.string().regex(/^CR-[1-9]\d*$/),
  status: z.enum(["open", "fixed", "deferred"]),
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
    generatedAt: z.string().datetime(),
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
