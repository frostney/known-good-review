import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import {
  vEmbedding,
  vMemoryClusterDoc,
  vMemoryEntryDoc,
  vMemoryIngestionDoc,
  vMemoryVectorDoc,
  vNormalizedMemory,
  vRepositoryMemoryDoc,
  vReviewKind,
} from "./validators";

function reviewDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function repositoryById(ctx: MutationCtx, repositoryId: string) {
  return ctx.db
    .query("repositoryMemory")
    .withIndex("by_repository_id", (query) =>
      query.eq("repositoryId", repositoryId),
    )
    .unique();
}

export const queueReview = internalMutation({
  args: {
    idempotencyKey: v.string(),
    installationId: v.number(),
    repositoryId: v.string(),
    repository: v.string(),
    repositoryCreatedAt: v.number(),
    pullRequest: v.number(),
    reviewKind: vReviewKind,
    base: v.string(),
    head: v.string(),
    publishedAt: v.number(),
    policyHash: v.string(),
    embedding: vEmbedding,
    memories: v.array(vNormalizedMemory),
  },
  returns: v.object({
    accepted: v.boolean(),
    status: v.union(v.literal("pending"), v.literal("awaiting_reembed")),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    accepted: boolean;
    status: "pending" | "awaiting_reembed";
  }> => {
    const existing = await ctx.db
      .query("memoryIngestions")
      .withIndex("by_idempotency_key", (query) =>
        query.eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing) {
      return {
        accepted: false,
        status:
          existing.status === "awaiting_reembed"
            ? "awaiting_reembed"
            : "pending",
      };
    }

    const current = await repositoryById(ctx, args.repositoryId);
    if (current?.deleting) {
      throw new Error("Repository memory is being deleted");
    }
    const embeddingChanged =
      current !== null &&
      (current.activeEmbedding.model !== args.embedding.model ||
        current.activeEmbedding.dimension !== args.embedding.dimension);
    const shouldStartReembed = embeddingChanged && !current?.pendingEmbedding;
    const status: "awaiting_reembed" | "pending" = embeddingChanged
      ? "awaiting_reembed"
      : "pending";
    const ingestionId = await ctx.db.insert("memoryIngestions", {
      ...args,
      status,
      attempts: 0,
    });

    const day = reviewDay(args.publishedAt);
    const existingDay = await ctx.db
      .query("repositoryReviewDays")
      .withIndex("by_repository_id_and_day", (query) =>
        query.eq("repositoryId", args.repositoryId).eq("day", day),
      )
      .unique();
    const newDay = existingDay === null;
    if (newDay) {
      await ctx.db.insert("repositoryReviewDays", {
        repositoryId: args.repositoryId,
        day,
      });
    }

    if (current) {
      const recentReviewTimes = [
        args.publishedAt,
        ...current.recentReviewTimes,
      ]
        .sort((left, right) => right - left)
        .slice(0, 20);
      await ctx.db.patch(current._id, {
        installationId: args.installationId,
        repository: args.repository,
        completedReviews: current.completedReviews + 1,
        reviewDays: current.reviewDays + (newDay ? 1 : 0),
        firstReviewAt: Math.min(current.firstReviewAt, args.publishedAt),
        lastReviewAt: Math.max(current.lastReviewAt, args.publishedAt),
        recentReviewTimes,
        policyHash: args.policyHash,
        ...(shouldStartReembed
          ? { pendingEmbedding: args.embedding }
          : {}),
      });
    } else {
      await ctx.db.insert("repositoryMemory", {
        installationId: args.installationId,
        repositoryId: args.repositoryId,
        repository: args.repository,
        repositoryCreatedAt: args.repositoryCreatedAt,
        completedReviews: 1,
        reviewDays: 1,
        firstReviewAt: args.publishedAt,
        lastReviewAt: args.publishedAt,
        recentReviewTimes: [args.publishedAt],
        activeEmbedding: args.embedding,
        policyHash: args.policyHash,
        deleting: false,
      });
    }

    if (shouldStartReembed) {
      await ctx.scheduler.runAfter(0, internal.memoryActions.reembedRepository, {
        attempt: 0,
        repositoryId: args.repositoryId,
        cursor: null,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.memoryActions.ingestReview, {
        ingestionId,
      });
    }
    return { accepted: true, status };
  },
});

export const getIngestion = internalQuery({
  args: { ingestionId: v.id("memoryIngestions") },
  returns: v.union(v.null(), vMemoryIngestionDoc),
  handler: (ctx, args) => ctx.db.get(args.ingestionId),
});

export const memoryClusterSeed = internalQuery({
  args: { repositoryId: v.string(), memoryKey: v.string() },
  returns: v.object({
    existingClusterKey: v.union(v.string(), v.null()),
    hasEntries: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("memoryEntries")
      .withIndex("by_memory_key", (query) =>
        query.eq("memoryKey", args.memoryKey),
      )
      .unique();
    if (existing) {
      return { existingClusterKey: existing.clusterKey, hasEntries: true };
    }
    const first = await ctx.db
      .query("memoryEntries")
      .withIndex("by_repository_id_and_observed_at", (query) =>
        query.eq("repositoryId", args.repositoryId),
      )
      .first();
    return { existingClusterKey: null, hasEntries: first !== null };
  },
});

export const startIngestion = internalMutation({
  args: { ingestionId: v.id("memoryIngestions") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const ingestion = await ctx.db.get(args.ingestionId);
    if (!ingestion || ingestion.status === "complete" || ingestion.status === "failed") {
      return false;
    }
    if (ingestion.status === "awaiting_reembed") return false;
    const repository = await repositoryById(ctx, ingestion.repositoryId);
    if (!repository || repository.deleting) return false;
    await ctx.db.patch(args.ingestionId, {
      status: "processing",
      attempts: ingestion.attempts + 1,
      lastFailureCode: undefined,
    });
    return true;
  },
});

export const completeIngestion = internalMutation({
  args: { ingestionId: v.id("memoryIngestions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ingestion = await ctx.db.get(args.ingestionId);
    if (ingestion) {
      await ctx.db.patch(args.ingestionId, {
        status: "complete",
        lastFailureCode: undefined,
      });
    }
    return null;
  },
});

export const retryIngestion = internalMutation({
  args: {
    ingestionId: v.id("memoryIngestions"),
    failureCode: v.string(),
  },
  returns: v.union(v.literal("retrying"), v.literal("failed")),
  handler: async (ctx, args) => {
    const ingestion = await ctx.db.get(args.ingestionId);
    if (!ingestion) return "failed";
    if (ingestion.attempts >= 5) {
      await ctx.db.patch(args.ingestionId, {
        status: "failed",
        lastFailureCode: args.failureCode,
      });
      return "failed";
    }
    await ctx.db.patch(args.ingestionId, {
      status: "pending",
      lastFailureCode: args.failureCode,
    });
    await ctx.scheduler.runAfter(
      Math.min(60_000, 2 ** ingestion.attempts * 1_000),
      internal.memoryActions.ingestReview,
      { ingestionId: args.ingestionId },
    );
    return "retrying";
  },
});

export const recordMemory = internalMutation({
  args: {
    memoryKey: v.string(),
    clusterKey: v.string(),
    ingestionId: v.id("memoryIngestions"),
    ragEntryId: v.string(),
    embedding: vEmbedding,
    memory: vNormalizedMemory,
    observedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ingestion = await ctx.db.get(args.ingestionId);
    if (!ingestion) throw new Error("Memory ingestion no longer exists");
    const existing = await ctx.db
      .query("memoryEntries")
      .withIndex("by_memory_key", (query) =>
        query.eq("memoryKey", args.memoryKey),
      )
      .unique();
    const memoryFields = {
      memoryKey: args.memoryKey,
      clusterKey: args.clusterKey,
      repositoryId: ingestion.repositoryId,
      pullRequest: ingestion.pullRequest,
      observedAt: args.observedAt,
      finding: args.memory.finding,
      invariant: args.memory.invariant,
      cause: args.memory.cause,
      remedy: args.memory.remedy,
      outcome: args.memory.outcome,
      severity: args.memory.severity,
      category: args.memory.category,
      provenance: args.memory.provenance,
    };
    const movedClusters =
      existing !== null && existing.clusterKey !== args.clusterKey;
    if (movedClusters) {
      const oldMembership = await ctx.db
        .query("memoryClusterPullRequests")
        .withIndex(
          "by_repository_id_and_cluster_key_and_pull_request",
          (query) =>
            query
              .eq("repositoryId", ingestion.repositoryId)
              .eq("clusterKey", existing.clusterKey)
              .eq("pullRequest", ingestion.pullRequest),
        )
        .unique();
      const otherOldEntries = await ctx.db
        .query("memoryEntries")
        .withIndex(
          "by_repository_id_and_cluster_key_and_pull_request",
          (query) =>
            query
              .eq("repositoryId", ingestion.repositoryId)
              .eq("clusterKey", existing.clusterKey)
              .eq("pullRequest", ingestion.pullRequest),
        )
        .take(2);
      const oldCluster = await ctx.db
        .query("memoryClusters")
        .withIndex("by_repository_id_and_cluster_key", (query) =>
          query
            .eq("repositoryId", ingestion.repositoryId)
            .eq("clusterKey", existing.clusterKey),
        )
        .unique();
      const hasOtherOldEntry = otherOldEntries.some(
        (entry) => entry._id !== existing._id,
      );
      if (!hasOtherOldEntry && oldMembership) {
        await ctx.db.delete(oldMembership._id);
      }
      if (oldCluster) {
        const totalOccurrences = Math.max(
          0,
          oldCluster.totalOccurrences - 1,
        );
        const distinctPullRequests = Math.max(
          0,
          oldCluster.distinctPullRequests -
            (!hasOtherOldEntry && oldMembership ? 1 : 0),
        );
        if (totalOccurrences === 0) {
          await ctx.db.delete(oldCluster._id);
        } else {
          await ctx.db.patch(oldCluster._id, {
            distinctPullRequests,
            totalOccurrences,
          });
        }
      }
    }
    if (existing) {
      await ctx.db.replace(existing._id, memoryFields);
    } else {
      await ctx.db.insert("memoryEntries", memoryFields);
    }
    await upsertVector(ctx, {
      repositoryId: ingestion.repositoryId,
      memoryKey: args.memoryKey,
      embedding: args.embedding,
      ragEntryId: args.ragEntryId,
    });

    const cluster = await ctx.db
      .query("memoryClusters")
      .withIndex("by_repository_id_and_cluster_key", (query) =>
        query
          .eq("repositoryId", ingestion.repositoryId)
          .eq("clusterKey", args.clusterKey),
      )
      .unique();
    const clusterPullRequest = await ctx.db
      .query("memoryClusterPullRequests")
      .withIndex(
        "by_repository_id_and_cluster_key_and_pull_request",
        (query) =>
          query
            .eq("repositoryId", ingestion.repositoryId)
            .eq("clusterKey", args.clusterKey)
            .eq("pullRequest", ingestion.pullRequest),
      )
      .unique();
    if (!clusterPullRequest) {
      await ctx.db.insert("memoryClusterPullRequests", {
        repositoryId: ingestion.repositoryId,
        clusterKey: args.clusterKey,
        pullRequest: ingestion.pullRequest,
      });
    }
    if (cluster) {
      await ctx.db.patch(cluster._id, {
        distinctPullRequests:
          cluster.distinctPullRequests + (clusterPullRequest ? 0 : 1),
        totalOccurrences:
          cluster.totalOccurrences + (!existing || movedClusters ? 1 : 0),
        lastSeenAt: Math.max(cluster.lastSeenAt, args.observedAt),
        severity: args.memory.severity,
        status: args.memory.outcome,
      });
    } else {
      await ctx.db.insert("memoryClusters", {
        repositoryId: ingestion.repositoryId,
        clusterKey: args.clusterKey,
        distinctPullRequests: 1,
        totalOccurrences: 1,
        lastSeenAt: args.observedAt,
        severity: args.memory.severity,
        status: args.memory.outcome,
      });
    }
    return null;
  },
});

async function upsertVector(
  ctx: MutationCtx,
  input: {
    readonly repositoryId: string;
    readonly memoryKey: string;
    readonly embedding: { readonly model: string; readonly dimension: number };
    readonly ragEntryId: string;
  },
): Promise<void> {
  const vector = await ctx.db
    .query("memoryVectors")
    .withIndex(
      "by_repository_id_and_memory_key_and_model_and_dimension",
      (query) =>
        query
          .eq("repositoryId", input.repositoryId)
          .eq("memoryKey", input.memoryKey)
          .eq("embeddingModel", input.embedding.model)
          .eq("embeddingDimension", input.embedding.dimension),
    )
    .unique();
  const fields = {
    repositoryId: input.repositoryId,
    memoryKey: input.memoryKey,
    embeddingModel: input.embedding.model,
    embeddingDimension: input.embedding.dimension,
    ragEntryId: input.ragEntryId,
  };
  if (vector) await ctx.db.replace(vector._id, fields);
  else await ctx.db.insert("memoryVectors", fields);
}

export const recordVectorCopy = internalMutation({
  args: {
    repositoryId: v.string(),
    memoryKey: v.string(),
    embedding: vEmbedding,
    ragEntryId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await upsertVector(ctx, args);
    return null;
  },
});

export const ensureEmbedding = internalMutation({
  args: { repositoryId: v.string(), embedding: vEmbedding },
  returns: v.union(v.null(), vRepositoryMemoryDoc),
  handler: async (ctx, args) => {
    const repository = await repositoryById(ctx, args.repositoryId);
    if (!repository) return null;
    if (repository.deleting) return repository;
    const differs =
      repository.activeEmbedding.model !== args.embedding.model ||
      repository.activeEmbedding.dimension !== args.embedding.dimension;
    if (differs && !repository.pendingEmbedding) {
      await ctx.db.patch(repository._id, { pendingEmbedding: args.embedding });
      await ctx.scheduler.runAfter(0, internal.memoryActions.reembedRepository, {
        attempt: 0,
        repositoryId: args.repositoryId,
        cursor: null,
      });
      return { ...repository, pendingEmbedding: args.embedding };
    }
    return repository;
  },
});

export const getRepository = internalQuery({
  args: { repositoryId: v.string() },
  returns: v.union(v.null(), vRepositoryMemoryDoc),
  handler: (ctx, args) =>
    ctx.db
      .query("repositoryMemory")
      .withIndex("by_repository_id", (query) =>
        query.eq("repositoryId", args.repositoryId),
      )
      .unique(),
});

export const listMemoryEntries = internalQuery({
  args: {
    repositoryId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(vMemoryEntryDoc),
  handler: (ctx, args) =>
    ctx.db
      .query("memoryEntries")
      .withIndex("by_repository_id_and_observed_at", (query) =>
        query.eq("repositoryId", args.repositoryId),
      )
      .paginate(args.paginationOpts),
});

export const clustersByKeys = internalQuery({
  args: { repositoryId: v.string(), clusterKeys: v.array(v.string()) },
  returns: v.array(vMemoryClusterDoc),
  handler: async (ctx, args) => {
    const clusters: Doc<"memoryClusters">[] = [];
    for (const clusterKey of args.clusterKeys.slice(0, 32)) {
      const cluster = await ctx.db
        .query("memoryClusters")
        .withIndex("by_repository_id_and_cluster_key", (query) =>
          query
            .eq("repositoryId", args.repositoryId)
            .eq("clusterKey", clusterKey),
        )
        .unique();
      if (cluster) clusters.push(cluster);
    }
    return clusters;
  },
});

export const completeReembed = internalMutation({
  args: { repositoryId: v.string(), embedding: vEmbedding },
  returns: v.null(),
  handler: async (ctx, args) => {
    const repository = await repositoryById(ctx, args.repositoryId);
    if (!repository) return null;
    if (
      repository.pendingEmbedding?.model !== args.embedding.model ||
      repository.pendingEmbedding.dimension !== args.embedding.dimension
    ) {
      return null;
    }
    await ctx.db.patch(repository._id, {
      activeEmbedding: args.embedding,
      pendingEmbedding: undefined,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.memoryData.releaseAwaitingIngestions,
      args,
    );
    return null;
  },
});

export const recordReembedFailure = internalMutation({
  args: {
    repositoryId: v.string(),
    embedding: vEmbedding,
    failureCode: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const repository = await repositoryById(ctx, args.repositoryId);
    if (
      repository?.pendingEmbedding?.model === args.embedding.model &&
      repository.pendingEmbedding.dimension === args.embedding.dimension
    ) {
      await ctx.db.patch(repository._id, { pendingEmbedding: undefined });
    }
    const waiting = await ctx.db
      .query("memoryIngestions")
      .withIndex("by_repository_id_and_status_and_embedding", (query) =>
        query
          .eq("repositoryId", args.repositoryId)
          .eq("status", "awaiting_reembed")
          .eq("embedding.model", args.embedding.model)
          .eq("embedding.dimension", args.embedding.dimension),
      )
      .take(100);
    for (const ingestion of waiting) {
      await ctx.db.patch(ingestion._id, {
        lastFailureCode: `reembed:${args.failureCode}`,
      });
    }
    return null;
  },
});

export const cancelReembedForDeletion = internalMutation({
  args: { repositoryId: v.string(), embedding: vEmbedding },
  returns: v.null(),
  handler: async (ctx, args) => {
    const repository = await repositoryById(ctx, args.repositoryId);
    if (
      repository?.deleting &&
      repository.pendingEmbedding?.model === args.embedding.model &&
      repository.pendingEmbedding.dimension === args.embedding.dimension
    ) {
      await ctx.db.patch(repository._id, { pendingEmbedding: undefined });
    }
    return null;
  },
});

export const releaseAwaitingIngestions = internalMutation({
  args: { repositoryId: v.string(), embedding: vEmbedding },
  returns: v.null(),
  handler: async (ctx, args) => {
    const waiting = await ctx.db
      .query("memoryIngestions")
      .withIndex("by_repository_id_and_status_and_embedding", (query) =>
        query
          .eq("repositoryId", args.repositoryId)
          .eq("status", "awaiting_reembed")
          .eq("embedding.model", args.embedding.model)
          .eq("embedding.dimension", args.embedding.dimension),
      )
      .take(100);
    for (const ingestion of waiting) {
      await ctx.db.patch(ingestion._id, { status: "pending" });
      await ctx.scheduler.runAfter(0, internal.memoryActions.ingestReview, {
        ingestionId: ingestion._id,
      });
    }
    if (waiting.length === 100) {
      await ctx.scheduler.runAfter(
        0,
        internal.memoryData.releaseAwaitingIngestions,
        args,
      );
      return null;
    }
    const next = await ctx.db
      .query("memoryIngestions")
      .withIndex("by_repository_id_and_status", (query) =>
        query
          .eq("repositoryId", args.repositoryId)
          .eq("status", "awaiting_reembed"),
      )
      .first();
    const repository = await repositoryById(ctx, args.repositoryId);
    if (
      next &&
      repository &&
      !repository.deleting &&
      !repository.pendingEmbedding
    ) {
      await ctx.db.patch(repository._id, {
        pendingEmbedding: next.embedding,
      });
      await ctx.scheduler.runAfter(0, internal.memoryActions.reembedRepository, {
        attempt: 0,
        repositoryId: args.repositoryId,
        cursor: null,
      });
    }
    return null;
  },
});

async function beginRepositoryDeletion(
  ctx: MutationCtx,
  repositoryId: string,
): Promise<void> {
  const repository = await repositoryById(ctx, repositoryId);
  if (!repository || repository.deleting) return;
  await ctx.db.patch(repository._id, { deleting: true });
  await ctx.scheduler.runAfter(0, internal.memoryActions.deleteRepository, {
    repositoryId,
  });
}

export const beginRepositoriesDeletion = internalMutation({
  args: { repositoryIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const repositoryId of new Set(args.repositoryIds)) {
      await beginRepositoryDeletion(ctx, repositoryId);
    }
    return null;
  },
});

export const reconcileInstallationRepositories = internalMutation({
  args: {
    installationId: v.number(),
    retainedRepositoryIds: v.array(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const retained = new Set(args.retainedRepositoryIds);
    const page = await ctx.db
      .query("repositoryMemory")
      .withIndex("by_installation_id", (query) =>
        query.eq("installationId", args.installationId),
      )
      .paginate({ cursor: args.cursor, numItems: 50 });
    for (const repository of page.page) {
      if (!retained.has(repository.repositoryId)) {
        await beginRepositoryDeletion(ctx, repository.repositoryId);
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.memoryData.reconcileInstallationRepositories,
        { ...args, cursor: page.continueCursor },
      );
    }
    return null;
  },
});

export const listRepositoryVectors = internalQuery({
  args: { repositoryId: v.string() },
  returns: v.array(vMemoryVectorDoc),
  handler: (ctx, args) =>
    ctx.db
      .query("memoryVectors")
      .withIndex("by_repository_id", (query) =>
        query.eq("repositoryId", args.repositoryId),
      )
      .take(50),
});

export const repositoryHasActiveMemoryWork = internalQuery({
  args: { repositoryId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const repository = await ctx.db
      .query("repositoryMemory")
      .withIndex("by_repository_id", (query) =>
        query.eq("repositoryId", args.repositoryId),
      )
      .unique();
    if (repository?.pendingEmbedding) return true;
    return (await ctx.db
      .query("memoryIngestions")
      .withIndex("by_repository_id_and_status", (query) =>
        query
          .eq("repositoryId", args.repositoryId)
          .eq("status", "processing"),
      )
      .first()) !== null;
  },
});

export const deleteVectorRows = internalMutation({
  args: { ids: v.array(v.id("memoryVectors")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const id of args.ids) await ctx.db.delete(id);
    return null;
  },
});

export const deleteRepositoryRows = internalMutation({
  args: { repositoryId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const memoryEntries = await ctx.db
      .query("memoryEntries")
      .withIndex("by_repository_id_and_observed_at", (query) =>
        query.eq("repositoryId", args.repositoryId),
      )
      .take(50);
    const memoryClusters = await ctx.db
      .query("memoryClusters")
      .withIndex("by_repository_id_and_cluster_key", (query) =>
        query.eq("repositoryId", args.repositoryId),
      )
      .take(50);
    const clusterPullRequests = await ctx.db
      .query("memoryClusterPullRequests")
      .withIndex(
        "by_repository_id_and_cluster_key_and_pull_request",
        (query) => query.eq("repositoryId", args.repositoryId),
      )
      .take(50);
    const ingestions = await ctx.db
      .query("memoryIngestions")
      .withIndex("by_repository_id_and_published_at", (query) =>
        query.eq("repositoryId", args.repositoryId),
      )
      .take(50);
    const reviewDays = await ctx.db
      .query("repositoryReviewDays")
      .withIndex("by_repository_id_and_day", (query) =>
        query.eq("repositoryId", args.repositoryId),
      )
      .take(50);
    for (const document of memoryEntries) await ctx.db.delete(document._id);
    for (const document of memoryClusters) await ctx.db.delete(document._id);
    for (const document of clusterPullRequests) {
      await ctx.db.delete(document._id);
    }
    for (const document of ingestions) await ctx.db.delete(document._id);
    for (const document of reviewDays) await ctx.db.delete(document._id);
    const deleted =
      memoryEntries.length +
      memoryClusters.length +
      clusterPullRequests.length +
      ingestions.length +
      reviewDays.length;
    if (deleted === 0) {
      const repository = await repositoryById(ctx, args.repositoryId);
      if (repository) await ctx.db.delete(repository._id);
      return true;
    }
    return false;
  },
});
