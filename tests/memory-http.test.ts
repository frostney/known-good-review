import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";

const modules = {
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/http.ts": () => import("../convex/http"),
};

test("memory HTTP routes reject unauthorized and malformed requests with safe client errors", async () => {
  const previous = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = "test-only-token";
  try {
    const t = convexTest(schema, modules);
    for (const path of ["/memory/admission", "/memory/ingest", "/memory/search", "/memory/delete"]) {
      const unauthorized = await t.fetch(path, { method: "POST", body: "private malformed request" });
      expect(unauthorized.status).toBe(401);
      for (const body of ["private malformed request", '{"private":"invalid shape"}']) {
        const response = await t.fetch(path, {
          method: "POST", headers: { authorization: "Bearer test-only-token" }, body,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_request" });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
    else process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = previous;
  }
});
