import { createHash } from "node:crypto";
import { z } from "zod";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const patchFileSchema = z.string().regex(/^patch-[a-f0-9]{64}\.diff$/);
export const reviewFileStatusSchema = z.enum([
  "added",
  "copied",
  "deleted",
  "modified",
  "renamed",
]);
export const repositoryPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").some((segment) => segment === "." || segment === ".."),
    "Review evidence paths must be repository-relative",
  );

const commonEntrySchema = z.object({
  path: repositoryPathSchema,
  status: reviewFileStatusSchema,
  patchCharacters: z.number().int().nonnegative(),
  patchTokens: z.number().int().nonnegative(),
  patchSha256: fingerprintSchema,
});

const includedEvidenceSchema = commonEntrySchema.extend({
  kind: z.literal("included"),
  patchFile: patchFileSchema,
});

const excludedEvidenceSchema = commonEntrySchema.extend({
  kind: z.literal("excluded"),
  classification: z.array(z.enum(["generated", "vendored", "binary"])).min(1),
  addedLines: z.number().int().nonnegative(),
  deletedLines: z.number().int().nonnegative(),
});

export const reviewEvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseSha: revisionSchema,
    headSha: revisionSchema,
    patchFingerprint: fingerprintSchema,
    entries: z.array(
      z.discriminatedUnion("kind", [
        includedEvidenceSchema,
        excludedEvidenceSchema,
      ]),
    ),
  })
  .superRefine((manifest, ctx) => {
    const paths = manifest.entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Review evidence paths must be unique",
      });
    }
    const patchFiles = manifest.entries.flatMap((entry) =>
      entry.kind === "included" ? [entry.patchFile] : [],
    );
    if (new Set(patchFiles).size !== patchFiles.length) {
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Included review patch files must be unique",
      });
    }
  });

export type ReviewEvidenceManifest = z.infer<
  typeof reviewEvidenceManifestSchema
>;
export type IncludedReviewEvidence = z.infer<typeof includedEvidenceSchema>;
export type ExcludedReviewEvidence = z.infer<typeof excludedEvidenceSchema>;

export interface ReviewEvidenceSandbox {
  readTextFile(options: { readonly path: string }): PromiseLike<string | null>;
  removePath(options: {
    readonly force?: boolean;
    readonly path: string;
    readonly recursive?: boolean;
  }): Promise<void>;
  writeTextFile(options: {
    readonly content: string;
    readonly path: string;
  }): PromiseLike<void>;
}

export interface ReviewEvidenceIdentity {
  readonly baseSha: string;
  readonly headSha: string;
  readonly patchFingerprint: string;
}

export const reviewEvidencePageSize = 50;
export const reviewEvidencePatchCharacters = 16_000;

export function reviewEvidenceDirectory(patchFingerprint: string): string {
  return `/tmp/known-good-review/evidence/${fingerprintSchema.parse(patchFingerprint)}`;
}

export function reviewEvidenceManifestPath(patchFingerprint: string): string {
  return `${reviewEvidenceDirectory(patchFingerprint)}/manifest.json`;
}

export function reviewEvidencePatchFile(
  patchFingerprint: string,
  path: string,
): { readonly fileName: string; readonly filePath: string } {
  const fileName = `patch-${createHash("sha256").update(path).digest("hex")}.diff`;
  return {
    fileName,
    filePath: `${reviewEvidenceDirectory(patchFingerprint)}/${fileName}`,
  };
}

export async function resetReviewEvidence(
  sandbox: ReviewEvidenceSandbox,
  patchFingerprint: string,
): Promise<void> {
  await sandbox.removePath({
    path: reviewEvidenceDirectory(patchFingerprint),
    recursive: true,
    force: true,
  });
}

export async function writeIncludedReviewEvidence(
  sandbox: ReviewEvidenceSandbox,
  input: {
    readonly patchFingerprint: string;
    readonly path: string;
    readonly patch: string;
    readonly patchTokens: number;
    readonly status: z.infer<typeof reviewFileStatusSchema>;
  },
): Promise<IncludedReviewEvidence> {
  const patchSha256 = createHash("sha256").update(input.patch).digest("hex");
  const patchFile = reviewEvidencePatchFile(input.patchFingerprint, input.path);
  await sandbox.writeTextFile({
    path: patchFile.filePath,
    content: input.patch,
  });
  return includedEvidenceSchema.parse({
    kind: "included",
    path: input.path,
    status: input.status,
    patchCharacters: input.patch.length,
    patchTokens: input.patchTokens,
    patchSha256,
    patchFile: patchFile.fileName,
  });
}

export async function writeReviewEvidenceManifest(
  sandbox: ReviewEvidenceSandbox,
  manifest: ReviewEvidenceManifest,
): Promise<void> {
  const parsed = reviewEvidenceManifestSchema.parse(manifest);
  await sandbox.writeTextFile({
    path: reviewEvidenceManifestPath(parsed.patchFingerprint),
    content: `${JSON.stringify(parsed)}\n`,
  });
}

export async function readReviewEvidenceManifest(
  sandbox: ReviewEvidenceSandbox,
  identity: ReviewEvidenceIdentity,
): Promise<ReviewEvidenceManifest> {
  const source = await sandbox.readTextFile({
    path: reviewEvidenceManifestPath(identity.patchFingerprint),
  });
  if (source === null) {
    throw new Error("Prepared review evidence is unavailable");
  }
  const manifest = reviewEvidenceManifestSchema.parse(JSON.parse(source));
  if (
    manifest.baseSha !== identity.baseSha ||
    manifest.headSha !== identity.headSha ||
    manifest.patchFingerprint !== identity.patchFingerprint
  ) {
    throw new Error(
      "Prepared review evidence does not match the trusted review",
    );
  }
  return manifest;
}

export function reviewEvidencePage(
  manifest: ReviewEvidenceManifest,
  cursor: number,
) {
  const start = z.number().int().nonnegative().parse(cursor);
  const entries = manifest.entries
    .slice(start, start + reviewEvidencePageSize)
    .map((entry, offset) => ({ index: start + offset, ...entry }));
  const nextCursor = start + entries.length;
  return {
    entries,
    nextCursor: nextCursor < manifest.entries.length ? nextCursor : null,
    totalEntries: manifest.entries.length,
  };
}

export async function readReviewEvidencePatch(
  sandbox: ReviewEvidenceSandbox,
  manifest: ReviewEvidenceManifest,
  input: { readonly path: string; readonly cursor: number },
) {
  const entry = manifest.entries.find(
    (candidate): candidate is IncludedReviewEvidence =>
      candidate.kind === "included" && candidate.path === input.path,
  );
  if (!entry) {
    throw new Error(`No included review patch exists for ${input.path}`);
  }
  const source = await sandbox.readTextFile({
    path: `${reviewEvidenceDirectory(manifest.patchFingerprint)}/${entry.patchFile}`,
  });
  if (source === null) {
    throw new Error(`Prepared review patch is unavailable for ${input.path}`);
  }
  const observedSha256 = createHash("sha256").update(source).digest("hex");
  if (observedSha256 !== entry.patchSha256) {
    throw new Error(
      `Prepared review patch failed integrity validation for ${input.path}`,
    );
  }
  const cursor = z
    .number()
    .int()
    .nonnegative()
    .max(source.length)
    .parse(input.cursor);
  let end = Math.min(cursor + reviewEvidencePatchCharacters, source.length);
  if (
    end < source.length &&
    source.charCodeAt(end - 1) >= 0xd800 &&
    source.charCodeAt(end - 1) <= 0xdbff &&
    source.charCodeAt(end) >= 0xdc00 &&
    source.charCodeAt(end) <= 0xdfff
  ) {
    end += 1;
  }
  const content = source.slice(cursor, end);
  const nextCursor = cursor + content.length;
  return {
    path: entry.path,
    patchSha256: entry.patchSha256,
    cursor,
    content,
    nextCursor: nextCursor < source.length ? nextCursor : null,
    totalCharacters: source.length,
  };
}
