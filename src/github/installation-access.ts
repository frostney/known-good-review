import type { Octokit } from "@octokit/rest";
import { z } from "zod";

const repositorySchema = z.object({ node_id: z.string().min(1) });

export async function accessibleRepositoryIds(
  octokit: Octokit,
  options: { readonly wantedRepositoryId?: string; readonly timeoutMs?: number } = {},
): Promise<string[]> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  let abort: () => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([deadline, (async () => {
      const ids: string[] = [];
      // The installed paginator drops parameters.request. Bind the signal to
      // the request defaults so every page's actual fetch receives it.
      const endpoint = octokit.rest.apps.listReposAccessibleToInstallation.endpoint({ per_page: 100 });
      const request = octokit.request.defaults({ request: { signal } });
      for await (const page of octokit.paginate.iterator(request, `GET ${endpoint.url}`)) {
        signal.throwIfAborted();
        for (const repository of page.data) {
          const id = repositorySchema.parse(repository).node_id;
          ids.push(id);
          if (id === options.wantedRepositoryId) return ids;
        }
      }
      return ids;
    })()]);
  } finally {
    // The race also bounds a stalled Connect credential hook before fetch.
    signal.removeEventListener("abort", abort);
  }
}
