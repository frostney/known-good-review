import { deleteTokenCacheEntry, type ConnectTokenParams } from "@vercel/connect";

// Entries exist only while recovery is running. A delayed 401 must not evict
// a replacement token already obtained by another request or adapter instance.
const recoveries = new Map<string, Promise<string>>();

export function connectGitHubRecoveryFetch(
  connector: string,
  params: ConnectTokenParams,
  resolveToken: () => string | Promise<string>,
): typeof fetch {
  const key = JSON.stringify({ connector, ...params });
  function recover(rejectedToken: string): Promise<string> {
    const pending = recoveries.get(key);
    if (pending) return pending;
    const recovery = (async () => {
      const current = await resolveToken();
      if (current !== rejectedToken) return current;
      deleteTokenCacheEntry(connector, params);
      return resolveToken();
    })();
    recoveries.set(key, recovery);
    void recovery.finally(() => {
      if (recoveries.get(key) === recovery) recoveries.delete(key);
    }).catch(() => {});
    return recovery;
  }

  return Object.assign(async (resource: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? (resource instanceof Request ? resource.signal : undefined);
    signal?.throwIfAborted();
    const headers = new Headers(init?.headers ?? (resource instanceof Request ? resource.headers : undefined));
    const authorization = headers.get("authorization");
    const bearer = authorization?.match(/^(Bearer|token) (.+)$/i);
    const url = new URL(resource instanceof Request ? resource.url : String(resource));
    const retryResource = resource instanceof Request ? resource.clone() : resource;
    const response = await fetch(resource, init);
    if (response.status !== 401 || url.origin !== "https://api.github.com" ||
      (response.url && new URL(response.url).origin !== url.origin) || !bearer?.[2]) return response;
    signal?.throwIfAborted();
    await response.body?.cancel();
    const recovery = recover(bearer[2]);
    let abort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          // Connect cannot cancel token exchange. Do not retain a stalled
          // exchange as the recovery promise for future requests after abort.
          if (recoveries.get(key) === recovery) recoveries.delete(key);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      const token = await Promise.race([recovery, cancelled]);
      signal?.throwIfAborted();
      headers.set("authorization", `${bearer[1]} ${token}`);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    // Call the underlying transport directly so a second 401 is terminal.
    return fetch(retryResource, { ...init, headers });
  }, { preconnect: fetch.preconnect });
}
