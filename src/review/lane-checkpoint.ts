import { z } from "zod";
import type { ReviewAxis } from "./axes";
import { reviewAxes } from "./axes";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const observationSchema = z.object({
  disposition: z.enum(["candidate", "dismissed", "lead"]),
  summary: z.string().min(1).max(1_000),
  evidence: z.array(z.string().min(1).max(500)).max(12),
});

export const laneCheckpointContentSchema = z
  .object({
    status: z.enum(["in-progress", "complete"]),
    reviewedEntries: z.array(z.number().int().nonnegative()).max(2_000),
    remainingEntries: z.array(z.number().int().nonnegative()).max(2_000),
    observations: z.array(observationSchema).max(40),
    nextSteps: z.array(z.string().min(1).max(500)).max(20),
    limitations: z.array(z.string().min(1).max(500)).max(20),
    completedReport: z
      .string()
      .min(1)
      .max(24_000)
      .refine(
        (report) => Buffer.byteLength(report, "utf8") <= 24_000,
        "A completed lane report must not exceed 24,000 UTF-8 bytes",
      )
      .optional(),
  })
  .superRefine((checkpoint, ctx) => {
    if (checkpoint.status === "complete" && !checkpoint.completedReport) {
      ctx.addIssue({
        code: "custom",
        path: ["completedReport"],
        message:
          "A complete lane checkpoint requires its terminal worker report",
      });
    }
    if (
      checkpoint.status === "complete" &&
      (checkpoint.observations.length > 0 ||
        checkpoint.nextSteps.length > 0 ||
        checkpoint.limitations.length > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "A complete lane checkpoint stores observations, next steps, and limitations only in its terminal report",
      });
    }
    if (checkpoint.status === "in-progress" && checkpoint.completedReport) {
      ctx.addIssue({
        code: "custom",
        path: ["completedReport"],
        message:
          "An in-progress lane checkpoint cannot contain a terminal report",
      });
    }
  });

export const laneCheckpointSchema = laneCheckpointContentSchema.extend({
  schemaVersion: z.literal(1),
  axis: z.enum(reviewAxes),
  baseSha: revisionSchema,
  headSha: revisionSchema,
  patchFingerprint: fingerprintSchema,
  revision: z.number().int().positive(),
});

export type LaneCheckpointContent = z.infer<typeof laneCheckpointContentSchema>;
export type LaneCheckpoint = z.infer<typeof laneCheckpointSchema>;

export interface LaneCheckpointIdentity {
  readonly baseSha: string;
  readonly headSha: string;
  readonly patchFingerprint: string;
}

export interface LaneCheckpointSandbox {
  readTextFile(options: { readonly path: string }): PromiseLike<string | null>;
  writeTextFile(options: {
    readonly content: string;
    readonly path: string;
  }): PromiseLike<void>;
}

const maxCheckpointBytes = 65_536;
export const reviewExecutionRevision = "review-context-v1";

export function validateLaneCheckpointCoverage(
  content: LaneCheckpointContent,
  entryCount: number,
): void {
  const exactEntryCount = z.number().int().nonnegative().parse(entryCount);
  const reviewed = new Set(content.reviewedEntries);
  const remaining = new Set(content.remainingEntries);
  if (reviewed.size !== content.reviewedEntries.length) {
    throw new Error("Lane checkpoint contains duplicate reviewed entries");
  }
  if (remaining.size !== content.remainingEntries.length) {
    throw new Error("Lane checkpoint contains duplicate remaining entries");
  }
  if ([...reviewed].some((index) => remaining.has(index))) {
    throw new Error(
      "Lane checkpoint entries cannot be both reviewed and remaining",
    );
  }
  const expected = new Set(
    Array.from({ length: exactEntryCount }, (_, index) => index),
  );
  const observed = new Set([...reviewed, ...remaining]);
  if (
    expected.size !== observed.size ||
    [...expected].some((index) => !observed.has(index))
  ) {
    throw new Error(
      "Lane checkpoint coverage must match the exact review scope",
    );
  }
  if (content.status === "complete" && remaining.size > 0) {
    throw new Error("A complete lane checkpoint cannot have remaining entries");
  }
}

export function laneCheckpointPath(
  patchFingerprint: string,
  axis: ReviewAxis,
): string {
  const fingerprint = fingerprintSchema.parse(patchFingerprint);
  const reviewAxis = z.enum(reviewAxes).parse(axis);
  return `/tmp/known-good-review/checkpoints/${reviewExecutionRevision}/${fingerprint}/${reviewAxis}.json`;
}

export async function readLaneCheckpoint(
  sandbox: LaneCheckpointSandbox,
  identity: LaneCheckpointIdentity,
  axis: ReviewAxis,
): Promise<LaneCheckpoint | null> {
  const source = await sandbox.readTextFile({
    path: laneCheckpointPath(identity.patchFingerprint, axis),
  });
  if (source === null) return null;
  const checkpoint = laneCheckpointSchema.parse(JSON.parse(source));
  if (
    checkpoint.axis !== axis ||
    checkpoint.baseSha !== identity.baseSha ||
    checkpoint.headSha !== identity.headSha ||
    checkpoint.patchFingerprint !== identity.patchFingerprint
  ) {
    throw new Error("Lane checkpoint does not match the trusted review");
  }
  return checkpoint;
}

export async function writeLaneCheckpoint(
  sandbox: LaneCheckpointSandbox,
  identity: LaneCheckpointIdentity,
  axis: ReviewAxis,
  content: LaneCheckpointContent,
  entryCount: number,
): Promise<LaneCheckpoint> {
  const parsedContent = laneCheckpointContentSchema.parse(content);
  validateLaneCheckpointCoverage(parsedContent, entryCount);
  const prior = await readLaneCheckpoint(sandbox, identity, axis);
  if (prior) validateLaneCheckpointCoverage(prior, entryCount);
  if (prior?.status === "complete") {
    if (
      parsedContent.status === "complete" &&
      JSON.stringify(laneCheckpointContentSchema.parse(prior)) ===
        JSON.stringify(parsedContent)
    ) {
      return prior;
    }
    throw new Error("A completed review lane cannot be replaced");
  }
  const checkpoint = laneCheckpointSchema.parse({
    schemaVersion: 1,
    axis,
    ...identity,
    revision: (prior?.revision ?? 0) + 1,
    ...parsedContent,
  });
  const serialized = `${JSON.stringify(checkpoint)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxCheckpointBytes) {
    throw new Error("Lane checkpoint exceeds the 64 KiB limit");
  }
  await sandbox.writeTextFile({
    path: laneCheckpointPath(identity.patchFingerprint, axis),
    content: serialized,
  });
  return checkpoint;
}
