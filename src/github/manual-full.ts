const manualFullPattern =
  /(?:@known-good-review|\/known-good-review)\s+(?:run\s+)?full\s+review\b/i;

export function requestsManualFullReview(body: string): boolean {
  return manualFullPattern.test(body);
}

export function canRequestManualFull(permission: string): boolean {
  return new Set(["admin", "maintain", "write"]).has(permission.toLowerCase());
}

export async function acknowledgeManualFullReview(thread: {
  readonly react: (reaction: "eyes") => Promise<unknown>;
}): Promise<boolean> {
  try {
    await thread.react("eyes");
    return true;
  } catch {
    return false;
  }
}
