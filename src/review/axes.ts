import { discoverabilityApplies } from "./discoverability";

export const reviewAxes = [
  "deduplication",
  "claim-and-specification",
  "engineering-quality",
  "discoverability",
  "test-against-spec",
  "writing-quality",
  "test-health",
] as const;

export type ReviewAxis = (typeof reviewAxes)[number];

export function isReviewAxis(value: string): value is ReviewAxis {
  return (reviewAxes as readonly string[]).includes(value);
}

/** Conservative activation: unknown text formats may contain authored prose. */
export function writingQualityApplies(paths: readonly string[]): boolean {
  return paths.some((path) => !/(?:\.(?:png|jpe?g|gif|webp|ico|avif|woff2?|ttf|mp[34]|zip|gz|pdf|wasm|lock)|(?:^|\/)(?:package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml))$/i.test(path));
}

export function testHealthApplies(paths: readonly string[]): boolean {
  return paths.some((path) => !/\.(?:mdx?|rst|adoc|txt|png|jpe?g|gif|webp|ico|avif|woff2?|ttf|mp[34]|zip|gz|pdf)$/i.test(path));
}

export function activeReviewAxes(paths: readonly string[], publicRoots: readonly string[]): ReviewAxis[] {
  const axes: ReviewAxis[] = ["deduplication", "claim-and-specification", "engineering-quality", "test-against-spec"];
  if (discoverabilityApplies(paths, publicRoots)) axes.push("discoverability");
  if (writingQualityApplies(paths)) axes.push("writing-quality");
  if (testHealthApplies(paths)) axes.push("test-health");
  return axes;
}
