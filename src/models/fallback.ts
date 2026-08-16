import type { ModelChain } from "../config/review-config";

export interface ModelFailure {
  readonly code?: string;
  readonly httpStatus?: number;
}

const transientCodes = new Set([
  "rate_limit",
  "rate_limited",
  "overloaded",
  "timeout",
  "request_timeout",
  "server_error",
  "service_unavailable",
]);

export function isTransientModelFailure(failure: ModelFailure): boolean {
  if (failure.code && transientCodes.has(failure.code.toLowerCase())) {
    return true;
  }
  return (
    failure.httpStatus === 408 ||
    failure.httpStatus === 429 ||
    (failure.httpStatus !== undefined && failure.httpStatus >= 500)
  );
}

export function nextFallbackModel(
  chain: ModelChain,
  attempt: number,
  failure: ModelFailure,
): { readonly attempt: number; readonly model: ModelChain[number] } | null {
  if (!isTransientModelFailure(failure)) {
    return null;
  }
  const nextAttempt = attempt + 1;
  const model = chain[nextAttempt];
  return model === undefined ? null : { attempt: nextAttempt, model };
}
