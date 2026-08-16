import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  memoryDeletionSchema,
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

http.route({
  path: "/memory/ingest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
    const ingestion = memoryIngestionSchema.parse(await request.json());
    const queued = await ctx.runMutation(
      internal.memoryData.queueReview,
      ingestion,
    );
    return json(queued, 202);
  }),
});

http.route({
  path: "/memory/search",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
    const search = memorySearchRequestSchema.parse(await request.json());
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
    const deletion = memoryDeletionSchema.parse(await request.json());
    if (deletion.kind === "repositories") {
      for (let start = 0; start < deletion.repositoryIds.length; start += 100) {
        await ctx.runMutation(internal.memoryData.beginRepositoriesDeletion, {
          repositoryIds: deletion.repositoryIds.slice(start, start + 100),
        });
      }
    } else {
      await ctx.runMutation(
        internal.memoryData.reconcileInstallationRepositories,
        {
          installationId: deletion.installationId,
          retainedRepositoryIds: deletion.retainedRepositoryIds,
          cursor: null,
        },
      );
    }
    return json({ accepted: true }, 202);
  }),
});

export default http;
