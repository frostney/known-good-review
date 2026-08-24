import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { RuntimeSandboxSession } from "eve/sandbox";
import {
  GitHubEvidenceError,
  prepareExactHeadGitHubEvidence,
} from "../src/review/github-evidence";
import {
  capabilityCommandNames,
  capabilityPreflightSchema,
  runCapabilityPreflight,
} from "../src/review/capability-preflight";
import {
  assembleReviewEvidenceLedger,
  readReviewEvidenceLedger,
  reviewEvidenceLedgerPath,
  validatePreparedArtifactArchives,
  writeReviewEvidenceLedger,
} from "../src/review/evidence-ledger";
import { writeReviewEvidenceManifest } from "../src/review/evidence-bundle";
import { prepareReviewEvidence } from "../src/review/prepare-review-evidence";

const headSha = "2".repeat(40);
const repositoryDatabaseId = 41;
const archive = new TextEncoder().encode("sanitized generated output");
const archiveDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;

function checkRun(head = headSha) {
  return {
    id: 101,
    name: "docs",
    head_sha: head,
    status: "completed",
    conclusion: "success",
    details_url: "https://github.com/frostney/repo/actions/runs/201",
    external_id: "docs-201",
    app: { slug: "github-actions" },
  };
}

function workflowRun(head = headSha) {
  return {
    id: 201,
    name: "PR",
    head_sha: head,
    status: "completed",
    conclusion: "success",
    event: "pull_request",
    run_attempt: 1,
    repository: { id: repositoryDatabaseId },
    head_repository: { id: repositoryDatabaseId },
  };
}

function artifact(digest = archiveDigest) {
  return {
    id: 301,
    name: "website-output",
    size_in_bytes: archive.byteLength,
    expired: false,
    digest,
    created_at: "2026-08-24T12:00:00.000Z",
    expires_at: "2026-11-22T12:00:00.000Z",
    workflow_run: {
      id: 201,
      repository_id: repositoryDatabaseId,
      head_repository_id: repositoryDatabaseId,
      head_sha: headSha,
    },
  };
}

function replay(input?: {
  readonly artifactDigest?: string;
  readonly checkHead?: string;
  readonly includeArtifact?: boolean;
  readonly workflowHead?: string;
}) {
  const run = workflowRun(input?.workflowHead);
  const includeArtifact = input?.includeArtifact ?? true;
  return prepareExactHeadGitHubEvidence({
    artifactsByRun: new Map([
      [
        run.id,
        includeArtifact
          ? [
              {
                archive,
                metadata: artifact(input?.artifactDigest),
              },
            ]
          : [],
      ],
    ]),
    checkRuns: [checkRun(input?.checkHead)],
    headSha,
    observedAt: "2026-08-24T12:01:00.000Z",
    repositoryDatabaseId,
    workflowRuns: [run],
  });
}

describe("exact-head evidence replay", () => {
  test("accepts a digest-validated artifact from the exact workflow head", () => {
    const prepared = replay();

    expect(prepared.evidence.artifacts.status).toBe("available");
    expect(prepared.evidence.artifacts.entries).toHaveLength(1);
    expect(prepared.evidence.artifacts.entries[0]).toMatchObject({
      id: 301,
      digest: archiveDigest,
      archiveFile: "artifact-301.zip",
      workflowRun: {
        id: 201,
        headSha,
        repositoryDatabaseId,
      },
    });
    expect(prepared.archives.get(301)).toEqual(archive);
    expect(prepared.evidence.gaps).toEqual([]);
  });

  test("binds the root digest and artifact bytes to the complete review identity", async () => {
    const prepared = replay();
    const identity = {
      executionRevision: "review-evidence-v1" as const,
      repositoryId: "R_test",
      repositoryDatabaseId,
      repository: "frostney/pascal-mcp-sdk",
      pullRequest: 61,
      baseSha: "1".repeat(40),
      headSha,
      patchFingerprint: "3".repeat(64),
      planKind: "delta" as const,
    };
    const ledger = assembleReviewEvidenceLedger({
      capabilities: capabilityPreflightSchema.parse({
        schemaVersion: 1,
        baseSha: identity.baseSha,
        headSha,
        patchFingerprint: identity.patchFingerprint,
        network: "github-only",
        commands: [],
        repositoryMarkers: [],
        digest: "7".repeat(64),
      }),
      github: prepared.evidence,
      identity,
      manifest: {
        schemaVersion: 1,
        baseSha: identity.baseSha,
        headSha,
        patchFingerprint: identity.patchFingerprint,
        entries: [],
      },
      probes: [],
    });
    const files = new Map<string, string>();
    const binaries = new Map<string, Uint8Array>([
      [
        `/tmp/known-good-review/evidence/${identity.patchFingerprint}/artifact-301.zip`,
        archive,
      ],
    ]);
    const sandbox = {
      async readTextFile({ path }: { readonly path: string }) {
        return files.get(path) ?? null;
      },
      async writeTextFile({
        content,
        path,
      }: {
        readonly content: string;
        readonly path: string;
      }) {
        files.set(path, content);
      },
      async readBinaryFile({ path }: { readonly path: string }) {
        return binaries.get(path) ?? null;
      },
    };
    await writeReviewEvidenceLedger(sandbox, ledger);

    expect((await readReviewEvidenceLedger(sandbox, identity)).digest).toBe(
      ledger.digest,
    );
    await validatePreparedArtifactArchives(sandbox, ledger);
    await expect(
      readReviewEvidenceLedger(sandbox, {
        ...identity,
        repositoryDatabaseId: 99,
      }),
    ).rejects.toThrow("does not match");
    binaries.set(
      `/tmp/known-good-review/evidence/${identity.patchFingerprint}/artifact-301.zip`,
      new TextEncoder().encode("changed"),
    );
    await expect(
      validatePreparedArtifactArchives(sandbox, ledger),
    ).rejects.toThrow("integrity validation");
  });

  test("reuses one complete ledger without rerunning application preparation", async () => {
    const identity = {
      executionRevision: "review-evidence-v1" as const,
      repositoryId: "R_test",
      repositoryDatabaseId,
      repository: "frostney/pascal-mcp-sdk",
      pullRequest: 61,
      baseSha: "1".repeat(40),
      headSha,
      patchFingerprint: "3".repeat(64),
      planKind: "delta" as const,
    };
    const files = new Map<string, string>();
    const commands: string[] = [];
    const runtime = {
      async removePath() {},
      async readTextFile({ path }: { readonly path: string }) {
        return files.get(path) ?? null;
      },
      async readBinaryFile() {
        return null;
      },
      async run({ command }: { readonly command: string }) {
        commands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout: capabilityCommandNames
            .map((name) => `command\t${name}\t${name === "git" ? "1" : "0"}`)
            .join("\n"),
        };
      },
      async writeTextFile({
        content,
        path,
      }: {
        readonly content: string;
        readonly path: string;
      }) {
        files.set(path, content);
      },
    };
    const manifest = {
      schemaVersion: 1 as const,
      baseSha: identity.baseSha,
      headSha,
      patchFingerprint: identity.patchFingerprint,
      entries: [],
    };
    const capabilities = await runCapabilityPreflight(runtime, identity);
    await writeReviewEvidenceManifest(runtime, manifest);
    const github = prepareExactHeadGitHubEvidence({
      artifactsByRun: new Map(),
      checkRuns: [],
      headSha,
      observedAt: "2026-08-24T12:01:00.000Z",
      repositoryDatabaseId,
      workflowRuns: [],
    });
    const ledger = assembleReviewEvidenceLedger({
      capabilities: capabilities.preflight,
      github: github.evidence,
      identity,
      manifest,
      probes: [],
    });
    await writeReviewEvidenceLedger(runtime, ledger);
    commands.length = 0;
    let collectionCalls = 0;
    const trusted = {
      installationId: 1,
      owner: "frostney",
      repo: "pascal-mcp-sdk",
      pullRequest: identity.pullRequest,
      repository: identity.repository,
      repositoryCreatedAt: 0,
      repositoryDatabaseId,
      repositoryId: identity.repositoryId,
      baseSha: identity.baseSha,
      headSha,
      patchFingerprint: identity.patchFingerprint,
    };
    const preparation = {
      planKind: identity.planKind,
      async collectGitHubEvidence() {
        collectionCalls += 1;
        return github;
      },
    };

    const reused = await prepareReviewEvidence(
      runtime as unknown as RuntimeSandboxSession,
      trusted,
      [],
      preparation,
    );

    expect(reused).toEqual(ledger);
    expect(collectionCalls).toBe(0);
    expect(commands).toEqual([]);

    const ledgerPath = reviewEvidenceLedgerPath(identity.patchFingerprint);
    files.set(
      ledgerPath,
      JSON.stringify({ ...ledger, digest: "9".repeat(64) }),
    );
    await expect(
      prepareReviewEvidence(
        runtime as unknown as RuntimeSandboxSession,
        trusted,
        [],
        preparation,
      ),
    ).rejects.toThrow("integrity validation");
    expect(collectionCalls).toBe(0);
  });

  test("records missing generated output once with a repository remedy", () => {
    const prepared = replay({ includeArtifact: false });

    expect(prepared.evidence.artifacts).toMatchObject({
      status: "missing",
      entries: [],
      disposition: {
        id: "exact-head-artifacts-missing",
        owner: "repository",
        disposition: "check-remedy",
      },
    });
    expect(prepared.evidence.gaps.map((gap) => gap.id)).toEqual([
      "exact-head-artifacts-missing",
    ]);
  });

  test("rejects stale Check and workflow evidence", () => {
    expect(() => replay({ checkHead: "4".repeat(40) })).toThrow(
      new GitHubEvidenceError("stale-check-head"),
    );
    expect(() => replay({ workflowHead: "5".repeat(40) })).toThrow(
      new GitHubEvidenceError("stale-workflow-head"),
    );
  });

  test("rejects an artifact whose bytes do not match GitHub provenance", () => {
    expect(() => replay({ artifactDigest: `sha256:${"6".repeat(64)}` })).toThrow(
      new GitHubEvidenceError("artifact-digest-mismatch"),
    );
  });
});
