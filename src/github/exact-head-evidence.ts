import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import {
  GitHubEvidenceError,
  prepareExactHeadGitHubEvidence,
  type PreparedGitHubEvidence,
} from "../review/github-evidence";

const requestErrorSchema = z.object({ status: z.number().int() });

function requestFailure(error: unknown, forbiddenCode: string): never {
  const parsed = requestErrorSchema.safeParse(error);
  throw new GitHubEvidenceError(
    parsed.success && parsed.data.status === 403
      ? forbiddenCode
      : "github-evidence-request-failed",
  );
}

async function archiveBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new Error("GitHub returned an unsupported artifact archive payload");
}

export async function collectExactHeadGitHubEvidence(
  octokit: Octokit,
  identity: {
    readonly headSha: string;
    readonly owner: string;
    readonly repo: string;
    readonly repositoryDatabaseId: number;
  },
): Promise<PreparedGitHubEvidence> {
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
  for (const run of workflowRuns) {
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
      const download = await octokit.rest.actions
        .downloadArtifact({
          owner: identity.owner,
          repo: identity.repo,
          artifact_id: artifact.id,
          archive_format: "zip",
        })
        .catch((error: unknown) =>
          requestFailure(error, "actions-read-permission-missing"),
        );
      prepared.push({
        archive: await archiveBytes(download.data),
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
