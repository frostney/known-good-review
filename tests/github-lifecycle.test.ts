import { describe, expect, spyOn, test } from "bun:test";
import {
  handleGitHubLifecycleWebhook,
  parseGitHubLifecycleEvent,
} from "../src/github/lifecycle";

const installation = {
  id: 41,
  account: { login: "frostney" },
  repository_selection: "selected",
};

function request(event: string | null, body: unknown): Request {
  const headers = new Headers({
    authorization: "Bearer verified-by-connect",
    "content-type": "application/json",
    "x-github-delivery": "delivery-1",
  });
  if (event) headers.set("x-github-event", event);
  return new Request("https://example.test/eve/v1/github", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function callbacks() {
  const calls: string[] = [];
  return {
    calls,
    verifier: async () => ({ authenticated: true }),
    deleteRepositories: async (repositoryIds: readonly string[]) => {
      calls.push(`delete:${repositoryIds.join(",")}`);
    },
    reconcileInstallation: async (
      installationId: number,
      retainedRepositoryIds: readonly string[],
    ) => {
      calls.push(
        `reconcile:${installationId}:${retainedRepositoryIds.join(",")}`,
      );
    },
    listAccessibleRepositories: async () => ["R_retained"],
  };
}

describe("GitHub App lifecycle webhooks", () => {
  test("recognizes a headerless installation deletion without confusing ordinary events", () => {
    expect(
      parseGitHubLifecycleEvent(
        JSON.stringify({ action: "deleted", installation }),
        null,
      ),
    ).toEqual({ kind: "installation-deleted", installationId: 41 });
    expect(
      parseGitHubLifecycleEvent(
        JSON.stringify({
          action: "deleted",
          installation: { id: 41 },
          repository: { node_id: "R_deleted" },
        }),
        null,
      ),
    ).toBeNull();
  });

  test("deletes the exact immutable repository IDs removed from an installation", async () => {
    const handlers = callbacks();
    const response = await handleGitHubLifecycleWebhook({
      request: request("installation_repositories", {
        action: "removed",
        installation,
        repositories_removed: [
          { node_id: "R_one" },
          { node_id: "R_two" },
          { node_id: "R_one" },
        ],
      }),
      ...handlers,
    });
    expect(response?.status).toBe(202);
    expect(handlers.calls).toEqual(["delete:R_one,R_two"]);
  });

  test("reconciles the installation when GitHub omits removed repositories", async () => {
    const handlers = callbacks();
    const response = await handleGitHubLifecycleWebhook({
      request: request("installation_repositories", {
        action: "removed",
        installation,
        repositories_removed: [],
      }),
      ...handlers,
    });
    expect(response?.status).toBe(202);
    expect(handlers.calls).toEqual(["reconcile:41:R_retained"]);
  });

  test("deletes every remembered repository for a complete uninstall", async () => {
    const handlers = callbacks();
    const response = await handleGitHubLifecycleWebhook({
      request: request("installation", { action: "deleted", installation }),
      ...handlers,
    });
    expect(response?.status).toBe(202);
    expect(handlers.calls).toEqual(["reconcile:41:"]);
  });

  test("delegates ordinary events and fails lifecycle requests closed", async () => {
    const ordinary = callbacks();
    expect(
      await handleGitHubLifecycleWebhook({
        request: request("pull_request", {
          action: "opened",
          installation: { id: 41 },
          pull_request: { number: 1 },
        }),
        ...ordinary,
      }),
    ).toBeNull();
    expect(ordinary.calls).toEqual([]);

    const rejected = callbacks();
    const response = await handleGitHubLifecycleWebhook({
      request: request("installation", { action: "deleted", installation }),
      ...rejected,
      verifier: async () => null,
    });
    expect(response?.status).toBe(401);
    expect(rejected.calls).toEqual([]);
  });

  test("returns a retryable failure until Convex accepts cleanup", async () => {
    const handlers = callbacks();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handleGitHubLifecycleWebhook({
        request: request("installation", { action: "deleted", installation }),
        ...handlers,
        reconcileInstallation: async () => {
          throw new Error("Convex unavailable");
        },
      });
      expect(response?.status).toBe(503);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});
