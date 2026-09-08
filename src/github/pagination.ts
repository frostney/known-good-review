import { z } from "zod";

export async function fetchBoundedGitHubPages(
  request: (path: string) => Promise<{ readonly body: unknown }>,
  path: string,
): Promise<unknown[]> {
  const all: unknown[] = [];
  const separator = path.includes("?") ? "&" : "?";
  // Page 21 is a lookahead: exactly 2,000 items are within the bound.
  for (let page = 1; page <= 21; page += 1) {
    const response = await request(`${path}${separator}per_page=100&page=${page}`);
    const items = z.array(z.unknown()).max(100).parse(response.body);
    if (all.length + items.length > 2_000) break;
    all.push(...items);
    if (items.length < 100) return all;
  }
  throw new Error(`GitHub pagination exceeded the bounded 2,000 item limit for ${path}`);
}
