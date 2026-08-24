import { createHash, randomUUID } from "node:crypto";
import type { RuntimeSandboxSession } from "eve/sandbox";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";
import type { TrustedGitHubContext } from "../github/trusted-context";
import { prepareReviewWorkspace } from "../github/review-workspace";
import {
  readCapabilityPreflight,
  runCapabilityPreflight,
} from "./capability-preflight";
import {
  assembleReviewEvidenceLedger,
  prepareCommonProbe,
  readReviewEvidenceLedger,
  reviewEvidenceLedgerPath,
  validatePreparedArtifactArchives,
  validateReviewEvidenceLedgerComponents,
  writeReviewEvidenceLedger,
  type ReviewEvidenceLedger,
  type ReviewEvidenceLedgerIdentity,
} from "./evidence-ledger";
import {
  readReviewEvidenceManifest,
  readReviewEvidencePatch,
  repositoryPathSchema,
  resetReviewEvidence,
  reviewEvidenceDirectory,
  reviewFileStatusSchema,
  type ReviewEvidenceManifest,
  writeIncludedReviewEvidence,
  writeReviewEvidenceManifest,
} from "./evidence-bundle";
import type { PreparedGitHubEvidence } from "./github-evidence";

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

async function preparedLedger(
  sandbox: RuntimeSandboxSession,
  identity: ReviewEvidenceLedgerIdentity,
  files: ReviewFileScope,
): Promise<ReviewEvidenceLedger | null> {
  const ledgerSource = await sandbox.readTextFile({
    path: reviewEvidenceLedgerPath(identity.patchFingerprint),
  });
  if (ledgerSource === null) return null;
  const ledger = await readReviewEvidenceLedger(sandbox, identity);
  const manifest = await readReviewEvidenceManifest(sandbox, identity);
  if (!matchesPreparedScope(manifest, files)) {
    throw new Error("Prepared evidence ledger does not match the exact file scope");
  }
  for (const entry of manifest.entries) {
    if (entry.kind === "included") {
      await readReviewEvidencePatch(sandbox, manifest, {
        path: entry.path,
        cursor: 0,
      });
    }
  }
  const capabilities = await readCapabilityPreflight(sandbox, identity);
  validateReviewEvidenceLedgerComponents(ledger, {
    capabilities,
    manifest,
  });
  await validatePreparedArtifactArchives(sandbox, ledger);
  return ledger;
}

export async function prepareReviewEvidence(
  sandbox: RuntimeSandboxSession,
  trusted: TrustedGitHubContext,
  inputFiles: unknown,
  input: {
    readonly collectGitHubEvidence: () => Promise<PreparedGitHubEvidence>;
    readonly planKind: "full" | "delta";
  },
): Promise<ReviewEvidenceLedger> {
  if (!trusted.patchFingerprint) {
    throw new Error("Trusted review context is missing the patch fingerprint");
  }
  if (!trusted.repositoryDatabaseId) {
    throw new Error(
      "Trusted review context is missing the repository database id",
    );
  }
  const files = reviewFileScopeSchema.parse(inputFiles);
  const identity: ReviewEvidenceLedgerIdentity = {
    executionRevision: "review-evidence-v1",
    repositoryId: trusted.repositoryId,
    repositoryDatabaseId: trusted.repositoryDatabaseId,
    repository: trusted.repository,
    pullRequest: trusted.pullRequest,
    baseSha: trusted.baseSha,
    headSha: trusted.headSha,
    patchFingerprint: trusted.patchFingerprint,
    planKind: input.planKind,
  };
  const existing = await preparedLedger(sandbox, identity, files);
  if (existing) return existing;

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
  const preparedGitHub = await input.collectGitHubEvidence();
  for (const artifact of preparedGitHub.evidence.artifacts.entries) {
    const archive = preparedGitHub.archives.get(artifact.id);
    if (!archive) {
      throw new Error(
        "Prepared artifact metadata is missing its validated archive",
      );
    }
    await sandbox.writeBinaryFile({
      path: `${reviewEvidenceDirectory(identity.patchFingerprint)}/${artifact.archiveFile}`,
      content: archive,
    });
  }
  const diffCheckCommand = `cd /workspace && git diff --check ${base} ${head}`;
  const diffCheck = await sandbox.run({ command: diffCheckCommand });
  const probes = [
    prepareCommonProbe({
      id: "git-diff-check",
      command: "git diff --check <base> <head>",
      exitCode: diffCheck.exitCode,
      stdout: String(diffCheck.stdout),
      stderr: String(diffCheck.stderr),
    }),
  ];
  const ledger = assembleReviewEvidenceLedger({
    capabilities: capabilities.preflight,
    github: preparedGitHub.evidence,
    identity,
    manifest,
    probes,
  });
  await writeReviewEvidenceLedger(sandbox, ledger);
  console.info(
    JSON.stringify({
      event: "known-good-review.evidence_ledger.completed",
      digest: ledger.digest,
      gaps: ledger.gaps.map((gap) => gap.id),
    }),
  );
  return ledger;
}
