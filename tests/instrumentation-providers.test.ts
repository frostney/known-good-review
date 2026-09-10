import { expect, spyOn, test } from "bun:test";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { HookContext, HookEvent } from "eve/hooks";
import type { InstrumentationEvent, InstrumentationAttemptScope } from "eve/instrumentation";
import { createAiSdkHookBridge } from "../node_modules/eve/dist/src/instrumentation/ai-sdk-hook-bridge.js";
import { createInstrumentationDispatcher } from "../node_modules/eve/dist/src/instrumentation/dispatch.js";
import { ContextContainer, contextStorage, serializeContext, deserializeContext } from "./fixtures/eve-context";
import provider from "../agent/instrumentation/observations";
import { modelObservations } from "../agent/lib/model-observations";
import { pendingGatewayTelemetry } from "../agent/lib/gateway-telemetry";
import telemetry from "../agent/hooks/telemetry";

const scope: InstrumentationAttemptScope = {
  sessionId: "native-session", turnId: "turn", stepIndex: 0,
  attemptId: "native-session:turn:0:0", attemptIndex: 0,
};
const ctx = {
  channel: { kind: "subagent" }, session: { id: scope.sessionId, parent: {}, auth: { current: null } },
} as unknown as HookContext;

function dispatcher(events: InstrumentationEvent[] = []) {
  const dispatch = createInstrumentationDispatcher([
    { name: "production", ...provider },
    { name: "privacy-witness", tracePolicy: provider.tracePolicy, events: {
      "model.call.started": event => { events.push(event); },
      "model.call.completed": event => { events.push(event); },
      "step.attempt.metadata": event => { events.push(event); },
    } },
    { name: "broken-observer", events: { "model.call.completed"() { throw new Error("observer fixture"); } } },
  ], {});
  const bound = dispatch.forTrace?.({ agentName: "test", audience: "public" });
  if (!bound) throw new Error("Expected a bound instrumentation dispatcher");
  return bound;
}

const model = () => new MockLanguageModelV4({
  modelId: "fixture-model", provider: "fixture-provider",
  doGenerate: {
    content: [{ type: "text", text: "PRIVATE_MODEL_OUTPUT" }],
    finishReason: { unified: "stop", raw: "stop" }, warnings: [],
    usage: { inputTokens: { total: 100, noCache: 60, cacheRead: 30, cacheWrite: 10 },
      outputTokens: { total: 20, text: 15, reasoning: 5 } },
    providerMetadata: { gateway: { generationId: "fixture-generation", cost: "0.01", secret: "PRIVATE_METADATA" } },
  },
});

async function cancel() {
  await telemetry.events?.["turn.cancelled"]?.({ type: "turn.cancelled",
    meta: { id: "cancel", at: "2026-09-10T00:00:00Z" }, data: { turnId: scope.turnId, sequence: 1 } }, ctx);
}

test("joins official SDK usage and metadata through native privacy projection, worker restoration and cancellation", async () => {
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation(value => { logged.push(JSON.parse(String(value))); });
  const events: InstrumentationEvent[] = [];
  try {
    const initial = new ContextContainer();
    await contextStorage.run(initial, async () => {
      await telemetry.events?.["step.started"]?.({ type: "step.started", meta: { id: "start", at: "2026-09-10T00:00:00Z" },
        data: { turnId: scope.turnId, stepIndex: 0, sequence: 0, modelId: "fixture-provider/fixture-model" } }, ctx);
      const result = await generateText({ model: model(), prompt: "PRIVATE_PROMPT",
        telemetry: { isEnabled: true, integrations: [createAiSdkHookBridge(scope, dispatcher(events))] } });
      expect(result.text).toBe("PRIVATE_MODEL_OUTPUT");
      expect(modelObservations.get()).toHaveLength(1);
      expect(modelObservations.get()[0]).toMatchObject({ inputTokens: 100, outputTokens: 20,
        cacheReadTokens: 30, cacheWriteTokens: 10, costUsd: 0.01, generationId: "fixture-generation" });
    });
    const visible = JSON.stringify(events);
    expect(visible).not.toContain("PRIVATE_");
    expect(visible).toContain("fixture-generation");
    expect(visible).toContain('"cost":"0.01"');
    expect(events.map(event => event.type)).toEqual(["model.call.started", "model.call.completed", "step.attempt.metadata"]);
    const restored = await deserializeContext(structuredClone(serializeContext(initial)));
    await contextStorage.run(restored, async () => {
      const completed = events.find(event => event.type === "model.call.completed");
      if (!completed) throw new Error("Expected completed SDK call");
      await dispatcher().publish(completed);
      const protocol = { type: "step.completed", meta: { id: "protocol-event" }, data: {
        turnId: scope.turnId, stepIndex: 0, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, costUsd: 0.01 },
        providerMetadata: { gateway: { generationId: "fixture-generation" } },
      } } as HookEvent<"step.completed">;
      await telemetry.events?.["step.completed"]?.(protocol, ctx);
      await telemetry.events?.["step.completed"]?.(protocol, ctx);
      await cancel();
      await cancel();
      expect(modelObservations.get()).toHaveLength(0);
      expect(pendingGatewayTelemetry.get()).toHaveLength(1);
      expect(pendingGatewayTelemetry.get()[0]).toMatchObject({ inputTokens: 100, cacheReadTokens: 30, costUsd: 0.01 });
    });
    const resumed = await deserializeContext(structuredClone(serializeContext(restored)));
    await contextStorage.run(resumed, async () => {
      const laterScope = { ...scope, turnId: "later-turn", attemptId: "native-session:later-turn:0:0" };
      await dispatcher().publish({ type: "model.call.completed", idempotencyKey: "later-call", scope: laterScope,
        usage: { inputTokens: 1 }, finishReason: "stop" });
      expect(pendingGatewayTelemetry.get()).toHaveLength(1);
      expect(pendingGatewayTelemetry.get()[0]?.generationId).toBe("fixture-generation");
      expect(modelObservations.get()[0]?.turnId).toBe("later-turn");
    });
    const budgets = logged.filter(event => event.event === "known-good-review.budget.completed");
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({ modelSteps: 1, inputTokens: 100, outputTokens: 20, sdkCostUsd: 0.01 });
  } finally { logging.mockRestore(); }
});

test("flushes a completed native call on cancellation before protocol step completion and preserves unknown versus zero", async () => {
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation(value => { logged.push(JSON.parse(String(value))); });
  try {
    for (const usage of [{}, { inputTokens: 0, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 } }]) {
      await contextStorage.run(new ContextContainer(), async () => {
        const dispatch = dispatcher();
        await dispatch.publish({ type: "model.call.completed", idempotencyKey: "native-call", scope, usage, finishReason: "stop" });
        await dispatch.publish({ type: "step.attempt.metadata", idempotencyKey: "attempt", scope,
          providerMetadata: { gateway: { cost: usage.inputTokens === 0 ? 0 : "" } } });
        await cancel();
      });
    }
    const budgets = logged.filter(event => event.event === "known-good-review.budget.completed");
    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, sdkCostUsd: null });
    expect(budgets[1]).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sdkCostUsd: 0 });
  } finally { logging.mockRestore(); }
});

test("carries native action identity across worker restoration without output or error content", async () => {
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation(value => { logged.push(JSON.parse(String(value))); });
  try {
    const initial = new ContextContainer();
    await contextStorage.run(initial, async () => {
      await dispatcher().publish({ type: "action.started", scope, idempotencyKey: "workflow-action", callId: "call",
        name: "review_workflow", kind: "tool-call", input: "PRIVATE_INPUT" });
    });
    const restored = await deserializeContext(structuredClone(serializeContext(initial)));
    await contextStorage.run(restored, async () => {
      await dispatcher().publish({ type: "action.failed", scope, idempotencyKey: "workflow-action",
        outcome: "cancelled", error: new Error("PRIVATE_ERROR") });
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ telemetryId: "workflow-action", name: "review_workflow", kind: "tool-call", outcome: "cancelled" });
    expect(JSON.stringify(logged)).not.toContain("PRIVATE_");
  } finally { logging.mockRestore(); }
});

test("accounts distinct retry calls and falls back when the final native observer failed", async () => {
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation(value => { logged.push(JSON.parse(String(value))); });
  try {
    await contextStorage.run(new ContextContainer(), async () => {
      const dispatch = dispatcher();
      await dispatch.publish({ type: "model.call.completed", idempotencyKey: "retry-call", scope,
        usage: { inputTokens: 10, outputTokens: 1 }, finishReason: "stop" });
      await dispatch.publish({ type: "step.attempt.metadata", idempotencyKey: "attempt", scope,
        providerMetadata: { gateway: { generationId: "retry-generation", cost: 0.02 } } });
      // The final successful SDK call reached the protocol boundary but its
      // failure-isolated completion observer did not persist usage. Its durable
      // start distinguishes it even when two attempts report identical totals.
      await dispatch.publish({ type: "model.call.started", idempotencyKey: "final-call",
        scope: { ...scope, attemptId: "native-session:turn:0:1", attemptIndex: 1 },
        model: { modelId: "fixture-model", provider: "fixture-provider" } });
      await telemetry.events?.["step.completed"]?.({ type: "step.completed", meta: { id: "final-protocol" }, data: {
        turnId: scope.turnId, stepIndex: 0, usage: { inputTokens: 20, outputTokens: 2, costUsd: 0.03 },
        providerMetadata: { gateway: { generationId: "final-generation" } },
      } } as HookEvent<"step.completed">, ctx);
      await cancel();
      expect(pendingGatewayTelemetry.get().map(observation => observation.generationId)).toEqual(["retry-generation", "final-generation"]);
      expect(pendingGatewayTelemetry.get().map(observation => observation.costUsd)).toEqual([0.02, 0.03]);
    });
    expect(logged.find(event => event.event === "known-good-review.budget.completed")).toMatchObject({
      modelSteps: 2, inputTokens: 30, outputTokens: 3, sdkCostUsd: 0.05,
    });
  } finally { logging.mockRestore(); }
});

test("uses native call identity when equal-usage retries omit Gateway generation IDs", async () => {
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation(value => { logged.push(JSON.parse(String(value))); });
  try {
    await contextStorage.run(new ContextContainer(), async () => {
      const dispatch = dispatcher();
      await dispatch.publish({ type: "model.call.completed", idempotencyKey: "first-call", scope,
        usage: { inputTokens: 10, outputTokens: 1 }, finishReason: "stop" });
      await dispatch.publish({ type: "model.call.started", idempotencyKey: "second-call",
        scope: { ...scope, attemptId: "native-session:turn:0:1", attemptIndex: 1 },
        model: { modelId: "fixture-model", provider: "fixture-provider" } });
      await telemetry.events?.["step.completed"]?.({ type: "step.completed", meta: { id: "final-protocol" }, data: {
        turnId: scope.turnId, stepIndex: 0, usage: { inputTokens: 10, outputTokens: 1 },
      } } as HookEvent<"step.completed">, ctx);
      await cancel();
    });
    expect(logged.find(event => event.event === "known-good-review.budget.completed")).toMatchObject({
      modelSteps: 2, inputTokens: 20, outputTokens: 2, sdkCostUsd: null,
    });
  } finally { logging.mockRestore(); }
});
