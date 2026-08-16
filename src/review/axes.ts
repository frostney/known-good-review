export const reviewAxes = [
  "deduplication",
  "claim-and-specification",
  "engineering-quality",
  "discoverability",
] as const;

export type ReviewAxis = (typeof reviewAxes)[number];

export function isReviewAxis(value: string): value is ReviewAxis {
  return (reviewAxes as readonly string[]).includes(value);
}
