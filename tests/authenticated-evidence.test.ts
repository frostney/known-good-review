import { expect, test } from "bun:test";
import { authenticatedEvidenceSandbox } from "../src/review/authenticated-evidence";

test("authenticates content, artifact path, review session, and signing key", async () => {
  const files = new Map<string, string>();
  const raw = {
    marker: "underlying sandbox",
    async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; },
    async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content); },
    owner() { return this.marker; },
  };
  const key = "ab".repeat(32);
  const path = "/tmp/known-good-review/evidence/ledger.json";
  const content = '{"digest":"attacker-can-recompute-this"}\n';
  const signed = authenticatedEvidenceSandbox(raw, "root-1", key);
  expect(signed.owner()).toBe(raw.marker);
  await signed.writeTextFile({ path, content });
  expect(await signed.readTextFile({ path })).toBe(content);
  const envelope = files.get(path)!;
  expect(envelope).not.toContain(key);
  for (const source of [content, envelope.replace("attacker", "forger"), ""]) {
    files.set(path, source);
    await expect(signed.readTextFile({ path })).rejects.toThrow("authentication failed");
  }
  files.set(path, envelope);
  const otherPath = "/tmp/known-good-review/checkpoints/axis.json";
  files.set(otherPath, envelope);
  await expect(signed.readTextFile({ path: otherPath })).rejects.toThrow("authentication failed");
  for (const [scope, secret] of [["root-2", key], ["root-1", "cd".repeat(32)]]) {
    await expect(authenticatedEvidenceSandbox(raw, scope!, secret).readTextFile({ path }))
      .rejects.toThrow("authentication failed");
  }
  await signed.writeTextFile({ path: "src/file.ts", content });
  expect(files.get("src/file.ts")).toBe(content);
  expect(await signed.readTextFile({ path: "/tmp/known-good-review/missing" })).toBeNull();
  expect(() => authenticatedEvidenceSandbox(raw, "root-1", undefined)).toThrow("EVIDENCE_KEY");
});
