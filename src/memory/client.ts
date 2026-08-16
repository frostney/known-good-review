import { createHash } from "node:crypto";
import type { ReviewConfig } from "../config/review-config";
import type { TrustedGitHubContext } from "../github/trusted-context";
import type { ReviewReport } from "../review/findings";
import {
  memoryDeletionSchema,
  memoryIngestionSchema,
  memorySearchResponseSchema,
  type MemoryDeletion,
  type MemoryIngestion,
  type MemorySearchResponse,
} from "./contracts";
import { memoryPolicyHash } from "./policy";

export type MemoryAvailability =
  | { readonly kind: "available"; readonly response: MemorySearchResponse }
  | { readonly kind: "delayed"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

function memoryServiceConfig():
  | { readonly baseUrl: string; readonly token: string }
  | null {
  const baseUrl = process.env.CONVEX_MEMORY_URL?.replace(/\/$/, "");
  const token = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  return baseUrl && token ? { baseUrl, token } : null;
}

async function postMemoryService(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const service = memoryServiceConfig();
  if (!service) throw new Error("memory service is not configured");
  return fetch(`${service.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function idempotencyKey(input: {
  readonly repositoryId: string;
  readonly pullRequest: number;
  readonly head: string;
  readonly patchFingerprint: string;
  readonly memories: MemoryIngestion["memories"];
}): string {
  return createHash("sha256")
    .update(
      `${input.repositoryId}\0${input.pullRequest}\0${input.head}\0${input.patchFingerprint}\0${JSON.stringify(input.memories)}`,
    )
    .digest("hex");
}

export function normalizedReviewMemory(input: {
  readonly config: ReviewConfig;
  readonly context: TrustedGitHubContext;
  readonly report: ReviewReport;
  readonly reviewKind: "full" | "delta";
  readonly publishedAt?: number;
}): MemoryIngestion {
  const patchFingerprint = input.context.patchFingerprint;
  if (!patchFingerprint) {
    throw new Error("Trusted review context is missing patch identity");
  }
  const publishedAt = input.publishedAt ?? Date.now();
  const memories = input.report.findings.map((finding) => ({
    finding: finding.title,
    invariant: finding.impact,
    cause: null,
    remedy: finding.remedy,
    outcome: finding.status,
    severity: finding.severity,
    category: finding.category,
    provenance: {
      repositoryId: input.context.repositoryId,
      repository: input.context.repository,
      pullRequest: input.context.pullRequest,
      base: input.context.baseSha,
      head: input.context.headSha,
      path: finding.location.path,
      symbol: finding.location.symbol,
      findingId: finding.id,
    },
  }));
  return memoryIngestionSchema.parse({
    idempotencyKey: idempotencyKey({
      repositoryId: input.context.repositoryId,
      pullRequest: input.context.pullRequest,
      head: input.context.headSha,
      patchFingerprint,
      memories,
    }),
    installationId: input.context.installationId,
    repositoryId: input.context.repositoryId,
    repository: input.context.repository,
    repositoryCreatedAt: input.context.repositoryCreatedAt,
    pullRequest: input.context.pullRequest,
    reviewKind: input.reviewKind,
    base: input.context.baseSha,
    head: input.context.headSha,
    publishedAt,
    policyHash: memoryPolicyHash(),
    embedding: input.config.embedding,
    memories,
  });
}

export async function requestMemoryDeletion(
  deletion: MemoryDeletion,
): Promise<void> {
  const response = await postMemoryService(
    "/memory/delete",
    memoryDeletionSchema.parse(deletion),
    15_000,
  );
  if (!response.ok) {
    throw new Error(`Repository memory deletion returned HTTP ${response.status}`);
  }
}

export async function enqueueReviewMemory(
  ingestion: MemoryIngestion,
): Promise<"queued" | "unavailable"> {
  if (!memoryServiceConfig()) return "unavailable";
  try {
    const response = await postMemoryService("/memory/ingest", ingestion, 5_000);
    if (!response.ok) {
      console.warn(
        JSON.stringify({
          event: "known-good-review.memory.ingestion_rejected",
          status: response.status,
          repositoryId: ingestion.repositoryId,
        }),
      );
      return "unavailable";
    }
    return "queued";
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "known-good-review.memory.ingestion_unavailable",
        error: error instanceof Error ? error.name : "unknown",
        repositoryId: ingestion.repositoryId,
      }),
    );
    return "unavailable";
  }
}

export async function retrieveReviewMemory(input: {
  readonly config: ReviewConfig;
  readonly repositoryId: string;
  readonly axis: "deduplication" | "claim-and-specification" | "engineering-quality" | "discoverability";
  readonly query: string;
  readonly limit?: number;
}): Promise<MemoryAvailability> {
  if (!memoryServiceConfig()) {
    return { kind: "unavailable", reason: "Repository memory is not configured." };
  }
  try {
    const response = await postMemoryService(
      "/memory/search",
      {
        repositoryId: input.repositoryId,
        axis: input.axis,
        query: input.query,
        embedding: input.config.embedding,
        limit: input.limit ?? 8,
      },
      15_000,
    );
    if (response.status === 202) {
      return { kind: "delayed", reason: "Repository memory is still indexing." };
    }
    if (!response.ok) {
      return {
        kind: "unavailable",
        reason: `Repository memory returned HTTP ${response.status}.`,
      };
    }
    return {
      kind: "available",
      response: memorySearchResponseSchema.parse(await response.json()),
    };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `Repository memory lookup failed (${error instanceof Error ? error.name : "unknown"}).`,
    };
  }
}
