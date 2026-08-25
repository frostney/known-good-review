import { describe, expect, test } from "bun:test";
import { parseReviewConfig } from "../src/config/review-config";
import {
  commonMemoryQuery,
  commonReviewWorkSchema,
  prepareCommonMemory,
  stableCommonWorkId,
} from "../src/review/common-work";
import { commonWorkFixture } from "./common-work-fixture";

const identity = {
  executionRevision: "review-evidence-v2" as const,
  repositoryId: "R_test",
  repositoryDatabaseId: 41,
  repository: "frostney/pascal-mcp-sdk",
  pullRequest: 61,
  baseSha: "1".repeat(40),
  headSha: "2".repeat(40),
  patchFingerprint: "3".repeat(64),
  planKind: "delta" as const,
};

describe("application-owned common review work", () => {
  test("uses canonical stable identities and keeps distinct work separate", () => {
    const left = stableCommonWorkId("github-evidence", {
      head: identity.headSha,
      repository: identity.repositoryId,
    });
    const reordered = stableCommonWorkId("github-evidence", {
      repository: identity.repositoryId,
      head: identity.headSha,
    });
    const changed = stableCommonWorkId("github-evidence", {
      head: "4".repeat(40),
      repository: identity.repositoryId,
    });

    expect(reordered).toBe(left);
    expect(changed).not.toBe(left);
    expect(
      stableCommonWorkId("repository-history", {
        head: identity.headSha,
        repository: identity.repositoryId,
      }),
    ).not.toBe(left);
  });

  test("builds one order-independent memory query for the exact file scope", () => {
    const first = commonMemoryQuery([
      { path: "src/z.ts", status: "modified" },
      { path: "src/a.ts", status: "added" },
    ]);
    const reordered = commonMemoryQuery([
      { path: "src/a.ts", status: "added" },
      { path: "src/z.ts", status: "modified" },
    ]);

    expect(reordered).toBe(first);
    expect(first).toContain("src/a.ts, src/z.ts");
  });

  test("binds delayed memory to the exact review without turning it into a gate", () => {
    const query = commonMemoryQuery([
      { path: "src/review.ts", status: "modified" },
    ]);
    const prepared = prepareCommonMemory({
      availability: {
        kind: "delayed",
        reason: "Repository memory is still indexing.",
      },
      config: parseReviewConfig(null),
      identity,
      policyHash: "4".repeat(64),
      query,
    });

    expect(prepared.record.outcome).toBe("delayed");
    expect(prepared.memory.availability.kind).toBe("delayed");
    expect(prepared.memory.workId).toBe(prepared.record.id);
  });

  test("rejects common results that do not match their stable records", () => {
    const work = commonWorkFixture(identity);

    expect(() =>
      commonReviewWorkSchema.parse({
        ...work,
        history: {
          ...work.history,
          commitShas: ["5".repeat(40)],
        },
      }),
    ).toThrow("does not match its common work record");
  });
});
