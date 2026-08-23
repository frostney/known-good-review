import { z } from "zod";
import { reviewAxes } from "./axes";
import { findingIdentity } from "./finding-identity";
import {
  reviewFindingSchema,
  reviewFindingObjectSchema,
  reviewReportSchema,
  type ReviewFinding,
  type ReviewReport,
} from "./findings";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const schemaDiagnosticSchema = z.object({
  code: z.string().min(1).max(64),
  path: z.array(z.union([z.string().max(128), z.number().int().nonnegative()])).max(12),
});

export type SchemaDiagnostic = z.infer<typeof schemaDiagnosticSchema>;

export const reportAssemblyIdentitySchema = z.object({
  executionRevision: z.literal("review-report-v1"),
  repositoryId: z.string().min(1),
  pullRequest: z.number().int().positive(),
  baseSha: revisionSchema,
  headSha: revisionSchema,
  patchFingerprint: fingerprintSchema,
  planKind: z.enum(["full", "delta"]),
  activeAxes: z.array(z.enum(reviewAxes)).min(1).max(reviewAxes.length),
  selectedFindingIds: z
    .array(z.string().regex(/^CR-[1-9]\d*$/))
    .max(100),
}).superRefine((identity, context) => {
  if (new Set(identity.activeAxes).size !== identity.activeAxes.length) {
    context.addIssue({
      code: "custom",
      path: ["activeAxes"],
      message: "Review report axes must be unique",
    });
  }
  if (
    new Set(identity.selectedFindingIds).size !==
    identity.selectedFindingIds.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["selectedFindingIds"],
      message: "Review report finding identities must be unique",
    });
  }
  if (identity.planKind === "full" && identity.selectedFindingIds.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["selectedFindingIds"],
      message: "A full review cannot select prior findings",
    });
  }
});

export type ReportAssemblyIdentity = z.infer<
  typeof reportAssemblyIdentitySchema
>;

const reviewFindingDraftSchema = reviewFindingObjectSchema.omit({ id: true });

export const reviewReportDraftSchema = z
  .object({
    scope: z.object({
      claim: z.string(),
      dirtyState: z.string(),
    }),
    coverage: z.object({
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
    freshFindings: z.array(reviewFindingDraftSchema),
    verifiedClaims: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .strict();

export type ReviewReportDraft = z.infer<typeof reviewReportDraftSchema>;

export const reportAssemblyStateSchema = z.object({
  schemaVersion: z.literal(1),
  identity: reportAssemblyIdentitySchema,
  revalidatedFindings: z.array(reviewFindingSchema).max(100),
  report: reviewReportSchema.nullable(),
  diagnostics: z.array(schemaDiagnosticSchema).max(20),
});

export type ReportAssemblyState = z.infer<typeof reportAssemblyStateSchema>;

function diagnosticsFrom(error: z.ZodError): SchemaDiagnostic[] {
  return error.issues.slice(0, 20).map((issue) =>
    schemaDiagnosticSchema.parse({
      code: issue.code,
      path: issue.path.slice(0, 12).map((part) =>
        typeof part === "number" ? part : String(part).slice(0, 128),
      ),
    }),
  );
}

export class ReviewReportValidationError extends Error {
  readonly diagnostics: readonly SchemaDiagnostic[];

  constructor(diagnostics: readonly SchemaDiagnostic[]) {
    super("Canonical review report input is invalid");
    this.name = "ReviewReportValidationError";
    this.diagnostics = diagnostics;
  }
}

export function beginReportAssembly(
  identity: ReportAssemblyIdentity,
): ReportAssemblyState {
  return reportAssemblyStateSchema.parse({
    schemaVersion: 1,
    identity,
    revalidatedFindings: [],
    report: null,
    diagnostics: [],
  });
}

function sameIdentity(
  left: ReportAssemblyIdentity,
  right: ReportAssemblyIdentity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateReportAssemblyIdentity(
  state: ReportAssemblyState,
  identity: ReportAssemblyIdentity,
): ReportAssemblyState {
  const parsed = reportAssemblyStateSchema.parse(state);
  const expected = reportAssemblyIdentitySchema.parse(identity);
  if (!sameIdentity(parsed.identity, expected)) {
    throw new Error("Review report state does not match the trusted review");
  }
  return parsed;
}

export function recordRevalidationResults(
  state: ReportAssemblyState,
  value: unknown,
): ReportAssemblyState {
  const current = reportAssemblyStateSchema.parse(state);
  const parsed = z.array(reviewFindingSchema).max(100).safeParse(value);
  if (!parsed.success) {
    const diagnostics = diagnosticsFrom(parsed.error);
    throw new ReviewReportValidationError(diagnostics);
  }
  if (current.revalidatedFindings.length > 0) {
    if (
      JSON.stringify(current.revalidatedFindings) === JSON.stringify(parsed.data)
    ) {
      return current;
    }
    throw new Error("Completed finding revalidation cannot be replaced");
  }
  const expected = [...current.identity.selectedFindingIds].sort();
  const observed = parsed.data.map((finding) => finding.id).sort();
  if (
    expected.length !== observed.length ||
    expected.some((id, index) => id !== observed[index])
  ) {
    throw new ReviewReportValidationError([
      { code: "custom", path: ["revalidatedFindings"] },
    ]);
  }
  return reportAssemblyStateSchema.parse({
    ...current,
    revalidatedFindings: parsed.data,
    report: null,
    diagnostics: [],
  });
}

export function reportAssemblyFailure(
  state: ReportAssemblyState,
  error: unknown,
): ReportAssemblyState {
  const current = reportAssemblyStateSchema.parse(state);
  const diagnostics =
    error instanceof ReviewReportValidationError
      ? error.diagnostics
      : error instanceof z.ZodError
        ? diagnosticsFrom(error)
        : [{ code: "custom", path: [] }];
  const invalidReport =
    error instanceof ReviewReportValidationError || error instanceof z.ZodError;
  return reportAssemblyStateSchema.parse({
    ...current,
    report: invalidReport ? null : current.report,
    diagnostics,
  });
}

const severityOrder: Readonly<Record<ReviewFinding["severity"], number>> = {
  BLOCKING: 0,
  IMPORTANT: 1,
  IMPROVEMENT: 2,
  NITPICK: 3,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function findingDraftIdentity(
  finding: z.infer<typeof reviewFindingDraftSchema>,
): string {
  return findingIdentity(finding);
}

function sortedFreshFindings(
  findings: readonly z.infer<typeof reviewFindingDraftSchema>[],
): readonly z.infer<typeof reviewFindingDraftSchema>[] {
  return [...findings].sort((left, right) => {
    return (
      severityOrder[left.severity] - severityOrder[right.severity] ||
      compareText(left.category, right.category) ||
      compareText(left.location.path, right.location.path) ||
      left.location.line - right.location.line ||
      compareText(left.title, right.title)
    );
  });
}

function reportVerdict(
  findings: readonly ReviewFinding[],
): ReviewReport["verdict"] {
  const active = findings.filter((finding) => finding.status !== "fixed");
  if (
    active.some(
      (finding) =>
        finding.severity === "BLOCKING" || finding.severity === "IMPORTANT",
    )
  ) {
    return "REQUEST_CHANGES";
  }
  return active.length > 0 ? "APPROVE_WITH_IMPROVEMENTS" : "APPROVE";
}

function priorFindings(
  state: ReportAssemblyState,
  priorReport: ReviewReport | null,
): ReviewFinding[] {
  if (state.identity.planKind === "full") return [];
  if (!priorReport) {
    throw new ReviewReportValidationError([
      { code: "custom", path: ["priorReport"] },
    ]);
  }
  if (
    priorReport.scope.head === state.identity.headSha ||
    priorReport.scope.base !== state.identity.baseSha
  ) {
    throw new ReviewReportValidationError([
      { code: "custom", path: ["priorReport", "scope"] },
    ]);
  }
  const priorById = new Map(
    priorReport.findings.map((finding) => [finding.id, finding] as const),
  );
  for (const id of state.identity.selectedFindingIds) {
    if (!priorById.has(id)) {
      throw new ReviewReportValidationError([
        { code: "custom", path: ["priorReport", "findings"] },
      ]);
    }
  }
  if (
    state.revalidatedFindings.length !==
    state.identity.selectedFindingIds.length
  ) {
    throw new ReviewReportValidationError([
      { code: "custom", path: ["revalidatedFindings"] },
    ]);
  }
  const revalidated = new Map(
    state.revalidatedFindings.map((finding) => [finding.id, finding] as const),
  );
  return priorReport.findings.map(
    (finding) => revalidated.get(finding.id) ?? finding,
  );
}

export function assembleCanonicalReviewReport(input: {
  readonly draft: unknown;
  readonly generatedAt: string;
  readonly priorReport: ReviewReport | null;
  readonly state: ReportAssemblyState;
}): ReportAssemblyState {
  const state = reportAssemblyStateSchema.parse(input.state);
  if (state.report) return state;
  const draft = reviewReportDraftSchema.safeParse(input.draft);
  if (!draft.success) {
    throw new ReviewReportValidationError(diagnosticsFrom(draft.error));
  }
  const skippedNames = new Set(
    draft.data.coverage.skippedAxes.map((axis) => axis.name),
  );
  if (
    draft.data.coverage.skippedAxes.some((axis) =>
      state.identity.activeAxes.includes(
        axis.name as (typeof reviewAxes)[number],
      ),
    ) ||
    reviewAxes.some(
      (axis) =>
        !state.identity.activeAxes.includes(axis) && !skippedNames.has(axis),
    )
  ) {
    throw new ReviewReportValidationError([
      { code: "custom", path: ["coverage", "skippedAxes"] },
    ]);
  }

  const preserved = priorFindings(state, input.priorReport);
  const knownIdentities = new Set(preserved.map(findingIdentity));
  const freshIdentities = new Set<string>();
  const fresh = sortedFreshFindings(draft.data.freshFindings).filter(
    (finding) => {
      const identity = findingDraftIdentity(finding);
      if (knownIdentities.has(identity)) return false;
      if (freshIdentities.has(identity)) {
        throw new ReviewReportValidationError([
          { code: "custom", path: ["freshFindings"] },
        ]);
      }
      freshIdentities.add(identity);
      return true;
    },
  );
  const highestPriorId = preserved.reduce((highest, finding) => {
    return Math.max(highest, Number(finding.id.slice(3)));
  }, 0);
  const findings = [
    ...preserved,
    ...fresh.map((finding, index) => ({
      ...finding,
      id: `CR-${highestPriorId + index + 1}`,
    })),
  ].sort((left, right) => Number(left.id.slice(3)) - Number(right.id.slice(3)));

  const report = reviewReportSchema.safeParse({
    schemaVersion: 2,
    kind: "code-review",
    generatedAt: input.generatedAt,
    verdict: reportVerdict(findings),
    scope: {
      claim: draft.data.scope.claim,
      base: state.identity.baseSha,
      head: state.identity.headSha,
      dirtyState: draft.data.scope.dirtyState,
    },
    coverage: {
      activeAxes: state.identity.activeAxes,
      ...draft.data.coverage,
    },
    churn: draft.data.churn,
    probes: draft.data.probes,
    findings,
    verifiedClaims: draft.data.verifiedClaims,
    limitations: draft.data.limitations,
  });
  if (!report.success) {
    throw new ReviewReportValidationError(diagnosticsFrom(report.error));
  }
  return reportAssemblyStateSchema.parse({
    ...state,
    report: report.data,
    diagnostics: [],
  });
}
