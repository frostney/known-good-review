import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { justbash } from "eve/sandbox/just-bash";
import { serializeSandboxMetadata } from "./fixtures/eve-runtime-smoke/agent/lib/sandbox-lifecycle";

test("native just-bash reconnect cannot read a fixture snapshot during its truncate/write window", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "slop-sheriff-sandbox-"));
  const native = justbash({ autoInstall: false });
  const input = { sessionKey: "root", templateKey: null, runtimeContext: { appRoot } };
  const initial = await native.create(input);
  let releaseSnapshot = () => {};
  let snapshotEntered = () => {};
  const entered = new Promise<void>((resolve) => { snapshotEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  try {
    const state = await initial.captureState();
    const rootPath = state.metadata.rootPath;
    if (typeof rootPath !== "string") throw new Error("Native backend omitted its filesystem identity");
    const metadataPath = join(rootPath, "metadata.json");
    const original = await readFile(metadataPath, "utf8");

    // Reproduce the exact installed reader failure while writeFile has truncated the snapshot.
    await writeFile(metadataPath, "");
    await expect(native.create(input)).rejects.toThrow(SyntaxError);
    await writeFile(metadataPath, original);

    let rootReads = 0;
    const serialized = serializeSandboxMetadata({
      ...native,
      async create(options) {
        if (options.sessionKey === "root") rootReads++;
        const handle = await native.create(options);
        return {
          ...handle,
          async captureState() {
            await writeFile(metadataPath, "");
            snapshotEntered();
            await release;
            return handle.captureState();
          },
        };
      },
    });
    const handle = await serialized.create(input);
    const snapshot = handle.captureState();
    await entered;
    const reconnect = serialized.create(input);
    await Promise.resolve();
    expect(rootReads).toBe(1);
    const independent = await serialized.create({ ...input, sessionKey: "independent-root" });
    await independent.shutdown();
    releaseSnapshot();
    await snapshot;
    const reopened = await reconnect;
    expect(rootReads).toBe(2);
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({ version: 1 });
    await Promise.all([handle.shutdown(), reopened.shutdown()]);
  } finally {
    releaseSnapshot();
    await initial.shutdown();
    await rm(appRoot, { recursive: true, force: true });
  }
});
