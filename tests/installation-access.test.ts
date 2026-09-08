import { expect, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import { accessibleRepositoryIds } from "../src/github/installation-access";

test("stops once access is proved, but enumerates every page for lifecycle reconciliation", async () => {
  const pages: number[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const octokit = new Octokit({ request: { fetch: async (resource: string | Request | URL, init?: RequestInit) => {
    const page = Number(new URL(String(resource)).searchParams.get("page") ?? 1);
    if (page === 1) expect(new URL(String(resource)).searchParams.getAll("per_page")).toEqual(["100"]);
    pages.push(page); signals.push(init?.signal);
    return Object.defineProperty(Response.json({ total_count: 2, repositories: [{ node_id: `R_${page}` }] }, {
      headers: page === 1 ? { link: '<https://api.github.com/installation/repositories?page=2>; rel="next"' } : {},
    }), "url", { value: String(resource) });
  } } });
  expect(await accessibleRepositoryIds(octokit, { wantedRepositoryId: "R_1" })).toEqual(["R_1"]);
  expect(pages).toEqual([1]);
  pages.length = 0; signals.length = 0;
  expect(await accessibleRepositoryIds(octokit)).toEqual(["R_1", "R_2"]);
  expect(pages).toEqual([1, 2]);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(signals[1]).toBe(signals[0]);
});

test("cancels a stalled later page and bounds a stalled authentication hook", async () => {
  let aborted = false;
  const octokit = new Octokit({ request: { fetch: async (resource: string | Request | URL, init?: RequestInit) => {
    if (!String(resource).includes("page=2")) return Object.defineProperty(Response.json({ total_count: 2, repositories: [{ node_id: "R_1" }] }, {
      headers: { link: '<https://api.github.com/installation/repositories?page=2>; rel="next"' },
    }), "url", { value: String(resource) });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal?.reason); }, { once: true });
    });
  } } });
  await expect(accessibleRepositoryIds(octokit, { timeoutMs: 30 })).rejects.toThrow();
  expect(aborted).toBe(true);
  let release: () => void = () => {};
  const authenticated = new Octokit({ request: { fetch: async (_resource: unknown, init?: RequestInit) => {
    expect(init?.signal?.aborted).toBe(true);
    throw init?.signal?.reason;
  } } });
  authenticated.hook.before("request", () => new Promise<void>((resolve) => { release = resolve; }));
  await expect(accessibleRepositoryIds(authenticated, { timeoutMs: 30 })).rejects.toThrow();
  release();
  await Bun.sleep(0);
});
