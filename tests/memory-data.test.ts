import { expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = {
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/memoryData.ts": () => import("../convex/memoryData"),
};
const embedding = { model: "openai/text-embedding-3-small", dimension: 1536 };

test("serializes ingestion, preserves newer memory, and releases abandoned work", async () => {
  // Inspect scheduled jobs without running embedding actions or paid requests.
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
  const now = spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    const t = convexTest(schema, modules);
    const [first, second] = await t.run(async (ctx) => {
      await ctx.db.insert("repositoryMemory", {
        installationId: 1, repositoryId: "R_test", repository: "acme/test", repositoryCreatedAt: 0,
        completedReviews: 2, reviewDays: 1, firstReviewAt: 1, lastReviewAt: 2,
        recentReviewTimes: [1, 2], activeEmbedding: embedding, policyHash: "policy", deleting: false,
      });
      const common = {
        installationId: 1, repositoryId: "R_test", repository: "acme/test", repositoryCreatedAt: 0,
        pullRequest: 1, reviewKind: "delta" as const, base: "base", head: "head",
        policyHash: "policy", embedding, memories: [], status: "pending" as const, attempts: 0,
      };
      return [
        await ctx.db.insert("memoryIngestions", { ...common, idempotencyKey: "first", publishedAt: 2 }),
        await ctx.db.insert("memoryIngestions", { ...common, idempotencyKey: "second", publishedAt: 1 }),
      ] as const;
    });
    expect(await t.mutation(internal.memoryData.startIngestion, { ingestionId: first })).toBe(true);
    expect(await t.mutation(internal.memoryData.startIngestion, { ingestionId: first })).toBe(false);
    expect(await t.mutation(internal.memoryData.startIngestion, { ingestionId: second })).toBe(false);
    expect((await t.query(internal.memoryData.getIngestion, { ingestionId: first }))?.attempts).toBe(1);
    const memory = {
      finding: "Finding", invariant: "Invariant", cause: null, remedy: "Remedy", outcome: "fixed" as const,
      severity: "IMPORTANT" as const, category: "QUALITY" as const,
      provenance: { repositoryId: "R_test", repository: "acme/test", pullRequest: 1, base: "base", head: "head", path: "src/a.ts", symbol: null, findingId: "CR-1" },
    };
    const record = { memoryKey: "memory", clusterKey: "cluster", embedding, memory, ragEntryId: "new-vector" };
    await t.mutation(internal.memoryData.recordMemory, { ...record, ingestionId: first, observedAt: 2 });
    await t.mutation(internal.memoryData.completeIngestion, { ingestionId: first });
    await t.mutation(internal.memoryData.retryIngestion, { ingestionId: first, failureCode: "late failure" });
    expect((await t.query(internal.memoryData.getIngestion, { ingestionId: first }))?.status).toBe("complete");
    expect(await t.mutation(internal.memoryData.startIngestion, { ingestionId: second })).toBe(true);
    await t.mutation(internal.memoryData.recordMemory, {
      ...record, memory: { ...memory, outcome: "open" }, ragEntryId: "old-vector", ingestionId: second, observedAt: 1,
    });
    expect(await t.query(internal.memoryData.memoryClusterSeed, { repositoryId: "R_test", memoryKey: "memory" }))
      .toMatchObject({ observedAt: 2 });
    expect(await t.run((ctx) => ctx.db.query("memoryEntries").first())).toMatchObject({ outcome: "fixed" });
    expect(await t.run((ctx) => ctx.db.query("memoryVectors").first())).toMatchObject({ ragEntryId: "new-vector" });
    await t.mutation(internal.memoryData.expireIngestion, { ingestionId: second, attempt: 1 });
    expect((await t.query(internal.memoryData.getIngestion, { ingestionId: second }))?.status).toBe("processing");
    now.mockReturnValue(2_000_000);
    await t.mutation(internal.memoryData.expireIngestion, { ingestionId: second, attempt: 1 });
    expect((await t.query(internal.memoryData.getIngestion, { ingestionId: second }))?.status).toBe("pending");
    expect(await t.mutation(internal.memoryData.startIngestion, { ingestionId: second })).toBe(true);
    await t.mutation(internal.memoryData.expireIngestion, { ingestionId: second, attempt: 1 });
    expect((await t.query(internal.memoryData.getIngestion, { ingestionId: second }))?.status).toBe("processing");
  } finally { timers.mockRestore(); now.mockRestore(); }
});

test("stops searches after deletion admission and gives legacy processing rows a bounded grace period", async () => {
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
  const now = spyOn(Date, "now").mockReturnValue(5_000_000);
  try {
    const t = convexTest(schema, modules);
    const ingestionId = await t.run(async (ctx) => {
      await ctx.db.insert("repositoryMemory", {
        installationId: 1, repositoryId: "R_legacy", repository: "acme/legacy", repositoryCreatedAt: 0,
        completedReviews: 1, reviewDays: 1, firstReviewAt: 1, lastReviewAt: 1,
        recentReviewTimes: [1], activeEmbedding: embedding, policyHash: "policy", deleting: true,
      });
      return ctx.db.insert("memoryIngestions", {
        installationId: 1, repositoryId: "R_legacy", repository: "acme/legacy", repositoryCreatedAt: 0,
        pullRequest: 1, reviewKind: "full", base: "base", head: "head", policyHash: "policy",
        embedding, memories: [], status: "processing", attempts: 1, idempotencyKey: "legacy", publishedAt: 1,
      });
    });
    expect(await t.mutation(internal.memoryData.ensureEmbedding, { repositoryId: "R_legacy", embedding })).toBeNull();
    expect(await t.mutation(internal.memoryData.repositoryHasActiveMemoryWork, { repositoryId: "R_legacy" })).toBe(true);
    expect(await t.query(internal.memoryData.getIngestion, { ingestionId })).toMatchObject({ processingStartedAt: 5_000_000 });
    await t.mutation(internal.memoryData.expireIngestion, { ingestionId, attempt: 1 });
    expect((await t.query(internal.memoryData.getIngestion, { ingestionId }))?.status).toBe("processing");
    now.mockReturnValue(5_660_000);
    await t.mutation(internal.memoryData.expireIngestion, { ingestionId, attempt: 1 });
    expect((await t.query(internal.memoryData.getIngestion, { ingestionId }))?.status).toBe("failed");
    expect(await t.mutation(internal.memoryData.repositoryHasActiveMemoryWork, { repositoryId: "R_legacy" })).toBe(false);
  } finally { timers.mockRestore(); now.mockRestore(); }
});

test("search uses the current ranking policy and never embeds a repository being deleted", async () => {
  const { RAG } = await import("@convex-dev/rag");
  const { memoryPolicyHash } = await import("../src/memory/policy");
  const search = spyOn(RAG.prototype, "search").mockResolvedValue({ text: "", results: [], entries: [], usage: { tokens: 3 } });
  try {
    const t = convexTest(schema, {
      ...modules,
      "../convex/memoryActions.ts": () => import("../convex/memoryActions"),
    });
    const repository = await t.run((ctx) => ctx.db.insert("repositoryMemory", {
      installationId: 1, repositoryId: "R_policy", repository: "acme/policy", repositoryCreatedAt: 0,
      completedReviews: 1, reviewDays: 1, firstReviewAt: 1, lastReviewAt: 1,
      recentReviewTimes: [1], activeEmbedding: embedding, policyHash: "0".repeat(64), deleting: false,
    }));
    const args = { repositoryId: "R_policy", embedding, axis: "engineering-quality" as const, query: "retry safety", limit: 8 };
    expect(await t.action(internal.memoryActions.searchRepository, args))
      .toMatchObject({ policyHash: memoryPolicyHash(), usage: { embeddingTokens: 3 } });
    await t.run((ctx) => ctx.db.patch(repository, { deleting: true }));
    expect(await t.action(internal.memoryActions.searchRepository, args))
      .toMatchObject({ memories: [], usage: { embeddingTokens: 0 } });
    expect(search).toHaveBeenCalledTimes(1);
  } finally { search.mockRestore(); }
});
