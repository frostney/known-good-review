import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import type schema from "../convex/schema";
import { fileURLToPath } from "node:url";

// The packages' test helpers use Vite's import.meta.glob. Register the same
// installed component schemas/modules using Bun's native glob loader instead.
export async function registerRag(t: TestConvex<typeof schema>): Promise<void> {
  for (const [name, entry] of [
    ["rag", "@convex-dev/rag/test"],
    ["rag/workpool", "@convex-dev/workpool/test"],
    ["rag/workpool/batchWorker", "@convex-dev/batch-worker/test"],
  ] as const) {
    const root = new URL("./component/", import.meta.resolve(entry));
    const imported: { default: SchemaDefinition<GenericSchema, boolean> } = await import(new URL("schema.ts", root).href);
    const modules = Object.fromEntries([...new Bun.Glob("**/*.ts").scanSync({ cwd: fileURLToPath(root) })]
      .map((path) => [`./component/${path}`, () => import(new URL(path, root).href)]));
    t.registerComponent(name, imported.default, modules);
  }
}
