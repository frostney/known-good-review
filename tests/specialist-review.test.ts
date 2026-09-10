import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { reviewInstructions } from "../src/review/policy";
import { reviewLaneCheckpointInputSchema } from "../agent/tools/review_lane_checkpoint";
import { activeReviewAxes } from "../src/review/axes";
import { readNextReviewEvidencePacket, writeIncludedReviewEvidence, type ReviewEvidenceManifest } from "../src/review/evidence-bundle";
import { validateLaneCheckpointCoverage, writeLaneCheckpoint, type LaneCompletedReport } from "../src/review/lane-checkpoint";
import { retainSpecialistEvidence } from "../src/review/specialist-report";
import { assembleCanonicalReviewReport, beginReportAssembly, type ReviewReportDraft } from "../src/review/report-assembly";
import { checkpointContent, identity } from "./fixtures/eve-runtime-smoke/agent/lib/orchestration";

function sandboxFixture() {
  const files = new Map<string, string>();
  return {
    async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; },
    async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content); },
    async removePath({ path }: { path: string }) { files.delete(path); },
  };
}

const check = {
  entries: [0], requirement: "The CLI rejects missing inputs", source: "docs/requirements.md at exact head",
  expected: "Nonzero exit with a useful diagnostic", environment: "Local exact-head CLI",
  action: "cli validate --input missing", observed: "No runtime available in this fixture", status: "unverified" as const,
};

describe("specialist evidence obligations", () => {
  test("activation retains core review and excludes writing only for known non-prose inputs", () => {
    expect(activeReviewAxes(["src/main.ts"], [])).toEqual(["deduplication", "claim-and-specification", "engineering-quality", "test-against-spec", "writing-quality", "test-health"]);
    expect(activeReviewAxes(["bun.lock", "assets/logo.png"], [])).toEqual(["deduplication", "claim-and-specification", "engineering-quality", "test-against-spec", "test-health"]);
    expect(activeReviewAxes(["README.md"], [])).not.toContain("test-health");
    expect(activeReviewAxes(["website/index.html"], [])).toContain("discoverability");
    expect(activeReviewAxes(["unfamiliar-format"], [])).toContain("writing-quality");
  });

  test("scoped packets retain every manifest index and core patches while omitting spec implementation payloads", async () => {
    const sandbox = sandboxFixture();
    const source = await writeIncludedReviewEvidence(sandbox, { patchFingerprint: identity.patchFingerprint, path: "src/main.ts", patch: "+implementation-only\n", patchTokens: 4, status: "modified" });
    const spec = await writeIncludedReviewEvidence(sandbox, { patchFingerprint: identity.patchFingerprint, path: "docs/requirements.md", patch: "+CLI must reject missing input\n", patchTokens: 7, status: "modified" });
    const lock = await writeIncludedReviewEvidence(sandbox, { patchFingerprint: identity.patchFingerprint, path: "bun.lock", patch: "+dependency graph\n", patchTokens: 3, status: "modified" });
    const manifest: ReviewEvidenceManifest = { schemaVersion: 1, ...identity, entries: [source, spec, lock] };
    const core = await readNextReviewEvidencePacket(sandbox, manifest, "engineering-quality", "core", 0);
    const specialist = await readNextReviewEvidencePacket(sandbox, manifest, "test-against-spec", "spec", 0);
    expect(core.entries.map((entry) => entry.content)).toEqual(["+implementation-only\n", "+CLI must reject missing input\n", "+dependency graph\n"]);
    expect(specialist.completedEntries).toEqual([0, 1, 2]);
    expect(specialist.entries[0]).toMatchObject({ index: 0, patchOmissionReason: expect.any(String), obligation: expect.any(String) });
    expect(specialist.entries[0]).not.toHaveProperty("content");
    expect(specialist.entries[1]?.content).toBe("+CLI must reject missing input\n");
    expect(await readNextReviewEvidencePacket(sandbox, manifest, "test-against-spec", "replacement", 0)).toEqual(specialist);
    const writing = await readNextReviewEvidencePacket(sandbox, manifest, "writing-quality", "writing", 0);
    expect(writing.completedEntries).toEqual([0, 1, 2]);
    expect(writing.entries[0]?.content).toBe("+implementation-only\n");
    expect(writing.entries[2]).not.toHaveProperty("content");
    const health = await readNextReviewEvidencePacket(sandbox, manifest, "test-health", "health", 0);
    expect(health.completedEntries).toEqual([0, 1, 2]);
    expect(health.entries[0]).not.toHaveProperty("content");
    expect(health.entries[1]?.content).toBe("+CLI must reject missing input\n");
    expect(health.entries[0]?.obligation).toContain("frozen external contract");
  });

  test("complete specialist checkpoints reject missing, partial or expanded obligations", async () => {
    const content = checkpointContent("test-against-spec");
    content.reviewedEntries = [0, 1];
    if (!content.completedReport) throw new Error("Expected complete fixture");
    content.completedReport.specialistChecks = [check];
    await expect(writeLaneCheckpoint(sandboxFixture(), identity, "test-against-spec", content, 2)).rejects.toThrow("every manifest entry");
    content.completedReport.specialistChecks = [{ ...check, entries: [0, 1, 2] }];
    expect(() => validateLaneCheckpointCoverage(content, 2)).toThrow("without expanding scope");
    content.completedReport.specialistChecks = [{ ...check, entries: [0, 1] }];
    expect(() => validateLaneCheckpointCoverage(content, 2)).not.toThrow();
    content.completedReport.specialistChecks = null;
    expect(() => validateLaneCheckpointCoverage(content, 2)).toThrow("explicit coverage checks");
  });

  test("the actual tool JSON Schema exposes closed, required specialist evidence fields", async () => {
    const schema = await asSchema(reviewLaneCheckpointInputSchema).jsonSchema;
    expect(schema).toHaveProperty("properties.checkpoint.anyOf.0.properties.completedReport.anyOf.0.properties.specialistChecks.anyOf.0.items.additionalProperties", false);
    expect(schema).toHaveProperty("properties.checkpoint.anyOf.0.properties.completedReport.anyOf.0.properties.specialistChecks.anyOf.0.items.properties.status.enum", ["passed", "failed", "unverified", "out-of-scope"]);
  });

  test("all specialist outcomes reach canonical report assembly without coordinator restatement", () => {
    const draft: ReviewReportDraft = { scope: { claim: "CLI validation", dirtyState: "clean" }, coverage: { staticOnly: [], unreached: [] }, churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] }, probes: [], freshFindings: [], verifiedClaims: [], limitations: [] };
    const completed = checkpointContent("test-against-spec").completedReport;
    if (!completed) throw new Error("Expected complete fixture");
    const report: LaneCompletedReport = { ...completed, specialistChecks: ["passed", "failed", "unverified", "out-of-scope"].map((status) => ({ ...check, status: status as "passed" | "failed" | "unverified" | "out-of-scope" })) };
    const retained = retainSpecialistEvidence(draft, [report]);
    const assembled = assembleCanonicalReviewReport({ draft: retained, generatedAt: "2026-09-10T00:00:00.000Z", priorReport: null, state: beginReportAssembly({ executionRevision: "review-report-v2", repositoryId: "R_fixture", pullRequest: 1, ...identity, planKind: "full", baselineHead: null, reviewPaths: ["src/main.ts"], activeAxes: ["test-against-spec"], selectedFindingIds: [] }) });
    expect(assembled.report?.probes).toHaveLength(4);
    expect(assembled.report?.limitations).toHaveLength(3);
    expect(assembled.report?.coverage.unreached[0]).toContain("unverified");
    expect(assembled.report?.verifiedClaims).toEqual([]);
    expect(retainSpecialistEvidence(retained, [report])).toEqual(retained);
  });
});

test("role-specific policies retain review authority without handing lanes coordinator procedure", () => {
  const coordinator = reviewInstructions({ role: "coordinator", attempt: 0 });
  const spec = reviewInstructions({ role: "lane", axis: "test-against-spec", attempt: 0 });
  const writing = reviewInstructions({ role: "lane", axis: "writing-quality", attempt: 0 });
  const health = reviewInstructions({ role: "lane", axis: "test-health", attempt: 0 });
  for (const policy of [coordinator, spec, writing, reviewInstructions({ role: "scout", attempt: 0 })]) {
    expect(policy).toContain("Slop Sheriff");
    expect(policy).toContain("Never push, merge");
    expect(policy).not.toContain("Load the installed");
  }
  expect(coordinator).toContain("Call workflow once");
  expect(spec).not.toContain("Call workflow once");
  expect(spec).toContain("Source, unit tests, mocks, snapshots and patches cannot establish behavioral success");
  expect(spec).toContain("absent/conflicting specification is unverified");
  expect(writing).toContain("Do not claim AI authorship");
  expect(writing).toContain("exact economical rewrite");
  expect(health).toContain("Freeze these expectations before running the candidate");
  expect(health).toContain("tolerate behavior-preserving refactors");
  expect(health).toContain("Never derive expected values from the implementation");
  expect(health).toContain("Do not infer when or by whom tests were written");
});
