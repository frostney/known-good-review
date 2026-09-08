import { gatewayTelemetryIdentity, type PendingGatewayTelemetry } from './gateway-reconciliation';

export type TurnUsageObservation = Pick<PendingGatewayTelemetry,
  'eventId' | 'sessionId' | 'turnId' | 'stepIndex' | 'generationId' |
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd'>;

export interface TurnUsageState {
  readonly turnId: string;
  readonly observations: readonly TurnUsageObservation[];
  readonly completed: boolean;
}

export function recordTurnUsage(current: TurnUsageState | null, observation: TurnUsageObservation): TurnUsageState {
  const state = current?.turnId === observation.turnId ? current : {
    turnId: observation.turnId, observations: [], completed: false,
  };
  if (state.completed) return state;
  const identity = gatewayTelemetryIdentity(observation);
  const existing = state.observations.find(entry => gatewayTelemetryIdentity(entry) === identity);
  if (existing) {
    if (existing.inputTokens !== observation.inputTokens ||
        existing.outputTokens !== observation.outputTokens ||
        existing.cacheReadTokens !== observation.cacheReadTokens ||
        existing.cacheWriteTokens !== observation.cacheWriteTokens ||
        existing.costUsd !== observation.costUsd) {
      throw new Error('Conflicting turn usage shares one stable generation identity');
    }
    return state;
  }
  return { ...state, observations: [...state.observations, observation] };
}

export function summarizeTurnUsage(state: TurnUsageState) {
  const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd'): number | null => {
    let total = 0;
    for (const observation of state.observations) {
      const value = observation[key];
      if (value === null) return null;
      total += value;
    }
    return total;
  };
  return {
    modelSteps: state.observations.length,
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'),
    sdkCostUsd: sum('costUsd'),
  };
}
