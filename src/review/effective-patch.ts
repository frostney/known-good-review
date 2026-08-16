import { createHash } from "node:crypto";

export interface PatchFile {
  readonly blobSha: string;
  readonly path: string;
  readonly previousPath?: string | null;
  readonly status: "added" | "copied" | "deleted" | "modified" | "renamed";
  readonly patch: string | null;
}

function normalizePatch(patch: string | null): string {
  return (patch ?? "")
    .replaceAll("\r\n", "\n")
    .replace(/^index [^\n]+\n/gm, "")
    .replace(/^@@ .* @@/gm, "@@");
}

export function effectivePatchFingerprint(files: readonly PatchFile[]): string {
  const canonical = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({
      blobSha: file.blobSha,
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
      patch: normalizePatch(file.patch),
    }));

  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

export function effectivePatchFileFingerprints(
  files: readonly PatchFile[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    files.map((file) => [file.path, effectivePatchFingerprint([file])]),
  );
}

export function changedEffectiveFiles(
  baseline: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
    .filter((path) => baseline[path] !== current[path])
    .sort();
}
