import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Proves the compiled Eve server can stream a routed root-copy child through production instrumentation.",
  tags: ["mock-model", "runtime-smoke"],
  async test(t) {
    await t.send("KGR-EVAL-SUBAGENT-ROUTING");

    t.succeeded();
    t.noFailedActions();
    t.calledSubagent("agent", {
      count: 1,
      output: "SUBAGENT-CHILD-COMPLETE",
    });
    t.eventOrder([
      { type: "subagent.called", count: 1 },
      { type: "subagent.completed", count: 1 },
    ]);
    t.messageIncludes("SUBAGENT-ROUTING-COMPLETE");
  },
});
