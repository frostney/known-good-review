import { describe, expect, spyOn, test } from "bun:test";
import usageCapture from "./fixtures/pr65-telemetry-usage.json";
import { createGateway, GatewayNotFoundError, GatewayResponseError } from "@ai-sdk/gateway";
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
  test("bounds the installed Gateway lookup and retains a stalled record", async () => {
    const priorKey = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "offline-telemetry-fixture";
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadlines = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(5_000);
      return timeout(30);
    });
    let aborted = false;
    const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_resource: unknown, init?: RequestInit) => {
      if (!init?.signal) throw new Error("Missing request deadline");
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal?.reason); }, { once: true });
      });
    }, { preconnect: () => {} }));
    try {
      const result = await reconcileGatewayTelemetry({ pending: [observation], retryDelaysMs: [0] });
      expect(aborted).toBe(true);
      expect(result.pending).toEqual([observation]);
      expect(result.resolved).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
    } finally {
      deadlines.mockRestore(); network.mockRestore();
      if (priorKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = priorKey;
    }
  });

  test("retries a delayed record represented by the SDK response error", async () => {
    let attempts = 0;
    const result = await reconcileGatewayTelemetry({
      pending: [observation],
      retryDelaysMs: [0, 0],
      getGenerationInfo: async () => {
        attempts += 1;
        throw new GatewayResponseError({ statusCode: 404 });
      },
    });
    expect(attempts).toBe(2);
    expect(result.diagnostics[0]).toMatchObject({ retryable: true, attempts: 2 });
    expect(result.pending).toEqual([observation]);
  });

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
        sdkCostUsd: 0.01,
        gatewayNativeUsage: { promptTokens: 11, completionTokens: 3, reasoningTokens: 0, cachedTokens: 5, cacheCreationTokens: 2 },
        costUsd: 0.02,
        durationMs: 1_110,
        latencyMs: 120,
      },
    ]);
  });

  test("retries the generation endpoint's production 404 response shape", async () => {
    let attempts = 0;
    const gateway = createGateway({
      apiKey: "test-key",
      baseURL: "https://gateway.test/v4/ai",
      fetch: Object.assign(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            return Response.json({}, { status: 404 });
          }
          return Response.json({
            data: {
              id: "gen_one",
              total_cost: 0.02,
              upstream_inference_cost: 0.02,
              usage: 0.02,
              created_at: "2026-08-26T12:30:39.000Z",
              model: "openai/gpt-5.6-sol",
              is_byok: false,
              provider_name: "bedrock",
              streamed: true,
              finish_reason: "stop",
              latency: 120,
              generation_time: 1_110,
              native_tokens_prompt: 11,
              native_tokens_completion: 3,
              native_tokens_reasoning: 0,
              native_tokens_cached: 5,
              native_tokens_cache_creation: 2,
              billable_web_search_calls: 0,
            },
          });
        },
        { preconnect() {} },
      ),
    });
    const result = await reconcileGatewayTelemetry({
      pending: [observation],
      retryDelaysMs: [0, 0],
      getGenerationInfo: (generationId) =>
        gateway.getGenerationInfo({ id: generationId }),
    });

    expect(attempts).toBe(2);
    expect(result.pending).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.resolved).toHaveLength(1);
  });

  test("deduplicates at-least-once hook delivery by stable generation identity", () => {
    expect(enqueuePendingGatewayTelemetry([observation], {
      ...observation, eventId: "new-event-envelope",
    })).toEqual([observation]);
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

test("preserves all recorded PR65 SDK usage and exact Gateway accounting categories", async () => {
  const pending = usageCapture.steps.map(step => ({
    ...observation, ...step.usage, generationId: step.generationId,
    stepIndex: step.stepIndex, turnId: step.turnId,
  }));
  const result = await reconcileGatewayTelemetry({
    pending, retryDelaysMs: [0],
    getGenerationInfo: id => {
      const native = usageCapture.native.find(generation => generation.id === id);
      if (!native) throw new Error("Missing recorded generation");
      // Replay the real native response through the installed SDK parser.
      const gateway = createGateway({
        apiKey: "offline-capture", baseURL: "https://gateway.test/v4/ai",
        fetch: Object.assign(async () => Response.json({ data: native }), { preconnect() {} }),
      });
      return gateway.getGenerationInfo({ id });
    },
  });
  expect(result.pending).toEqual([]);
  expect(result.resolved).toHaveLength(5);
  for (const [index, resolved] of result.resolved.entries()) {
    const recorded = usageCapture.steps[index];
    const native = usageCapture.native[index];
    expect(resolved).toMatchObject({
      ...recorded?.usage,
      sdkCostUsd: recorded?.usage.costUsd,
      costUsd: native?.total_cost,
      gatewayNativeUsage: {
        promptTokens: native?.native_tokens_prompt,
        completionTokens: native?.native_tokens_completion,
        reasoningTokens: native?.native_tokens_reasoning,
        cachedTokens: native?.native_tokens_cached,
        cacheCreationTokens: native?.native_tokens_cache_creation,
      },
    });
  }
  expect(result.resolved.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)).toBeCloseTo(0.0743096, 10);
});
