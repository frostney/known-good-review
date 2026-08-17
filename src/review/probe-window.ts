export const reviewLaneProbeSteps = 12;

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
