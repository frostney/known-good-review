import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReviewConfig } from "../config/review-config";
import { memorySearchResponseSchema } from "../memory/contracts";
import type { MemoryAvailability } from "../memory/client";
import type { ReviewEvidenceLedgerIdentity } from "./evidence-ledger";
import type { ReviewFileScope } from "./prepare-review-evidence";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const commonWorkKinds = [
  "patch-manifest",
  "capability-preflight",
  "github-evidence",
  "repository-history",
  "repository-memory",
  "common-probe",
] as const;

export const commonWorkIdSchema = z
  .string()
  .regex(/^work-[a-f0-9]{64}$/);

export const commonWorkRecordSchema = z.object({
  id: commonWorkIdSchema,
  kind: z.enum(commonWorkKinds),
  inputDigest: fingerprintSchema,
  outputDigest: fingerprintSchema,
  outcome: z.enum(["completed", "delayed", "unavailable"]),
});

export type CommonWorkRecord = z.infer<typeof commonWorkRecordSchema>;

export const commonHistorySchema = z.object({
  workId: commonWorkIdSchema,
  baseSha: revisionSchema,
  paths: z.array(z.string().min(1)),
  commitShas: z.array(revisionSchema),
  truncated: z.boolean(),
});

export type CommonHistory = z.infer<typeof commonHistorySchema>;

const commonMemoryAvailabilitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    response: memorySearchResponseSchema,
  }),
  z.object({
    kind: z.literal("delayed"),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.string().min(1).max(500),
  }),
]);

export const commonMemorySchema = z.object({
  workId: commonWorkIdSchema,
  query: z.string().min(1).max(20_000),
  availability: commonMemoryAvailabilitySchema,
});

export type CommonMemory = z.infer<typeof commonMemorySchema>;

export const commonReviewWorkSchema = z
  .object({
    executionRevision: z.literal("review-common-work-v1"),
    records: z.array(commonWorkRecordSchema),
    history: commonHistorySchema,
    memory: commonMemorySchema,
  })
  .superRefine((work, context) => {
    const recordIds = work.records.map((record) => record.id);
    if (new Set(recordIds).size !== recordIds.length) {
      context.addIssue({
        code: "custom",
        path: ["records"],
        message: "Common work identities must be unique",
      });
    }
    const recordIdSet = new Set(recordIds);
    if (
      !recordIdSet.has(work.history.workId) ||
      !recordIdSet.has(work.memory.workId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["records"],
        message: "Common work results must reference recorded identities",
      });
    }
    for (const kind of commonWorkKinds) {
      if (!work.records.some((record) => record.kind === kind)) {
        context.addIssue({
          code: "custom",
          path: ["records"],
          message: `Common work must retain ${kind}`,
        });
      }
    }
    const historyRecord = work.records.find(
      (record) => record.id === work.history.workId,
    );
    const { workId: _historyWorkId, ...historyOutput } = work.history;
    if (
      historyRecord?.kind !== "repository-history" ||
      historyRecord.outputDigest !== digestCommonWorkValue(historyOutput)
    ) {
      context.addIssue({
        code: "custom",
        path: ["history"],
        message: "Prepared history does not match its common work record",
      });
    }
    const memoryRecord = work.records.find(
      (record) => record.id === work.memory.workId,
    );
    const memoryOutcome = work.memory.availability.kind === "available"
      ? "completed"
      : work.memory.availability.kind;
    if (
      memoryRecord?.kind !== "repository-memory" ||
      memoryRecord.outcome !== memoryOutcome ||
      memoryRecord.outputDigest !==
        digestCommonWorkValue(work.memory.availability)
    ) {
      context.addIssue({
        code: "custom",
        path: ["memory"],
        message: "Prepared memory does not match its common work record",
      });
    }
  });

export type CommonReviewWork = z.infer<typeof commonReviewWorkSchema>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function digestCommonWorkValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

export function stableCommonWorkId(
  kind: (typeof commonWorkKinds)[number],
  input: unknown,
): string {
  return commonWorkIdSchema.parse(
    `work-${digestCommonWorkValue({ kind, input })}`,
  );
}

export function commonWorkRecord(input: {
  readonly kind: (typeof commonWorkKinds)[number];
  readonly identity: unknown;
  readonly output: unknown;
  readonly outcome?: "completed" | "delayed" | "unavailable";
}): CommonWorkRecord {
  return commonWorkRecordSchema.parse({
    id: stableCommonWorkId(input.kind, input.identity),
    kind: input.kind,
    inputDigest: digestCommonWorkValue(input.identity),
    outputDigest: digestCommonWorkValue(input.output),
    outcome: input.outcome ?? "completed",
  });
}

export function commonMemoryQuery(files: ReviewFileScope): string {
  const prefix =
    "Prior review findings relevant to these exact changed repository paths: ";
  const paths = [...files.map((file) => file.path)].sort();
  let query = prefix;
  for (const path of paths) {
    const addition = `${query === prefix ? "" : ", "}${path}`;
    if (query.length + addition.length > 20_000) break;
    query += addition;
  }
  return query;
}

export function prepareCommonMemory(input: {
  readonly availability: MemoryAvailability;
  readonly config: Pick<ReviewConfig, "embedding">;
  readonly identity: Pick<
    ReviewEvidenceLedgerIdentity,
    "repositoryId" | "baseSha" | "headSha" | "patchFingerprint"
  >;
  readonly policyHash: string;
  readonly query: string;
}): { readonly memory: CommonMemory; readonly record: CommonWorkRecord } {
  const workIdentity = {
    executionRevision: "review-common-work-v1",
    repositoryId: input.identity.repositoryId,
    baseSha: input.identity.baseSha,
    headSha: input.identity.headSha,
    patchFingerprint: input.identity.patchFingerprint,
    embedding: input.config.embedding,
    policyHash: input.policyHash,
    query: input.query,
  };
  const availability = commonMemoryAvailabilitySchema.parse(
    input.availability,
  );
  const outcome =
    availability.kind === "available" ? "completed" : availability.kind;
  const record = commonWorkRecord({
    kind: "repository-memory",
    identity: workIdentity,
    output: availability,
    outcome,
  });
  return {
    record,
    memory: commonMemorySchema.parse({
      workId: record.id,
      query: input.query,
      availability,
    }),
  };
}
