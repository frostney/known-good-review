import { expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = {
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/memoryAccess.ts": () => import("../convex/memoryAccess"),
  "../convex/memoryData.ts": () => import("../convex/memoryData"),
};
const identity = { installationId: 1, repositoryId: "R_delete" };
const review = {
  ...identity, repository: "acme/delete", repositoryCreatedAt: 0, pullRequest: 1,
  reviewKind: "full" as const, base: "base", head: "head", policyHash: "policy",
  embedding: { model: "openai/text-embedding-3-small", dimension: 1536 },
  memories: [], idempotencyKey: "review", publishedAt: 1,
};
const removal = { installationId: 1, repositoryIds: [identity.repositoryId], deliveryId: "removal-1" };

test("revokes delayed ingestion after cleanup and preserves a fresh admission through webhook redelivery", async () => {
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
  try {
    const t = convexTest(schema, modules);
    const old = await t.mutation(internal.memoryAccess.captureAdmission, identity);
    if (!old.receipt) throw new Error("Missing initial admission");
    const queued = { ...review, memoryAdmission: old.receipt };
    expect(await t.mutation(internal.memoryData.queueReview, queued)).toMatchObject({ accepted: true });
    const repository = await t.query(internal.memoryData.getRepository, { repositoryId: identity.repositoryId });
    if (!repository) throw new Error("Missing repository");
    await t.mutation(internal.memoryData.beginRepositoriesDeletion, removal);
    const deletion = { repositoryId: identity.repositoryId, repositoryRecordId: repository._id };
    const watchdogs = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => job.name === "memoryData:resumeDeletion"));
    expect(await watchdogs()).toHaveLength(1);
    await t.mutation(internal.memoryData.resolveDeletion, deletion);
    expect(await watchdogs()).toHaveLength(1);
    await t.mutation(internal.memoryData.resumeDeletion, deletion);
    expect(await watchdogs()).toHaveLength(2);
    expect(await t.mutation(internal.memoryData.deleteRepositoryRows, deletion)).toBe(false);
    expect(await t.mutation(internal.memoryData.deleteRepositoryRows, deletion)).toBe(true);
    expect(await t.query(internal.memoryData.getRepository, { repositoryId: identity.repositoryId })).toBeNull();
    expect(await t.mutation(internal.memoryData.queueReview, queued)).toEqual({ accepted: false, status: "revoked" });
    const fresh = await t.mutation(internal.memoryAccess.captureAdmission, identity);
    if (!fresh.receipt) throw new Error("Missing fresh admission");
    expect(fresh.receipt).not.toBe(old.receipt);
    expect(await t.mutation(internal.memoryData.queueReview, { ...review, memoryAdmission: fresh.receipt })).toMatchObject({ accepted: true });
    const replacement = await t.query(internal.memoryData.getRepository, { repositoryId: identity.repositoryId });
    expect(replacement?._id).not.toBe(repository._id);
    await t.mutation(internal.memoryData.beginRepositoriesDeletion, removal);
    expect(await t.mutation(internal.memoryAccess.captureAdmission, identity)).toEqual(fresh);
    expect(replacement?.deleting).toBe(false);
    if (!replacement) throw new Error("Missing replacement repository");
    // Even if a later removal starts, the old worker cannot skip that record's
    // active-work drain and delete its pending ingestion rows.
    await t.run((ctx) => ctx.db.patch(replacement._id, { deleting: true }));
    expect(await t.mutation(internal.memoryData.resolveDeletion, deletion)).toBeNull();
    expect(await t.query(internal.memoryData.listDeletionNamespaces, deletion)).toBeNull();
    expect(await t.mutation(internal.memoryData.deleteRepositoryRows, deletion)).toBe(true);
    await t.mutation(internal.memoryData.resumeDeletion, deletion);
    expect(await t.query(internal.memoryData.getRepository, { repositoryId: identity.repositoryId }))
      .toMatchObject({ _id: replacement._id, deleting: true });
    expect(await t.run((ctx) => ctx.db.query("memoryIngestions").first())).not.toBeNull();
  } finally { timers.mockRestore(); }
});

test("removal covers reviews registered before their first ingestion and allows later re-addition", async () => {
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
  try {
    const t = convexTest(schema, modules);
    const old = await t.mutation(internal.memoryAccess.captureAdmission, identity);
    if (!old.receipt) throw new Error("Missing initial admission");
    await t.mutation(internal.memoryData.reconcileInstallationRepositories, {
      installationId: 1, deliveryId: "remove-all-repositories", retainedRepositoryIds: [], uninstalled: false, phase: "access", cursor: null,
    });
    expect(await t.mutation(internal.memoryData.queueReview, { ...review, memoryAdmission: old.receipt })).toMatchObject({ status: "revoked" });
    const fresh = await t.mutation(internal.memoryAccess.captureAdmission, identity);
    if (!fresh.receipt) throw new Error("Repository re-add must remain possible");
    expect(await t.mutation(internal.memoryData.queueReview, { ...review, memoryAdmission: fresh.receipt })).toMatchObject({ accepted: true });
    await t.mutation(internal.memoryData.reconcileInstallationRepositories, {
      installationId: 1, deliveryId: "uninstall", retainedRepositoryIds: [], uninstalled: true, phase: "access", cursor: null,
    });
    expect(await t.mutation(internal.memoryAccess.captureAdmission, identity)).toEqual({ receipt: null });
    expect(await t.mutation(internal.memoryAccess.captureAdmission, { ...identity, repositoryId: "R_first_seen_after_uninstall" }))
      .toEqual({ receipt: null });
    expect(await t.mutation(internal.memoryData.queueReview, { ...review, memoryAdmission: fresh.receipt, idempotencyKey: "late" }))
      .toMatchObject({ status: "revoked" });
    expect((await t.mutation(internal.memoryAccess.captureAdmission, { ...identity, installationId: 2 })).receipt).not.toBeNull();
  } finally { timers.mockRestore(); }
});

test("a new installation cannot inherit old memory or let old cleanup delete its replacement", async () => {
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
  try {
    const t = convexTest(schema, modules);
    const old = await t.mutation(internal.memoryAccess.captureAdmission, identity);
    const fresh = await t.mutation(internal.memoryAccess.captureAdmission, { ...identity, installationId: 2 });
    if (!old.receipt || !fresh.receipt) throw new Error("Missing admissions");
    await t.mutation(internal.memoryData.queueReview, { ...review, memoryAdmission: old.receipt });
    const repository = await t.query(internal.memoryData.getRepository, { repositoryId: identity.repositoryId });
    if (!repository) throw new Error("Missing old repository");
    const replacement = { ...review, installationId: 2, memoryAdmission: fresh.receipt };
    expect(await t.mutation(internal.memoryData.queueReview, replacement)).toMatchObject({ status: "revoked" });
    const deletion = { repositoryId: identity.repositoryId, repositoryRecordId: repository._id };
    for (let index = 0; index < 3; index++) if (await t.mutation(internal.memoryData.deleteRepositoryRows, deletion)) break;
    expect(await t.mutation(internal.memoryData.queueReview, replacement)).toMatchObject({ accepted: true });
    expect(await t.mutation(internal.memoryData.queueReview, { ...review, memoryAdmission: old.receipt })).toMatchObject({ status: "revoked" });
    await t.mutation(internal.memoryData.beginRepositoriesDeletion, removal);
    expect(await t.query(internal.memoryData.getRepository, { repositoryId: identity.repositoryId }))
      .toMatchObject({ installationId: 2, deleting: false });
  } finally { timers.mockRestore(); }
});

test("deletes orphan RAG entries and all namespace versions through the installed component", async () => {
  const { registerRag } = await import("./rag-fixture");
  const { RAG } = await import("@convex-dev/rag");
  const { gateway } = await import("@ai-sdk/gateway");
  const { components } = await import("../convex/_generated/api");
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("Embedding calls are forbidden in this offline test"); }, { preconnect: () => {} }));
  try {
    const t = convexTest(schema, { ...modules, "../convex/memoryActions.ts": () => import("../convex/memoryActions") });
    await registerRag(t);
    const admission = await t.mutation(internal.memoryAccess.captureAdmission, identity);
    if (!admission.receipt) throw new Error("Missing admission");
    await t.mutation(internal.memoryData.queueReview, { ...review, memoryAdmission: admission.receipt });
    const namespace = `github:${identity.repositoryId}`;
    for (const dimension of [128, 256]) {
      const rag = new RAG(components.rag, { textEmbeddingModel: gateway.embedding("openai/text-embedding-3-small"), embeddingDimension: dimension });
      await t.action((ctx) => rag.add(ctx, {
        namespace, key: "orphan", title: "Interrupted application write",
        chunks: [{ text: "orphan fixture", embedding: Array.from({ length: dimension }, () => 1 / Math.sqrt(dimension)) }],
      }));
    }
    const namespaces = () => t.run((ctx) => ctx.runQuery(components.rag.namespaces.listNamespaceVersions, {
      namespace, paginationOpts: { cursor: null, numItems: 10 },
    }));
    expect((await namespaces()).page).toHaveLength(2);
    expect(await t.run((ctx) => ctx.db.query("memoryVectors").first())).toBeNull();
    await t.mutation(internal.memoryData.beginRepositoriesDeletion, removal);
    for (let index = 0; index < 4; index++) await t.action(internal.memoryActions.deleteRepository, { repositoryId: identity.repositoryId });
    expect((await namespaces()).page).toHaveLength(0);
    expect(await t.query(internal.memoryData.getRepository, { repositoryId: identity.repositoryId })).toBeNull();
    expect(network).not.toHaveBeenCalled();
  } finally { timers.mockRestore(); network.mockRestore(); }
});
