import { v } from "convex/values";

export const vEmbedding = v.object({
  model: v.string(),
  dimension: v.number(),
});

export const vMemorySeverity = v.union(
  v.literal("BLOCKING"),
  v.literal("IMPORTANT"),
  v.literal("IMPROVEMENT"),
);

export const vMemoryStatus = v.union(
  v.literal("open"),
  v.literal("deferred"),
  v.literal("fixed"),
);

export const vMemoryCategory = v.union(
  v.literal("CLAIM"),
  v.literal("QUALITY"),
  v.literal("ARCHITECTURE_RISK"),
  v.literal("DISCOVERABILITY"),
);

export const vNormalizedMemory = v.object({
  finding: v.string(),
  invariant: v.string(),
  cause: v.union(v.string(), v.null()),
  remedy: v.string(),
  outcome: vMemoryStatus,
  severity: vMemorySeverity,
  category: vMemoryCategory,
  provenance: v.object({
    repositoryId: v.string(),
    repository: v.string(),
    pullRequest: v.number(),
    base: v.string(),
    head: v.string(),
    path: v.string(),
    symbol: v.union(v.string(), v.null()),
    findingId: v.string(),
  }),
});

export const vIngestionStatus = v.union(
  v.literal("pending"),
  v.literal("awaiting_reembed"),
  v.literal("processing"),
  v.literal("complete"),
  v.literal("failed"),
);

export const vReviewKind = v.union(v.literal("full"), v.literal("delta"));

export const vMemorySearchResponse = v.object({
  mode: v.union(v.literal("bootstrap"), v.literal("tiered")),
  policyHash: v.string(),
  memories: v.array(
    v.object({
      ...vNormalizedMemory.fields,
      tier: v.union(
        v.literal("bootstrap"),
        v.literal("short"),
        v.literal("mid"),
        v.literal("long"),
      ),
      score: v.number(),
      distinctPullRequests: v.number(),
      durable: v.boolean(),
      observedAt: v.number(),
    }),
  ),
  usage: v.object({ embeddingTokens: v.number() }),
});

export const vRepositoryMemoryDoc = v.object({
  _id: v.id("repositoryMemory"),
  _creationTime: v.number(),
  installationId: v.number(),
  repositoryId: v.string(),
  repository: v.string(),
  repositoryCreatedAt: v.number(),
  completedReviews: v.number(),
  reviewDays: v.number(),
  firstReviewAt: v.number(),
  lastReviewAt: v.number(),
  recentReviewTimes: v.array(v.number()),
  activeEmbedding: vEmbedding,
  pendingEmbedding: v.optional(vEmbedding),
  policyHash: v.string(),
  deleting: v.boolean(),
});

export const vMemoryIngestionDoc = v.object({
  _id: v.id("memoryIngestions"),
  _creationTime: v.number(),
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
  status: vIngestionStatus,
  attempts: v.number(),
  lastFailureCode: v.optional(v.string()),
});

export const vMemoryEntryDoc = v.object({
  _id: v.id("memoryEntries"),
  _creationTime: v.number(),
  memoryKey: v.string(),
  clusterKey: v.string(),
  repositoryId: v.string(),
  pullRequest: v.number(),
  observedAt: v.number(),
  finding: v.string(),
  invariant: v.string(),
  cause: v.union(v.string(), v.null()),
  remedy: v.string(),
  outcome: vMemoryStatus,
  severity: vMemorySeverity,
  category: vMemoryCategory,
  provenance: vNormalizedMemory.fields.provenance,
});

export const vMemoryClusterDoc = v.object({
  _id: v.id("memoryClusters"),
  _creationTime: v.number(),
  repositoryId: v.string(),
  clusterKey: v.string(),
  distinctPullRequests: v.number(),
  totalOccurrences: v.number(),
  lastSeenAt: v.number(),
  severity: vMemorySeverity,
  status: vMemoryStatus,
});

export const vMemoryVectorDoc = v.object({
  _id: v.id("memoryVectors"),
  _creationTime: v.number(),
  repositoryId: v.string(),
  memoryKey: v.string(),
  embeddingModel: v.string(),
  embeddingDimension: v.number(),
  ragEntryId: v.string(),
});
