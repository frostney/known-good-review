import { expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";
import { RAG } from "@convex-dev/rag";
import { gateway } from "@ai-sdk/gateway";
import schema from "../convex/schema";
import { components, internal } from "../convex/_generated/api";
import { registerRag } from "./rag-fixture";
import type { NormalizedMemory } from "../src/memory/contracts";

const modules = {
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/memoryAccess.ts": () => import("../convex/memoryAccess"),
  "../convex/memoryData.ts": () => import("../convex/memoryData"),
  "../convex/memoryActions.ts": () => import("../convex/memoryActions"),
};
const embedding = { model: "openai/text-embedding-3-small", dimension: 128 };
const identity = { installationId: 1, repositoryId: "R_embedding" };
const memory: NormalizedMemory = {
  finding: "Requests outlive the caller", invariant: "Cancelled work must stop",
  cause: null, remedy: "Propagate cancellation", category: "QUALITY", severity: "IMPORTANT", outcome: "open",
  provenance: { repositoryId: identity.repositoryId, repository: "acme/embedding", pullRequest: 1,
    base: "base", head: "head-1", path: "src/request.ts", symbol: null, findingId: "CR-1" },
};

test("reuses unchanged text while search reflects current metadata and excludes uncommitted vectors", async () => {
  const priorKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "offline-embedding-fixture";
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
  const requests: string[][] = [];
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (resource: Request | string | URL, init?: RequestInit) => {
    if (!String(resource).endsWith("/embedding-model")) throw new Error("Unexpected fixture request");
    const body = JSON.parse(String(init?.body)) as { values: string[] };
    requests.push(body.values);
    return Response.json({ embeddings: body.values.map(() => [1, ...Array<number>(127).fill(0)]), usage: { tokens: 42 } });
  }, { preconnect: () => {} }));
  try {
    const t = convexTest(schema, modules);
    await registerRag(t);
    const { receipt } = await t.mutation(internal.memoryAccess.captureAdmission, identity);
    if (!receipt) throw new Error("Missing admission");
    let revision = 0;
    const ingest = async (next: NormalizedMemory, requestedEmbedding = embedding) => {
      revision += 1;
      await t.mutation(internal.memoryData.queueReview, {
        ...identity, memoryAdmission: receipt, idempotencyKey: `review-${revision}`,
        repository: memory.provenance.repository, repositoryCreatedAt: 0, pullRequest: 1,
        reviewKind: revision === 1 ? "full" : "delta", base: "base", head: `head-${revision}`,
        publishedAt: revision, policyHash: "policy", embedding: requestedEmbedding, memories: [next],
      });
      const ingestion = await t.run((ctx) => ctx.db.query("memoryIngestions")
        .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", `review-${revision}`)).unique());
      if (!ingestion) throw new Error("Missing ingestion");
      await t.action(internal.memoryActions.ingestReview, { ingestionId: ingestion._id });
      expect((await t.query(internal.memoryData.getIngestion, { ingestionId: ingestion._id }))?.status).toBe("complete");
      const vector = await t.run((ctx) => ctx.db.query("memoryVectors")
        .withIndex("by_repository_id_and_memory_key_and_model_and_dimension", (q) =>
          q.eq("repositoryId", identity.repositoryId).eq("memoryKey", `${identity.repositoryId}:pr:1:finding:CR-1`)
            .eq("embeddingModel", requestedEmbedding.model).eq("embeddingDimension", requestedEmbedding.dimension)).unique());
      if (!vector) throw new Error("Missing vector");
      return vector;
    };
    const first = await ingest(memory);
    expect(requests).toHaveLength(1);
    const updated: NormalizedMemory = {
      ...memory, outcome: "fixed", severity: "IMPROVEMENT",
      provenance: { ...memory.provenance, head: "head-2", path: "src/new-request.ts" },
    };
    const second = await ingest(updated);
    expect(requests).toHaveLength(1);
    expect(second.ragEntryId).toBe(first.ragEntryId);
    // Real RAG retrieval must use current application metadata despite retaining
    // the original entry metadata and embedding.
    const search = () => t.action(internal.memoryActions.searchRepository, {
      repositoryId: identity.repositoryId, embedding, axis: "engineering-quality", query: "cancellation", limit: 8,
    });
    const result = await search();
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({ outcome: "fixed", severity: "IMPROVEMENT", observedAt: 2,
      provenance: { head: "head-2", path: "src/new-request.ts" } });
    expect(requests).toHaveLength(2); // The search query has its own embedding.
    const revised = { ...updated, remedy: "Abort the request and release its response stream" };
    const changed = await ingest(revised);
    expect(changed.ragEntryId).not.toBe(first.ragEntryId);
    expect(requests).toHaveLength(3);
    expect(await t.query(internal.memoryData.searchMemories, {
      repositoryId: identity.repositoryId, embedding,
      entries: [{ memoryKey: first.memoryKey, ragEntryId: first.ragEntryId }],
    })).toEqual([]);
    // Simulate an interrupted action between RAG.add and recordMemory. Search
    // must not surface metadata that the app has never committed.
    const rag = new RAG(components.rag, { textEmbeddingModel: gateway.embedding(embedding.model), embeddingDimension: 128 });
    await t.run(async (ctx) => {
      await rag.add(ctx, { namespace: `github:${identity.repositoryId}`, key: "orphan",
        chunks: [{ text: "orphaned finding", embedding: [1, ...Array<number>(127).fill(0)] }],
        metadata: { ...updated, clusterKey: "a".repeat(64), observedAt: 99 } });
    });
    expect((await search()).memories).toHaveLength(1);
    const replacement = { model: "openai/text-embedding-3-large", dimension: 128 };
    const pending = await t.mutation(internal.memoryData.ensureEmbedding, { repositoryId: identity.repositoryId, embedding: replacement });
    if (!pending?.reembedJob) throw new Error("Missing migration");
    const beforeMigration = requests.length;
    await t.action(internal.memoryActions.reembedRepository, { repositoryId: identity.repositoryId, token: pending.reembedJob.token });
    expect(requests).toHaveLength(beforeMigration + 1);
    const migrated = await ingest({ ...revised, outcome: "deferred" }, replacement);
    expect(requests).toHaveLength(beforeMigration + 1);
    expect(migrated.ragEntryId).not.toBe(changed.ragEntryId);
    expect(await t.query(internal.memoryData.searchMemories, {
      repositoryId: identity.repositoryId, embedding,
      entries: [{ memoryKey: changed.memoryKey, ragEntryId: changed.ragEntryId }],
    })).toEqual([]);
    const repository = await t.query(internal.memoryData.getRepository, { repositoryId: identity.repositoryId });
    if (!repository) throw new Error("Missing repository");
    await t.run((ctx) => ctx.db.patch(repository._id, { deleting: true }));
    expect(await t.query(internal.memoryData.searchMemories, {
      repositoryId: identity.repositoryId, embedding: replacement,
      entries: [{ memoryKey: migrated.memoryKey, ragEntryId: migrated.ragEntryId }],
    })).toEqual([]);
  } finally {
    timers.mockRestore(); network.mockRestore();
    if (priorKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = priorKey;
  }
});
