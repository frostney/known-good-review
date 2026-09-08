import { describe, expect, test } from "bun:test";
import {
  changedEffectiveFiles,
  effectivePatchFileFingerprints,
  effectivePatchFingerprint,
  type PatchFile,
} from "../src/review/effective-patch";
import { findingsToRevalidate } from "../src/review/revalidation";

describe("review mechanics", () => {
  test("effective patch identity ignores ordering and diff metadata", () => {
    const first = effectivePatchFingerprint([
      {
        blobSha: "same-blob",
        path: "src/b.ts",
        status: "modified",
        patch: "index abc..def 100644\n@@ -1 +1 @@\n-old\n+new\n",
      },
      {
        blobSha: "same-other-blob",
        path: "src/a.ts",
        status: "added",
        patch: "@@ -0,0 +1 @@\n+value\n",
      },
    ]);
    const rebased = effectivePatchFingerprint([
      {
        blobSha: "same-other-blob",
        path: "src/a.ts",
        status: "added",
        patch: "@@ -0,0 +1 @@\r\n+value\r\n",
      },
      {
        blobSha: "same-blob",
        path: "src/b.ts",
        status: "modified",
        patch: "index 111..222 100644\n@@ -9 +9 @@\n-old\n+new\n",
      },
    ]);
    expect(rebased).toBe(first);
  });

  test("content SHA distinguishes files whose GitHub patch is unavailable", () => {
    const before: PatchFile[] = [
      {
        blobSha: "old-binary-blob",
        path: "assets/logo.png",
        status: "modified",
        patch: null,
      },
    ];
    const after: PatchFile[] = [
      {
        blobSha: "new-binary-blob",
        path: "assets/logo.png",
        status: "modified",
        patch: null,
      },
    ];

    expect(effectivePatchFingerprint(before)).not.toBe(
      effectivePatchFingerprint(after),
    );
  });

  test("finds exact semantic delta files across rebases", () => {
    const baseline = effectivePatchFileFingerprints([
      {
        blobSha: "old-a",
        path: "a.ts",
        status: "modified",
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
      {
        blobSha: "same-b",
        path: "b.ts",
        status: "added",
        patch: "@@ -0 +1 @@\n+same",
      },
    ]);
    const current = effectivePatchFileFingerprints([
      {
        blobSha: "new-a",
        path: "a.ts",
        status: "modified",
        patch: "@@ -20 +20 @@\n-old\n+newer",
      },
      {
        blobSha: "same-b",
        path: "b.ts",
        status: "added",
        patch: "@@ -0 +99 @@\n+same",
      },
    ]);
    expect(changedEffectiveFiles(baseline, current)).toEqual(["a.ts"]);
  });

  test("revalidates all material findings and only relevant improvements", () => {
    const selected = findingsToRevalidate(
      [
        {
          id: "CR-1",
          severity: "BLOCKING",
          status: "open",
          location: { path: "src/a.ts", line: 1, symbol: "a" },
        },
        {
          id: "CR-2",
          severity: "IMPORTANT",
          status: "deferred",
          location: { path: "src/b.ts", line: 2, symbol: null },
        },
        {
          id: "CR-3",
          severity: "IMPROVEMENT",
          status: "open",
          location: { path: "src/c.ts", line: 3, symbol: "changed" },
        },
        {
          id: "CR-4",
          severity: "IMPROVEMENT",
          status: "open",
          location: { path: "src/d.ts", line: 4, symbol: "unrelated" },
        },
        {
          id: "CR-5",
          severity: "BLOCKING",
          status: "fixed",
          location: { path: "src/e.ts", line: 5, symbol: null },
        },
        {
          id: "CR-6",
          severity: "NITPICK",
          status: "open",
          location: { path: "src/f.ts", line: 6, symbol: "changed" },
        },
        {
          id: "CR-7",
          severity: "NITPICK",
          status: "open",
          location: { path: "src/g.ts", line: 7, symbol: "unrelated" },
        },
      ],
      new Set(["src/other.ts"]),
      new Set(["changed"]),
    );
    expect(selected.map(({ id }) => id)).toEqual([
      "CR-1",
      "CR-2",
      "CR-3",
      "CR-6",
    ]);
  });
});
