import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { admissionIsCurrent, revokeRepositoryAdmission, installationRemoved } from "./memoryAccess";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  vEmbedding,
  vMemoryClusterDoc,
  vMemoryEntryDoc,
  vMemoryIngestionDoc,
  vNormalizedMemory,
  vRepositoryMemoryDoc,
  vReviewKind,
} from "./validators";

function reviewDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

const ingestionTimeoutMs = 11 * 60_000;

async function processingIngestion(ctx: MutationCtx, repositoryId: string) {
  const ingestion = await ctx.db.query("memoryIngestions")
    .withIndex("by_repository_id_and_status", (query) =>
      query.eq("repositoryId", repositoryId).eq("status", "processing"))
    .first();
  if (ingestion && ingestion.processingStartedAt === undefined) {
    // Older deployments did not record start times. Grant one full action
    // lifetime before expiring their work; repeated polls must not renew it.
    await ctx.db.patch(ingestion._id, { processingStartedAt: Date.now() });
    await ctx.scheduler.runAfter(ingestionTimeoutMs, internal.memoryData.expireIngestion, {
      ingestionId: ingestion._id, attempt: ingestion.attempts,
    });
  }
  return ingestion;
}

async function repositoryById(ctx: QueryCtx, repositoryId: string) {
  return ctx.db
    .query("repositoryMemory")
    .withIndex("by_repository_id", (query) =>
      query.eq("repositoryId", repositoryId),
    )
    .unique();
}

async function scheduleReembed(
  ctx: MutationCtx,
  repository: Doc<"repositoryMemory">,
  embedding: Doc<"repositoryMemory">["activeEmbedding"],
  cursor: string | null = null,
  attempt = 0,
) {
  const generation = (repository.reembedGeneration ?? 0) + 1;
  const job = { token: `${repository._id}:${generation}`, cursor, attempt };
  await ctx.db.patch(repository._id, {
    pendingEmbedding: embedding, reembedGeneration: generation, reembedJob: job,
  });
  await ctx.scheduler.runAfter(attempt === 0 ? 0 : Math.min(60_000, 2 ** attempt * 1_000),
    internal.memoryActions.reembedRepository, { repositoryId: repository.repositoryId, token: job.token });
}

export const queueReview = internalMutation({
  args: {
    idempotencyKey: v.string(),
    memoryAdmission: v.string(),
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
    status: v.union(v.literal("pending"), v.literal("awaiting_reembed"), v.literal("revoked")),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    accepted: boolean;
    status: "pending" | "awaiting_reembed" | "revoked";
  }> => {
    if (!await admissionIsCurrent(ctx, args)) return { accepted: false, status: "revoked" };
    const current = await repositoryById(ctx, args.repositoryId);
    if (current?.deleting) return { accepted: false, status: "revoked" };
    if (current && current.installationId !== args.installationId) {
      await revokeRepositoryAdmission(ctx, {
        installationId: current.installationId, repositoryId: args.repositoryId,
        deliveryId: `replacement:${args.installationId}`,
      });
      await beginRepositoryDeletion(ctx, current.installationId, args.repositoryId);
      return { accepted: false, status: "revoked" };
    }
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

    if (current?.pendingEmbedding && !current.reembedJob) {
      await scheduleReembed(ctx, current, current.pendingEmbedding);
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
      if (current) await scheduleReembed(ctx, current, args.embedding);
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
    observedAt: v.union(v.number(), v.null()),
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
      return { existingClusterKey: existing.clusterKey, observedAt: existing.observedAt, hasEntries: true };
    }
    const first = await ctx.db
      .query("memoryEntries")
      .withIndex("by_repository_id_and_observed_at", (query) =>
        query.eq("repositoryId", args.repositoryId),
      )
      .first();
    return { existingClusterKey: null, observedAt: null, hasEntries: first !== null };
  },
});

export const startIngestion = internalMutation({
  args: { ingestionId: v.id("memoryIngestions") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const ingestion = await ctx.db.get(args.ingestionId);
    if (!ingestion || ingestion.status !== "pending") {
      return false;
    }
    const repository = await repositoryById(ctx, ingestion.repositoryId);
    if (!repository || repository.deleting || await installationRemoved(ctx, repository.installationId)) return false;
    const processing = await processingIngestion(ctx, ingestion.repositoryId);
    if (processing || repository.reembedJob?.startedAt !== undefined) {
      await ctx.scheduler.runAfter(1_000, internal.memoryActions.ingestReview, args);
      return false;
    }
    if (repository.activeEmbedding.model !== ingestion.embedding.model ||
        repository.activeEmbedding.dimension !== ingestion.embedding.dimension) {
      await ctx.db.patch(ingestion._id, { status: "awaiting_reembed" });
      await ctx.scheduler.runAfter(0, internal.memoryData.releaseAwaitingIngestions, {
        repositoryId: ingestion.repositoryId, embedding: repository.activeEmbedding,
      });
      return false;
    }
    await ctx.db.patch(args.ingestionId, {
      status: "processing",
      attempts: ingestion.attempts + 1,
      processingStartedAt: Date.now(),
      lastFailureCode: undefined,
    });
    // Node actions have a ten-minute execution limit. A lost action must not
    // hold the repository's ingestion/deletion queue indefinitely.
    await ctx.scheduler.runAfter(ingestionTimeoutMs, internal.memoryData.expireIngestion, {
      ...args, attempt: ingestion.attempts + 1,
    });
    return true;
  },
});

export const expireIngestion = internalMutation({
  args: { ingestionId: v.id("memoryIngestions"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ingestion = await ctx.db.get(args.ingestionId);
    if (!ingestion || ingestion.status !== "processing" || ingestion.attempts !== args.attempt) return null;
    if (ingestion.processingStartedAt === undefined ||
        Date.now() < ingestion.processingStartedAt + ingestionTimeoutMs) return null;
    const repository = await repositoryById(ctx, ingestion.repositoryId);
    const retry = repository && !repository.deleting && ingestion.attempts < 5;
    await ctx.db.patch(ingestion._id, { status: retry ? "pending" : "failed", lastFailureCode: "action-timeout" });
    if (retry) await ctx.scheduler.runAfter(0, internal.memoryActions.ingestReview, { ingestionId: ingestion._id });
    return null;
  },
});

export const repositoryHasProcessingIngestion = internalMutation({
  args: { repositoryId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => (await processingIngestion(ctx, args.repositoryId)) !== null,
});

export const completeIngestion = internalMutation({
  args: { ingestionId: v.id("memoryIngestions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ingestion = await ctx.db.get(args.ingestionId);
    if (ingestion?.status === "processing") {
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
    if (!ingestion || ingestion.status !== "processing") return "failed";
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
    if (!ingestion || ingestion.status !== "processing") throw new Error("Memory ingestion is not active");
    const existing = await ctx.db
      .query("memoryEntries")
      .withIndex("by_memory_key", (query) =>
        query.eq("memoryKey", args.memoryKey),
      )
      .unique();
    if (existing && existing.observedAt > args.observedAt) return null;
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
    token: v.string(),
    memoryKey: v.string(),
    embedding: vEmbedding,
    ragEntryId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const repository = await repositoryById(ctx, args.repositoryId);
    if (repository?.reembedJob?.token !== args.token || repository.reembedJob.startedAt === undefined) {
      throw new Error("Memory re-embedding is not active");
    }
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
    if (repository.deleting || await installationRemoved(ctx, repository.installationId)) return null;
    if (repository.pendingEmbedding && !repository.reembedJob) {
      await scheduleReembed(ctx, repository, repository.pendingEmbedding);
      return ctx.db.get(repository._id);
    }
    const differs =
      repository.activeEmbedding.model !== args.embedding.model ||
      repository.activeEmbedding.dimension !== args.embedding.dimension;
    if (differs && !repository.pendingEmbedding) {
      await scheduleReembed(ctx, repository, args.embedding);
      return ctx.db.get(repository._id);
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

export const searchMemories = internalQuery({
  args: {
    repositoryId: v.string(), embedding: vEmbedding,
    entries: v.array(v.object({ memoryKey: v.string(), ragEntryId: v.string() })),
  },
  returns: v.array(v.object({ ragEntryId: v.string(), memory: vMemoryEntryDoc, cluster: vMemoryClusterDoc })),
  handler: async (ctx, args) => {
    const repository = await repositoryById(ctx, args.repositoryId);
    if (!repository || repository.deleting || await installationRemoved(ctx, repository.installationId) ||
        repository.activeEmbedding.model !== args.embedding.model ||
        repository.activeEmbedding.dimension !== args.embedding.dimension) return [];
    const candidates = [];
    for (const entry of args.entries.slice(0, 32)) {
      const vector = await ctx.db.query("memoryVectors")
        .withIndex("by_repository_id_and_memory_key_and_model_and_dimension", (q) =>
          q.eq("repositoryId", args.repositoryId).eq("memoryKey", entry.memoryKey)
            .eq("embeddingModel", args.embedding.model).eq("embeddingDimension", args.embedding.dimension))
        .unique();
      if (vector?.ragEntryId !== entry.ragEntryId) continue;
      const memory = await ctx.db.query("memoryEntries")
        .withIndex("by_memory_key", (q) => q.eq("memoryKey", entry.memoryKey)).unique();
      if (!memory || memory.repositoryId !== args.repositoryId) continue;
      const cluster = await ctx.db
        .query("memoryClusters")
        .withIndex("by_repository_id_and_cluster_key", (query) =>
          query
            .eq("repositoryId", args.repositoryId)
            .eq("clusterKey", memory.clusterKey),
        )
        .unique();
      if (cluster) candidates.push({ ragEntryId: entry.ragEntryId, memory, cluster });
    }
    return candidates;
  },
});

export const startReembed = internalMutation({
  args: { repositoryId: v.string(), token: v.optional(v.string()) },
  returns: v.union(v.null(), vRepositoryMemoryDoc),
  handler: async (ctx, args) => {
    const repository = await repositoryById(ctx, args.repositoryId);
    if (!repository?.pendingEmbedding) return null;
    if (!repository.reembedJob) {
      // Restart legacy queued work from the beginning with a durable identity.
      await scheduleReembed(ctx, repository, repository.pendingEmbedding);
      return null;
    }
    if (repository.reembedJob.token !== args.token || repository.reembedJob.startedAt !== undefined) return null;
    if (repository.deleting) {
      await ctx.db.patch(repository._id, { pendingEmbedding: undefined, reembedJob: undefined });
      return null;
    }
    const pending = await ctx.db.query("memoryIngestions")
      .withIndex("by_repository_id_and_status_and_embedding", (q) => q.eq("repositoryId", args.repositoryId)
        .eq("status", "pending").eq("embedding.model", repository.activeEmbedding.model)
        .eq("embedding.dimension", repository.activeEmbedding.dimension)).first();
    if (pending || await processingIngestion(ctx, args.repositoryId)) {
      await ctx.scheduler.runAfter(1_000, internal.memoryActions.reembedRepository, args);
      return null;
    }
    const startedAt = Date.now();
    await ctx.db.patch(repository._id, { reembedJob: { ...repository.reembedJob, startedAt } });
    await ctx.scheduler.runAfter(ingestionTimeoutMs, internal.memoryData.expireReembed, {
      repositoryId: args.repositoryId, token: repository.reembedJob.token,
    });
    return ctx.db.get(repository._id);
  },
});

export const completeReembed = internalMutation({
  args: { repositoryId: v.string(), token: v.string(), nextCursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const repository = await repositoryById(ctx, args.repositoryId);
    if (!repository?.pendingEmbedding || repository.reembedJob?.token !== args.token ||
        repository.reembedJob.startedAt === undefined) return null;
    if (args.nextCursor !== null && !repository.deleting) {
      await scheduleReembed(ctx, repository, repository.pendingEmbedding, args.nextCursor);
      return null;
    }
    await ctx.db.patch(repository._id, {
      ...(!repository.deleting ? { activeEmbedding: repository.pendingEmbedding } : {}),
      pendingEmbedding: undefined, reembedJob: undefined,
    });
    if (!repository.deleting) await ctx.scheduler.runAfter(0, internal.memoryData.releaseAwaitingIngestions, {
      repositoryId: args.repositoryId, embedding: repository.pendingEmbedding,
    });
    return null;
  },
});

async function failReembed(ctx: MutationCtx, repository: Doc<"repositoryMemory">, failureCode: string) {
  const job = repository.reembedJob;
  const embedding = repository.pendingEmbedding;
  if (!job || !embedding) return;
  if (!repository.deleting && job.attempt < 4) {
    await scheduleReembed(ctx, repository, embedding, job.cursor, job.attempt + 1);
    return;
  }
  await ctx.db.patch(repository._id, { pendingEmbedding: undefined, reembedJob: undefined });
  const waiting = await ctx.db.query("memoryIngestions")
    .withIndex("by_repository_id_and_status_and_embedding", (query) => query
      .eq("repositoryId", repository.repositoryId).eq("status", "awaiting_reembed")
      .eq("embedding.model", embedding.model).eq("embedding.dimension", embedding.dimension))
    .take(100);
  for (const ingestion of waiting) {
    await ctx.db.patch(ingestion._id, { lastFailureCode: `reembed:${failureCode}` });
  }
}

export const recordReembedFailure = internalMutation({
  args: { repositoryId: v.string(), token: v.string(), failureCode: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const repository = await repositoryById(ctx, args.repositoryId);
    if (repository?.reembedJob?.token === args.token && repository.reembedJob.startedAt !== undefined) {
      await failReembed(ctx, repository, args.failureCode);
    }
    return null;
  },
});

export const expireReembed = internalMutation({
  args: { repositoryId: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const repository = await repositoryById(ctx, args.repositoryId);
    const job = repository?.reembedJob;
    if (repository && job?.token === args.token && job.startedAt !== undefined &&
        Date.now() >= job.startedAt + ingestionTimeoutMs) await failReembed(ctx, repository, "action-timeout");
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
      await scheduleReembed(ctx, repository, next.embedding);
    }
    return null;
  },
});

async function scheduleDeletion(ctx: MutationCtx, repository: Doc<"repositoryMemory">) {
  const args = { repositoryId: repository.repositoryId, repositoryRecordId: repository._id };
  await ctx.scheduler.runAfter(0, internal.memoryActions.deleteRepository, args);
  if (!repository.deletionWatchdog) {
    await ctx.db.patch(repository._id, { deletionWatchdog: true });
    await ctx.scheduler.runAfter(ingestionTimeoutMs, internal.memoryData.resumeDeletion, args);
  }
}

async function beginRepositoryDeletion(
  ctx: MutationCtx,
  installationId: number,
  repositoryId: string,
): Promise<void> {
  const repository = await repositoryById(ctx, repositoryId);
  if (!repository || repository.installationId !== installationId) return;
  await ctx.db.patch(repository._id, { deleting: true });
  await scheduleDeletion(ctx, repository);
}

export const beginRepositoriesDeletion = internalMutation({
  args: { installationId: v.number(), deliveryId: v.string(), repositoryIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const repositoryId of new Set(args.repositoryIds)) {
      if (await revokeRepositoryAdmission(ctx, { installationId: args.installationId, deliveryId: args.deliveryId, repositoryId })) {
        await beginRepositoryDeletion(ctx, args.installationId, repositoryId);
      }
    }
    return null;
  },
});

export const reconcileInstallationRepositories = internalMutation({
  args: {
    installationId: v.number(),
    deliveryId: v.optional(v.string()),
    uninstalled: v.optional(v.boolean()),
    retainedRepositoryIds: v.array(v.string()),
    cursor: v.union(v.string(), v.null()),
    phase: v.optional(v.union(v.literal("access"), v.literal("memory"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.uninstalled && !await installationRemoved(ctx, args.installationId)) {
      await ctx.db.insert("memoryUninstalls", { installationId: args.installationId });
    }
    const retained = new Set(args.retainedRepositoryIds);
    // Calls already queued by the prior deployment have memory-table cursors.
    const phase = args.phase ?? "memory";
    const page = phase === "access"
      ? await ctx.db.query("memoryAccess").withIndex("by_installation_id", (q) => q.eq("installationId", args.installationId))
        .paginate({ cursor: args.cursor, numItems: 50 })
      : await ctx.db.query("repositoryMemory").withIndex("by_installation_id", (q) => q.eq("installationId", args.installationId))
        .paginate({ cursor: args.cursor, numItems: 50 });
    for (const repository of page.page) {
      if (!retained.has(repository.repositoryId)) {
        const deliveryId = args.deliveryId ?? "legacy-reconciliation";
        if (await revokeRepositoryAdmission(ctx, { installationId: args.installationId, deliveryId, repositoryId: repository.repositoryId })) {
          await beginRepositoryDeletion(ctx, args.installationId, repository.repositoryId);
        }
      }
    }
    if (!page.isDone || phase === "access") {
      await ctx.scheduler.runAfter(0, internal.memoryData.reconcileInstallationRepositories, {
        ...args, phase: page.isDone ? "memory" : phase, cursor: page.isDone ? null : page.continueCursor,
      });
    }
    return null;
  },
});

const deletionIdentity = { repositoryId: v.string(), repositoryRecordId: v.id("repositoryMemory") };

export const resolveDeletion = internalMutation({
  args: { repositoryId: v.string(), repositoryRecordId: v.optional(v.id("repositoryMemory")) },
  returns: v.union(v.id("repositoryMemory"), v.null()),
  handler: async (ctx, args) => {
    const repository = await repositoryById(ctx, args.repositoryId);
    if (!repository?.deleting || (args.repositoryRecordId && repository._id !== args.repositoryRecordId)) return null;
    if (!repository.deletionWatchdog) await scheduleDeletion(ctx, repository);
    return repository._id;
  },
});

export const resumeDeletion = internalMutation({
  args: deletionIdentity,
  returns: v.null(),
  handler: async (ctx, args) => {
    const repository = await ctx.db.get(args.repositoryRecordId);
    if (!repository?.deleting || repository.repositoryId !== args.repositoryId) return null;
    await ctx.scheduler.runAfter(0, internal.memoryActions.deleteRepository, args);
    await ctx.scheduler.runAfter(ingestionTimeoutMs, internal.memoryData.resumeDeletion, args);
    return null;
  },
});

export const listDeletionNamespaces = internalQuery({
  args: deletionIdentity,
  returns: v.union(v.null(), v.array(v.string())),
  handler: async (ctx, args): Promise<string[] | null> => {
    const repository = await ctx.db.get(args.repositoryRecordId);
    if (!repository?.deleting || repository.repositoryId !== args.repositoryId) return null;
    const namespaces = await ctx.runQuery(components.rag.namespaces.listNamespaceVersions, {
      namespace: `github:${args.repositoryId}`, paginationOpts: { cursor: null, numItems: 10 },
    });
    return namespaces.page.map((namespace) => namespace.namespaceId);
  },
});

export const repositoryHasActiveMemoryWork = internalMutation({
  args: { repositoryId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const repository = await ctx.db
      .query("repositoryMemory")
      .withIndex("by_repository_id", (query) =>
        query.eq("repositoryId", args.repositoryId),
      )
      .unique();
    if (repository?.pendingEmbedding) {
      if (!repository.reembedJob) await scheduleReembed(ctx, repository, repository.pendingEmbedding);
      return true;
    }
    return (await processingIngestion(ctx, args.repositoryId)) !== null;
  },
});

export const deleteRepositoryRows = internalMutation({
  args: deletionIdentity,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const repository = await ctx.db.get(args.repositoryRecordId);
    if (!repository?.deleting || repository.repositoryId !== args.repositoryId) return true;
    const vectors = await ctx.db.query("memoryVectors")
      .withIndex("by_repository_id", (q) => q.eq("repositoryId", args.repositoryId)).take(50);
    for (const vector of vectors) await ctx.db.delete(vector._id);
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
      vectors.length + memoryEntries.length +
      memoryClusters.length +
      clusterPullRequests.length +
      ingestions.length +
      reviewDays.length;
    if (deleted === 0) {
      await ctx.db.delete(repository._id);
      return true;
    }
    return false;
  },
});
