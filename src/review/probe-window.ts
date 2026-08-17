export const reviewLaneProbeSteps = 12;
export const coordinatorReviewSteps = 12;

export function reviewLaneProbeWindowClosed(input: {
  readonly channelKind: string | undefined;
  readonly stepIndex: number;
}): boolean {
  return (
    input.channelKind === "subagent" &&
    Number.isInteger(input.stepIndex) &&
    input.stepIndex >= reviewLaneProbeSteps
  );
}

export function coordinatorReviewWindowClosed(input: {
  readonly channelKind: string | undefined;
  readonly reviewKind: string | undefined;
  readonly stepIndex: number;
}): boolean {
  return (
    input.channelKind === "github" &&
    (input.reviewKind === "full" || input.reviewKind === "delta") &&
    Number.isInteger(input.stepIndex) &&
    input.stepIndex >= coordinatorReviewSteps
  );
}
