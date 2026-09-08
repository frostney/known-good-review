import { expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = {
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/memoryData.ts": () => import("../convex/memoryData"),
};
const embedding = { model: "openai/text-embedding-3-small", dimension: 1536 };
const replacement = { model: "openai/text-embedding-3-large", dimension: 3072 };
const repo = {
  installationId: 1, repositoryId: "R_reembed", repository: "acme/reembed", repositoryCreatedAt: 0,
  completedReviews: 1, reviewDays: 1, firstReviewAt: 1, lastReviewAt: 1,
  recentReviewTimes: [1], activeEmbedding: embedding, policyHash: "policy", deleting: false,
};

test("binds migration cursors, retries, and vector writes to a single claimed job", async () => {
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
  const now = spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("repositoryMemory", repo));
    const read = () => t.query(internal.memoryData.getRepository, { repositoryId: repo.repositoryId });
    await t.mutation(internal.memoryData.ensureEmbedding, { repositoryId: repo.repositoryId, embedding: replacement });
    const first = (await read())?.reembedJob;
    if (!first) throw new Error("Missing migration job");
    const claim = { repositoryId: repo.repositoryId, token: first.token };
    expect(await t.mutation(internal.memoryData.startReembed, claim)).toMatchObject({ reembedJob: { startedAt: 1_000_000 } });
    expect(await t.mutation(internal.memoryData.startReembed, claim)).toBeNull();
    await t.mutation(internal.memoryData.completeReembed, { ...claim, nextCursor: "page-two" });
    const second = (await read())?.reembedJob;
    if (!second) throw new Error("Missing continuation job");
    expect(second.cursor).toBe("page-two");
    expect(second.token).not.toBe(first.token);
    expect(await t.mutation(internal.memoryData.startReembed, claim)).toBeNull();
    await t.mutation(internal.memoryData.completeReembed, { ...claim, nextCursor: null });
    await t.mutation(internal.memoryData.recordReembedFailure, { ...claim, failureCode: "late failure" });
    expect((await read())?.pendingEmbedding).toEqual(replacement);
    await expect(t.mutation(internal.memoryData.recordVectorCopy, {
      ...claim, memoryKey: "memory", embedding: replacement, ragEntryId: "stale-vector",
    })).rejects.toThrow("not active");
    const next = { repositoryId: repo.repositoryId, token: second.token };
    await t.mutation(internal.memoryData.startReembed, next);
    await t.mutation(internal.memoryData.expireReembed, next);
    expect((await read())?.reembedJob?.token).toBe(second.token);
    now.mockReturnValue(1_660_000);
    await t.mutation(internal.memoryData.expireReembed, next);
    const retry = (await read())?.reembedJob;
    expect(retry).toMatchObject({ cursor: "page-two", attempt: 1 });
    expect(retry?.token).not.toBe(second.token);
    if (!retry) throw new Error("Missing retry job");
    const retryClaim = { repositoryId: repo.repositoryId, token: retry.token };
    await t.mutation(internal.memoryData.startReembed, retryClaim);
    await t.mutation(internal.memoryData.recordVectorCopy, {
      ...retryClaim, memoryKey: "memory", embedding: replacement, ragEntryId: "current-vector",
    });
    await t.mutation(internal.memoryData.completeReembed, { ...retryClaim, nextCursor: null });
    expect(await read()).toMatchObject({ activeEmbedding: replacement });
    expect((await read())?.pendingEmbedding).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("memoryVectors").first())).toMatchObject({ ragEntryId: "current-vector" });
    await t.mutation(internal.memoryData.ensureEmbedding, { repositoryId: repo.repositoryId, embedding });
    expect(await t.mutation(internal.memoryData.startReembed, claim)).toBeNull();
    expect((await read())?.reembedJob?.cursor).toBeNull();
  } finally { timers.mockRestore(); now.mockRestore(); }
});

test("recovers legacy migrations and releases deletion after an abandoned action", async () => {
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
  const now = spyOn(Date, "now").mockReturnValue(5_000_000);
  try {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) => ctx.db.insert("repositoryMemory", { ...repo, pendingEmbedding: replacement }));
    // A legacy action may already have vanished before deployment. A new search
    // must recover its job even if no old scheduled callback remains.
    expect(await t.mutation(internal.memoryData.ensureEmbedding, { repositoryId: repo.repositoryId, embedding: replacement }))
      .toMatchObject({ reembedJob: { cursor: null, attempt: 0 } });
    expect(await t.mutation(internal.memoryData.startReembed, { repositoryId: repo.repositoryId })).toBeNull();
    const current = await t.query(internal.memoryData.getRepository, { repositoryId: repo.repositoryId });
    if (!current?.reembedJob) throw new Error("Missing adopted migration");
    expect(current.reembedJob.cursor).toBeNull();
    const claim = { repositoryId: repo.repositoryId, token: current.reembedJob.token };
    await t.mutation(internal.memoryData.startReembed, claim);
    await t.run((ctx) => ctx.db.patch(id, { deleting: true }));
    expect(await t.mutation(internal.memoryData.repositoryHasActiveMemoryWork, { repositoryId: repo.repositoryId })).toBe(true);
    now.mockReturnValue(5_660_000);
    await t.mutation(internal.memoryData.expireReembed, claim);
    expect(await t.mutation(internal.memoryData.repositoryHasActiveMemoryWork, { repositoryId: repo.repositoryId })).toBe(false);
    expect(await t.query(internal.memoryData.getRepository, { repositoryId: repo.repositoryId }))
      .toMatchObject({ activeEmbedding: embedding });
  } finally { timers.mockRestore(); now.mockRestore(); }
});

test("drains ready ingestion before switching models when migrations overlap", async () => {
  const { registerRag } = await import("./rag-fixture");
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("No provider calls in this test"); }, { preconnect: () => {} }));
  try {
    const t = convexTest(schema, {
      ...modules, "../convex/memoryAccess.ts": () => import("../convex/memoryAccess"),
      "../convex/memoryActions.ts": () => import("../convex/memoryActions"),
    });
    await registerRag(t);
    await t.run((ctx) => ctx.db.insert("repositoryMemory", repo));
    const identity = { installationId: 1, repositoryId: repo.repositoryId };
    const admission = await t.mutation(internal.memoryAccess.captureAdmission, identity);
    if (!admission.receipt) throw new Error("Missing admission");
    const third = { model: "voyage/voyage-4", dimension: 1024 };
    for (const [index, model] of [replacement, third].entries()) {
      await t.mutation(internal.memoryData.queueReview, {
        ...identity, repository: repo.repository, repositoryCreatedAt: 0, pullRequest: index + 1,
        reviewKind: "full", base: "base", head: "head", publishedAt: index + 1, policyHash: "policy",
        embedding: model, memories: [], memoryAdmission: admission.receipt, idempotencyKey: `queued-${index}`,
      });
    }
    const read = () => t.query(internal.memoryData.getRepository, { repositoryId: repo.repositoryId });
    const firstJob = (await read())?.reembedJob;
    if (!firstJob) throw new Error("Missing first migration");
    await t.action(internal.memoryActions.reembedRepository, { repositoryId: repo.repositoryId, token: firstJob.token });
    await t.mutation(internal.memoryData.releaseAwaitingIngestions, { repositoryId: repo.repositoryId, embedding: replacement });
    const nextJob = (await read())?.reembedJob;
    if (!nextJob) throw new Error("Missing queued second migration");
    expect(await t.mutation(internal.memoryData.startReembed, { repositoryId: repo.repositoryId, token: nextJob.token })).toBeNull();
    const firstIngestion = await t.run((ctx) => ctx.db.query("memoryIngestions")
      .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", "queued-0")).unique());
    if (!firstIngestion) throw new Error("Missing first ingestion");
    await t.action(internal.memoryActions.ingestReview, { ingestionId: firstIngestion._id });
    expect((await t.query(internal.memoryData.getIngestion, { ingestionId: firstIngestion._id }))?.status).toBe("complete");
    await t.action(internal.memoryActions.reembedRepository, { repositoryId: repo.repositoryId, token: nextJob.token });
    await t.mutation(internal.memoryData.releaseAwaitingIngestions, { repositoryId: repo.repositoryId, embedding: third });
    const secondIngestion = await t.run((ctx) => ctx.db.query("memoryIngestions")
      .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", "queued-1")).unique());
    if (!secondIngestion) throw new Error("Missing second ingestion");
    await t.action(internal.memoryActions.ingestReview, { ingestionId: secondIngestion._id });
    expect((await t.query(internal.memoryData.getIngestion, { ingestionId: secondIngestion._id }))?.status).toBe("complete");
    expect((await read())?.activeEmbedding).toEqual(third);
    expect((await read())?.pendingEmbedding).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  } finally { timers.mockRestore(); network.mockRestore(); }
});
