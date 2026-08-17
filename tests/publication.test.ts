import { describe, expect, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import {
  publishInProgressCheck,
  publishReview,
} from "../src/github/publication";
import type { TrustedGitHubContext } from "../src/github/trusted-context";
import type { ReviewReport } from "../src/review/findings";

interface CapturedRequest {
  readonly body: unknown;
  readonly headers: Headers;
  readonly method: string;
  readonly path: string;
}

function json(value: unknown): Response {
  return Response.json(value, {
    headers: { "content-type": "application/json" },
  });
}

function context(): TrustedGitHubContext {
  return {
    installationId: 1,
    owner: "acme",
    repo: "widget",
    repository: "acme/widget",
    repositoryId: "R_widget",
    repositoryCreatedAt: 0,
    pullRequest: 7,
    baseSha: "base",
    headSha: "head",
    patchFingerprint: "a".repeat(64),
  };
}

function report(): ReviewReport {
  return {
    schemaVersion: 2,
    kind: "code-review",
    generatedAt: "2026-08-17T18:00:00.000Z",
    verdict: "REQUEST_CHANGES",
    scope: {
      claim: "Publish native review feedback",
      base: "base",
      head: "head",
      dirtyState: "clean",
    },
    coverage: {
      activeAxes: [
        "deduplication",
        "claim-and-specification",
        "engineering-quality",
      ],
      skippedAxes: [],
      staticOnly: [],
      unreached: [],
    },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [],
    findings: [
      {
        id: "CR-1",
        severity: "IMPORTANT",
        category: "QUALITY",
        title: "The feedback loses its code location",
        location: { path: "src/review.ts", line: 11, symbol: null },
        evidence: ["The result is only available on the timeline."],
        impact: "The author cannot discuss the affected code in place.",
        remedy: "Publish a native inline review thread.",
        status: "open",
        staticOnly: false,
        churn: null,
      },
    ],
    verifiedClaims: [],
    limitations: [],
  };
}

describe("GitHub publication lifecycle", () => {
  test("creates a fresh Check Run when the prior run is completed", async () => {
    const requests: CapturedRequest[] = [];
    const octokit = new Octokit({
      auth: "test-token",
      request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const method = init?.method ?? "GET";
          const body =
            typeof init?.body === "string" ? JSON.parse(init.body) : null;
          requests.push({
            body,
            headers: new Headers(init?.headers),
            method,
            path: url.pathname,
          });
          if (method === "GET" && url.pathname.endsWith("/check-runs")) {
            return json({
              check_runs: [
                {
                  conclusion: "failure",
                  id: 91,
                  name: "known-good-review",
                  status: "completed",
                },
              ],
              total_count: 1,
            });
          }
          if (method === "POST" && url.pathname.endsWith("/check-runs")) {
            return json({
              id: 92,
              name: "known-good-review",
              html_url: "https://github.com/acme/widget/runs/92",
            });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    await publishInProgressCheck({
      context: context(),
      octokit,
      reviewKind: "full",
    });

    expect(
      requests.find(
        (request) =>
          request.method === "POST" && request.path.endsWith("/check-runs"),
      )?.body,
    ).toMatchObject({ head_sha: "head", status: "in_progress" });
    expect(
      requests.some(
        (request) =>
          request.method === "PATCH" && request.path.endsWith("/check-runs/91"),
      ),
    ).toBeFalse();
  });

  test("moves one Check Run from in progress to a visible inline result", async () => {
    const requests: CapturedRequest[] = [];
    let checkExists = false;
    const octokit = new Octokit({
      auth: "test-token",
      request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const method = init?.method ?? "GET";
          const body =
            typeof init?.body === "string" ? JSON.parse(init.body) : null;
          requests.push({
            body,
            headers: new Headers(init?.headers),
            method,
            path: url.pathname,
          });

          if (method === "GET" && url.pathname.endsWith("/check-runs")) {
            return json({
              check_runs: checkExists
                ? [{ id: 91, name: "known-good-review", status: "in_progress" }]
                : [],
              total_count: checkExists ? 1 : 0,
            });
          }
          if (method === "POST" && url.pathname.endsWith("/check-runs")) {
            checkExists = true;
            return json({
              id: 91,
              name: "known-good-review",
              html_url: "https://github.com/acme/widget/runs/91",
            });
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/files")) {
            return json([
              {
                filename: "src/review.ts",
                status: "modified",
                sha: "blob",
                patch: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context",
              },
            ]);
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/comments")) {
            return json([]);
          }
          if (method === "POST" && url.pathname.endsWith("/pulls/7/comments")) {
            return json({ id: 101, body, path: "src/review.ts", line: 11 });
          }
          if (method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
            return json([
              {
                id: 88,
                body: "<!-- known-good-review:finding:CR-2 -->\nlegacy finding",
              },
            ]);
          }
          if (method === "POST" && url.pathname.endsWith("/issues/7/comments")) {
            return json({ id: 102, body });
          }
          if (method === "PATCH" && url.pathname.endsWith("/issues/comments/88")) {
            return json({ id: 88, body });
          }
          if (method === "PATCH" && url.pathname.endsWith("/check-runs/91")) {
            return json({
              id: 91,
              name: "known-good-review",
              html_url: "https://github.com/acme/widget/runs/91",
            });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    await publishInProgressCheck({
      context: context(),
      octokit,
      reviewKind: "full",
    });
    await publishReview({ context: context(), octokit, report: report() });

    expect(
      requests.find(
        (request) =>
          request.method === "POST" && request.path.endsWith("/check-runs"),
      )?.body,
    ).toMatchObject({ status: "in_progress" });
    expect(
      requests.find(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/pulls/7/comments"),
      )?.body,
    ).toMatchObject({
      commit_id: "head",
      line: 11,
      path: "src/review.ts",
      side: "RIGHT",
      subject_type: "line",
      body: expect.stringContaining(
        "### ⚠️ The feedback loses its code location",
      ),
    });
    expect(
      requests
        .find(
          (request) =>
            request.method === "POST" &&
            request.path.endsWith("/pulls/7/comments"),
        )
        ?.headers.get("x-github-api-version"),
    ).toBe("2026-03-10");
    expect(
      requests.find(
        (request) =>
          request.method === "PATCH" && request.path.endsWith("/check-runs/91"),
      )?.body,
    ).toMatchObject({ conclusion: "failure", status: "completed" });
    expect(
      requests.find(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/issues/7/comments"),
      )?.body,
    ).toMatchObject({
      body: expect.stringContaining(
        "## ❌ known-good-review: changes requested",
      ),
    });
    expect(
      requests.find(
        (request) =>
          request.method === "PATCH" &&
          request.path.endsWith("/issues/comments/88"),
      )?.body,
    ).toMatchObject({
      body: expect.stringContaining("### ✅ No longer active"),
    });
  });
});
