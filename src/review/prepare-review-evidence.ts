import { createHash, randomUUID } from "node:crypto";
import type { RuntimeSandboxSession } from "eve/sandbox";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";
import type { TrustedGitHubContext } from "../github/trusted-context";
import { prepareReviewWorkspace } from "../github/review-workspace";
import { runCapabilityPreflight } from "./capability-preflight";
import {
  readReviewEvidenceManifest,
  readReviewEvidencePatch,
  repositoryPathSchema,
  resetReviewEvidence,
  reviewFileStatusSchema,
  type ReviewEvidenceManifest,
  writeIncludedReviewEvidence,
  writeReviewEvidenceManifest,
} from "./evidence-bundle";

export const reviewFileScopeSchema = z
  .array(
    z.object({
      path: repositoryPathSchema,
      status: reviewFileStatusSchema,
    }),
  )
  .superRefine((files, ctx) => {
    const paths = files.map((file) => file.path);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: "custom",
        message: "Trusted review file paths must be unique",
      });
    }
  });

export type ReviewFileScope = z.infer<typeof reviewFileScopeSchema>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function attributeValue(output: string, attribute: string): string | null {
  const suffix = `: ${attribute}: `;
  const line = output
    .split("\n")
    .find((candidate) => candidate.includes(suffix));
  return line ? line.slice(line.indexOf(suffix) + suffix.length).trim() : null;
}

function isSet(value: string | null): boolean {
  return value === "set" || value === "true";
}

function matchesPreparedScope(
  manifest: ReviewEvidenceManifest,
  files: ReviewFileScope,
): boolean {
  return (
    manifest.entries.length === files.length &&
    manifest.entries.every(
      (entry, index) =>
        entry.path === files[index]?.path &&
        entry.status === files[index]?.status,
    )
  );
}

async function preparedManifest(
  sandbox: RuntimeSandboxSession,
  trusted: TrustedGitHubContext & { readonly patchFingerprint: string },
  files: ReviewFileScope,
): Promise<ReviewEvidenceManifest | null> {
  try {
    const manifest = await readReviewEvidenceManifest(sandbox, trusted);
    if (!matchesPreparedScope(manifest, files)) return null;
    for (const entry of manifest.entries) {
      if (entry.kind === "included") {
        await readReviewEvidencePatch(sandbox, manifest, {
          path: entry.path,
          cursor: 0,
        });
      }
    }
    return manifest;
  } catch {
    return null;
  }
}

export async function prepareReviewEvidence(
  sandbox: RuntimeSandboxSession,
  trusted: TrustedGitHubContext,
  inputFiles: unknown,
): Promise<ReviewEvidenceManifest> {
  if (!trusted.patchFingerprint) {
    throw new Error("Trusted review context is missing the patch fingerprint");
  }
  const files = reviewFileScopeSchema.parse(inputFiles);
  const identity = { ...trusted, patchFingerprint: trusted.patchFingerprint };
  const existing = await preparedManifest(sandbox, identity, files);
  if (existing) {
    const capabilities = await runCapabilityPreflight(sandbox, identity);
    if (capabilities.created) {
      console.info(
        JSON.stringify({
          event: "known-good-review.capability_preflight.completed",
          digest: capabilities.preflight.digest,
        }),
      );
    }
    return existing;
  }

  await prepareReviewWorkspace(trusted, sandbox);
  await resetReviewEvidence(sandbox, trusted.patchFingerprint);
  const indexPath = `/tmp/known-good-review-index-${randomUUID()}`;
  const base = shellQuote(trusted.baseSha);
  const head = shellQuote(trusted.headSha);
  const entries: ReviewEvidenceManifest["entries"] = [];
  try {
    const prepared = await sandbox.run({
      command: `cd /workspace && GIT_INDEX_FILE=${shellQuote(indexPath)} git read-tree ${base}`,
    });
    if (prepared.exitCode !== 0) {
      throw new Error(
        "Could not prepare trusted-base attributes for review evidence",
      );
    }
    const encoder = getEncoding("o200k_base");
    for (const file of files) {
      const path = shellQuote(file.path);
      const attributes = await sandbox.run({
        command: `cd /workspace && GIT_INDEX_FILE=${shellQuote(indexPath)} git check-attr --cached linguist-generated linguist-vendored binary diff -- ${path}`,
      });
      if (attributes.exitCode !== 0) {
        throw new Error(
          `Could not classify ${file.path} from trusted-base attributes`,
        );
      }
      const numstat = await sandbox.run({
        command: `cd /workspace && git diff --numstat ${base} ${head} -- ${path}`,
      });
      if (numstat.exitCode !== 0) {
        throw new Error(`Could not classify Git diff for ${file.path}`);
      }
      const [added = "0", deleted = "0"] = String(numstat.stdout).split(
        "\t",
        2,
      );
      const classification: Array<"generated" | "vendored" | "binary"> = [];
      if (
        isSet(attributeValue(String(attributes.stdout), "linguist-generated"))
      ) {
        classification.push("generated");
      }
      if (
        isSet(attributeValue(String(attributes.stdout), "linguist-vendored"))
      ) {
        classification.push("vendored");
      }
      if (
        added === "-" ||
        deleted === "-" ||
        isSet(attributeValue(String(attributes.stdout), "binary")) ||
        attributeValue(String(attributes.stdout), "diff") === "unset"
      ) {
        classification.push("binary");
      }
      const patch = await sandbox.run({
        command: `cd /workspace && git diff --no-ext-diff --full-index ${base} ${head} -- ${path}`,
      });
      if (patch.exitCode !== 0) {
        throw new Error(`Could not summarize classified patch ${file.path}`);
      }
      const text = String(patch.stdout);
      const patchTokens = encoder.encode(text).length;
      entries.push(
        classification.length === 0
          ? await writeIncludedReviewEvidence(sandbox, {
              patchFingerprint: trusted.patchFingerprint,
              path: file.path,
              patch: text,
              patchTokens,
              status: file.status,
            })
          : {
              kind: "excluded",
              path: file.path,
              classification,
              status: file.status,
              addedLines: added === "-" ? 0 : Number.parseInt(added, 10),
              deletedLines: deleted === "-" ? 0 : Number.parseInt(deleted, 10),
              patchCharacters: text.length,
              patchTokens,
              patchSha256: createHash("sha256").update(text).digest("hex"),
            },
      );
    }
  } finally {
    await sandbox.run({ command: `rm -f -- ${shellQuote(indexPath)}` });
  }
  const manifest: ReviewEvidenceManifest = {
    schemaVersion: 1,
    baseSha: trusted.baseSha,
    headSha: trusted.headSha,
    patchFingerprint: trusted.patchFingerprint,
    entries,
  };
  await writeReviewEvidenceManifest(sandbox, manifest);
  const capabilities = await runCapabilityPreflight(sandbox, identity);
  if (capabilities.created) {
    console.info(
      JSON.stringify({
        event: "known-good-review.capability_preflight.completed",
        digest: capabilities.preflight.digest,
      }),
    );
  }
  return manifest;
}
