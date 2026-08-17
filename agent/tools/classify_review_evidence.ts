import { createHash, randomUUID } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  reviewContextAttributes,
  trustedGitHubContext,
} from "../../src/github/trusted-context";
import { prepareReviewWorkspace } from "../../src/github/review-workspace";

const reviewFilesSchema = z.array(
  z.object({
    path: z.string().min(1),
    status: z.string().min(1),
  }),
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function attributeValue(output: string, attribute: string): string | null {
  const suffix = `: ${attribute}: `;
  const line = output
    .split("\n")
    .find((candidate) => candidate.includes(suffix));
  return line ? line.slice(line.indexOf(suffix) + suffix.length).trim() : null;
}

function isSet(value: string | null): boolean {
  return value === "set" || value === "true";
}

export default defineTool({
  description:
    "Classify the exact review file scope from the trusted base attributes and Git binary result. Call this before reading diffs. Do not read raw content for returned excluded files; use their canonical metadata and inspect source inputs or generators instead.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    const rawFiles =
      ctx.session.auth.current?.attributes[reviewContextAttributes.reviewFiles];
    if (typeof rawFiles !== "string") {
      throw new Error("Trusted review context is missing the exact file scope");
    }
    const files = reviewFilesSchema.parse(JSON.parse(rawFiles));
    const sandbox = await ctx.getSandbox();
    await prepareReviewWorkspace(trusted, sandbox);
    const indexPath = `/tmp/known-good-review-index-${randomUUID()}`;
    const base = shellQuote(trusted.baseSha);
    const head = shellQuote(trusted.headSha);
    const prepared = await sandbox.run({
      command: `cd /workspace && GIT_INDEX_FILE=${shellQuote(indexPath)} git read-tree ${base}`,
    });
    if (prepared.exitCode !== 0) {
      throw new Error(
        "Could not prepare trusted-base attributes for review evidence",
      );
    }
    const encoder = getEncoding("o200k_base");
    const included: string[] = [];
    const excluded: Array<{
      path: string;
      classification: string[];
      status: string;
      addedLines: number;
      deletedLines: number;
      patchCharacters: number;
      patchTokens: number;
      patchSha256: string;
    }> = [];
    try {
      for (const file of files) {
        const path = shellQuote(file.path);
        const attributes = await sandbox.run({
          command: `cd /workspace && GIT_INDEX_FILE=${shellQuote(indexPath)} git check-attr --cached linguist-generated linguist-vendored binary diff -- ${path}`,
        });
        if (attributes.exitCode !== 0) {
          throw new Error(`Could not classify ${file.path} from trusted-base attributes`);
        }
        const numstat = await sandbox.run({
          command: `cd /workspace && git diff --numstat ${base} ${head} -- ${path}`,
        });
        if (numstat.exitCode !== 0) {
          throw new Error(`Could not classify Git diff for ${file.path}`);
        }
        const [added = "0", deleted = "0"] = String(numstat.stdout)
          .split("\t", 2);
        const classification = [
          ...(isSet(attributeValue(String(attributes.stdout), "linguist-generated"))
            ? ["generated"]
            : []),
          ...(isSet(attributeValue(String(attributes.stdout), "linguist-vendored"))
            ? ["vendored"]
            : []),
          ...(added === "-" ||
          deleted === "-" ||
          isSet(attributeValue(String(attributes.stdout), "binary")) ||
          attributeValue(String(attributes.stdout), "diff") === "unset"
            ? ["binary"]
            : []),
        ];
        if (classification.length === 0) {
          included.push(file.path);
          continue;
        }
        const patch = await sandbox.run({
          command: `cd /workspace && git diff --no-ext-diff --full-index ${base} ${head} -- ${path}`,
        });
        if (patch.exitCode !== 0) {
          throw new Error(`Could not summarize classified patch ${file.path}`);
        }
        const text = String(patch.stdout);
        excluded.push({
          path: file.path,
          classification,
          status: file.status,
          addedLines: added === "-" ? 0 : Number.parseInt(added, 10),
          deletedLines: deleted === "-" ? 0 : Number.parseInt(deleted, 10),
          patchCharacters: text.length,
          patchTokens: encoder.encode(text).length,
          patchSha256: createHash("sha256").update(text).digest("hex"),
        });
      }
    } finally {
      await sandbox.run({ command: `rm -f -- ${shellQuote(indexPath)}` });
    }
    return { included, excluded };
  },
});
