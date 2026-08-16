import { z } from "zod";
import { reviewAxes } from "./axes";

const findingLocationSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  symbol: z.string().nullable(),
});

const churnSchema = z.object({
  granularity: z.enum(["symbol", "file"]),
  window: z.string(),
  touches: z.number().int().nonnegative(),
  linesAdded: z.number().int().nonnegative(),
  linesDeleted: z.number().int().nonnegative(),
  coSignals: z.array(z.string()),
});

export const reviewFindingSchema = z
  .object({
    id: z.string().regex(/^CR-[1-9]\d*$/),
    severity: z.enum(["BLOCKING", "IMPORTANT", "IMPROVEMENT"]),
    category: z.enum([
      "CLAIM",
      "QUALITY",
      "ARCHITECTURE_RISK",
      "DISCOVERABILITY",
    ]),
    title: z.string().min(1),
    location: findingLocationSchema,
    evidence: z.array(z.string().min(1)).min(1),
    impact: z.string().min(1),
    remedy: z.string().min(1),
    status: z.enum(["open", "fixed", "deferred"]),
    staticOnly: z.boolean(),
    churn: churnSchema.nullable(),
  })
  .superRefine((finding, ctx) => {
    if (finding.category === "ARCHITECTURE_RISK" && finding.churn === null) {
      ctx.addIssue({
        code: "custom",
        path: ["churn"],
        message: "ARCHITECTURE_RISK findings require churn evidence",
      });
    }
    if (finding.category !== "ARCHITECTURE_RISK" && finding.churn !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["churn"],
        message: "Only ARCHITECTURE_RISK findings may contain churn evidence",
      });
    }
  });

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
    report.findings.forEach((finding, index) => {
      const path = finding.location.path;
      if (
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").includes("..")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["findings", index, "location", "path"],
          message: "Finding paths must be repository-relative",
        });
      }
    });
  });

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewReport = z.infer<typeof reviewReportSchema>;
