import { describe, expect, test } from "bun:test";
import { GatewayNotFoundError, GatewayResponseError } from "@ai-sdk/gateway";
import {
  enqueuePendingGatewayTelemetry,
  reconcileGatewayTelemetry,
  type PendingGatewayTelemetry,
} from "../src/telemetry/gateway-reconciliation";

const observation: PendingGatewayTelemetry = {
  eventId: "event_one",
  sessionId: "session_one",
  turnId: "turn_one",
  stepIndex: 2,
  generationId: "gen_one",
  reviewKind: "full",
  phase: "fresh-axes",
  reviewAxis: "engineering-quality",
  attempt: 0,
  memoryPolicyHash: "policy_one",
  requestedModel: "openai/gpt-5.6-sol",
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 4,
  cacheWriteTokens: 1,
  costUsd: 0.01,
};

describe("Gateway telemetry reconciliation", () => {
  test("enriches a generation that becomes available after the first lookup", async () => {
    let attempts = 0;
    const result = await reconcileGatewayTelemetry({
      pending: [observation],
      retryDelaysMs: [0, 0],
      getGenerationInfo: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new GatewayNotFoundError();
        }
        return {
          id: "gen_one",
          totalCost: 0.02,
          upstreamInferenceCost: 0.02,
          usage: 0.02,
          createdAt: "2026-08-26T12:30:39.000Z",
          model: "openai/gpt-5.6-sol",
          isByok: false,
          providerName: "bedrock",
          streamed: true,
          finishReason: "stop",
          latency: 120,
          generationTime: 1_110,
          promptTokens: 11,
          completionTokens: 3,
          reasoningTokens: 0,
          cachedTokens: 5,
          cacheCreationTokens: 2,
          billableWebSearchCalls: 0,
        };
      },
    });

    expect(attempts).toBe(2);
    expect(result.pending).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.resolved).toEqual([
      {
        ...observation,
        actualModel: "openai/gpt-5.6-sol",
        provider: "bedrock",
        inputTokens: 11,
        outputTokens: 3,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        costUsd: 0.02,
        durationMs: 1_110,
        latencyMs: 120,
      },
    ]);
  });

  test("deduplicates at-least-once hook delivery by stable generation identity", () => {
    expect(enqueuePendingGatewayTelemetry([observation], observation)).toEqual([
      observation,
    ]);
    expect(() =>
      enqueuePendingGatewayTelemetry([observation], {
        ...observation,
        costUsd: 0.02,
      }),
    ).toThrow("Conflicting Gateway telemetry");
  });

  test("retains a nonretryable lookup with safe diagnostics", async () => {
    let attempts = 0;
    const authenticationError = Object.assign(
      new Error("credential details are intentionally omitted"),
      { name: "GatewayAuthenticationError", statusCode: 401 },
    );
    const result = await reconcileGatewayTelemetry({
      pending: [observation],
      retryDelaysMs: [0, 0, 0],
      getGenerationInfo: async () => {
        attempts += 1;
        throw authenticationError;
      },
    });

    expect(attempts).toBe(1);
    expect(result.resolved).toEqual([]);
    expect(result.pending).toEqual([observation]);
    expect(result.diagnostics).toEqual([
      {
        telemetryId: "session_one:turn_one:2:gen_one",
        generationId: "gen_one",
        error: "GatewayAuthenticationError",
        statusCode: 401,
        retryable: false,
        attempts: 1,
        validationIssues: [],
      },
    ]);
    expect(result.diagnostics[0]).not.toHaveProperty("message");
  });

  test("continues reconciling retryable records beside a terminal failure", async () => {
    const attempts = new Map<string, number>();
    const delayed = { ...observation, generationId: "gen_delayed" };
    const authentication = { ...observation, generationId: "gen_auth" };
    const result = await reconcileGatewayTelemetry({
      pending: [authentication, delayed],
      retryDelaysMs: [0, 0],
      getGenerationInfo: async (generationId) => {
        attempts.set(generationId, (attempts.get(generationId) ?? 0) + 1);
        if (generationId === "gen_auth") {
          throw Object.assign(new Error("omitted"), {
            name: "GatewayAuthenticationError",
            statusCode: 401,
          });
        }
        if (attempts.get(generationId) === 1) {
          throw new GatewayNotFoundError();
        }
        return {
          id: generationId,
          totalCost: 0.02,
          upstreamInferenceCost: 0.02,
          usage: 0.02,
          createdAt: "2026-08-26T12:30:39.000Z",
          model: observation.requestedModel,
          isByok: false,
          providerName: "bedrock",
          streamed: true,
          finishReason: "stop",
          latency: 120,
          generationTime: 1_110,
          promptTokens: 11,
          completionTokens: 3,
          reasoningTokens: 0,
          cachedTokens: 5,
          cacheCreationTokens: 2,
          billableWebSearchCalls: 0,
        };
      },
    });

    expect(attempts).toEqual(
      new Map([
        ["gen_auth", 1],
        ["gen_delayed", 2],
      ]),
    );
    expect(result.resolved.map((entry) => entry.generationId)).toEqual([
      "gen_delayed",
    ]);
    expect(result.pending).toEqual([authentication]);
  });

  test("reports strict response-schema paths without logging response values", async () => {
    let attempts = 0;
    const result = await reconcileGatewayTelemetry({
      pending: [observation],
      retryDelaysMs: [0, 0],
      getGenerationInfo: async () => {
        attempts += 1;
        throw new GatewayResponseError({
          statusCode: 200,
          validationError: Object.assign(new Error("value omitted"), {
            cause: {
              issues: [
                {
                  code: "invalid_type",
                  path: ["data", "provider_name"],
                  message: "value omitted",
                },
              ],
            },
          }) as never,
        });
      },
    });

    expect(result.diagnostics[0]?.validationIssues).toEqual([
      { code: "invalid_type", path: ["data", "provider_name"] },
    ]);
    expect(attempts).toBe(1);
    expect(result.diagnostics[0]?.retryable).toBe(false);
    expect(result.diagnostics[0]).not.toHaveProperty("response");
  });
});
