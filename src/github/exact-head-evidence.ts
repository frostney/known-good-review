import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import {
  GitHubEvidenceError,
  prepareExactHeadGitHubEvidence,
  type PreparedGitHubEvidence,
} from "../review/github-evidence";

const requestErrorSchema = z.object({ status: z.number().int() });

export const artifactDownloadLimits = {
  archiveBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
} as const;

function requestFailure(error: unknown, forbiddenCode: string): never {
  const parsed = requestErrorSchema.safeParse(error);
  throw new GitHubEvidenceError(
    parsed.success && parsed.data.status === 403
      ? forbiddenCode
      : "github-evidence-request-failed",
  );
}

async function archiveBytes(data: unknown, limit: number): Promise<Uint8Array> {
  if (data instanceof ReadableStream) {
    const reader = data.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value }: { done: boolean; value?: unknown } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new GitHubEvidenceError("invalid-artifact-stream");
        length += value.byteLength;
        if (length > limit) throw new GitHubEvidenceError("artifact-download-size-limit");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }
  const bytes = data instanceof Uint8Array ? data
    : data instanceof ArrayBuffer ? new Uint8Array(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
  if (!bytes) throw new GitHubEvidenceError("invalid-artifact-stream");
  if (bytes.byteLength > limit) throw new GitHubEvidenceError("artifact-download-size-limit");
  return bytes;
}

export async function collectExactHeadGitHubEvidence(
  octokit: Octokit,
  identity: {
    readonly headSha: string;
    readonly owner: string;
    readonly repo: string;
    readonly repositoryDatabaseId: number;
  },
  limits: { readonly archiveBytes: number; readonly totalBytes: number } = artifactDownloadLimits,
): Promise<PreparedGitHubEvidence> {
  if (![limits.archiveBytes, limits.totalBytes].every((limit) => Number.isSafeInteger(limit) && limit > 0)) {
    throw new Error("Artifact download limits must be positive byte counts");
  }
  const [checkRuns, workflowRuns] = await Promise.all([
    octokit
      .paginate(octokit.rest.checks.listForRef, {
        owner: identity.owner,
        repo: identity.repo,
        ref: identity.headSha,
        filter: "all",
        per_page: 100,
      })
      .catch((error: unknown) =>
        requestFailure(error, "checks-read-permission-missing"),
      ),
    octokit
      .paginate(octokit.rest.actions.listWorkflowRunsForRepo, {
        owner: identity.owner,
        repo: identity.repo,
        head_sha: identity.headSha,
        per_page: 100,
      })
      .catch((error: unknown) =>
        requestFailure(error, "actions-read-permission-missing"),
      ),
  ]);
  const artifactsByRun = new Map<
    number,
    { readonly archive: Uint8Array; readonly metadata: unknown }[]
  >();
  let downloadedBytes = 0;
  for (const run of workflowRuns) {
    if (run.head_sha !== identity.headSha) throw new GitHubEvidenceError("stale-workflow-head");
    if (run.repository.id !== identity.repositoryDatabaseId) throw new GitHubEvidenceError("mismatched-workflow-repository");
    if (run.status !== "completed" || run.conclusion !== "success") continue;
    const artifacts = await octokit
      .paginate(
        octokit.rest.actions.listWorkflowRunArtifacts,
        {
          owner: identity.owner,
          repo: identity.repo,
          run_id: run.id,
          per_page: 100,
        },
      )
      .catch((error: unknown) =>
        requestFailure(error, "actions-read-permission-missing"),
      );
    const prepared: {
      readonly archive: Uint8Array;
      readonly metadata: unknown;
    }[] = [];
    for (const artifact of artifacts) {
      if (artifact.expired) continue;
      const limit = Math.min(limits.archiveBytes, limits.totalBytes - downloadedBytes);
      if (artifact.size_in_bytes > limit) throw new GitHubEvidenceError("artifact-download-size-limit");
      const download = await octokit.rest.actions
        .downloadArtifact({
          owner: identity.owner,
          repo: identity.repo,
          artifact_id: artifact.id,
          archive_format: "zip",
          request: { parseSuccessResponseBody: false, signal: AbortSignal.timeout(60_000) },
        })
        .catch((error: unknown) =>
          requestFailure(error, "actions-read-permission-missing"),
        );
      const archive = await archiveBytes(download.data, limit);
      downloadedBytes += archive.byteLength;
      prepared.push({
        archive,
        metadata: artifact,
      });
    }
    artifactsByRun.set(run.id, prepared);
  }
  return prepareExactHeadGitHubEvidence({
    artifactsByRun,
    checkRuns,
    headSha: identity.headSha,
    observedAt: new Date().toISOString(),
    repositoryDatabaseId: identity.repositoryDatabaseId,
    workflowRuns,
  });
}
