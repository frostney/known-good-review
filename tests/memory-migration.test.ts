import { expect, test } from "bun:test";
import { inspectMemoryMigration, parseMemoryTable } from "../scripts/check-memory-migration";

const empty = { jobs: [], repositories: [], ingestions: [] };

test("recognizes the native CLI empty-table response without hiding command failures", () => {
  expect(parseMemoryTable("", "There are no documents in this table.\n", 0)).toEqual([]);
  expect(parseMemoryTable('[{"status":"complete"}]', "", 0)).toEqual([{ status: "complete" }]);
  expect(() => parseMemoryTable("", "There are no documents in this table.", 1)).toThrow();
  expect(() => parseMemoryTable("", "", 0)).toThrow();
  expect(() => parseMemoryTable("", "Unexpected failure", 0)).toThrow();
});

test("migration gate accepts drained history and rejects active or unrecognized states", () => {
  expect(inspectMemoryMigration(empty).drained).toBe(true);
  expect(inspectMemoryMigration({
    jobs: ["success", "failed", "canceled"].map(kind => ({ state: { kind } })),
    repositories: [{ deleting: false }],
    ingestions: [{ status: "complete" }, { status: "failed" }],
  }).drained).toBe(true);
  for (const kind of ["pending", "inProgress", "unknown"]) {
    expect(() => inspectMemoryMigration({ ...empty, jobs: [{ state: { kind } }] })).toThrow();
  }
  for (const status of ["pending", "processing", "awaiting_reembed", "unknown"]) {
    expect(() => inspectMemoryMigration({ ...empty, ingestions: [{ status }] })).toThrow();
  }
  for (const row of [{ deleting: true }, { deleting: false, pendingEmbedding: {} }, {}]) {
    expect(() => inspectMemoryMigration({ ...empty, repositories: [row] })).toThrow();
  }
  expect(() => inspectMemoryMigration({ ...empty, ingestions: Array.from({ length: 1001 }, () => ({ status: "complete" })) })).toThrow();
});
