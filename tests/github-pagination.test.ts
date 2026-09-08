import { expect, test } from "bun:test";
import { fetchBoundedGitHubPages } from "../src/github/pagination";

test("accepts exactly 2,000 GitHub records and rejects an overflowing page", async () => {
  for (const count of [0, 100, 1_999, 2_000, 2_001]) {
    const paths: string[] = [];
    const result = fetchBoundedGitHubPages(async (path) => {
      paths.push(path);
      const page = Number(new URL(path, "https://github.test").searchParams.get("page"));
      return { body: Array.from({ length: Math.max(0, Math.min(100, count - (page - 1) * 100)) }, () => ({})) };
    }, "/items?state=open");
    if (count <= 2_000) expect((await result).length).toBe(count);
    else await expect(result).rejects.toThrow("2,000 item limit");
    expect(paths.length).toBe(Math.floor(count / 100) + 1);
    expect(paths[0]).toBe("/items?state=open&per_page=100&page=1");
  }
});
