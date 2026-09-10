import { defineState } from "eve/context";
import type { InstrumentationModelCallStartedEvent, InstrumentationModelCallCompletedEvent, InstrumentationStepAttemptMetadataEvent } from "eve/instrumentation";

export interface ModelObservation {
  readonly eventId: string;
  readonly completed: boolean;
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly actualModel: string | null;
  readonly provider: string | null;
  readonly generationId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly costUsd: number | null;
}

// Providers see operation state; the session-owned inbox joins usage and later
// metadata and remains available to control hooks after worker turnover.
export const modelObservations = defineState<readonly ModelObservation[]>(
  "known-good-review.model-observations.v1", () => [],
);

export function observeModelStart(
  current: readonly ModelObservation[],
  event: InstrumentationModelCallStartedEvent,
): readonly ModelObservation[] {
  if (current.some(observation => observation.eventId === event.idempotencyKey)) return current;
  return [...current, {
    eventId: event.idempotencyKey, completed: false,
    attemptId: event.scope.attemptId, attemptIndex: event.scope.attemptIndex,
    sessionId: event.scope.sessionId, turnId: event.scope.turnId, stepIndex: event.scope.stepIndex,
    actualModel: event.model.modelId, provider: event.model.provider,
    generationId: "", inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
  }];
}

export function observeModelCall(
  current: readonly ModelObservation[],
  event: InstrumentationModelCallCompletedEvent,
): readonly ModelObservation[] {
  const previous = current.find(observation => observation.eventId === event.idempotencyKey);
  if (previous?.completed) return current;
  const observation: ModelObservation = {
    eventId: event.idempotencyKey, completed: true,
    attemptId: event.scope.attemptId, attemptIndex: event.scope.attemptIndex,
    sessionId: event.scope.sessionId, turnId: event.scope.turnId, stepIndex: event.scope.stepIndex,
    actualModel: previous?.actualModel ?? null, provider: previous?.provider ?? null,
    generationId: previous?.generationId ?? "",
    inputTokens: event.usage.inputTokens ?? null,
    outputTokens: event.usage.outputTokens ?? null,
    cacheReadTokens: event.usage.inputTokenDetails?.cacheReadTokens ?? null,
    cacheWriteTokens: event.usage.inputTokenDetails?.cacheWriteTokens ?? null,
    costUsd: previous?.costUsd ?? null,
  };
  return previous
    ? current.map(entry => entry.eventId === observation.eventId ? observation : entry)
    : [...current, observation];
}

export function observeModelMetadata(
  current: readonly ModelObservation[],
  event: InstrumentationStepAttemptMetadataEvent,
): readonly ModelObservation[] {
  // Eve emits metadata after the corresponding SDK model call. A retried Eve
  // step has a distinct attemptId; an SDK step within it has its own call key.
  let index = current.length - 1;
  while (index >= 0 && current[index]?.attemptId !== event.scope.attemptId) index -= 1;
  if (index < 0) return current;
  const gateway = event.providerMetadata.gateway;
  if (typeof gateway !== "object" || gateway === null || Array.isArray(gateway)) return current;
  const generationId = "generationId" in gateway && typeof gateway.generationId === "string" ? gateway.generationId : "";
  const rawCost = "cost" in gateway ? gateway.cost : undefined;
  const cost = typeof rawCost === "number" || (typeof rawCost === "string" && rawCost.trim() !== "") ? Number(rawCost) : NaN;
  return current.map((observation, position) => position !== index ? observation : {
    ...observation, generationId, costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
  });
}
