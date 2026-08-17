import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readReviewEvidenceInputSchema } from "../agent/tools/read_review_evidence";
import { reviewLaneCheckpointInputSchema } from "../agent/tools/review_lane_checkpoint";
import {
  readReviewEvidenceManifest,
  readNextReviewEvidencePacket,
  readReviewEvidenceProgress,
  readReviewEvidencePatch,
  reviewEvidenceManifestSchema,
  resetReviewEvidence,
  reviewEvidenceManifestPath,
  reviewEvidencePage,
  reviewEvidencePatchFile,
  writeIncludedReviewEvidence,
  writeReviewEvidenceManifest,
  type ReviewEvidenceManifest,
} from "../src/review/evidence-bundle";
import {
  readLaneCheckpoint,
  validateLaneCheckpointCoverage,
  validateLaneCheckpointEvidenceProgress,
  writeLaneCheckpoint,
} from "../src/review/lane-checkpoint";
import {
  coordinatorReviewSteps,
  coordinatorReviewWindowClosed,
  reviewLaneProbeSteps,
  reviewLaneProbeWindowClosed,
} from "../src/review/probe-window";

const identity = {
  baseSha: "1".repeat(40),
  headSha: "2".repeat(40),
  patchFingerprint: "3".repeat(64),
};

function memorySandbox() {
  const files = new Map<string, string>();
  return {
    files,
    runtime: {
      async readTextFile({ path }: { readonly path: string }) {
        return files.get(path) ?? null;
      },
      async removePath({ path }: { readonly path: string }) {
        for (const filePath of files.keys()) {
          if (filePath === path || filePath.startsWith(`${path}/`)) {
            files.delete(filePath);
          }
        }
      },
      async writeTextFile({
        path,
        content,
      }: {
        readonly path: string;
        readonly content: string;
      }) {
        files.set(path, content);
      },
    },
  };
}

describe("review evidence bundle", () => {
  test("exposes provider-compatible object schemas for variant tools", () => {
    expect(z.toJSONSchema(readReviewEvidenceInputSchema)).toHaveProperty(
      "type",
      "object",
    );
    expect(z.toJSONSchema(reviewLaneCheckpointInputSchema)).toHaveProperty(
      "type",
      "object",
    );
    expect(
      readReviewEvidenceInputSchema.safeParse({ operation: "patch" }).success,
    ).toBeFalse();
    expect(
      readReviewEvidenceInputSchema.safeParse({
        operation: "packet",
        axis: "engineering-quality",
      }).success,
    ).toBeTrue();
    expect(
      reviewLaneCheckpointInputSchema.safeParse({
        operation: "write",
        axis: "engineering-quality",
      }).success,
    ).toBeFalse();
  });

  test("stores one content-addressed patch and returns bounded pages", async () => {
    const sandbox = memorySandbox();
    const patch = "@@ -1 +1 @@\n-old\n+new\n".repeat(1_000);
    await resetReviewEvidence(sandbox.runtime, identity.patchFingerprint);
    const included = await writeIncludedReviewEvidence(sandbox.runtime, {
      patchFingerprint: identity.patchFingerprint,
      path: "src/review.ts",
      patch,
      patchTokens: 7_000,
      status: "modified",
    });
    const excluded: ReviewEvidenceManifest["entries"][number] = {
      kind: "excluded",
      path: "assets/logo.png",
      status: "modified",
      classification: ["binary"],
      addedLines: 0,
      deletedLines: 0,
      patchCharacters: 20,
      patchTokens: 7,
      patchSha256: createHash("sha256").update("binary patch").digest("hex"),
    };
    await writeReviewEvidenceManifest(sandbox.runtime, {
      schemaVersion: 1,
      ...identity,
      entries: [included, excluded],
    });

    const manifest = await readReviewEvidenceManifest(
      sandbox.runtime,
      identity,
    );
    expect(reviewEvidencePage(manifest, 0)).toMatchObject({
      totalEntries: 2,
      nextCursor: null,
      entries: [{ index: 0 }, { index: 1 }],
    });
    const first = await readReviewEvidencePatch(sandbox.runtime, manifest, {
      path: "src/review.ts",
      cursor: 0,
    });
    expect(first.content.length).toBe(16_000);
    expect(first.nextCursor).toBe(16_000);
    const second = await readReviewEvidencePatch(sandbox.runtime, manifest, {
      path: "src/review.ts",
      cursor: first.nextCursor ?? 0,
    });
    expect(`${first.content}${second.content}`).toBe(patch);
  });

  test("rejects a changed patch and a mismatched trusted review", async () => {
    const sandbox = memorySandbox();
    const included = await writeIncludedReviewEvidence(sandbox.runtime, {
      patchFingerprint: identity.patchFingerprint,
      path: "src/review.ts",
      patch: "original",
      patchTokens: 1,
      status: "modified",
    });
    await writeReviewEvidenceManifest(sandbox.runtime, {
      schemaVersion: 1,
      ...identity,
      entries: [included],
    });
    const manifest = await readReviewEvidenceManifest(
      sandbox.runtime,
      identity,
    );
    const patchFile = reviewEvidencePatchFile(
      identity.patchFingerprint,
      "src/review.ts",
    );
    sandbox.files.set(patchFile.filePath, "changed");
    await expect(
      readReviewEvidencePatch(sandbox.runtime, manifest, {
        path: "src/review.ts",
        cursor: 0,
      }),
    ).rejects.toThrow("integrity validation");

    sandbox.files.set(
      reviewEvidenceManifestPath(identity.patchFingerprint),
      `${JSON.stringify({ ...manifest, headSha: "4".repeat(40) })}\n`,
    );
    await expect(
      readReviewEvidenceManifest(sandbox.runtime, identity),
    ).rejects.toThrow("does not match the trusted review");
  });

  test("rejects unsafe or duplicate manifest paths", () => {
    const entry = {
      kind: "excluded" as const,
      path: "src/review.ts",
      status: "modified" as const,
      classification: ["binary" as const],
      addedLines: 0,
      deletedLines: 0,
      patchCharacters: 20,
      patchTokens: 7,
      patchSha256: createHash("sha256").update("binary patch").digest("hex"),
    };
    expect(() =>
      reviewEvidenceManifestSchema.parse({
        schemaVersion: 1,
        ...identity,
        entries: [entry, entry],
      }),
    ).toThrow("paths must be unique");
    expect(() =>
      reviewEvidenceManifestSchema.parse({
        schemaVersion: 1,
        ...identity,
        entries: [{ ...entry, path: "../outside.ts" }],
      }),
    ).toThrow("repository-relative");
  });

  test("keeps Unicode scalar values intact at patch page boundaries", async () => {
    const sandbox = memorySandbox();
    const patch = `${"a".repeat(15_999)}😀tail`;
    const included = await writeIncludedReviewEvidence(sandbox.runtime, {
      patchFingerprint: identity.patchFingerprint,
      path: "src/unicode.ts",
      patch,
      patchTokens: 1,
      status: "modified",
    });
    await writeReviewEvidenceManifest(sandbox.runtime, {
      schemaVersion: 1,
      ...identity,
      entries: [included],
    });
    const manifest = await readReviewEvidenceManifest(
      sandbox.runtime,
      identity,
    );
    const first = await readReviewEvidencePatch(sandbox.runtime, manifest, {
      path: "src/unicode.ts",
      cursor: 0,
    });
    const second = await readReviewEvidencePatch(sandbox.runtime, manifest, {
      path: "src/unicode.ts",
      cursor: first.nextCursor ?? 0,
    });
    expect(first.content.endsWith("😀")).toBe(true);
    expect(`${first.content}${second.content}`).toBe(patch);
  });

  test("advances one bounded idempotent evidence packet per fresh session", async () => {
    const sandbox = memorySandbox();
    const patch = "x".repeat(600_000);
    const included = await writeIncludedReviewEvidence(sandbox.runtime, {
      patchFingerprint: identity.patchFingerprint,
      path: "src/large.ts",
      patch,
      patchTokens: 150_000,
      status: "modified",
    });
    await writeReviewEvidenceManifest(sandbox.runtime, {
      schemaVersion: 1,
      ...identity,
      entries: [included],
    });
    const manifest = await readReviewEvidenceManifest(
      sandbox.runtime,
      identity,
    );

    const first = await readNextReviewEvidencePacket(
      sandbox.runtime,
      manifest,
      "engineering-quality",
      "session-one",
    );
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]?.content).toHaveLength(500_000);
    expect(first.completedEntries).toEqual([]);
    expect(first.nextCursor).toEqual({
      entryIndex: 0,
      characterOffset: 500_000,
    });
    expect(
      await readNextReviewEvidencePacket(
        sandbox.runtime,
        manifest,
        "engineering-quality",
        "session-one",
      ),
    ).toEqual(first);

    const second = await readNextReviewEvidencePacket(
      sandbox.runtime,
      manifest,
      "engineering-quality",
      "session-two",
    );
    expect(second.entries[0]?.content).toHaveLength(100_000);
    expect(second.completedEntries).toEqual([0]);
    expect(second.nextCursor).toBeNull();
    expect(
      await readReviewEvidenceProgress(
        sandbox.runtime,
        manifest,
        "engineering-quality",
      ),
    ).toEqual({ cursor: null, completedEntries: [0] });
  });
});

describe("review lane checkpoint", () => {
  test("rolls a deep lane into checkpoint-only mode at the fixed step boundary", () => {
    expect(
      reviewLaneProbeWindowClosed({
        channelKind: "subagent",
        stepIndex: reviewLaneProbeSteps - 1,
      }),
    ).toBe(false);
    expect(
      reviewLaneProbeWindowClosed({
        channelKind: "subagent",
        stepIndex: reviewLaneProbeSteps,
      }),
    ).toBe(true);
    expect(
      reviewLaneProbeWindowClosed({
        channelKind: "github",
        stepIndex: reviewLaneProbeSteps,
      }),
    ).toBe(false);
  });

  test("moves a fresh review coordinator into checkpoint and publish mode", () => {
    expect(
      coordinatorReviewWindowClosed({
        channelKind: "github",
        reviewKind: "full",
        stepIndex: coordinatorReviewSteps - 1,
      }),
    ).toBe(false);
    expect(
      coordinatorReviewWindowClosed({
        channelKind: "github",
        reviewKind: "delta",
        stepIndex: coordinatorReviewSteps,
      }),
    ).toBe(true);
    expect(
      coordinatorReviewWindowClosed({
        channelKind: "subagent",
        reviewKind: "full",
        stepIndex: coordinatorReviewSteps,
      }),
    ).toBe(false);
  });

  test("requires exact, non-overlapping finding-scope coverage", () => {
    expect(() =>
      validateLaneCheckpointCoverage(
        {
          status: "in-progress",
          reviewedEntries: [0],
          remainingEntries: [0],
          observations: [],
          nextSteps: [],
          limitations: [],
        },
        1,
      ),
    ).toThrow("both reviewed and remaining");
    expect(() =>
      validateLaneCheckpointCoverage(
        {
          status: "complete",
          reviewedEntries: [0],
          remainingEntries: [],
          observations: [],
          nextSteps: [],
          limitations: [],
          completedReport: "Complete.",
        },
        2,
      ),
    ).toThrow("must match the exact review scope");
  });

  test("binds checkpoints to application-recorded packet coverage", () => {
    expect(() =>
      validateLaneCheckpointEvidenceProgress(
        {
          status: "in-progress",
          reviewedEntries: [0],
          remainingEntries: [1],
          observations: [],
          nextSteps: [],
          limitations: [],
        },
        {
          completedEntries: [],
          cursor: { entryIndex: 0, characterOffset: 500_000 },
        },
      ),
    ).toThrow("application-recorded evidence coverage");
    expect(() =>
      validateLaneCheckpointEvidenceProgress(
        {
          status: "complete",
          reviewedEntries: [0],
          remainingEntries: [],
          observations: [],
          nextSteps: [],
          limitations: [],
          completedReport: "Complete.",
        },
        {
          completedEntries: [0],
          cursor: { entryIndex: 1, characterOffset: 0 },
        },
      ),
    ).toThrow("before its immutable evidence packets are exhausted");
  });

  test("persists compact progress for a fresh lane continuation", async () => {
    const sandbox = memorySandbox();
    const first = await writeLaneCheckpoint(
      sandbox.runtime,
      identity,
      "engineering-quality",
      {
        status: "in-progress",
        reviewedEntries: [0],
        remainingEntries: [1],
        observations: [
          {
            disposition: "lead",
            summary: "Trace the retry state transition.",
            evidence: ["src/a.ts:20"],
          },
        ],
        nextSteps: ["Inspect the caller in src/b.ts."],
        limitations: [],
      },
      2,
    );
    expect(first.revision).toBe(1);
    expect(
      await readLaneCheckpoint(
        sandbox.runtime,
        identity,
        "engineering-quality",
      ),
    ).toEqual(first);

    const complete = await writeLaneCheckpoint(
      sandbox.runtime,
      identity,
      "engineering-quality",
      {
        status: "complete",
        reviewedEntries: [0, 1],
        remainingEntries: [],
        observations: [],
        nextSteps: [],
        limitations: [],
        completedReport:
          "Engineering-quality lane completed with no candidates.",
      },
      2,
    );
    expect(complete.revision).toBe(2);
    await expect(
      writeLaneCheckpoint(
        sandbox.runtime,
        identity,
        "engineering-quality",
        {
          status: "in-progress",
          reviewedEntries: [],
          remainingEntries: [0, 1],
          observations: [],
          nextSteps: ["Start over."],
          limitations: [],
        },
        2,
      ),
    ).rejects.toThrow("cannot be replaced");
  });

  test("accepts a complete maximum-file checkpoint with a bounded report", async () => {
    const sandbox = memorySandbox();
    const reviewedEntries = Array.from({ length: 2_000 }, (_, index) => index);
    const checkpoint = await writeLaneCheckpoint(
      sandbox.runtime,
      identity,
      "deduplication",
      {
        status: "complete",
        reviewedEntries,
        remainingEntries: [],
        observations: [],
        nextSteps: [],
        limitations: [],
        completedReport: "x".repeat(24_000),
      },
      2_000,
    );
    expect(checkpoint.reviewedEntries).toHaveLength(2_000);
  });
});
