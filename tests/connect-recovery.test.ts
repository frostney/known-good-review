import { afterEach, expect, spyOn, test } from "bun:test";
import { githubChannel } from "eve/channels/github";
import { connectedGitHubAdapter } from "../src/github/chat-adapter";
import { connectedGitHubChannel } from "../src/github/connect-channel";
import { accessibleRepositoryIds } from "../src/github/installation-access";

const options = { vercelToken: "synthetic-connect-credential" };
let nextConnector = 0;
const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

function transport() {
  const connector = `github/recovery-test-${++nextConnector}`;
  const exchanges: { installationId?: string; subject: unknown; scopes: string[] }[] = [];
  const requests: { token: string; signal: AbortSignal | null | undefined; body: unknown; method: string | undefined }[] = [];
  let tokenStatus = 200;
  let githubStatus = 200;
  let networkFailure = false;
  let alwaysUnauthorized = false;
  let responseOrigin = "https://api.github.com";
  let beforeExchange: (() => Promise<void>) | undefined;
  let beforeGitHub: ((token: string) => Promise<void>) | undefined;
  const generations = new Map<string, number>();
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(resource));
    if (url.hostname === "api.vercel.com" && url.pathname.includes("/v1/connect/token/")) {
      const body = JSON.parse(String(init?.body));
      exchanges.push(body);
      await beforeExchange?.();
      if (tokenStatus !== 200) return Response.json({ error: { code: "no_token", message: "Synthetic exchange rejected" } }, { status: tokenStatus });
      const key = `${body.installationId ?? "default"}:${body.scopes.join(",")}`;
      const generation = (generations.get(key) ?? 0) + 1;
      generations.set(key, generation);
      return Response.json({ token: `synthetic-${key}-${generation}`, expiresAt: Date.now() + 3_600_000, connector: { id: "test", uid: connector, type: "github" } });
    }
    if (url.origin === "https://api.github.com") {
      const token = new Headers(init?.headers).get("authorization") ?? "";
      requests.push({ token, signal: init?.signal, body: init?.body, method: init?.method });
      await beforeGitHub?.(token);
      init?.signal?.throwIfAborted();
      if (networkFailure) throw new TypeError("Synthetic network failure");
      const status = alwaysUnauthorized ? 401 : githubStatus === 401 && !token.endsWith("-1") ? 200 : githubStatus;
      const response = status === 200
        ? Response.json(url.pathname === "/installation/repositories"
          ? { total_count: 1, repositories: [{ node_id: "R_42" }] } : { id: 42 })
        : Response.json({ message: "Synthetic GitHub rejection" }, { status });
      return Object.defineProperty(response, "url", { value: `${responseOrigin}${url.pathname}` });
    }
    throw new Error(`Unexpected offline request ${url.origin}${url.pathname}`);
  }, { preconnect() {} }));
  spies.push(fetcher);
  return {
    connector, exchanges, requests,
    tokenStatus(value: number) { tokenStatus = value; },
    githubStatus(value: number) { githubStatus = value; },
    networkFailure() { networkFailure = true; },
    alwaysUnauthorized() { alwaysUnauthorized = true; },
    responseOrigin(value: string) { responseOrigin = value; },
    beforeExchange(callback: () => Promise<void>) { beforeExchange = callback; },
    beforeGitHub(callback: (token: string) => Promise<void>) { beforeGitHub = callback; },
  };
}

type Transport = ReturnType<typeof transport>;
function chat(transport: Transport, installationId = "11", scopes?: string[]) {
  return connectedGitHubAdapter(transport.connector, {
    installationId, ...(scopes ? { scopes } : {}),
  }, {}, options);
}

async function eveRequest(transport: Transport): Promise<void> {
  // Exercise Eve's public channel entry point. Repository lookup and comment
  // posting use its installed HTTP client; stop before dispatching a model turn.
  const channel = githubChannel({
    ...connectedGitHubChannel(transport.connector, {}, options),
    botName: "test",
  });
  if (!channel.receive) throw new Error("Expected the native receive entry point");
  const stopped = new Error("Stop before model dispatch");
  try {
    await channel.receive({
      target: { owner: "test", repo: "test", issueNumber: 1, installationId: 11, initialMessage: "Synthetic comment" },
      auth: null, message: "Synthetic request",
    }, { from() { throw stopped; }, resolveSession() { throw stopped; } });
  } catch (error) {
    if (error !== stopped) throw error;
  }
}

for (const surface of ["chat", "eve"] as const) {
  test(`${surface}: recovers once through installed Connect and preserves subsequent cache reuse`, async () => {
    const state = transport();
    const adapter = chat(state);
    const request = () => surface === "chat" ? accessibleRepositoryIds(adapter.octokit) : eveRequest(state);
    await request();
    state.githubStatus(401);
    await request();
    await request();
    expect(state.exchanges).toHaveLength(2);
    expect(state.exchanges.map((entry) => entry.subject)).toEqual([{ type: "app" }, { type: "app" }]);
    expect(state.exchanges.map((entry) => entry.installationId)).toEqual(surface === "chat" ? ["11", "11"] : [undefined, undefined]);
    const retry = state.requests.findIndex((request) => request.token.endsWith("-2"));
    expect(retry).toBeGreaterThan(0);
    expect(state.requests[retry]?.body).toEqual(state.requests[retry - 1]?.body);
    expect(state.requests[retry]?.method).toBe(state.requests[retry - 1]?.method);
  });

  test(`${surface}: a second 401 stops after one refresh`, async () => {
    const state = transport();
    state.alwaysUnauthorized();
    const adapter = chat(state);
    await expect(surface === "chat" ? accessibleRepositoryIds(adapter.octokit) : eveRequest(state)).rejects.toThrow();
    expect(state.exchanges).toHaveLength(2);
    expect(state.requests).toHaveLength(2);
  });

  for (const failure of ["403", "network", "connect401"] as const) {
    test(`${surface}: ${failure} does not trigger cache recovery`, async () => {
      const state = transport();
      if (failure === "403") state.githubStatus(403);
      if (failure === "network") state.networkFailure();
      if (failure === "connect401") state.tokenStatus(401);
      const adapter = chat(state);
      await expect(surface === "chat" ? accessibleRepositoryIds(adapter.octokit) : eveRequest(state)).rejects.toThrow();
      expect(state.exchanges).toHaveLength(1);
      expect(state.requests).toHaveLength(failure === "connect401" ? 0 : 1);
    });
  }

  test(`${surface}: failed refresh remains terminal without credential logging`, async () => {
    const state = transport();
    const logs = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
    spies.push(...logs);
    const adapter = chat(state);
    const request = () => surface === "chat" ? accessibleRepositoryIds(adapter.octokit) : eveRequest(state);
    await request();
    state.githubStatus(401);
    state.tokenStatus(403);
    await expect(request()).rejects.toThrow("Synthetic exchange rejected");
    expect(state.exchanges).toHaveLength(2);
    expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain("synthetic-");
  });
}

test("targeted recovery preserves installation and scope cache entries", async () => {
  const state = transport();
  const adapters = [chat(state), chat(state, "22"), chat(state, "11", ["contents:read"]),
    connectedGitHubAdapter(`${state.connector}-other`, { installationId: "11" }, {}, options)];
  for (const adapter of adapters) await accessibleRepositoryIds(adapter.octokit);
  state.githubStatus(401);
  const primary = adapters[0];
  if (!primary) throw new Error("Expected primary installation");
  await accessibleRepositoryIds(primary.octokit);
  state.githubStatus(200);
  for (const adapter of adapters) await accessibleRepositoryIds(adapter.octokit);
  expect(state.exchanges.map((entry) => [entry.installationId, entry.scopes])).toEqual([
    ["11", ["*"]], ["22", ["*"]], ["11", ["contents:read"]], ["11", ["*"]], ["11", ["*"]],
  ]);
  const scoped = adapters[2];
  if (!scoped) throw new Error("Expected scoped installation");
  state.githubStatus(401);
  await accessibleRepositoryIds(scoped.octokit);
  expect(state.exchanges.at(-1)?.scopes).toEqual(["contents:read"]);
  expect(state.exchanges).toHaveLength(6);
});

test("concurrent stale requests across adapters share a refresh and delayed 401s reuse it", async () => {
  const state = transport();
  const first = chat(state), second = chat(state);
  await accessibleRepositoryIds(first.octokit);
  state.githubStatus(401);
  let release: () => void = () => {};
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let staleRequests = 0;
  state.beforeGitHub(async (token) => {
    if (token.endsWith("-1") && ++staleRequests === 2) await delayed;
  });
  const results = [accessibleRepositoryIds(first.octokit), accessibleRepositoryIds(second.octokit)];
  await results[0];
  release();
  expect(await Promise.all(results)).toEqual([["R_42"], ["R_42"]]);
  expect(state.exchanges).toHaveLength(2);
});

test("admission deadline bounds a stalled refresh and prevents a late retry", async () => {
  const state = transport();
  const adapter = chat(state);
  await accessibleRepositoryIds(adapter.octokit);
  state.githubStatus(401);
  let release: () => void = () => {};
  state.beforeExchange(() => new Promise<void>((resolve) => { release = resolve; }));
  await expect(accessibleRepositoryIds(adapter.octokit, { timeoutMs: 30 })).rejects.toThrow();
  expect(state.requests).toHaveLength(2);
  expect(state.requests[1]?.signal?.aborted).toBe(true);
  release();
  await Bun.sleep(0);
  expect(state.requests).toHaveLength(2);
});

test("cancellation after GitHub rejects prevents token invalidation", async () => {
  const state = transport();
  const adapter = chat(state);
  await accessibleRepositoryIds(adapter.octokit);
  state.githubStatus(401);
  const controller = new AbortController();
  state.beforeGitHub(async () => { controller.abort(); });
  await expect(adapter.octokit.request("GET /installation/repositories", { request: { signal: controller.signal } })).rejects.toThrow();
  expect(state.exchanges).toHaveLength(1);
});

test("Eve retries a rejected comment with the same method and JSON body", async () => {
  const state = transport();
  state.beforeGitHub(async () => {
    state.githubStatus(state.requests.at(-1)?.method === "POST" ? 401 : 200);
  });
  await eveRequest(state);
  const posts = state.requests.filter((request) => request.method === "POST");
  expect(posts).toHaveLength(2);
  expect(posts.map((request) => request.body)).toEqual([
    JSON.stringify({ body: "Synthetic comment" }), JSON.stringify({ body: "Synthetic comment" }),
  ]);
  expect(posts[0]?.token).toEndWith("-1");
  expect(posts[1]?.token).toEndWith("-2");
});

test("overlapping 401 responses share one in-flight Connect exchange", async () => {
  const state = transport();
  const first = chat(state), second = chat(state);
  await accessibleRepositoryIds(first.octokit);
  state.githubStatus(401);
  let release: () => void = () => {};
  state.beforeExchange(() => new Promise<void>((resolve) => { release = resolve; }));
  const pending = [accessibleRepositoryIds(first.octokit), accessibleRepositoryIds(second.octokit)];
  await Bun.sleep(0);
  expect(state.requests).toHaveLength(3);
  expect(state.exchanges).toHaveLength(2);
  release();
  expect(await Promise.all(pending)).toEqual([["R_42"], ["R_42"]]);
  expect(state.exchanges).toHaveLength(2);
});

test("an aborted refresh does not leave future recovery waiting on a stalled exchange", async () => {
  const state = transport();
  const adapter = chat(state);
  await accessibleRepositoryIds(adapter.octokit);
  state.githubStatus(401);
  let release: () => void = () => {};
  state.beforeExchange(() => new Promise<void>((resolve) => { release = resolve; }));
  await expect(accessibleRepositoryIds(adapter.octokit, { timeoutMs: 30 })).rejects.toThrow();
  state.beforeExchange(async () => {});
  // A new adapter resolves its own credential after the eviction, then can
  // recover independently even though the original exchange is still stalled.
  state.alwaysUnauthorized();
  await expect(accessibleRepositoryIds(chat(state).octokit, { timeoutMs: 100 })).rejects.toThrow("Synthetic GitHub rejection");
  expect(state.exchanges).toHaveLength(4);
  release();
  await Bun.sleep(0);
});


test("a redirected non-GitHub 401 does not refresh Connect credentials", async () => {
  const state = transport();
  state.alwaysUnauthorized();
  state.responseOrigin("https://example.invalid");
  await expect(accessibleRepositoryIds(chat(state).octokit)).rejects.toThrow("Synthetic GitHub rejection");
  expect(state.exchanges).toHaveLength(1);
  expect(state.requests).toHaveLength(1);
});
