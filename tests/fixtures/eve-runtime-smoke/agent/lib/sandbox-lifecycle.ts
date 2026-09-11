import type { SandboxBackend } from "eve/sandbox";

/** Eve 0.52.5 just-bash snapshots truncate metadata before writing; protect native reconnect reads. */
export function serializeSandboxMetadata(backend: SandboxBackend): SandboxBackend {
  const pending = new Map<string, Promise<void>>();
  function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (pending.get(key) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    pending.set(key, settled);
    return result.finally(() => {
      if (pending.get(key) === settled) pending.delete(key);
    });
  }
  return {
    ...backend,
    create(input) {
      const key = `${input.runtimeContext.appRoot}\0${input.sessionKey}`;
      return serialize(key, async () => {
        const handle = await backend.create(input);
        return {
          ...handle,
          captureState: () => serialize(key, () => handle.captureState()),
          delete: (options) => serialize(key, () => handle.delete(options)),
        };
      });
    },
  };
}
