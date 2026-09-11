/** An absent new config permits legacy fallback; empty or invalid content does not. */
export async function readReviewConfigSource(
  read: (path: string) => Promise<string | null>,
): Promise<string> {
  const source = await read(".github/slop-sheriff.yml");
  return source ?? await read(".github/known-good-review.yml") ?? "";
}
