function normalizeRoot(root: string): string {
  return root.replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
}

export function discoverabilityApplies(
  paths: readonly string[],
  publicRoots: readonly string[],
): boolean {
  const roots = publicRoots.map(normalizeRoot);
  return paths.some((path) => {
    const normalized = path.toLowerCase();
    if (
      roots.some(
        (root) => normalized === root || normalized.startsWith(`${root}/`),
      )
    ) {
      return true;
    }
    const segments = normalized.split("/");
    if (
      segments.some((segment) =>
        ["website", "seo", "landing", "blog", "legal"].includes(segment),
      )
    ) {
      return true;
    }
    const basename = segments.at(-1)?.replace(/\.[^.]+$/, "") ?? "";
    return [
      "robots",
      "sitemap",
      "opengraph-image",
      "twitter-image",
      "favicon",
      "icon",
    ].includes(basename);
  });
}
