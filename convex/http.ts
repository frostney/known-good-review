import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { z } from "zod";
import {
  memoryDeletionSchema,
  memoryAdmissionRequestSchema,
  memoryIngestionSchema,
  memorySearchRequestSchema,
} from "../src/memory/contracts";

const http = httpRouter();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function isAuthorized(request: Request): Promise<boolean> {
  const expected = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  const authorization = request.headers.get("authorization");
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  const [actualDigest, expectedDigest] = await Promise.all([
    digest(authorization.slice("Bearer ".length)),
    digest(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |=
      (actualDigest.at(index) ?? 0) ^ (expectedDigest.at(index) ?? 0);
  }
  return difference === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function requestBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

http.route({
  path: "/memory/admission",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
    const admission = await requestBody(request, memoryAdmissionRequestSchema);
    if (!admission) return json({ error: "invalid_request" }, 400);
    return json(await ctx.runMutation(internal.memoryAccess.captureAdmission, admission));
  }),
});

http.route({
  path: "/memory/ingest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
    const ingestion = await requestBody(request, memoryIngestionSchema);
    if (!ingestion) return json({ error: "invalid_request" }, 400);
    if (!ingestion.memoryAdmission) return json({ error: "memory_admission_required" }, 409);
    const queued = await ctx.runMutation(
      internal.memoryData.queueReview,
      { ...ingestion, memoryAdmission: ingestion.memoryAdmission },
    );
    return json(queued, queued.status === "revoked" ? 409 : 202);
  }),
});

http.route({
  path: "/memory/search",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
    const search = await requestBody(request, memorySearchRequestSchema);
    if (!search) return json({ error: "invalid_request" }, 400);
    return json(
      await ctx.runAction(internal.memoryActions.searchRepository, search),
    );
  }),
});

http.route({
  path: "/memory/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
    const deletion = await requestBody(request, memoryDeletionSchema);
    if (!deletion) return json({ error: "invalid_request" }, 400);
    if (deletion.kind === "repositories") {
      for (let start = 0; start < deletion.repositoryIds.length; start += 100) {
        await ctx.runMutation(internal.memoryData.beginRepositoriesDeletion, {
          installationId: deletion.installationId,
          deliveryId: deletion.deliveryId,
          repositoryIds: deletion.repositoryIds.slice(start, start + 100),
        });
      }
    } else {
      await ctx.runMutation(
        internal.memoryData.reconcileInstallationRepositories,
        {
          installationId: deletion.installationId,
          deliveryId: deletion.deliveryId,
          uninstalled: deletion.uninstalled,
          phase: "access",
          retainedRepositoryIds: deletion.retainedRepositoryIds,
          cursor: null,
        },
      );
    }
    return json({ accepted: true }, 202);
  }),
});

export default http;
