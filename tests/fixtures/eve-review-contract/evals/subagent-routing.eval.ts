import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Exercises a routed root-copy child, production instrumentation, and an inert child tool step.",
  tags: ["offline", "review-contract"],
  async test(t) {
    await t.send("KGR-EVAL-SUBAGENT-ROUTING");

    t.succeeded();
    t.noFailedActions();
    t.calledSubagent("agent", {
      count: 1,
      output: "SUBAGENT-CHILD-COMPLETE",
    });
    t.messageIncludes("SUBAGENT-ROUTING-COMPLETE");
  },
});
