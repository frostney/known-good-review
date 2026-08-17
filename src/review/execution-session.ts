export function ownsReviewLifecycle(input: {
  readonly channelKind: string | undefined;
  readonly hasParent: boolean;
}): boolean {
  return input.channelKind !== "subagent" && !input.hasParent;
}
