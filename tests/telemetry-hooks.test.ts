import { expect, spyOn, test } from "bun:test";
import type { HookContext, HookEvent } from "eve/hooks";
import telemetry from "../agent/hooks/telemetry";

test("flushes cancelled-turn usage once and stops only the root sandbox", async () => {
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation((value) => { logged.push(JSON.parse(String(value))); });
  let stops = 0;
  try {
    for (const kind of ["github", "subagent"]) {
      const ctx = {
        channel: { kind }, session: { id: `cancel-${kind}`, auth: { current: null } },
        getSandbox: async () => ({ stop: async () => { stops += 1; } }),
      } as unknown as HookContext;
      telemetry.events?.["step.completed"]?.({
        type: "step.completed", meta: { id: `event-${kind}` },
        data: { turnId: "turn", stepIndex: 0, usage: { inputTokens: 120, outputTokens: 8 } },
      } as HookEvent<"step.completed">, ctx);
      const event: HookEvent<"turn.cancelled"> = {
        type: "turn.cancelled", data: { sequence: 1, turnId: "turn" },
        meta: { id: `cancel-${kind}`, at: "2026-09-05T00:00:00.000Z" },
      };
      await telemetry.events?.["turn.cancelled"]?.(event, ctx);
      // Replayed terminal events must not emit already-flushed usage again.
      await telemetry.events?.["turn.cancelled"]?.(event, ctx);
    }
    const budgets = logged.filter((record) => record.event === "known-good-review.budget.completed");
    expect(budgets).toHaveLength(2);
    expect(budgets.map(({ inputTokens, outputTokens }) => ({ inputTokens, outputTokens })))
      .toEqual([{ inputTokens: 120, outputTokens: 8 }, { inputTokens: 120, outputTokens: 8 }]);
    expect(stops).toBe(2);
  } finally { logging.mockRestore(); }
});
