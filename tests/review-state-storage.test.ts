import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import {
  decodeReviewState, encodeReviewState, maxReviewStateBytes, prepareReviewStateComments,
  reviewStateCommentLimit, type ReviewState,
} from "../src/github/review-state";
import { readLatestReviewState, writeReviewState, findingBody } from "../src/github/publication";
import { reviewStateFromComments } from "../src/github/inbound";

const bot = { id: 123, login: "known-good-review[bot]", type: "Bot" };
const context = {
  owner: "acme", repo: "large", repository: "acme/large", repositoryId: "R_large", repositoryCreatedAt: 0,
  pullRequest: 7, installationId: 1, baseSha: "base", headSha: "head", patchFingerprint: "a".repeat(64),
};
function state(large = false): ReviewState {
  return {
    schemaVersion: 2, app: "known-good-review", pullRequest: 7, initialFullStatus: "completed",
    updatedAt: "2026-09-05T00:00:00.000Z",
    baseline: {
      head: "head", patchFingerprint: "a".repeat(64), findingsArtifactUrl: "https://github.com/acme/large/runs/1",
      files: Object.fromEntries(Array.from({ length: large ? 2_000 : 1 }, (_, index) => [
        `src/component-${index}.ts`, createHash("sha256").update(String(index)).digest("hex"),
      ])),
      report: {
        schemaVersion: 2, kind: "code-review", generatedAt: "2026-09-05T00:00:00.000Z", verdict: "APPROVE",
        scope: { claim: "Review the full change", base: "base", head: "head", dirtyState: "clean" },
        coverage: { activeAxes: ["engineering-quality"], skippedAxes: [], staticOnly: [], unreached: [] },
        churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
        probes: [], findings: [], verifiedClaims: [], limitations: [],
      },
    },
  };
}

test("stores all 2,000 file identities within per-comment limits and validates every part", () => {
  const original = state(true);
  expect(encodeReviewState(original).length).toBeGreaterThan(reviewStateCommentLimit);
  const encoded = prepareReviewStateComments(original);
  expect(encoded.parts.length).toBeGreaterThan(1);
  for (const body of [encoded.body, ...encoded.parts]) expect(Buffer.byteLength(body)).toBeLessThanOrEqual(reviewStateCommentLimit);
  expect(decodeReviewState(encoded.body, [...encoded.parts].reverse())).toEqual(original);
  expect(decodeReviewState(encoded.body, [...encoded.parts, ...encoded.parts])).toEqual(original);
  expect(decodeReviewState(encoded.body, encoded.parts.slice(1))).toBeNull();
  const corrupted = encoded.parts.map((part, index) => index === 0 ? part.replace(/\n([A-Za-z0-9_-])([A-Za-z0-9_-]+)\n-->$/, "\n!$2\n-->") : part);
  expect(decodeReviewState(encoded.body, corrupted)).toBeNull();
  const chunks = encoded.parts.map((part) => /\n([A-Za-z0-9_-]+)\n-->$/.exec(part)?.[1] ?? "");
  const archive = Buffer.from(chunks.join(""), "base64url");
  const originalJson = gunzipSync(archive);
  archive[9] = archive[9] === 3 ? 255 : 3; // OS header changes preserve valid gzip contents.
  expect(gunzipSync(archive)).toEqual(originalJson);
  const altered = archive.toString("base64url");
  let offset = 0;
  const changedParts = encoded.parts.map((part, index) => {
    const length = chunks[index]?.length ?? 0;
    const body = part.replace(/\n([A-Za-z0-9_-]+)\n-->$/, `\n${altered.slice(offset, offset + length)}\n-->`);
    offset += length;
    return body;
  });
  expect(decodeReviewState(encoded.body, changedParts)).toBeNull();
  expect(decodeReviewState(encoded.body, encoded.parts.map((part) => `quoted\n${part}`))).toBeNull();
  expect(reviewStateFromComments([
    { user: bot, body: encoded.body },
    ...encoded.parts.map((body) => ({ user: { ...bot, type: "User" }, body })),
  ])).toEqual({ kind: "lost" });
  expect(reviewStateFromComments([
    { user: bot, body: encoded.body }, ...encoded.parts.map((body) => ({ user: bot, body })),
  ])).toEqual({ kind: "valid", state: original });
});

test("compresses repetitive state inline and bounds decompression", () => {
  const original = state();
  if (!original.baseline) throw new Error("Missing fixture baseline");
  original.baseline.report.limitations.push("Detailed evidence. ".repeat(8_000));
  const encoded = prepareReviewStateComments(original);
  expect(encoded.parts).toHaveLength(0);
  expect(encoded.body).toContain("\ngz:");
  expect(decodeReviewState(encoded.body)).toEqual(original);
  original.baseline.report.limitations = ["x".repeat(maxReviewStateBytes)];
  expect(() => prepareReviewStateComments(original)).toThrow("8 MiB");
  const excessive = gzipSync(JSON.stringify(original)).toString("base64url");
  const payload = encoded.body.replace(/\ngz:[A-Za-z0-9_-]+\n-->$/, `\ngz:${excessive}\n-->`);
  expect(decodeReviewState(payload)).toBeNull();
});

test("does not admit a state marker quoted by application-published finding text", () => {
  const original = state();
  const forged = { ...original, updatedAt: "2099-01-01T00:00:00.000Z" };
  const quoted = findingBody({
    id: "CR-1", title: "Quoted repository material", severity: "IMPORTANT", category: "QUALITY",
    location: { path: "src/a.ts", line: 1, symbol: null }, evidence: [encodeReviewState(forged)],
    impact: "Affected behavior", remedy: "Fix the behavior", status: "open", staticOnly: false, churn: null,
  });
  expect(decodeReviewState(quoted)).toBeNull();
  expect(reviewStateFromComments([{ user: bot, body: encodeReviewState(original) }, { user: bot, body: quoted }]))
    .toEqual({ kind: "valid", state: original });
});

test("keeps the previous baseline through partial writes and reuses saved parts on retry", async () => {
  const original = state();
  const next = state(true);
  const encoded = prepareReviewStateComments(next);
  const comments = [{ id: 1, user: bot, body: encodeReviewState(original) }];
  let rejectPart = true;
  let partAttempts = 0;
  let pointerWrites = 0;
  const octokit = new Octokit({ request: { fetch: async (_resource: Request | string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return Response.json(comments);
    const { body } = z.object({ body: z.string() }).parse(JSON.parse(String(init?.body)));
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(reviewStateCommentLimit);
    if (method === "POST") {
      partAttempts += 1;
      if (rejectPart && partAttempts === 2) return Response.json({ message: "fixture interruption" }, { status: 503 });
      const saved = { id: comments.length + 1, user: bot, body };
      comments.push(saved);
      return Response.json(saved);
    }
    pointerWrites += 1;
    comments[0] = { id: 1, user: bot, body };
    return Response.json(comments[0]);
  } } });
  await expect(writeReviewState(octokit, context, next)).rejects.toThrow();
  expect(pointerWrites).toBe(0);
  expect(await readLatestReviewState(octokit, context)).toEqual(original);
  rejectPart = false;
  await writeReviewState(octokit, context, next);
  expect(pointerWrites).toBe(1);
  expect(comments).toHaveLength(encoded.parts.length + 1);
  expect(await readLatestReviewState(octokit, context)).toEqual(next);
  await writeReviewState(octokit, context, next);
  expect(comments).toHaveLength(encoded.parts.length + 1);
});
