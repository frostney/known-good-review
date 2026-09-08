import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { collectExactHeadGitHubEvidence } from "../src/github/exact-head-evidence";

const identity = { owner: "acme", repo: "artifacts", repositoryDatabaseId: 1, headSha: "a".repeat(40) };
const bytes = new Uint8Array([1, 2, 3]);
const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function fixture(sizes: number[], streamOverflow = false, stale = false) {
  let downloads = 0;
  let cancelled = 0;
  const octokit = new Octokit({ request: { fetch: async (resource: Request | string | URL) => {
    const path = new URL(String(resource)).pathname;
    const json = (data: unknown) => Object.defineProperty(Response.json(data), "url", { value: String(resource) });
    if (path.endsWith("/check-runs")) return json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/actions/runs")) return json({ total_count: 1, workflow_runs: [{
      id: 10, name: "build", head_sha: stale ? "b".repeat(40) : identity.headSha,
      status: "completed", conclusion: "success", event: "pull_request", run_attempt: 1,
      repository: { id: 1 }, head_repository: { id: 1 },
    }] });
    if (path.endsWith("/artifacts")) return json({ total_count: sizes.length, artifacts: sizes.map((size, index) => ({
      id: index + 20, name: `artifact-${index}`, size_in_bytes: size, expired: false, digest: hash,
      created_at: "2026-09-05T00:00:00.000Z", expires_at: "2027-09-05T00:00:00.000Z",
      workflow_run: { id: 10, repository_id: 1, head_repository_id: 1, head_sha: identity.headSha },
    })) });
    if (path.endsWith("/zip")) {
      downloads += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); if (!streamOverflow) controller.close(); },
        cancel() { cancelled += 1; },
      }), { headers: { "content-type": "application/zip" } });
    }
    throw new Error(`Unexpected fixture request ${path}`);
  } } });
  return { octokit, downloads: () => downloads, cancelled: () => cancelled };
}

test("streams a bounded archive through Octokit and retains exact digest validation", async () => {
  const input = fixture([bytes.length]);
  const result = await collectExactHeadGitHubEvidence(input.octokit, identity, { archiveBytes: 4, totalBytes: 4 });
  expect(result.archives.get(20)).toEqual(bytes);
  expect(result.evidence.artifacts.status).toBe("available");
  expect(input.downloads()).toBe(1);
});

test("rejects oversized metadata and stale workflow identity before downloading", async () => {
  for (const stale of [false, true]) {
    const input = fixture([5], false, stale);
    await expect(collectExactHeadGitHubEvidence(input.octokit, identity, { archiveBytes: 4, totalBytes: 4 }))
      .rejects.toThrow(stale ? "stale-workflow-head" : "artifact-download-size-limit");
    expect(input.downloads()).toBe(0);
  }
});

test("cancels a stream whose actual bytes exceed its advertised size or remaining allowance", async () => {
  const oversized = fixture([1], true);
  await expect(collectExactHeadGitHubEvidence(oversized.octokit, identity, { archiveBytes: 2, totalBytes: 4 }))
    .rejects.toThrow("artifact-download-size-limit");
  expect(oversized.cancelled()).toBe(1);
  const cumulative = fixture([1, 1]);
  await expect(collectExactHeadGitHubEvidence(cumulative.octokit, identity, { archiveBytes: 4, totalBytes: 5 }))
    .rejects.toThrow("artifact-download-size-limit");
  expect(cumulative.downloads()).toBe(2);
});
