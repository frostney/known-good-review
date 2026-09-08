import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectivePatchFingerprint } from "../src/review/effective-patch";
import { parsePullRequestFiles } from "../src/github/inbound";

function fingerprint(sha: string, patch: string | null, additions = 1, deletions = 1) {
  return effectivePatchFingerprint(parsePullRequestFiles([{
    filename: "code.txt", status: "modified", sha, additions, deletions, ...(patch === null ? {} : { patch }),
  }]));
}

test("real rebases keep complete effective patches stable when unrelated base content changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "known-good-patch-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Audit", "-c", "user.email=audit@example.invalid", ...args], { cwd: dir });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trimEnd();
  };
  try {
    git("init", "--initial-branch=main");
    const original = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n") + "\n";
    await writeFile(join(dir, "code.txt"), original);
    git("add", "."); git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-b", "feature");
    await writeFile(join(dir, "code.txt"), original.replace("line 30", "reviewed change"));
    git("commit", "-am", "reviewed change");
    const patch = (from: string) => git("diff", "--no-ext-diff", from, "HEAD", "--", "code.txt").split(/(?=^@@ )/m).slice(1).join("");
    const firstPatch = patch(base);
    const firstBlob = git("rev-parse", "HEAD:code.txt");
    git("checkout", "main");
    await writeFile(join(dir, "code.txt"), `new base line\n${original}`);
    git("commit", "-am", "unrelated base advancement");
    git("checkout", "feature"); git("rebase", "main");
    const nextPatch = patch("main");
    const nextBlob = git("rev-parse", "HEAD:code.txt");
    expect(nextBlob).not.toBe(firstBlob);
    expect(nextPatch).not.toBe(firstPatch);
    expect(fingerprint(nextBlob, nextPatch)).toBe(fingerprint(firstBlob, firstPatch));
    expect(fingerprint(nextBlob, nextPatch.replace("+reviewed change", "+different change")))
      .not.toBe(fingerprint(firstBlob, firstPatch));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("retains content identity for missing, truncated, and malformed patches", () => {
  const complete = "@@ -1 +1 @@\n-old\n+new";
  expect(fingerprint("before", complete)).toBe(fingerprint("after", complete));
  for (const patch of [null, "", "@@ -1,2 +1,2 @@\n-old\n+new", "@@ -1 +1 @@\n-old", "-old\n+new"]) {
    expect(fingerprint("before", patch)).not.toBe(fingerprint("after", patch));
  }
  // A complete first hunk does not prove that the API included the later hunks.
  expect(fingerprint("before", complete, 2, 2)).not.toBe(fingerprint("after", complete, 2, 2));
  expect(fingerprint("before", `${complete}\n\\ No newline at end of file`))
    .toBe(fingerprint("after", `${complete}\n\\ No newline at end of file`));
  expect(fingerprint("same", "@@ -1 +1 @@\n-old\r\n+new\r"))
    .not.toBe(fingerprint("same", complete));
});
