import {
  GatewayNotFoundError,
  GatewayResponseError,
  type GatewayGenerationInfo,
} from "@ai-sdk/gateway";

const defaultRetryDelaysMs = [0, 100, 250, 500, 1_000] as const;

export interface PendingGatewayTelemetry {
  readonly eventId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly generationId: string;
  readonly reviewKind: string;
  readonly phase: string;
  readonly reviewAxis: string;
  readonly attempt: number;
  readonly memoryPolicyHash: string;
  readonly requestedModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

export interface ReconciledGatewayTelemetry extends PendingGatewayTelemetry {
  readonly actualModel: string;
  readonly provider: string;
  readonly durationMs: number;
  readonly latencyMs: number;
}

export interface GatewayLookupDiagnostic {
  readonly telemetryId: string;
  readonly generationId: string;
  readonly error: string;
  readonly statusCode: number | null;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly validationIssues: readonly {
    readonly code: string;
    readonly path: readonly (string | number)[];
  }[];
}

interface FailedLookup {
  readonly observation: PendingGatewayTelemetry;
  readonly diagnostic: GatewayLookupDiagnostic;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function gatewayTelemetryIdentity(
  observation: Pick<
    PendingGatewayTelemetry,
    "eventId" | "sessionId" | "turnId" | "stepIndex" | "generationId"
  >,
): string {
  if (!observation.generationId) return observation.eventId;
  return [
    observation.sessionId,
    observation.turnId,
    observation.stepIndex,
    observation.generationId,
  ].join(":");
}

export function enqueuePendingGatewayTelemetry(
  current: readonly PendingGatewayTelemetry[],
  observation: PendingGatewayTelemetry,
): readonly PendingGatewayTelemetry[] {
  const identity = gatewayTelemetryIdentity(observation);
  const existing = current.find(
    (candidate) => gatewayTelemetryIdentity(candidate) === identity,
  );
  if (!existing) return [...current, observation];
  if (JSON.stringify(existing) !== JSON.stringify(observation)) {
    throw new Error("Conflicting Gateway telemetry shares one stable identity");
  }
  return current;
}

function statusCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function validationIssues(
  error: unknown,
): GatewayLookupDiagnostic["validationIssues"] {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if ("issues" in current && Array.isArray(current.issues)) {
      return current.issues.flatMap((issue) => {
        if (typeof issue !== "object" || issue === null) return [];
        const code =
          "code" in issue && typeof issue.code === "string"
            ? issue.code
            : "unknown";
        const rawPath: readonly unknown[] =
          "path" in issue && Array.isArray(issue.path) ? issue.path : [];
        const path = rawPath.filter(
          (part: unknown): part is string | number =>
            typeof part === "string" || typeof part === "number",
        );
        return [{ code, path }];
      });
    }
    if ("validationError" in current) queue.push(current.validationError);
    if ("cause" in current) queue.push(current.cause);
  }
  return [];
}

function isRetryableLookup(error: unknown): boolean {
  if (GatewayNotFoundError.isInstance(error)) return true;
  if (GatewayResponseError.isInstance(error)) return error.isRetryable;
  const code = statusCode(error);
  return (
    code === 404 ||
    code === 408 ||
    code === 409 ||
    code === 429 ||
    (code !== null && code >= 500)
  );
}

function diagnostic(
  observation: PendingGatewayTelemetry,
  error: unknown,
  attempts: number,
): GatewayLookupDiagnostic {
  return {
    telemetryId: gatewayTelemetryIdentity(observation),
    generationId: observation.generationId,
    error: errorName(error),
    statusCode: statusCode(error),
    retryable: isRetryableLookup(error),
    attempts,
    validationIssues: validationIssues(error),
  };
}

function enriched(
  observation: PendingGatewayTelemetry,
  generation: GatewayGenerationInfo,
): ReconciledGatewayTelemetry {
  return {
    ...observation,
    actualModel: generation.model,
    provider: generation.providerName,
    inputTokens: generation.promptTokens,
    outputTokens: generation.completionTokens,
    cacheReadTokens: generation.cachedTokens,
    cacheWriteTokens: generation.cacheCreationTokens,
    costUsd: generation.totalCost,
    durationMs: generation.generationTime,
    latencyMs: generation.latency,
  };
}

export async function reconcileGatewayTelemetry(input: {
  readonly pending: readonly PendingGatewayTelemetry[];
  readonly getGenerationInfo: (
    generationId: string,
  ) => Promise<GatewayGenerationInfo>;
  readonly retryDelaysMs?: readonly number[];
  readonly wait?: (milliseconds: number) => Promise<void>;
}): Promise<{
  readonly resolved: readonly ReconciledGatewayTelemetry[];
  readonly pending: readonly PendingGatewayTelemetry[];
  readonly diagnostics: readonly GatewayLookupDiagnostic[];
}> {
  const retryDelaysMs = input.retryDelaysMs ?? defaultRetryDelaysMs;
  if (retryDelaysMs.length === 0) {
    throw new Error("Gateway telemetry reconciliation needs an attempt");
  }
  const wait = input.wait ?? sleep;
  const resolved: ReconciledGatewayTelemetry[] = [];
  const terminalFailures: FailedLookup[] = [];
  let retryablePending = [...input.pending];
  let retryableFailures: FailedLookup[] = [];

  for (const [attemptIndex, delayMs] of retryDelaysMs.entries()) {
    if (retryablePending.length === 0) break;
    if (!Number.isInteger(delayMs) || delayMs < 0) {
      throw new Error(
        "Gateway telemetry retry delays must be nonnegative integers",
      );
    }
    if (delayMs > 0) await wait(delayMs);

    const results = await Promise.all(
      retryablePending.map(async (observation) => {
        try {
          const generation = await input.getGenerationInfo(
            observation.generationId,
          );
          return { kind: "resolved" as const, observation, generation };
        } catch (error) {
          return {
            kind: "failed" as const,
            observation,
            diagnostic: diagnostic(observation, error, attemptIndex + 1),
          };
        }
      }),
    );

    retryableFailures = [];
    for (const result of results) {
      if (result.kind === "resolved") {
        resolved.push(enriched(result.observation, result.generation));
      } else if (result.diagnostic.retryable) {
        retryableFailures.push(result);
      } else {
        terminalFailures.push(result);
      }
    }
    retryablePending = retryableFailures.map((failure) => failure.observation);
  }

  return {
    resolved,
    pending: [...terminalFailures, ...retryableFailures].map(
      (failure) => failure.observation,
    ),
    diagnostics: [...terminalFailures, ...retryableFailures].map(
      (failure) => failure.diagnostic,
    ),
  };
}
