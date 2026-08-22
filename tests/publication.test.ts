import { describe, expect, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import {
  activeReviewExternalId,
  findingBody,
  parseActiveReviewExternalId,
  publishInProgressCheck,
  publishReview,
  writeReviewFailureState,
} from "../src/github/publication";
import type { TrustedGitHubContext } from "../src/github/trusted-context";
import type { ReviewReport } from "../src/review/findings";
import {
  advanceReviewRecovery,
  beginReviewRecovery,
  buildReviewFailureEnvelope,
} from "../src/review/recovery";

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

function graphqlOperation(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "query" in body &&
    typeof body.query === "string"
  ) {
    return body.query;
  }
  return "";
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
  test("persists a current-head recovery failure without inventing review output", async () => {
    const requests: CapturedRequest[] = [];
    const failureContext = {
      ...context(),
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
    };
    const recovery = advanceReviewRecovery(
      beginReviewRecovery({
        activeAxes: ["engineering-quality"],
        identity: {
          baseSha: failureContext.baseSha,
          headSha: failureContext.headSha,
          patchFingerprint: failureContext.patchFingerprint ?? "",
          planKind: "delta",
        },
        selectedFindingIds: ["CR-7"],
      }),
      {
        completedAxes: ["engineering-quality"],
        stage: "axes-complete",
      },
    );
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
          if (method === "GET" && url.pathname.endsWith("/pulls/7")) {
            return json({
              base: { sha: failureContext.baseSha },
              head: { sha: failureContext.headSha },
            });
          }
          if (method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
            return json([]);
          }
          if (method === "POST" && url.pathname.endsWith("/issues/7/comments")) {
            return json({ id: 401, body });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    await writeReviewFailureState({
      context: failureContext,
      failure: buildReviewFailureEnvelope({
        errorClass: "WORKFLOW_INCOMPLETE",
        recovery,
        run: { sessionId: "session-safe", turnId: "turn-safe" },
      }),
      octokit,
    });

    expect(
      requests.find(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/issues/7/comments"),
      )?.body,
    ).toMatchObject({
      body: expect.stringContaining("known-good-review:state"),
    });
  });

  test("round-trips current-head review identity through the Check Run", () => {
    const full = activeReviewExternalId(context(), {
      kind: "full",
      reason: "manual",
    });
    const delta = activeReviewExternalId(context(), { kind: "delta" });

    expect(parseActiveReviewExternalId(full, context())).toEqual({
      kind: "full",
      reason: "manual",
    });
    expect(parseActiveReviewExternalId(delta, context())).toEqual({
      kind: "delta",
    });
    expect(
      parseActiveReviewExternalId(full, { ...context(), headSha: "new-head" }),
    ).toBeNull();
    expect(
      parseActiveReviewExternalId(full, { ...context(), baseSha: "new-base" }),
    ).toBeNull();
    expect(
      parseActiveReviewExternalId(full, { ...context(), pullRequest: 8 }),
    ).toBeNull();
  });

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
      review: { kind: "full", reason: "manual" },
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
          if (method === "GET" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json([{ id: 77, state: "PENDING" }]);
          }
          if (
            method === "DELETE" &&
            url.pathname.endsWith("/pulls/7/reviews/77")
          ) {
            return json({ id: 77, state: "PENDING" });
          }
          if (method === "POST" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json({ id: 101, node_id: "PRR_101" });
          }
          if (method === "POST" && url.pathname === "/graphql") {
            const operation = graphqlOperation(body);
            if (operation.includes("KnownGoodReviewAddReviewThread")) {
              return json({
                data: {
                  addPullRequestReviewThread: { thread: { id: "PRRT_102" } },
                },
              });
            }
            throw new Error(`Unexpected GraphQL operation: ${operation}`);
          }
          if (
            method === "POST" &&
            url.pathname.endsWith("/pulls/7/reviews/101/events")
          ) {
            return json({ id: 101, node_id: "PRR_101", state: "COMMENTED" });
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
      review: { kind: "full", reason: "manual" },
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
          request.path === "/graphql" &&
          graphqlOperation(request.body).includes(
            "KnownGoodReviewAddReviewThread",
          ),
      )?.body,
    ).toMatchObject({
      variables: {
        input: {
          body: expect.stringContaining(
            "### ⚠️ The feedback loses its code location",
          ),
          line: 11,
          path: "src/review.ts",
          pullRequestReviewId: "PRR_101",
          side: "RIGHT",
          subjectType: "LINE",
        },
      },
    });
    expect(
      requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path.endsWith("/pulls/7/reviews/77"),
      ),
    ).toBeTrue();
    expect(
      requests.some(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/pulls/7/reviews/101/events") &&
          typeof request.body === "object" &&
          request.body !== null &&
          "event" in request.body &&
          request.body.event === "COMMENT",
      ),
    ).toBeTrue();
    expect(
      requests.find(
        (request) =>
          request.method === "PATCH" && request.path.endsWith("/check-runs/91"),
      )?.body,
    ).toMatchObject({ conclusion: "neutral", status: "completed" });
    expect(
      requests.find(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/issues/7/comments"),
      )?.body,
    ).toMatchObject({
      body: expect.stringContaining(
        "## 💬 known-good-review: review complete",
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

  test("removes a pending review when native thread creation fails", async () => {
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
          if (method === "GET" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json([]);
          }
          if (method === "POST" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json({ id: 101, node_id: "PRR_101" });
          }
          if (method === "POST" && url.pathname === "/graphql") {
            const operation = graphqlOperation(body);
            if (operation.includes("KnownGoodReviewAddReviewThread")) {
              return json({
                data: { addPullRequestReviewThread: null },
                errors: [{ message: "native thread creation failed" }],
              });
            }
            throw new Error(`Unexpected GraphQL operation: ${operation}`);
          }
          if (
            method === "DELETE" &&
            url.pathname.endsWith("/pulls/7/reviews/101")
          ) {
            return json({ id: 101, node_id: "PRR_101" });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    expect(
      publishReview({ context: context(), octokit, report: report() }),
    ).rejects.toThrow("native thread creation failed");
    expect(
      requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path.endsWith("/pulls/7/reviews/101"),
      ),
    ).toBeTrue();
    expect(
      requests.some(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/pulls/7/reviews/101/events"),
      ),
    ).toBeFalse();
  });

  test("retires an old thread only after the replacement and state artifact are durable", async () => {
    const requests: CapturedRequest[] = [];
    const octokit = new Octokit({
      auth: "test-token",
      request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const method = init?.method ?? "GET";
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
          requests.push({
            body,
            headers: new Headers(init?.headers),
            method,
            path: url.pathname,
          });
          if (method === "GET" && url.pathname.endsWith("/pulls/7/files")) {
            return json([{
              filename: "src/review.ts",
              status: "modified",
              sha: "blob",
              patch: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context",
            }]);
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/comments")) {
            return json([{
              id: 201,
              body: "<!-- known-good-review:finding:CR-1 -->\nold finding",
              path: "src/old.ts",
              line: 3,
              side: "RIGHT",
              subject_type: "line",
              in_reply_to_id: null,
            }]);
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json([]);
          }
          if (method === "POST" && url.pathname.endsWith("/pulls/7/reviews")) {
            return json({ id: 101, node_id: "PRR_101" });
          }
          if (
            method === "POST" &&
            url.pathname.endsWith("/pulls/7/reviews/101/events")
          ) {
            return json({ id: 101, state: "COMMENTED" });
          }
          if (
            method === "POST" &&
            url.pathname.endsWith("/pulls/7/comments/201/replies")
          ) {
            return json({ id: 202, body, in_reply_to_id: 201 });
          }
          if (method === "POST" && url.pathname === "/graphql") {
            const operation = graphqlOperation(body);
            if (operation.includes("KnownGoodReviewThreads")) {
              return json({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes: [{
                          id: "PRRT_201",
                          isResolved: false,
                          comments: { nodes: [{ databaseId: 201, body: "old finding" }] },
                        }],
                        pageInfo: { endCursor: null, hasNextPage: false },
                      },
                    },
                  },
                },
              });
            }
            if (operation.includes("KnownGoodReviewAddReviewThread")) {
              return json({
                data: {
                  addPullRequestReviewThread: { thread: { id: "PRRT_202" } },
                },
              });
            }
            if (operation.includes("KnownGoodReviewResolveThread")) {
              throw new Error("review thread resolution failed");
            }
            throw new Error(`Unexpected GraphQL operation: ${operation}`);
          }
          if (method === "GET" && url.pathname.endsWith("/check-runs")) {
            return json({ check_runs: [], total_count: 0 });
          }
          if (method === "POST" && url.pathname.endsWith("/check-runs")) {
            return json({
              id: requests.length + 300,
              name: "known-good-review",
              html_url: "https://github.com/acme/widget/runs/300",
            });
          }
          if (method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
            return json([]);
          }
          if (method === "POST" && url.pathname.endsWith("/issues/7/comments")) {
            return json({ id: 401, body });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    await publishReview({ context: context(), octokit, report: report() });

    const stateArtifact = requests.findIndex(
      (request) =>
        request.method === "POST" &&
        request.path.endsWith("/issues/7/comments") &&
        typeof request.body === "object" &&
        request.body !== null &&
        "body" in request.body &&
        typeof request.body.body === "string" &&
        request.body.body.includes("known-good-review:state"),
    );
    const retirementReply = requests.findIndex((request) =>
      request.path.endsWith("/pulls/7/comments/201/replies"),
    );
    expect(stateArtifact).toBeGreaterThan(-1);
    expect(retirementReply).toBeGreaterThan(stateArtifact);
    expect(requests[retirementReply]?.body).toMatchObject({
      body: expect.stringContaining("no longer published"),
    });
    expect(requests[retirementReply]?.body).not.toMatchObject({
      body: expect.stringContaining("moved to a new inline location"),
    });
  });

  test("replies to and resolves a fixed finding without reposting it", async () => {
    const requests: CapturedRequest[] = [];
    const fixed = report();
    fixed.findings[0]!.status = "fixed";
    fixed.verdict = "APPROVE";
    const octokit = new Octokit({
      auth: "test-token",
      request: {
        fetch: async (resource: Request | string | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const method = init?.method ?? "GET";
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
          requests.push({
            body,
            headers: new Headers(init?.headers),
            method,
            path: url.pathname,
          });
          if (method === "GET" && url.pathname.endsWith("/pulls/7/files")) {
            return json([{
              filename: "src/review.ts",
              status: "modified",
              sha: "blob",
              patch: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context",
            }]);
          }
          if (method === "GET" && url.pathname.endsWith("/pulls/7/comments")) {
            return json([{
              id: 201,
              body: findingBody(fixed.findings[0]!),
              path: "src/review.ts",
              line: 11,
              side: "RIGHT",
              subject_type: "line",
              in_reply_to_id: null,
            }]);
          }
          if (
            method === "POST" &&
            url.pathname.endsWith("/pulls/7/comments/201/replies")
          ) {
            return json({ id: 202, body, in_reply_to_id: 201 });
          }
          if (method === "POST" && url.pathname === "/graphql") {
            const operation = graphqlOperation(body);
            if (operation.includes("KnownGoodReviewThreads")) {
              return json({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes: [{
                          id: "PRRT_201",
                          isResolved: false,
                          comments: {
                            nodes: [{ databaseId: 201, body: "original finding" }],
                          },
                        }],
                        pageInfo: { endCursor: null, hasNextPage: false },
                      },
                    },
                  },
                },
              });
            }
            if (operation.includes("KnownGoodReviewResolveThread")) {
              return json({
                data: {
                  resolveReviewThread: {
                    thread: { id: "PRRT_201", isResolved: true },
                  },
                },
              });
            }
            throw new Error(`Unexpected GraphQL operation: ${operation}`);
          }
          if (method === "GET" && url.pathname.endsWith("/check-runs")) {
            return json({ check_runs: [], total_count: 0 });
          }
          if (method === "POST" && url.pathname.endsWith("/check-runs")) {
            return json({
              id: requests.length + 300,
              name: "known-good-review",
              html_url: "https://github.com/acme/widget/runs/300",
            });
          }
          if (method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
            return json([]);
          }
          if (method === "POST" && url.pathname.endsWith("/issues/7/comments")) {
            return json({ id: 401, body });
          }
          throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`);
        },
      },
    });

    await publishReview({ context: context(), octokit, report: fixed });

    expect(
      requests.find((request) =>
        request.path.endsWith("/pulls/7/comments/201/replies"),
      )?.body,
    ).toMatchObject({ body: expect.stringContaining("✅ Fixed in the current review.") });
    expect(
      requests.some(
        (request) =>
          request.path === "/graphql" &&
          graphqlOperation(request.body).includes("KnownGoodReviewResolveThread"),
      ),
    ).toBeTrue();
    expect(
      requests.some((request) => request.path.endsWith("/pulls/7/reviews")),
    ).toBeFalse();
    expect(
      requests.some(
        (request) =>
          request.method === "PATCH" &&
          request.path.endsWith("/pulls/comments/201"),
      ),
    ).toBeFalse();
  });
});
